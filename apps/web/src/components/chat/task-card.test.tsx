import type { TaskCard, TaskCardStatus } from '@openharness/client'
import { newSessionId } from '@openharness/protocol'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { TaskCardView } from './task-card'

/**
 * The task card's markup (epic #340, S9; issue #346): the five states, the live line with its
 * tokens and money, the conversation between the parent and the child, and the result behind the
 * disclosure.
 *
 * The *derivation* is the client's — which status a task draws, what its activity line says,
 * what its messages and result are — so these cases drive `TaskCardView`, which takes every fact
 * already derived. What is under test is what the card does with them, and what a reader can do
 * to it: Open follows the child, Stop asks for one.
 */

/** A card, with the two fields a case cares about. */
function card(overrides: Partial<TaskCard> = {}): TaskCard {
  const child = newSessionId()
  return {
    id: 'task_1',
    kind: 'subagent',
    childSessionId: child,
    type: 'researcher',
    description: 'Check the release notes',
    status: 'running',
    messages: [],
    result: null,
    position: 3,
    ...overrides,
  }
}

describe('the task card', () => {
  it('draws a running task: its type, its description, its status, and Stop', () => {
    const task = card()
    const { container } = render(
      <TaskCardView
        card={task}
        line="web_fetch: https://example.com"
        tokens={1234}
        cost={{ cost: 0.0012, unpriced_requests: 0 }}
        onStop={() => undefined}
      />,
    )

    const box = container.querySelector('[data-slot="task-card"]') as HTMLElement
    expect(box.dataset.status).toBe('running')
    expect(within(box).getByText('researcher')).toBeInTheDocument()
    expect(within(box).getByText('Check the release notes')).toBeInTheDocument()
    expect(within(box).getByText('running')).toBeInTheDocument()
    expect(box.querySelector('[data-slot="task-activity-line"]')?.textContent).toBe(
      'web_fetch: https://example.com',
    )
    expect(box.querySelector('[data-slot="task-tokens"]')?.textContent).toBe('1,234 tokens')
    expect(box.querySelector('[data-slot="task-cost"]')?.textContent).toBe('$0.0012')
    expect(within(box).getByRole('button', { name: 'Stop researcher task_1' })).toBeEnabled()
    // The child's chat is reachable from the card, and Open is a real link so Back, middle-click
    // and a reload land where a reader expects.
    expect(within(box).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      `#/s/${task.childSessionId ?? ''}`,
    )
    // A task nothing has finished has no result to fold.
    expect(box.querySelector('[data-slot="task-result-trigger"]')).toBeNull()
  })

  it('shows the task list as the activity when the child is between calls', () => {
    const { container } = render(<TaskCardView card={card()} line="2 of 5" />)
    expect(container.querySelector('[data-slot="task-activity-line"]')?.textContent).toBe('2 of 5')
  })

  it('draws a task waiting on its own helpers as waiting, and still offers Stop', () => {
    const { container } = render(<TaskCardView card={card()} waiting onStop={() => undefined} />)
    const box = container.querySelector('[data-slot="task-card"]') as HTMLElement
    expect(box.dataset.status).toBe('waiting')
    expect(within(box).getByText('waiting')).toBeInTheDocument()
    expect(within(box).getByRole('button', { name: /^Stop / })).toBeInTheDocument()
  })

  it('folds the result into a finished card and drops the live line with it', () => {
    const { container } = render(
      <TaskCardView
        card={card({
          status: 'done',
          result: { kind: 'result', text: 'The notes are accurate.', seq: 11 },
        })}
        // Whatever the child's stream said, a finished card has no activity to draw: the two
        // would contradict each other.
        line="writing…"
        tokens={900}
      />,
    )

    const box = container.querySelector('[data-slot="task-card"]') as HTMLElement
    expect(box.dataset.status).toBe('done')
    expect(box.querySelector('[data-slot="task-activity"]')).toBeNull()
    // Collapsed by default: the trigger is there, the words are not.
    expect(within(box).getByRole('button', { name: 'Result' })).toBeInTheDocument()
    expect(box.querySelector('[data-slot="task-result"]')).toBeNull()
    // A finished task is not something a reader can stop — it has stopped.
    expect(box.querySelector('[data-slot="task-stop"]')).toBeNull()
  })

  it('opens the result on demand, and calls a failure what it is', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <TaskCardView
        card={card({
          status: 'failed',
          result: { kind: 'failed', text: 'the provider refused the request', seq: 14 },
        })}
      />,
    )
    const box = container.querySelector('[data-slot="task-card"]') as HTMLElement
    expect(box.dataset.status).toBe('failed')
    expect(within(box).getByText('failed')).toBeInTheDocument()

    await user.click(within(box).getByRole('button', { name: 'Failed — what it said' }))
    expect(box.querySelector('[data-slot="task-result"]')?.textContent).toBe(
      'the provider refused the request',
    )
  })

  it('draws a stopped task as stopped', () => {
    const { container } = render(<TaskCardView card={card({ status: 'stopped' })} />)
    const box = container.querySelector('[data-slot="task-card"]') as HTMLElement
    expect(box.dataset.status).toBe('stopped')
    expect(within(box).getByText('stopped')).toBeInTheDocument()
  })

  it('draws every status word the epic decided on', () => {
    for (const status of ['running', 'waiting', 'done', 'failed', 'stopped'] as TaskCardStatus[]) {
      const { container, unmount } = render(
        <TaskCardView
          card={card({ status: status === 'waiting' ? 'running' : status })}
          waiting={status === 'waiting'}
        />,
      )
      const box = container.querySelector('[data-slot="task-card"]') as HTMLElement
      expect(box.dataset.status).toBe(status)
      unmount()
    }
  })

  it('draws the conversation between the parent and the child inline, in order', () => {
    const { container } = render(
      <TaskCardView
        card={card({
          messages: [
            { from: 'parent', text: 'Focus on the changelog.', seq: 4 },
            { from: 'child', text: 'On it.', seq: 6 },
          ],
        })}
      />,
    )

    const lines = [...container.querySelectorAll('[data-slot="task-messages"] li')]
    expect(lines.map((line) => line.textContent)).toEqual([
      '→ researcher:Focus on the changelog.',
      'researcher →:On it.',
    ])
  })

  it('offers Stop with what the task is, and answers the card it was pressed for', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    const task = card()
    render(<TaskCardView card={task} onStop={onStop} />)

    await user.click(screen.getByRole('button', { name: 'Stop researcher task_1' }))
    expect(onStop).toHaveBeenCalledWith(task)
  })

  it('holds Stop off while the request is in flight', () => {
    render(<TaskCardView card={card()} stopping onStop={() => undefined} />)
    expect(screen.getByRole('button', { name: /^Stop / })).toBeDisabled()
    expect(screen.getByText('Stopping…')).toBeInTheDocument()
  })

  it('offers no Open for a task with no session to open', () => {
    const { container } = render(<TaskCardView card={card({ childSessionId: null })} />)
    expect(container.querySelector('[data-slot="task-open"]')).toBeNull()
  })

  it('offers no Stop when the caller cannot stop anything', () => {
    // A read-only view of a conversation (a share, a test) passes no `onStop`.
    const { container } = render(<TaskCardView card={card()} />)
    expect(container.querySelector('[data-slot="task-stop"]')).toBeNull()
  })
})
