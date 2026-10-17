import type { TaskCard, TranscriptMessage, TranscriptToolCall } from '@openharness/client'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ClientProvider } from '../client-provider'
import { makeFake } from '../../test-support/render-app'
import { MessageList } from './message-list'

/**
 * Where a task's card lands in the conversation (epic #340, S9; issue #346).
 *
 * A card draws where the `agent` call that started it was, and that call is deliberately not a
 * tool line — the client keeps it out of `toolCalls` entirely — so the only thing to prove here is
 * that the list merges the two ordered streams and draws the card in the right place among the
 * messages, leaving a run of tool calls unbroken elsewhere. The card's own markup is
 * `task-card.test.tsx`'s.
 */

/** A message at a position, as the transcript holds one. */
function message(id: string, position: number): TranscriptMessage {
  return {
    id,
    role: 'user',
    text: id,
    parts: [{ type: 'text', text: id }],
    pending: false,
    streaming: false,
    position,
  }
}

/** A running call at a position — enough of one for the line the list draws. */
function call(id: string, position: number): TranscriptToolCall {
  return {
    id,
    name: 'web_fetch',
    input: { url: 'https://example.com' },
    status: 'running',
    permission: 'allow',
    source: 'builtin',
    position,
  }
}

/** A card at a position. No child session: this file is about placement, not about watching. */
function card(id: string, position: number): TaskCard {
  return {
    id,
    kind: 'subagent',
    childSessionId: null,
    type: 'researcher',
    description: `Check the release notes (${id})`,
    status: 'running',
    messages: [],
    result: null,
    position,
  }
}

/** What the list drew, in document order: a message's role, a call, or a card's id. */
function order(container: HTMLElement): string[] {
  const drawn = container.querySelectorAll(
    '[data-role], [data-slot="tool-call"], [data-slot="task-card"]',
  )
  return [...drawn].map((element) => {
    const role = element.getAttribute('data-role')
    if (role !== null) {
      return `message:${role}`
    }
    const task = element.getAttribute('data-task')
    return task === null ? 'tool' : `task:${task}`
  })
}

describe('the tasks among the messages (#346)', () => {
  it('draws a card where the `agent` call that started it was', () => {
    const { container } = render(
      <ClientProvider client={makeFake()}>
        <MessageList
          messages={[message('before', 1), message('after', 5)]}
          tasks={[card('task_1', 3)]}
          loading={false}
        />
      </ClientProvider>,
    )

    expect(order(container)).toEqual(['message:user', 'task:task_1', 'message:user'])
  })

  it('leaves a run of calls unbroken by a card at another position', () => {
    const { container } = render(
      <ClientProvider client={makeFake()}>
        <MessageList
          messages={[message('start', 1)]}
          toolCalls={[call('call_a', 2), call('call_b', 3)]}
          tasks={[card('task_1', 9)]}
          loading={false}
        />
      </ClientProvider>,
    )

    // The two calls are one group, and the card is after it.
    expect(order(container)).toEqual(['message:user', 'tool', 'tool', 'task:task_1'])
    expect(container.querySelectorAll('[data-slot="tool-group"]')).toHaveLength(1)
  })

  it('draws no card for a chat that started none', () => {
    const { container } = render(
      <ClientProvider client={makeFake()}>
        <MessageList messages={[message('only', 1)]} loading={false} />
      </ClientProvider>,
    )

    expect(container.querySelector('[data-slot="task-card"]')).toBeNull()
  })
})
