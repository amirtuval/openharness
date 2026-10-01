import { newEventId } from '@openharness/protocol'
import type { EventId, StoredEvent } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  createContextStrategy,
  estimateTokens,
} from './context'

/** A message event, as the log stores one. */
function userMessage(seq: number, text: string): StoredEvent {
  return {
    id: newEventId(),
    type: 'user.message',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    content: [{ type: 'text', text }],
  }
}

/** An agent reply, as the log stores one. */
function agentMessage(seq: number, text: string): StoredEvent {
  return {
    id: newEventId(),
    type: 'agent.message',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    content: [{ type: 'text', text }],
  }
}

/** An event the context is not made of. */
function statusRunning(seq: number): StoredEvent {
  return {
    id: newEventId(),
    type: 'session.status_running',
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
  }
}

/** A stored chunk of a reply in flight: an `event_start` or an `event_delta` (D9). */
function chunk(seq: number, of: EventId): StoredEvent {
  return seq % 2 === 0
    ? {
        id: newEventId(),
        type: 'event_delta',
        seq,
        processed_at: '2026-03-15T10:00:00.000Z',
        event_id: of,
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'half a rep' } },
      }
    : {
        id: newEventId(),
        type: 'event_start',
        seq,
        processed_at: '2026-03-15T10:00:00.000Z',
        event: { type: 'agent.message', id: of },
      }
}

const MODEL = { id: 'anthropic/claude-sonnet-5' }

describe('createContextStrategy', () => {
  it('turns the conversation into messages, oldest first', () => {
    const strategy = createContextStrategy()

    const messages = strategy(
      [
        statusRunning(1),
        userMessage(2, 'First'),
        agentMessage(3, 'Answer'),
        userMessage(4, 'Second'),
      ],
      { model: MODEL, system: 'Be terse.' },
    )

    expect(messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Second' },
    ])
  })

  it('leaves the system message out when the session has no prompt', () => {
    const strategy = createContextStrategy()

    expect(strategy([userMessage(1, 'Hi')], { model: MODEL, system: null })).toEqual([
      { role: 'user', content: 'Hi' },
    ])
  })

  it('leaves out messages that carry no text', () => {
    const strategy = createContextStrategy()
    const empty: StoredEvent = {
      id: newEventId(),
      type: 'agent.message',
      seq: 2,
      processed_at: '2026-03-15T10:00:00.000Z',
      content: [],
    }

    expect(strategy([userMessage(1, 'Hi'), empty], { model: MODEL, system: null })).toEqual([
      { role: 'user', content: 'Hi' },
    ])
  })

  it('ignores the stored chunks of a reply (D9)', () => {
    // Since D9 a reply is stored twice while it streams: as its chunks, and as the message that
    // supersedes them. The chunks are the stream's shape, not the conversation's — the model
    // must see one reply, once, and the empty text of a chunk would otherwise read as a message
    // the model did not send.
    const strategy = createContextStrategy()
    const reply = newEventId()

    expect(
      strategy(
        [
          userMessage(1, 'Hi'),
          chunk(2, reply),
          chunk(3, reply),
          chunk(4, reply),
          agentMessage(5, 'Hello there'),
        ],
        { model: MODEL, system: null },
      ),
    ).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello there' },
    ])
  })

  it('joins a message of several blocks', () => {
    const strategy = createContextStrategy()
    const multi: StoredEvent = {
      id: newEventId(),
      type: 'user.message',
      seq: 1,
      processed_at: '2026-03-15T10:00:00.000Z',
      content: [
        { type: 'text', text: 'One' },
        { type: 'text', text: 'Two' },
      ],
    }

    expect(strategy([multi], { model: MODEL, system: null })).toEqual([
      { role: 'user', content: 'OneTwo' },
    ])
  })

  it('drops the oldest turns when the history is over budget', () => {
    // A budget of 20 tokens is 80 characters at `CHARS_PER_TOKEN`.
    const strategy = createContextStrategy({ tokenBudget: 20 })
    const events = [
      userMessage(1, 'a'.repeat(40)),
      agentMessage(2, 'b'.repeat(40)),
      userMessage(3, 'c'.repeat(40)),
      agentMessage(4, 'd'.repeat(40)),
    ]

    const messages = strategy(events, { model: MODEL, system: null })

    expect(messages).toEqual([
      { role: 'user', content: 'c'.repeat(40) },
      { role: 'assistant', content: 'd'.repeat(40) },
    ])
  })

  it('keeps the newest message even when it alone is over budget', () => {
    const strategy = createContextStrategy({ tokenBudget: 1 })
    const events = [
      userMessage(1, 'a'.repeat(40)),
      agentMessage(2, 'b'.repeat(40)),
      userMessage(3, 'c'.repeat(400)),
    ]

    expect(strategy(events, { model: MODEL, system: 'System prompt.' })).toEqual([
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'c'.repeat(400) },
    ])
  })

  it('never opens the history with a reply', () => {
    // Dropping whole turns from a log that starts with a user message keeps that shape, so this
    // is the defensive half of the rule: a history whose oldest kept message is a reply (a log
    // that opens with one) has it dropped too, leaving the question it was answering.
    const strategy = createContextStrategy({ tokenBudget: 25 })
    const events = [
      agentMessage(1, 'b'.repeat(40)),
      userMessage(2, 'c'.repeat(40)),
      agentMessage(3, 'd'.repeat(40)),
      userMessage(4, 'e'.repeat(4)),
    ]

    expect(strategy(events, { model: MODEL, system: null })).toEqual([
      { role: 'user', content: 'e'.repeat(4) },
    ])
  })

  it('budgets per model, with the default as the fallback', () => {
    const strategy = createContextStrategy({
      tokenBudget: 20,
      tokenBudgetByModel: { 'small/one': 4 },
    })
    const events = [
      userMessage(1, 'a'.repeat(40)),
      agentMessage(2, 'b'.repeat(40)),
      userMessage(3, 'c'.repeat(40)),
      agentMessage(4, 'd'.repeat(40)),
    ]

    expect(strategy(events, { model: { id: 'small/one' }, system: null })).toEqual([
      { role: 'user', content: 'c'.repeat(40) },
      { role: 'assistant', content: 'd'.repeat(40) },
    ])
    expect(strategy(events, { model: { id: 'large/two' }, system: null })).toHaveLength(2)
  })
})

describe('estimateTokens', () => {
  it('is four characters per token, rounded up', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('has a sane default budget', () => {
    expect(DEFAULT_CONTEXT_TOKEN_BUDGET).toBeGreaterThan(1_000)
  })
})
