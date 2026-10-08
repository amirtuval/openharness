import { EVENT_TYPES, newEventId } from '@openharness/protocol'
import type { StoredEvent } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  contextView,
  lastStatusEventType,
  needsModelRequest,
  readLog,
  usageByModel,
  withRequestUsage,
} from './log'
import { newSession } from './testing/harness'

/** A message event, queued or claimed. */
function message(seq: number, processed: boolean): StoredEvent {
  return {
    id: newEventId(),
    type: EVENT_TYPES.userMessage,
    seq,
    processed_at: processed ? '2026-03-15T10:00:00.000Z' : null,
    content: [{ type: 'text', text: `message ${seq}` }],
  }
}

/** A reply, as the log stores one. */
function reply(seq: number): StoredEvent {
  return {
    id: newEventId(),
    type: EVENT_TYPES.agentMessage,
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    content: [{ type: 'text', text: `reply ${seq}` }],
  }
}

/** A span start, as the log stores one, naming the model that serves the request. */
function spanStart(seq: number, model?: string): StoredEvent {
  return {
    id: newEventId(),
    type: EVENT_TYPES.modelRequestStart,
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    ...(model === undefined ? {} : { model }),
  }
}

/** A span end closing `start`, with the tokens it reported. */
function spanEnd(seq: number, start: StoredEvent, tokens: number): StoredEvent {
  return {
    id: newEventId(),
    type: EVENT_TYPES.modelRequestEnd,
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
    model_request_start_id: start.id,
    model_usage: {
      input_tokens: tokens,
      output_tokens: tokens / 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    is_error: null,
  }
}

/** A status event. */
function status(seq: number, type: string): StoredEvent {
  return {
    id: newEventId(),
    type,
    seq,
    processed_at: '2026-03-15T10:00:00.000Z',
  } as StoredEvent
}

describe('readLog', () => {
  it('pages through a log longer than one page', async () => {
    const { store, sessionId } = await newSession()
    const appended = await store.appendEvents(
      sessionId,
      Array.from({ length: 250 }, () => ({
        type: EVENT_TYPES.sessionStatusRunning,
      })),
    )

    const log = await readLog(store, sessionId)

    expect(log).toHaveLength(250)
    expect(log.map((event) => event.seq)).toEqual(appended.map((event) => event.seq))
  })

  it('reads an empty log', async () => {
    const { store, sessionId } = await newSession()

    expect(await readLog(store, sessionId)).toEqual([])
  })
})

describe('lastStatusEventType', () => {
  it('answers the last status event, whatever else the log holds', () => {
    expect(lastStatusEventType([])).toBeUndefined()
    expect(
      lastStatusEventType([
        status(1, EVENT_TYPES.sessionStatusRunning),
        message(2, true),
        status(3, EVENT_TYPES.sessionStatusRescheduled),
        message(4, true),
      ]),
    ).toBe(EVENT_TYPES.sessionStatusRescheduled)
    expect(lastStatusEventType([status(1, EVENT_TYPES.sessionStatusIdle)])).toBe(
      EVENT_TYPES.sessionStatusIdle,
    )
  })
})

describe('contextView', () => {
  it('leaves out the user events that are still waiting to be claimed', () => {
    const queued = message(1, false)
    const claimed = message(2, true)
    const interrupt: StoredEvent = {
      id: newEventId(),
      type: EVENT_TYPES.userInterrupt,
      seq: 3,
      processed_at: null,
    }

    const answered = reply(4)

    expect(contextView([queued, claimed, interrupt, answered])).toEqual([claimed, answered])
  })
})

describe('needsModelRequest', () => {
  it('is true while a claimed message has no reply', () => {
    expect(needsModelRequest([message(1, true)])).toBe(true)
    expect(needsModelRequest([message(1, true), status(2, EVENT_TYPES.sessionStatusRunning)])).toBe(
      true,
    )
  })

  it('is false once every claimed message has been answered', () => {
    expect(
      needsModelRequest([
        message(1, true),
        status(2, EVENT_TYPES.sessionStatusRunning),
        spanStart(3),
        reply(4),
      ]),
    ).toBe(false)
  })

  it('counts a message that arrived mid-request as unanswered', () => {
    // The shape a steer leaves in the log: the message lands while the first request streams,
    // so the reply that follows it belongs to the request before it.
    const events = [
      message(1, true),
      status(2, EVENT_TYPES.sessionStatusRunning),
      spanStart(3),
      message(4, true),
      reply(5),
    ]

    expect(needsModelRequest(events)).toBe(true)
  })

  it('has nothing to answer when the only message is still queued', () => {
    // Which is why the loop builds its view first: an unclaimed message is the next turn's.
    expect(needsModelRequest(contextView([message(1, false)]))).toBe(false)
  })
})

describe('usageByModel', () => {
  it('folds every request onto the model its span start named', () => {
    const first = spanStart(1, 'anthropic/claude-sonnet-5')
    const second = spanStart(3, 'anthropic/claude-sonnet-5')
    const switched = spanStart(5, 'openai/gpt-5.1')
    const events = [
      message(0, true),
      first,
      spanEnd(2, first, 100),
      second,
      spanEnd(4, second, 200),
      switched,
      spanEnd(6, switched, 8),
    ]
    expect(usageByModel(events)).toEqual([
      {
        model: 'anthropic/claude-sonnet-5',
        usage: {
          input_tokens: 300,
          output_tokens: 150,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      {
        model: 'openai/gpt-5.1',
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    ])
  })

  it('is empty for a log with no request in it', () => {
    expect(usageByModel([message(1, true), reply(2)])).toEqual([])
    // A span still in flight reports nothing yet: an end is what carries tokens.
    expect(usageByModel([spanStart(1, 'anthropic/claude-sonnet-5')])).toEqual([])
  })

  it('leaves out a request whose model the log does not name', () => {
    // A span start from before the `model` field existed names no model, and a span end whose
    // start is not in the log names nothing either. Neither invents a model to bill — the
    // totals are per model, and a request that cannot be attributed to one is not in them.
    const unnamed = spanStart(1)
    const named = spanStart(2, 'anthropic/claude-sonnet-5')
    const orphanEnd = spanEnd(3, { ...named, id: newEventId() }, 100)
    const events = [unnamed, spanEnd(2, unnamed, 7), named, orphanEnd, spanEnd(5, named, 5)]
    expect(usageByModel(events)).toEqual([
      {
        model: 'anthropic/claude-sonnet-5',
        usage: {
          input_tokens: 5,
          output_tokens: 2.5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    ])
  })
})

describe('withRequestUsage', () => {
  const usage = {
    input_tokens: 10,
    output_tokens: 4,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 1,
  }

  it('adds a request to the model it ran on, keeping the order of first appearance', () => {
    expect(
      withRequestUsage(
        [{ model: 'anthropic/claude-sonnet-5', usage }],
        'anthropic/claude-sonnet-5',
        { ...usage, input_tokens: 1 },
      ),
    ).toEqual([
      {
        model: 'anthropic/claude-sonnet-5',
        // Every counter adds: the same request counted twice.
        usage: {
          input_tokens: 11,
          output_tokens: 8,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 2,
        },
      },
    ])
  })

  it('adds the model a switch introduced after the ones already there', () => {
    expect(
      withRequestUsage([{ model: 'anthropic/claude-sonnet-5', usage }], 'openai/gpt-5.1', usage),
    ).toEqual([
      { model: 'anthropic/claude-sonnet-5', usage },
      { model: 'openai/gpt-5.1', usage },
    ])
  })

  it('hands back copies: the fold never shares what it holds', () => {
    const held = [{ model: 'anthropic/claude-sonnet-5', usage }]
    const next = withRequestUsage(held, 'anthropic/claude-sonnet-5', usage)
    expect(next[0]?.usage).not.toBe(held[0]?.usage)
    expect(Object.isFrozen(next)).toBe(false)
  })
})
