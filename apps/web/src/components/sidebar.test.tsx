import { MAX_PAGE_LIMIT } from '@openharness/protocol'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { DeleteSessionResult } from '../hooks/use-sessions'
import { MAX_PAGE_ITEMS } from '../lib/paging'
import { makeFake, recordListRequests, renderApp, sessionRows } from '../test-support/render-app'
import { Sidebar } from './sidebar'

/** The sidebar's session list: all of it, not the first page of it — and the row's actions. */
describe('Sidebar', () => {
  it('shows the first page while the rest is still on its way, then the whole list', async () => {
    const fake = makeFake()
    for (let index = 1; index <= 120; index += 1) {
      await fake.sessions.create({ agent: fake.agent.id })
    }
    const firstPage = await fake.sessions.list({ limit: MAX_PAGE_LIMIT })
    expect(firstPage.next_page).not.toBeNull()

    // Hold every page after the first open: "the first page shows before the rest arrives"
    // is only observable while the rest is late.
    const requests = recordListRequests(fake)
    const recorded = fake.sessions.list.bind(fake.sessions)
    let release: (() => void) | undefined
    fake.sessions.list = async (params, options) => {
      if (params?.page !== undefined) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return recorded(params, options)
    }

    renderApp(fake, { hash: '#/' })

    // As many as the first page holds — the sidebar is usable while the walk continues.
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(MAX_PAGE_LIMIT)
    })

    // Let the rest through: the walk follows the cursor the server handed back.
    await waitFor(() => {
      expect(release).toBeDefined()
    })
    release?.()
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(121)
    })
    expect(requests.sessions).toEqual([
      { limit: MAX_PAGE_LIMIT, page: undefined },
      { limit: MAX_PAGE_LIMIT, page: firstPage.next_page ?? '' },
    ])
  })

  it('says so when the safety cap cuts the list short', () => {
    render(
      <Sidebar
        sessions={[]}
        loading={false}
        error={null}
        truncated
        activeSessionId={undefined}
        user={null}
        onSignOut={undefined}
      />,
    )

    expect(
      screen.getByText(`and more… only the first ${MAX_PAGE_ITEMS} are listed`),
    ).toBeInTheDocument()
  })

  it('does not claim there is more when there is not', () => {
    render(
      <Sidebar
        sessions={[]}
        loading={false}
        error={null}
        truncated={false}
        activeSessionId={undefined}
        user={null}
        onSignOut={undefined}
      />,
    )

    expect(screen.queryByText(/and more…/)).not.toBeInTheDocument()
  })
})

/**
 * The row's actions (epic #116, U5): a kebab menu with Delete chat, an in-page confirmation,
 * and a failure that stays next to the row it was about. Rendered on the list directly — the
 * app-level behaviour (navigation, the removed row) is in `App.test.tsx`.
 */
describe('the sidebar row actions', () => {
  async function renderSidebar(
    onDelete: (sessionId: string) => Promise<DeleteSessionResult>,
  ): Promise<{ user: ReturnType<typeof userEvent.setup>; row: HTMLElement }> {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake()
    const sessions = (await fake.sessions.list()).data
    render(
      <Sidebar
        sessions={sessions}
        loading={false}
        error={null}
        truncated={false}
        activeSessionId={undefined}
        user={null}
        onSignOut={undefined}
        onDelete={onDelete}
      />,
    )
    const row = sessionRows()[0]
    if (row === undefined) {
      throw new Error('the sidebar rendered no rows')
    }
    return { user, row }
  }

  it('asks in the page before deleting, and deletes through onDelete', async () => {
    const onDelete = vi.fn((): Promise<DeleteSessionResult> => Promise.resolve({ ok: true }))
    const { user, row } = await renderSidebar(onDelete)
    const sessionId = row.querySelector('a')?.getAttribute('href')?.replace('#/s/', '') ?? ''

    await user.click(within(row).getByRole('button', { name: 'Chat actions' }))
    await user.click(within(row).getByRole('menuitem', { name: 'Delete chat' }))

    // The question is an element in the page — a `window.confirm` would block and cannot be
    // styled or tested like the rest of the app.
    expect(within(row).getByText('Delete this chat?')).toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()

    await user.click(within(row).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(onDelete).toHaveBeenCalledWith(sessionId)
    })
    expect(within(row).queryByText('Delete this chat?')).not.toBeInTheDocument()
  })

  it('cancels without deleting', async () => {
    const onDelete = vi.fn((): Promise<DeleteSessionResult> => Promise.resolve({ ok: true }))
    const { user, row } = await renderSidebar(onDelete)

    await user.click(within(row).getByRole('button', { name: 'Chat actions' }))
    await user.click(within(row).getByRole('menuitem', { name: 'Delete chat' }))
    await user.click(within(row).getByRole('button', { name: 'Cancel' }))

    expect(onDelete).not.toHaveBeenCalled()
    expect(within(row).queryByText('Delete this chat?')).not.toBeInTheDocument()
    expect(within(row).getByRole('link')).toBeInTheDocument()
  })

  it('closes the menu on Escape without deleting', async () => {
    const onDelete = vi.fn((): Promise<DeleteSessionResult> => Promise.resolve({ ok: true }))
    const { user, row } = await renderSidebar(onDelete)

    await user.click(within(row).getByRole('button', { name: 'Chat actions' }))
    expect(within(row).getByRole('menu', { name: 'Chat actions' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(within(row).queryByRole('menu')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('shows why a failed delete failed, next to the row, and keeps asking', async () => {
    const onDelete = vi.fn((): Promise<DeleteSessionResult> =>
      Promise.resolve({ ok: false, message: 'The chat could not be deleted.' }),
    )
    const { user, row } = await renderSidebar(onDelete)

    await user.click(within(row).getByRole('button', { name: 'Chat actions' }))
    await user.click(within(row).getByRole('menuitem', { name: 'Delete chat' }))
    await user.click(within(row).getByRole('button', { name: 'Delete' }))

    const alert = await within(row).findByRole('alert')
    expect(alert).toHaveTextContent('The chat could not be deleted.')
    // The row is intact — the list still holds it — and the confirmation is still up: the
    // retry is one click away.
    expect(sessionRows()).toHaveLength(1)
    expect(within(row).getByText('Delete this chat?')).toBeInTheDocument()
  })

  it('has no delete action when the list was given none', async () => {
    const fake = makeFake()
    const sessions = (await fake.sessions.list()).data
    render(
      <Sidebar
        sessions={sessions}
        loading={false}
        error={null}
        truncated={false}
        activeSessionId={undefined}
        user={null}
        onSignOut={undefined}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Chat actions' })).not.toBeInTheDocument()
  })
})
