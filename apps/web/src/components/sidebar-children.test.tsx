import type { Session } from '@openharness/protocol'
import { makeChildSession, makeSession } from '@openharness/protocol/fixtures'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Sidebar } from './sidebar'

/**
 * The subagents a chat started, nested under its row (epic #340, S1/S3/S9; issue #346).
 *
 * A child is a real session with a parent, and the server never lists one as a chat of its own —
 * so this group is what makes a helper reachable from the sidebar at all. It is collapsed by
 * default with the count and whether one is working on the header, and expanding it is what shows
 * the children as ordinary chat links.
 *
 * The tree is read by the shell (`useSessionTree`) and handed down, which is what lets these cases
 * state a chat's children directly instead of driving a server.
 */

/** Three chats, and two subagents under the middle one. */
function fixture(): {
  readonly parent: Session
  readonly other: Session
  readonly children: readonly Session[]
} {
  const parent = makeSession({ title: 'Release notes' })
  const other = makeSession({ title: 'A chat with no helpers' })
  const first = makeChildSession(parent, { title: 'Check the changelog', status: 'running' })
  const second = makeChildSession(parent, { title: 'Read the issue', status: 'idle' })
  return { parent, other, children: [first, second] }
}

/** The sidebar with one chat's children declared, and nothing else faked. */
function renderSidebar(options: {
  readonly sessions: readonly Session[]
  readonly children: readonly Session[]
  readonly parentId: string
  readonly activeSessionId?: string
}): ReturnType<typeof render> {
  return render(
    <Sidebar
      sessions={options.sessions}
      loading={false}
      error={null}
      truncated={false}
      activeSessionId={options.activeSessionId}
      user={null}
      onSignOut={undefined}
      childrenOf={(sessionId) => (sessionId === options.parentId ? options.children : [])}
    />,
  )
}

describe('the sidebar nests a chat’s subagents (#346)', () => {
  it('shows a collapsed group with the count and the running one', () => {
    const { parent, other, children } = fixture()
    renderSidebar({ sessions: [parent, other], children, parentId: parent.id })

    const toggle = screen.getByRole('button', { name: /2 subagents/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.textContent).toContain('1 running')
    // Collapsed: the children are not drawn, and neither is the other chat's group (there is
    // none — a chat with no children gets no control).
    expect(screen.queryByRole('link', { name: /Check the changelog/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: /subagent/ })).toHaveLength(1)
  })

  it('follows a child on a click, as an ordinary chat link', async () => {
    const user = userEvent.setup()
    const { parent, other, children } = fixture()
    renderSidebar({ sessions: [parent, other], children, parentId: parent.id })

    await user.click(screen.getByRole('button', { name: /2 subagents/ }))

    expect(screen.getByRole('button', { name: /2 subagents/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('link', { name: 'Check the changelog' })).toHaveAttribute(
      'href',
      `#/s/${children[0]?.id ?? ''}`,
    )
    expect(screen.getByRole('link', { name: 'Read the issue' })).toBeInTheDocument()
    // Only the one that is working carries the dot; the idle one does not.
    expect(document.querySelectorAll('[data-slot="child-running"]')).toHaveLength(1)
  })

  it('collapses again on a second click', async () => {
    const user = userEvent.setup()
    const { parent, other, children } = fixture()
    renderSidebar({ sessions: [parent, other], children, parentId: parent.id })

    const toggle = screen.getByRole('button', { name: /2 subagents/ })
    await user.click(toggle)
    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'Check the changelog' })).toBeNull()
  })

  it('opens the group that holds the chat the reader is in, and marks it', () => {
    const { parent, other, children } = fixture()
    renderSidebar({
      sessions: [parent, other],
      children,
      parentId: parent.id,
      activeSessionId: children[1]?.id,
    })

    // A reader inside a subagent's chat finds its group already open, with its own row marked
    // the way the open chat's row is.
    const row = screen.getByRole('link', { name: 'Read the issue' })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /2 subagents/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(row.closest('[data-slot="chat-children"]')).not.toBeNull()
  })

  it('draws no group for a chat with no children', () => {
    const { parent } = fixture()
    renderSidebar({ sessions: [parent], children: [], parentId: parent.id })

    expect(screen.queryByRole('button', { name: /subagent/ })).toBeNull()
    expect(document.querySelector('[data-slot="chat-children"]')).toBeNull()
  })

  it('draws the group inside the chat’s own row, under its label', () => {
    const { parent, other, children } = fixture()
    renderSidebar({ sessions: [parent, other], children, parentId: parent.id })

    const row = screen.getByRole('link', { name: /Release notes/ }).closest('li')
    expect(row).not.toBeNull()
    // The count is part of the chat's row rather than a second list item: a helper is not a chat
    // of its own, and a list of chats must not read as if it were.
    expect(
      within(row as HTMLElement).getByRole('button', { name: /2 subagents/ }),
    ).toBeInTheDocument()
  })

  it('labels a child with its title rather than the model it runs', async () => {
    // The bug the maintainer found on staging: a child was created with no title, so the only
    // thing left to label it with was its **model's** name — "DeepSeek V4 Pro" for a helper
    // whose job was "Check the changelog". The title is the description the parent model gave
    // (epic #340), and the row shows it.
    const user = userEvent.setup()
    const parent = makeSession({ title: 'Release notes' })
    const child = makeChildSession(parent, {
      title: 'Check the changelog',
      model: { id: 'deepseek/deepseek-chat' },
    })
    renderSidebar({ sessions: [parent], children: [child], parentId: parent.id })

    await user.click(screen.getByRole('button', { name: /1 subagent/ }))

    expect(screen.getByRole('link', { name: 'Check the changelog' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /deepseek/ })).toBeNull()
  })
})
