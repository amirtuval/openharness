import { describe, expect, it } from 'vitest'

import { newEventId } from '../ids'
import {
  AgentEventSchema,
  AgentMessageEventSchema,
  EventDeltaSchema,
  EventStartSchema,
  ModelRequestEndEventSchema,
  ModelRequestStartEventSchema,
  STORED_EVENT_TYPES,
  SessionEventSchema,
  SessionErrorEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionStatusRunningEventSchema,
  SpanEventSchema,
  StoredEventSchema,
  StreamEventSchema,
  StreamOnlyEventSchema,
  UserEventInputSchema,
  UserEventSchema,
  UserInterruptEventSchema,
  UserMessageEventInputSchema,
  UserMessageEventSchema,
  isStoredEvent,
} from './index'

const eventId = (): string => newEventId()
const text = (value: string) => [{ type: 'text', text: value }]

/** One valid wire sample per stored event type, keyed by type string. */
const storedSamples = {
  'user.message': {
    id: eventId(),
    type: 'user.message',
    seq: 1,
    processed_at: null,
    content: text('hello'),
  },
  'user.interrupt': {
    id: eventId(),
    type: 'user.interrupt',
    seq: 2,
    processed_at: null,
  },
  'agent.message': {
    id: eventId(),
    type: 'agent.message',
    seq: 3,
    processed_at: '2026-03-15T10:00:00Z',
    content: text('hi'),
  },
  'session.status_running': {
    id: eventId(),
    type: 'session.status_running',
    seq: 4,
    processed_at: '2026-03-15T10:00:00Z',
  },
  'session.status_idle': {
    id: eventId(),
    type: 'session.status_idle',
    seq: 5,
    processed_at: '2026-03-15T10:00:00Z',
    stop_reason: { type: 'end_turn' },
  },
  'session.status_rescheduled': {
    id: eventId(),
    type: 'session.status_rescheduled',
    seq: 6,
    processed_at: '2026-03-15T10:00:00Z',
  },
  'session.error': {
    id: eventId(),
    type: 'session.error',
    seq: 7,
    processed_at: '2026-03-15T10:00:00Z',
    error: {
      type: 'model_overloaded_error',
      message: 'overloaded',
      retry_status: { type: 'retrying' },
    },
  },
  'span.model_request_start': {
    id: eventId(),
    type: 'span.model_request_start',
    seq: 8,
    processed_at: '2026-03-15T10:00:00Z',
  },
  'span.model_request_end': {
    id: eventId(),
    type: 'span.model_request_end',
    seq: 9,
    processed_at: '2026-03-15T10:00:00Z',
    model_request_start_id: eventId(),
    model_usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    is_error: null,
  },
} as const

