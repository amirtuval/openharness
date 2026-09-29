import { MAX_PAGE_LIMIT } from '@openharness/protocol'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { MAX_PAGE_ITEMS } from '../lib/paging'
import { makeFake, recordListRequests, renderApp, sessionRows } from '../test-support/render-app'
import { Sidebar } from './sidebar'

/** The sidebar's session list: all of it, not the first page of it. */
describe('Sidebar', () => {
  it('lists every session, following next_page, without waiting for all pages to show the first', async () => {
    const fake = makeFake()
    for (let index = 1; index <= 120; index += 1) {
      await fake.sessions.create({ agent: fake.agent.id })
    }
    const firstPage = await fake.sessions.list({ limit: MAX_PAGE_LIMIT })
    expect(firstPage.next_page).not.toBeNull()

    const requests = recordListRequests(fake)
    renderApp(fake, { hash: '#/' })

    // Every session: the sidebar is the only way to an older chat.
    await waitFor(() => {
      expect(sessionRows()).toHaveLength(121)
    })

    // Two requests: a full first page, then the cursor the server handed back.
    expect(requests.sessions).toEqual([
      { limit: MAX_PAGE_LIMIT, page: undefined },
      { limit: MAX_PAGE_LIMIT, page: firstPage.next_page ?? '' },
    ])
  })

  it('says so when the safety cap cuts the list short', () => {
    render(
      <Sidebar sessions={[]} loading={false} error={null} truncated activeSessionId={undefined} />,
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
      />,
    )

    expect(screen.queryByText(/and more…/)).not.toBeInTheDocument()
  })
})
