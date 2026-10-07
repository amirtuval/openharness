import { MAX_PAGE_LIMIT, type Session, type User } from '@openharness/protocol'
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
    await user.click(screen.getByRole('menuitem', { name: 'Delete chat' }))

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
    await user.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
    await user.click(within(row).getByRole('button', { name: 'Cancel' }))

    expect(onDelete).not.toHaveBeenCalled()
    expect(within(row).queryByText('Delete this chat?')).not.toBeInTheDocument()
    expect(within(row).getByRole('link')).toBeInTheDocument()
  })

  it('closes the menu on Escape without deleting', async () => {
    const onDelete = vi.fn((): Promise<DeleteSessionResult> => Promise.resolve({ ok: true }))
    const { user, row } = await renderSidebar(onDelete)

    await user.click(within(row).getByRole('button', { name: 'Chat actions' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('shows why a failed delete failed, next to the row, and keeps asking', async () => {
    const onDelete = vi.fn((): Promise<DeleteSessionResult> =>
      Promise.resolve({ ok: false, message: 'The chat could not be deleted.' }),
    )
    const { user, row } = await renderSidebar(onDelete)

    await user.click(within(row).getByRole('button', { name: 'Chat actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete chat' }))
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

/**
 * The list itself (epic #201, U10): date headings, a marked open chat, the account menu at the
 * foot and the put-away column.
 *
 * Rendered on the component with a hand-built list, because these are all rules about the
 * list's own props — `groupSessionsByDate` has its calendar pinned in its own test
 * (`src/lib/session-groups.test.ts`), and here the question is only whether the sidebar draws
 * what it returns.
 */
describe('the sidebar list', () => {
  /** A session with nothing but the fields the list reads. */
  function session(id: string, createdAt: string, model = 'openai/gpt-5.1-mini'): Session {
    return {
      id,
      type: 'session',
      owner_id: 'user_1',
      status: 'idle',
      title: id,
      metadata: {},
      model: { id: model },
      system: null,
      agent: null,
      created_at: createdAt,
      updated_at: createdAt,
    }
  }

  /** A timestamp `daysAgo` days ago, at midday. */
  function daysAgo(days: number): string {
    const date = new Date()
    date.setDate(date.getDate() - days)
    date.setHours(12, 0, 0, 0)
    return date.toISOString()
  }

  it('draws a heading per date bucket, and only the buckets that hold something', () => {
    render(
      <Sidebar
        sessions={[
          session('today', daysAgo(0)),
          session('yesterday', daysAgo(1)),
          session('older', daysAgo(40)),
        ]}
        loading={false}
        error={null}
        truncated={false}
        activeSessionId={undefined}
        user={null}
        onSignOut={undefined}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Older' })).toBeInTheDocument()
    // Nothing landed in it, so it is not drawn: a heading over an empty run of the list reads
    // as a bug.
    expect(screen.queryByRole('heading', { name: 'Previous 7 days' })).not.toBeInTheDocument()
    // The headings are not rows: the list is still three chats.
    expect(sessionRows()).toHaveLength(3)
  })

  it('marks the open chat beyond its colour', () => {
    const { container } = render(
      <Sidebar
        sessions={[session('open', daysAgo(0)), session('other', daysAgo(0))]}
        loading={false}
        error={null}
        truncated={false}
        activeSessionId="open"
        user={null}
        onSignOut={undefined}
      />,
    )

    // `aria-current` is the accessible half — what says "you are here" to a reader who cannot
    // see the tint — and the bar is the visible one.
    const linkFor = (id: string): HTMLElement | null =>
      sessionRows()
        .find((row) => row.querySelector('a')?.getAttribute('href') === `#/s/${id}`)
        ?.querySelector('a') ?? null
    expect(linkFor('open')).toHaveAttribute('aria-current', 'page')
    expect(linkFor('other')).not.toHaveAttribute('aria-current')
    expect(container.querySelectorAll('[data-slot="active-marker"]')).toHaveLength(1)
  })

  it('puts Settings, the theme and Sign out behind the account at the foot', async () => {
    const user = userEvent.setup({ delay: null })
    const user_ = { id: 'user_1', email: 'ada@example.com', name: 'Ada', image: undefined }
    const onSignOut = vi.fn()
    render(
      <Sidebar
        sessions={[]}
        loading={false}
        error={null}
        truncated={false}
        activeSessionId={undefined}
        user={user_ as unknown as User}
        onSignOut={onSignOut}
      />,
    )

    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Account menu' }))

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '#/settings')
    expect(screen.getByRole('menuitem', { name: 'Theme' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }))
    expect(onSignOut).toHaveBeenCalled()
  })

  it('shows skeleton rows while the list is still on its way', () => {
    render(
      <Sidebar
        sessions={[]}
        loading
        error={null}
        truncated={false}
        activeSessionId={undefined}
        user={null}
        onSignOut={undefined}
      />,
    )

    expect(screen.getByText('Loading your chats')).toBeInTheDocument()
    // Not the empty state: "no chats yet" and "we do not know yet" are different screens.
    expect(screen.queryByText('No chats yet.')).not.toBeInTheDocument()
  })

  it('offers the collapse control only when the shell gave it one', async () => {
    const user = userEvent.setup({ delay: null })
    const onToggleCollapsed = vi.fn()
    const fake = makeFake()
    const sessions = (await fake.sessions.list()).data

    const { rerender } = render(
      <Sidebar
        sessions={sessions}
        loading={false}
        error={null}
        truncated={false}
        activeSessionId={undefined}
        user={null}
        onSignOut={undefined}
        onToggleCollapsed={onToggleCollapsed}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Hide sidebar' }))
    expect(onToggleCollapsed).toHaveBeenCalled()

    // Rendered without one — the sidebar tests, and the drawer — it is not there at all.
    rerender(
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
    expect(screen.queryByRole('button', { name: 'Hide sidebar' })).not.toBeInTheDocument()
  })
})