describe('stored event schemas', () => {
  it('covers every stored event type', () => {
    expect(Object.keys(storedSamples).sort()).toEqual([...STORED_EVENT_TYPES].sort())
  })

  it.each(Object.entries(storedSamples))('parses a %s event', (_type, sample) => {
    const parsed = StoredEventSchema.safeParse(sample)
    expect(parsed.error?.issues ?? []).toEqual([])
    expect(parsed.success).toBe(true)
  })

  it.each(Object.entries(storedSamples))('keeps the %s discriminant', (type, sample) => {
    expect(StoredEventSchema.parse(sample).type).toBe(type)
  })

  it('rejects an unknown event type', () => {
    // `agent.tool_use` is a real Anthropic event that v1 does not implement.
    const unknown = { ...storedSamples['agent.message'], type: 'agent.tool_use' }
    const parsed = StoredEventSchema.safeParse(unknown)
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.code).toBe('invalid_union')
  })

  it('rejects a stored event missing a required field', () => {
    const { seq: _seq, ...withoutSeq } = storedSamples['user.message']
    expect(StoredEventSchema.safeParse(withoutSeq).success).toBe(false)
    expect(
      StoredEventSchema.safeParse({ ...storedSamples['agent.message'], content: [] }).success,
    ).toBe(true)
    expect(
      StoredEventSchema.safeParse({
        ...storedSamples['agent.message'],
        content: [{ type: 'image', source: {} }],
      }).success,
    ).toBe(false)
  })

  it('rejects a seq below 1: the first event of a session is 1', () => {
    expect(StoredEventSchema.safeParse({ ...storedSamples['user.message'], seq: 0 }).success).toBe(
      false,
    )
  })

  it('accepts an offset timestamp as well as Zulu', () => {
    expect(
      StoredEventSchema.safeParse({
        ...storedSamples['agent.message'],
        processed_at: '2026-03-15T12:00:00+02:00',
      }).success,
    ).toBe(true)
  })

  it('requires processed_at on server-produced events but not on user events', () => {
    expect(
      StoredEventSchema.safeParse({ ...storedSamples['agent.message'], processed_at: null })
        .success,
    ).toBe(false)
    expect(
      StoredEventSchema.safeParse({ ...storedSamples['user.message'], processed_at: null }).success,
    ).toBe(true)
    expect(
      StoredEventSchema.safeParse({
        ...storedSamples['user.message'],
        processed_at: '2026-03-15T10:00:00Z',
      }).success,
    ).toBe(true)
  })
})

describe('event sub-unions', () => {
  it('routes each event to its domain union', () => {
    expect(UserEventSchema.safeParse(storedSamples['user.message']).success).toBe(true)
    expect(UserEventSchema.safeParse(storedSamples['user.interrupt']).success).toBe(true)
    expect(AgentEventSchema.safeParse(storedSamples['agent.message']).success).toBe(true)
    expect(AgentMessageEventSchema.parse(storedSamples['agent.message']).content).toHaveLength(1)
    expect(SessionEventSchema.safeParse(storedSamples['session.status_idle']).success).toBe(true)
    expect(
      SessionStatusRunningEventSchema.safeParse(storedSamples['session.status_running']).success,
    ).toBe(true)
    expect(
      SessionStatusRescheduledEventSchema.safeParse(storedSamples['session.status_rescheduled'])
        .success,
    ).toBe(true)
    expect(SpanEventSchema.safeParse(storedSamples['span.model_request_end']).success).toBe(true)
  })

  it('keeps the domains apart', () => {
    expect(UserEventSchema.safeParse(storedSamples['agent.message']).success).toBe(false)
    expect(AgentEventSchema.safeParse(storedSamples['user.message']).success).toBe(false)
    expect(SessionEventSchema.safeParse(storedSamples['user.interrupt']).success).toBe(false)
    expect(SpanEventSchema.safeParse(storedSamples['session.error']).success).toBe(false)
    expect(SpanEventSchema.safeParse(storedSamples['span.model_request_start']).success).toBe(true)
  })

  it('narrows to the concrete event', () => {
    const event = UserEventSchema.parse(storedSamples['user.message'])
    expect(event.type === 'user.message' && event.content[0]?.type === 'text').toBe(true)
    expect(UserMessageEventSchema.safeParse(event).success).toBe(true)
    expect(UserInterruptEventSchema.safeParse(event).success).toBe(false)
  })
})

describe('session.error', () => {
  it('carries Anthropic’s error types and retry statuses', () => {
    for (const type of [
      'unknown_error',
      'model_overloaded_error',
      'model_rate_limited_error',
      'model_request_failed_error',
      'mcp_connection_failed_error',
      'mcp_authentication_failed_error',
      'billing_error',
      'credential_host_unreachable_error',
    ]) {
      for (const retryStatus of ['retrying', 'exhausted', 'terminal']) {
        const event = {
          ...storedSamples['session.error'],
          error: { type, message: 'x', retry_status: { type: retryStatus } },
        }
        expect(SessionErrorEventSchema.safeParse(event).success, `${type}/${retryStatus}`).toBe(
          true,
        )
      }
    }
  })

  it('rejects an unknown error type or retry status', () => {
    expect(
      SessionErrorEventSchema.safeParse({
        ...storedSamples['session.error'],
        error: { type: 'something_new', message: 'x', retry_status: { type: 'retrying' } },
      }).success,
    ).toBe(false)
    expect(
      SessionErrorEventSchema.safeParse({
        ...storedSamples['session.error'],
        error: { type: 'billing_error', message: 'x', retry_status: { type: 'later' } },
      }).success,
    ).toBe(false)
  })
})

