import type { Session } from '@openharness/protocol'
import { makeChildSession, makeSession } from '@openharness/protocol/fixtures'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ClientProvider, useClient } from '../client-provider'
import { useSessionBreadcrumb } from '../../hooks/use-session-breadcrumb'
import { makeFake } from '../../test-support/render-app'
import { SubagentHeader } from './subagent-header'

/**
 * Where a child's chat says it came from (epic #340, S9; issue #346).
 *
 * Two halves: the strip itself (the crumbs and the one line about what a subagent is), and the
 * walk that feeds it — `sessionBreadcrumb`, which reads each parent up the tree and must not be
 * started at all for a top-level chat.
 */

/** The strip, with the chain a test states. */
function renderHeader(chain: readonly Session[]): HTMLElement {
  const { container } = render(<SubagentHeader chain={chain} />)
  const header = container.querySelector<HTMLElement>('[data-slot="subagent-header"]')
  if (header === null) {
    throw new Error('the strip did not render')
  }
  return header
}

describe('the subagent strip (#346)', () => {
  it('draws the chain root first, links for every step but the last', () => {
    const root = makeSession({ title: 'Release notes' })
    const middle = makeChildSession(root, { title: 'Check the changelog' })
    const child = makeChildSession(middle, { title: 'Read the issue' })

    const header = renderHeader([root, middle, child])

    expect(within(header).getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      `#/s/${root.id}`,
    )
    expect(within(header).getByRole('link', { name: 'Check the changelog' })).toHaveAttribute(
      'href',
      `#/s/${middle.id}`,
    )
    // The last crumb is where the reader already is: text, marked as the current page, not a link
    // back to itself.
    const current = header.querySelector('[data-slot="breadcrumb-current"]') as HTMLElement
    expect(current.textContent).toBe('Read the issue')
    expect(current).toHaveAttribute('aria-current', 'page')
    expect(within(header).queryByRole('link', { name: 'Read the issue' })).toBeNull()
  })

  it('says what being a subagent means in one line', () => {
    const root = makeSession({ title: 'Release notes' })
    const header = renderHeader([root, makeChildSession(root, { title: 'Check the changelog' })])

    expect(within(header).getByText('subagent')).toBeInTheDocument()
    expect(header.querySelector('[data-slot="subagent-note"]')?.textContent).toBe(
      'A subagent cannot ask you anything, but you can message and interrupt it.',
    )
  })

  it('draws nothing for a chain with no sessions', () => {
    const { container } = render(<SubagentHeader chain={[]} />)
    expect(container.querySelector('[data-slot="subagent-header"]')).toBeNull()
  })
})

/** A component that only shows what the walk answered, so the hook can be read. */
function BreadcrumbProbe({ session }: { readonly session: Session | null }) {
  const client = useClient()
  const chain = useSessionBreadcrumb(client, session)
  return (
    <ul data-slot="probe">
      {/* The id, not the label: what is under test here is which sessions the walk found and in
          what order, and a label would drag the catalog lookup into it. */}
      {(chain ?? []).map((step) => (
        <li key={step.id}>{step.id}</li>
      ))}
    </ul>
  )
}

describe('the breadcrumb walk (#346)', () => {
  it('reads the parent up from the session, root first', async () => {
    const fake = makeFake()
    // The fake holds exactly one session, so a chain can be one step deep — which is all the
    // walk's order needs: the root first, the session it started from last.
    const child = makeChildSession(fake.session, { title: 'Read the issue' })
    const get = vi.spyOn(fake.sessions, 'get')

    render(
      <ClientProvider client={fake}>
        <BreadcrumbProbe session={child} />
      </ClientProvider>,
    )

    const steps = await screen.findAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual([fake.session.id, child.id])
    // One read: the parent the child names, and nothing for the root above it.
    expect(get.mock.calls.map((call) => call[0])).toEqual([fake.session.id])
  })

  it('walks nothing for a top-level chat', async () => {
    const fake = makeFake()
    const get = vi.spyOn(fake.sessions, 'get')

    render(
      <ClientProvider client={fake}>
        <BreadcrumbProbe
          session={{ ...makeSession({ title: 'A chat' }), parent_session_id: null }}
        />
      </ClientProvider>,
    )

    // Nothing to breadcrumb: no parent read is made at all.
    await waitFor(() => {
      expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    })
    expect(get).not.toHaveBeenCalled()
  })
})
