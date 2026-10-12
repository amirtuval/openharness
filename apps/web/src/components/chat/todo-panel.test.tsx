import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TodoPanel } from './todo-panel'

/**
 * The chat's task list (epic #303, X5; #305; #308).
 *
 * The protocol's `readTodoList` (tested in `@openharness/protocol`) decides *what* the list is;
 * this file is what the web draws: the three states, how far along it is, and the empty list a
 * model writes when it clears one.
 */
describe('TodoPanel (#308)', () => {
  it('draws every item, its state and how far along the list is', () => {
    render(
      <TodoPanel
        todos={[
          { content: 'read the docs', status: 'done' },
          { content: 'write the code', status: 'in_progress' },
          { content: 'ship it', status: 'pending' },
        ]}
      />,
    )

    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveAttribute('data-status', 'done')
    expect(items[1]).toHaveAttribute('data-status', 'in_progress')
    expect(items[2]).toHaveAttribute('data-status', 'pending')
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument()
    // The current item is called out, because "what is the model on now" is the question.
    expect(
      screen.getByText('write the code', { selector: '[data-slot="todo-current"]' }),
    ).toBeInTheDocument()
  })

  it('shows an empty list as cleared rather than as nothing to draw', () => {
    render(<TodoPanel todos={[]} />)

    expect(screen.getByText('cleared')).toBeInTheDocument()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('carries the whole list in a labelled region, so a screen reader can find it', () => {
    render(<TodoPanel todos={[{ content: 'only one', status: 'pending' }]} />)

    const panel = screen.getByRole('region', { name: 'Task list' })
    expect(within(panel).getByText('only one')).toBeInTheDocument()
  })
})