describe('session.status_idle stop_reason', () => {
  it('is end_turn in v1', () => {
    expect(
      SessionStatusIdleEventSchema.safeParse({
        ...storedSamples['session.status_idle'],
        stop_reason: { type: 'end_turn' },
      }).success,
    ).toBe(true)
  })

  it('rejects the stop reasons v1 cannot emit', () => {
    for (const type of ['requires_action', 'retries_exhausted', 'budget_reached']) {
      expect(
        SessionStatusIdleEventSchema.safeParse({
          ...storedSamples['session.status_idle'],
          stop_reason: { type },
        }).success,
        type,
      ).toBe(false)
    }
  })
})

describe('span.model_request_end', () => {
  it('carries the usage Anthropic reports', () => {
    const event = ModelRequestEndEventSchema.parse(storedSamples['span.model_request_end'])
    expect(event.model_usage).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
  })

  it('accepts the error extension on a failed request', () => {
    for (const type of ['interrupted', 'brain_lost', 'model_error']) {
      expect(
        ModelRequestEndEventSchema.safeParse({
          ...storedSamples['span.model_request_end'],
          is_error: true,
          error: { type, message: 'why' },
        }).success,
        type,
      ).toBe(true)
    }
  })

  it('carries no error extension on a request that completed normally', () => {
    const event = ModelRequestEndEventSchema.parse(storedSamples['span.model_request_end'])
    expect(event.is_error).toBeNull()
    expect(event.error).toBeUndefined()
  })

  it('rejects an unknown error extension type', () => {
    expect(
      ModelRequestEndEventSchema.safeParse({
        ...storedSamples['span.model_request_end'],
        is_error: true,
        error: { type: 'crashed' },
      }).success,
    ).toBe(false)
  })

  it('requires the span it closes', () => {
    const { model_request_start_id: _id, ...rest } = storedSamples['span.model_request_end']
    expect(ModelRequestEndEventSchema.safeParse(rest).success).toBe(false)
    expect(
      ModelRequestStartEventSchema.safeParse(storedSamples['span.model_request_start']).success,
    ).toBe(true)
  })
})

describe('stream-only events', () => {
  const id = newEventId()

  it('matches the documented preview shapes', () => {
    expect(
      EventStartSchema.parse({ type: 'event_start', event: { type: 'agent.message', id } }),
    ).toEqual({ type: 'event_start', event: { type: 'agent.message', id } })
    expect(
      EventDeltaSchema.parse({
        type: 'event_delta',
        event_id: id,
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Here' } },
      }),
    ).toMatchObject({ delta: { type: 'content_delta', index: 0 } })
  })

  it('carries no id, seq or processed_at of their own', () => {
    const start = StreamOnlyEventSchema.parse({
      type: 'event_start',
      event: { type: 'agent.message', id },
    })
    expect(start).not.toHaveProperty('id')
    expect(start).not.toHaveProperty('seq')
    expect(StreamOnlyEventSchema.safeParse({ ...storedSamples['agent.message'] }).success).toBe(
      false,
    )
  })

  it('rejects a delta for an event type that cannot be previewed', () => {
    expect(
      EventStartSchema.safeParse({ type: 'event_start', event: { type: 'agent.thinking', id } })
        .success,
    ).toBe(false)
    expect(
      EventDeltaSchema.safeParse({
        type: 'event_delta',
        event_id: id,
        delta: { type: 'content_block_delta', index: 0, content: { type: 'text', text: 'x' } },
      }).success,
    ).toBe(false)
  })

  it('rejects a negative or fractional block index', () => {
    for (const index of [-1, 0.5]) {
      expect(
        EventDeltaSchema.safeParse({
          type: 'event_delta',
          event_id: id,
          delta: { type: 'content_delta', index, content: { type: 'text', text: 'x' } },
        }).success,
      ).toBe(false)
    }
  })

  it('reads a missing block index as 0, the way Anthropic’s accumulator does', () => {
    const parsed = EventDeltaSchema.parse({
      type: 'event_delta',
      event_id: id,
      delta: { type: 'content_delta', content: { type: 'text', text: 'x' } },
    })
    expect(parsed.delta.index).toBe(0)
  })
})

