import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TodoPanel } from './todo-panel'

/**
 * The chat's task list (epic #303, X5; #305; #308; the panel's own shape: #314).
 *
 * The protocol's `readTodoList` (tested in `@openharness/protocol`) decides *what* the list is;
 * this file is what the web draws: the three states, how far along it is, the fold, the two
 * places the panel can be drawn, and the empty list a model writes when it clears one.
 */
const LIST = [
  { content: 'read the docs', status: 'done' as const },
  { content: 'write the code', status: 'in_progress' as const },
  { content: 'ship it', status: 'pending' as const },
]

function panel(overrides: Partial<Parameters<typeof TodoPanel>[0]> = {}) {
  const onToggle = vi.fn()
  render(
    <TodoPanel
      todos={LIST}
      collapsed={false}
      onToggle={onToggle}
      variant="bottom"
      {...overrides}
    />,
  )
  return { onToggle }
}

describe('TodoPanel (#308)', () => {
  it('draws every item, its state and how far along the list is', () => {
    panel()

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveAttribute('data-status', 'done')
    expect(items[1]).toHaveAttribute('data-status', 'in_progress')
    expect(items[2]).toHaveAttribute('data-status', 'pending')
    // The header, in one sentence: what the panel is and how far along it is (#314).
    expect(screen.getByRole('button', { name: 'Tasks · 1 of 3 done' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    // The current item is called out, because "what is the model on now" is the question.
    expect(
      screen.getByText('write the code', { selector: '[data-slot="todo-current"]' }),
    ).toBeInTheDocument()
  })

  it('shows an empty list as cleared rather than as nothing to draw', () => {
    panel({ todos: [] })

    expect(screen.getByRole('button', { name: 'Tasks · cleared' })).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('carries the whole list in a labelled region, so a screen reader can find it', () => {
    panel({ todos: [{ content: 'only one', status: 'pending' }] })

    const region = screen.getByRole('region', { name: 'Task list' })
    expect(within(region).getByText('only one')).toBeInTheDocument()
  })

  it('folds to its header and the item in progress, and back', async () => {
    const user = userEvent.setup({ delay: null })
    const { onToggle } = panel({ collapsed: true })

    // Folded: no list, the count still right, the item in progress on a line of its own, and
    // the control saying so.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Tasks · 1 of 3 done' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(
      screen.getByText('write the code', { selector: '[data-slot="todo-current"]' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Tasks · 1 of 3 done' }))
    // The panel reports the state it was in, so the screen stores the opposite of what it drew.
    expect(onToggle).toHaveBeenCalledWith(false)
  })

  it('starts folded where the reader has not said, and only above the composer', () => {
    // Long list, no stored choice: the row above the composer folds (it takes the
    // conversation's height), the side panel does not (a column of its own costs nothing).
    const long = [0, 1, 2, 3, 4, 5].map((n) => ({
      content: `step ${String(n)}`,
      status: 'pending' as const,
    }))
    const { unmount } = render(
      <TodoPanel todos={long} collapsed={null} onToggle={vi.fn()} variant="bottom" />,
    )
    expect(screen.getByRole('button', { name: 'Tasks · 0 of 6 done' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    unmount()

    render(<TodoPanel todos={long} collapsed={null} onToggle={vi.fn()} variant="side" />)
    expect(screen.getByRole('button', { name: 'Tasks · 0 of 6 done' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(6)
  })

  it('points the control at the list only while the list is there', () => {
    // `aria-controls` naming an element that is not rendered is worse than none at all.
    panel()
    const open = screen.getByRole('button', { name: 'Tasks · 1 of 3 done' })
    expect(screen.getByRole('region', { name: 'Task list' })).toContainElement(
      document.getElementById(open.getAttribute('aria-controls') ?? ''),
    )
  })

  it('draws itself as the side panel or the row above the composer, and the CSS picks', () => {
    const { unmount } = render(
      <TodoPanel todos={LIST} collapsed={false} onToggle={vi.fn()} variant="side" />,
    )
    const side = screen.getByRole('region', { name: 'Task list' })
    expect(side).toHaveAttribute('data-variant', 'side')
    // Below `xl` this instance is not drawn: the composer's row is the one that is.
    expect(side.className).toContain('hidden')
    expect(side.className).toContain('xl:block')
    unmount()

    render(<TodoPanel todos={LIST} collapsed={false} onToggle={vi.fn()} variant="bottom" />)
    const bottom = screen.getByRole('region', { name: 'Task list' })
    expect(bottom).toHaveAttribute('data-variant', 'bottom')
    expect(bottom.className).toContain('xl:hidden')
  })
})
