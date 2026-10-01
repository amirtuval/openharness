import { describe, expect, it } from 'vitest'

import { newEventId } from '../ids'
import { encodeSeqCursor } from '../pagination'
import {
  DEFAULT_EVENT_ORDER,
  ListEventsQuerySchema,
  ListEventsResponseSchema,
  MAX_EVENT_DELTAS,
  SendEventsRequestSchema,
  SendEventsResponseSchema,
  StreamEventsQuerySchema,
} from './api'

const text = (value: string) => [{ type: 'text', text: value }]

const storedMessage = {
  id: newEventId(),
  type: 'user.message',
  seq: 1,
  processed_at: null,
  content: text('hi'),
}

describe('SendEventsRequestSchema', () => {
  it('accepts one or more user events', () => {
    expect(
      SendEventsRequestSchema.safeParse({
        events: [{ type: 'user.message', content: text('hi') }, { type: 'user.interrupt' }],
      }).success,
    ).toBe(true)
  })

  it('rejects an empty batch, a missing batch and non-user events', () => {
    expect(SendEventsRequestSchema.safeParse({ events: [] }).success).toBe(false)
    expect(SendEventsRequestSchema.safeParse({}).success).toBe(false)
    expect(
      SendEventsRequestSchema.safeParse({
        events: [{ type: 'agent.message', content: text('hi') }],
      }).success,
    ).toBe(false)
    expect(
      SendEventsRequestSchema.safeParse({
        events: [{ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }],
      }).success,
    ).toBe(false)
  })
})

describe('SendEventsResponseSchema', () => {
  it('returns the stored user events', () => {
    const parsed = SendEventsResponseSchema.safeParse({ data: [storedMessage] })
    expect(parsed.success).toBe(true)
  })

  it('rejects a server-produced event in the response', () => {
    expect(
      SendEventsResponseSchema.safeParse({
        data: [{ ...storedMessage, type: 'agent.message', content: text('hi') }],
      }).success,
    ).toBe(false)
  })
})

describe('ListEventsQuerySchema', () => {
  it('accepts the documented parameters', () => {
    const query = ListEventsQuerySchema.parse({
      limit: 50,
      order: 'desc',
      page: encodeSeqCursor(12),
      types: ['user.message', 'agent.message'],
      after_seq: 12,
    })
    expect(query).toEqual({
      limit: 50,
      order: 'desc',
      page: encodeSeqCursor(12),
      types: ['user.message', 'agent.message'],
      after_seq: 12,
    })
  })

  it('accepts string query values, since that is what a URL carries', () => {
    const query = ListEventsQuerySchema.parse({ limit: '25', after_seq: '0' })
    expect(query).toEqual({ limit: 25, after_seq: 0 })
  })

  it('rejects an unknown event type in the filter', () => {
    // `agent.tool_use` is a real Anthropic event type; v1 does not store it.
    expect(ListEventsQuerySchema.safeParse({ types: ['agent.tool_use'] }).success).toBe(false)
    expect(ListEventsQuerySchema.safeParse({ types: [] }).success).toBe(true)
  })

  it('accepts the chunk types: a reply’s chunks are stored events', () => {
    // A streamed reply's `event_start` / `event_delta` are stored events since D9 — the only
    // form they have since P4 — so a reader may filter the log by them.
    expect(ListEventsQuerySchema.safeParse({ types: ['event_start'] }).success).toBe(true)
    expect(ListEventsQuerySchema.safeParse({ types: ['event_delta'] }).success).toBe(true)
  })

  it('rejects an unknown order, a bad limit and a plain-string page', () => {
    expect(ListEventsQuerySchema.safeParse({ order: 'newest' }).success).toBe(false)
    expect(ListEventsQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(ListEventsQuerySchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(ListEventsQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(ListEventsQuerySchema.safeParse({ page: '12' }).success).toBe(false)
  })

  it('rejects a negative after_seq', () => {
    expect(ListEventsQuerySchema.safeParse({ after_seq: -1 }).success).toBe(false)
    expect(ListEventsQuerySchema.safeParse({ after_seq: 1.5 }).success).toBe(false)
  })

  it('documents that the default order is oldest first', () => {
    expect(DEFAULT_EVENT_ORDER).toBe('asc')
    expect(ListEventsQuerySchema.parse({}).order).toBeUndefined()
  })
})

describe('ListEventsResponseSchema', () => {
  it('uses the Anthropic list envelope', () => {
    expect(
      ListEventsResponseSchema.safeParse({ data: [storedMessage], next_page: null }).success,
    ).toBe(true)
    expect(
      ListEventsResponseSchema.safeParse({
        data: [storedMessage],
        next_page: encodeSeqCursor(1),
      }).success,
    ).toBe(true)
    expect(ListEventsResponseSchema.safeParse({ data: [] }).success).toBe(false)
  })

  it('rejects a stream-only event in the history', () => {
    expect(
      ListEventsResponseSchema.safeParse({
        data: [{ type: 'event_start', event: { type: 'agent.message', id: newEventId() } }],
        next_page: null,
      }).success,
    ).toBe(false)
  })
})

describe('StreamEventsQuerySchema', () => {
  it('accepts an empty query: a plain stream of stored events', () => {
    expect(StreamEventsQuerySchema.parse({})).toEqual({})
  })

  it('accepts the delta types it can preview', () => {
    expect(StreamEventsQuerySchema.parse({ event_deltas: ['agent.message'] })).toEqual({
      event_deltas: ['agent.message'],
    })
  })

  it('rejects a delta type it cannot preview', () => {
    expect(StreamEventsQuerySchema.safeParse({ event_deltas: ['agent.thinking'] }).success).toBe(
      false,
    )
    expect(StreamEventsQuerySchema.safeParse({ event_deltas: ['user.message'] }).success).toBe(
      false,
    )
  })

  it('caps how many delta types one connection may ask for', () => {
    expect(MAX_EVENT_DELTAS).toBe(100)
    expect(
      StreamEventsQuerySchema.safeParse({
        event_deltas: new Array(MAX_EVENT_DELTAS + 1).fill('agent.message'),
      }).success,
    ).toBe(false)
  })

  it('accepts the after_seq resume extension', () => {
    expect(StreamEventsQuerySchema.parse({ after_seq: '17' })).toEqual({ after_seq: 17 })
    expect(StreamEventsQuerySchema.safeParse({ after_seq: -1 }).success).toBe(false)
  })
})