describe('StreamEventSchema', () => {
  const id = newEventId()

  it('accepts every stored event and every stream-only event', () => {
    for (const sample of Object.values(storedSamples)) {
      expect(StreamEventSchema.safeParse(sample).success).toBe(true)
    }
    expect(
      StreamEventSchema.safeParse({ type: 'event_start', event: { type: 'agent.message', id } })
        .success,
    ).toBe(true)
    expect(
      StreamEventSchema.safeParse({
        type: 'event_delta',
        event_id: id,
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'x' } },
      }).success,
    ).toBe(true)
  })

  it('still rejects unknown types', () => {
    expect(StreamEventSchema.safeParse({ type: 'agent.tool_use', id, seq: 1 }).success).toBe(false)
  })

  it('tells stored events from previews', () => {
    const stored = StreamEventSchema.parse(storedSamples['agent.message'])
    const preview = StreamEventSchema.parse({
      type: 'event_start',
      event: { type: 'agent.message', id },
    })
    expect(isStoredEvent(stored)).toBe(true)
    expect(isStoredEvent(preview)).toBe(false)
  })
})

describe('user event inputs', () => {
  it('accept the shapes a client sends', () => {
    expect(
      UserEventInputSchema.safeParse({ type: 'user.message', content: text('hi') }).success,
    ).toBe(true)
    expect(UserEventInputSchema.safeParse({ type: 'user.interrupt' }).success).toBe(true)
  })

  it('strip the fields the server assigns', () => {
    // `id`, `seq` and `processed_at` are the server's to choose, so an input carrying them
    // parses but does not keep them.
    expect(
      UserEventInputSchema.parse({
        type: 'user.message',
        id: newEventId(),
        seq: 1,
        processed_at: null,
        content: text('hi'),
      }),
    ).toEqual({ type: 'user.message', content: text('hi') })
  })

  it('reject agent and session events', () => {
    expect(
      UserEventInputSchema.safeParse({ type: 'agent.message', content: text('hi') }).success,
    ).toBe(false)
    expect(UserEventInputSchema.safeParse({ type: 'session.status_running' }).success).toBe(false)
  })

  it('reject an empty text block', () => {
    expect(UserMessageEventSchema.safeParse(storedSamples['user.message']).success).toBe(true)
    expect(
      UserMessageEventSchema.safeParse({
        ...storedSamples['user.message'],
        content: [{ type: 'text', text: '' }],
      }).success,
    ).toBe(false)
  })

  it('reject a session status event sent as an input', () => {
    expect(
      UserEventInputSchema.safeParse({
        type: 'session.status_idle',
        stop_reason: { type: 'end_turn' },
      }).success,
    ).toBe(false)
  })

  it('round-trips: what a client sends becomes what the server stores', () => {
    const input = UserMessageEventInputSchema.parse({
      type: 'user.message',
      content: text('Summarize the README'),
    })
    const stored = UserMessageEventSchema.parse({
      id: newEventId(),
      seq: 1,
      processed_at: null,
      ...input,
    })
    expect(stored.content).toEqual(input.content)
  })
})
