import { describe, expect, it } from 'vitest'

import type { EventId } from '../ids'
import { newEventId } from '../ids'
import {
  AgentEventSchema,
  AgentMessageEventSchema,
  ContentDeltaSchema,
  EVENT_TYPES,
  EventInputSchema,
  ModelRequestEndEventSchema,
  ModelRequestStartEventSchema,
  STORED_EVENT_TYPES,
  SessionDeletedEventSchema,
  SessionEventSchema,
  SessionRewindEventInputSchema,
  SessionRewindEventSchema,
  SessionErrorEventSchema,
  SessionErrorSchema,
  SessionErrorTypeSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionStatusRunningEventSchema,
  SpanEventSchema,
  StoredEventDeltaSchema,
  StoredEventSchema,
  StoredEventStartSchema,
  StreamEventSchema,
  SupersedesSchema,
  UserEventInputSchema,
  UserEventSchema,
  UserInterruptEventSchema,
  UserMessageEventInputSchema,
  UserMessageEventSchema,
  isStoredEvent,
} from './index'
import type {
  AgentMessageEvent,
  ModelRequestEndEvent,
  SessionStatusIdleEvent,
  StoredEvent,
  StoredEventStart,
  UserEvent,
  UserMessageEvent,
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
  event_start: {
    id: eventId(),
    type: 'event_start',
    seq: 10,
    processed_at: '2026-03-15T10:00:00Z',
    event: { type: 'agent.message', id: eventId() },
  },
  event_delta: {
    id: eventId(),
    type: 'event_delta',
    seq: 11,
    processed_at: '2026-03-15T10:00:00Z',
    event_id: eventId(),
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Here' } },
  },
  'session.rewind': {
    id: eventId(),
    type: 'session.rewind',
    seq: 12,
    processed_at: '2026-03-15T10:00:00Z',
    supersedes: { from_seq: 1, to_seq: 11 },
  },
  'session.usage': {
    id: eventId(),
    type: 'session.usage',
    seq: 13,
    processed_at: '2026-03-15T10:00:00Z',
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4,
    models: [
      {
        model: 'anthropic/claude-sonnet-5',
        usage: {
          input_tokens: 6,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4,
        },
      },
      {
        model: 'openai/gpt-4.1-mini',
        usage: {
          input_tokens: 4,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    ],
  },
} as const

describe('stored event schemas', () => {
  it('covers every stored event type', () => {
    expect(Object.keys(storedSamples).sort()).toEqual([...STORED_EVENT_TYPES].sort())
  })

  it.each(Object.entries(storedSamples))('parses a %s event', (_type, sample) => {
    const parsed = StoredEventSchema.safeParse(sample)
    // `safeParse` sets `success` and `error` together, so one assertion says both — and the
    // issues are what a failure has to show to be diagnosable.
    expect(parsed.error?.issues ?? [], JSON.stringify(sample)).toEqual([])
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

describe('session.deleted (stream-only, #111)', () => {
  const deleted = { type: 'session.deleted', session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7' }

  it('is in the event vocabulary but not among the stored event types', () => {
    expect(EVENT_TYPES.sessionDeleted).toBe('session.deleted')
    expect(STORED_EVENT_TYPES).not.toContain('session.deleted')
  })

  it('parses as a stream event and carries the session id', () => {
    const parsed = StreamEventSchema.parse(deleted)
    expect(parsed.type === 'session.deleted' && parsed.session_id).toBe(deleted.session_id)
    expect(SessionDeletedEventSchema.parse(deleted)).toEqual(deleted)
  })

  it('is not a stored event: there is no log left to store it in', () => {
    expect(StoredEventSchema.safeParse(deleted).success).toBe(false)
    expect(isStoredEvent(StreamEventSchema.parse(deleted))).toBe(false)
    // It carries no envelope at all — no `seq`, no `id`, no `processed_at`.
    expect('seq' in deleted).toBe(false)
    expect(
      StoredEventSchema.safeParse({
        ...deleted,
        id: eventId(),
        seq: 1,
        processed_at: '2026-03-15T10:00:00Z',
      }).success,
    ).toBe(false)
  })

  it('requires a session_id and rejects a well-shaped event with a bad one', () => {
    expect(SessionDeletedEventSchema.safeParse({ type: 'session.deleted' }).success).toBe(false)
    for (const sessionId of ['', 'sevt_01JQZ8R6X9M4V0W7Y2B3C5D6E7', 'sesn_nope', 42]) {
      expect(
        SessionDeletedEventSchema.safeParse({ ...deleted, session_id: sessionId }).success,
        String(sessionId),
      ).toBe(false)
    }
  })

  it('rejects an unknown stream-only event type', () => {
    expect(
      StreamEventSchema.safeParse({ type: 'session.terminated', session_id: deleted.session_id })
        .success,
    ).toBe(false)
  })
})

describe('session.rewind (#238)', () => {
  const rewind = storedSamples['session.rewind']

  it('is a stored event: the log keeps the rewind and is otherwise unchanged', () => {
    expect(EVENT_TYPES.sessionRewind).toBe('session.rewind')
    expect(STORED_EVENT_TYPES).toContain('session.rewind')
    expect(StoredEventSchema.safeParse(rewind).success).toBe(true)
    expect(SessionEventSchema.safeParse(rewind).success).toBe(true)
    expect(StreamEventSchema.safeParse(rewind).success).toBe(true)
  })

  it('requires a supersedes range, and one that is not inverted', () => {
    const { supersedes: _supersedes, ...withoutRange } = rewind
    expect(SessionRewindEventSchema.safeParse(withoutRange).success).toBe(false)
    for (const range of [
      { from_seq: 0, to_seq: 3 },
      { from_seq: 4, to_seq: 3 },
      { from_seq: 1.5, to_seq: 3 },
      { from_seq: 1, to_seq: '3' },
    ]) {
      expect(
        SessionRewindEventSchema.safeParse({ ...rewind, supersedes: range }).success,
        JSON.stringify(range),
      ).toBe(false)
    }
  })

  it('is not a user event: the user domain union stays the user’s own two events', () => {
    expect(UserEventSchema.safeParse(rewind).success).toBe(false)
    expect(UserEventInputSchema.safeParse({ type: 'session.rewind', from_seq: 4 }).success).toBe(
      false,
    )
  })

  it('sends the message to restart from, not the range', () => {
    // The store owns how far a rewind reaches — the end of the log is its to know — so the
    // input names the edited message alone.
    expect(SessionRewindEventInputSchema.parse({ type: 'session.rewind', from_seq: 4 })).toEqual({
      type: 'session.rewind',
      from_seq: 4,
    })
    expect(SessionRewindEventInputSchema.safeParse({ type: 'session.rewind' }).success).toBe(false)
    expect(
      SessionRewindEventInputSchema.safeParse({ type: 'session.rewind', from_seq: 0 }).success,
    ).toBe(false)
    // The stored shape is not the input shape: an input carrying a range names no `from_seq`.
    expect(SessionRewindEventInputSchema.safeParse(rewind).success).toBe(false)
  })

  it('travels with the edited message in one batch a client may send', () => {
    const batch = [
      { type: 'session.rewind', from_seq: 4 },
      { type: 'user.message', content: text('write a haiku about snow') },
    ]
    expect(batch.map((event) => EventInputSchema.parse(event).type)).toEqual([
      'session.rewind',
      'user.message',
    ])
    expect(EventInputSchema.safeParse({ type: 'user.interrupt' }).success).toBe(true)
  })
})

describe('user.message model switch (#111)', () => {
  it('is optional on a stored message: every pre-#111 message still parses', () => {
    const parsed = UserMessageEventSchema.parse(storedSamples['user.message'])
    expect(parsed.model).toBeUndefined()
  })

  it('carries a model when the message switches it', () => {
    const parsed = UserMessageEventSchema.parse({
      ...storedSamples['user.message'],
      model: { id: 'openai/gpt-5-mini' },
    })
    expect(parsed.model).toEqual({ id: 'openai/gpt-5-mini' })
  })

  it('travels on the input form and round-trips to the stored event', () => {
    const input = UserMessageEventInputSchema.parse({
      type: 'user.message',
      content: text('switch it up'),
      model: { id: 'openai/gpt-5-mini' },
    })
    expect(input.model).toEqual({ id: 'openai/gpt-5-mini' })
    const stored = UserMessageEventSchema.parse({
      id: eventId(),
      seq: 1,
      processed_at: null,
      ...input,
    })
    expect(stored.model).toEqual({ id: 'openai/gpt-5-mini' })
  })

  it('requires a non-empty id inside the model', () => {
    for (const model of [{}, { id: '' }, { id: 42 }, 'openai/gpt-5-mini']) {
      expect(
        UserMessageEventSchema.safeParse({ ...storedSamples['user.message'], model }).success,
        JSON.stringify(model),
      ).toBe(false)
    }
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

  it('carries missing_provider_credential, never-retried', () => {
    // The extension type (epic #65, A5): the owner has no credential for the model's
    // provider, so no model request can be made and nothing is retried. The message names
    // the provider; the retry status is pinned to `exhausted` by the schema.
    const event = {
      ...storedSamples['session.error'],
      error: {
        type: 'missing_provider_credential',
        message: 'No anthropic credential is stored for this user. Add one in Settings.',
        retry_status: { type: 'exhausted' },
      },
    }
    expect(SessionErrorTypeSchema.safeParse('missing_provider_credential').success).toBe(true)
    expect(SessionErrorEventSchema.safeParse(event).success).toBe(true)
    expect(SessionErrorSchema.parse(event.error).type).toBe('missing_provider_credential')
  })

  it('refuses to retry missing_provider_credential', () => {
    for (const retryStatus of ['retrying', 'terminal']) {
      expect(
        SessionErrorEventSchema.safeParse({
          ...storedSamples['session.error'],
          error: {
            type: 'missing_provider_credential',
            message: 'No anthropic credential is stored for this user.',
            retry_status: { type: retryStatus },
          },
        }).success,
        retryStatus,
      ).toBe(false)
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

describe('content deltas', () => {
  it('rejects a delta for an event type that cannot be previewed', () => {
    expect(
      StoredEventDeltaSchema.safeParse({
        ...storedSamples.event_delta,
        delta: { type: 'content_block_delta', index: 0, content: { type: 'text', text: 'x' } },
      }).success,
    ).toBe(false)
  })

  it('defaults its content-block index the way Anthropic’s accumulator does', () => {
    const parsed = ContentDeltaSchema.parse({
      type: 'content_delta',
      content: { type: 'text', text: 'x' },
    })
    expect(parsed.index).toBe(0)
  })

  it('rejects a negative or fractional block index', () => {
    for (const index of [-1, 0.5]) {
      expect(
        ContentDeltaSchema.safeParse({
          type: 'content_delta',
          index,
          content: { type: 'text', text: 'x' },
        }).success,
        String(index),
      ).toBe(false)
    }
  })
})

describe('StreamEventSchema', () => {
  it('accepts every stored event: since P4 the stream carries the log and nothing else', () => {
    for (const sample of Object.values(storedSamples)) {
      expect(StreamEventSchema.safeParse(sample).success, sample.type).toBe(true)
    }
  })

  it('rejects a stream-only preview: the envelope-less form was removed in P4', () => {
    const { id: _id, seq: _seq, processed_at: _processedAt, ...start } = storedSamples.event_start
    expect(StreamEventSchema.safeParse(start).success).toBe(false)
    const { event_id, delta } = storedSamples.event_delta
    expect(StreamEventSchema.safeParse({ type: 'event_delta', event_id, delta }).success).toBe(
      false,
    )
  })

  it('still rejects unknown types', () => {
    expect(
      StreamEventSchema.safeParse({ type: 'agent.tool_use', id: eventId(), seq: 1 }).success,
    ).toBe(false)
  })

  it('is the stored event union', () => {
    const stored = StreamEventSchema.parse(storedSamples['agent.message'])
    expect(isStoredEvent(stored)).toBe(true)
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

describe('claims (D9, P4)', () => {
  it('still parses without consumes and model: events stored before D9', () => {
    const parsed = ModelRequestStartEventSchema.parse(storedSamples['span.model_request_start'])
    expect(parsed.consumes).toBeUndefined()
    expect(parsed.model).toBeUndefined()
    expect(StoredEventSchema.safeParse(storedSamples['span.model_request_start']).success).toBe(
      true,
    )
  })

  it('carries consumes on a span end that answers an interrupt, and on an interrupt-idle turn', () => {
    const stopped = newEventId()
    const parsedEnd = ModelRequestEndEventSchema.parse({
      ...storedSamples['span.model_request_end'],
      is_error: true,
      error: { type: 'interrupted', message: 'Interrupted by the user.' },
      consumes: [stopped],
    })
    expect(parsedEnd.consumes).toEqual([stopped])
    const parsedIdle = SessionStatusIdleEventSchema.parse({
      ...storedSamples['session.status_idle'],
      consumes: [stopped],
    })
    expect(parsedIdle.consumes).toEqual([stopped])
  })

  it('leaves consumes off an event that claims nothing: a log stored before P4 parses', () => {
    const parsedEnd = ModelRequestEndEventSchema.parse(storedSamples['span.model_request_end'])
    expect(parsedEnd.consumes).toBeUndefined()
    const parsedIdle = SessionStatusIdleEventSchema.parse(storedSamples['session.status_idle'])
    expect(parsedIdle.consumes).toBeUndefined()
  })

  it('rejects a consumed id that is not a `sevt_` id on any of the three claim sites', () => {
    for (const consumed of ['user_01H…', 'nope']) {
      expect(
        ModelRequestEndEventSchema.safeParse({
          ...storedSamples['span.model_request_end'],
          consumes: [consumed],
        }).success,
        consumed,
      ).toBe(false)
      expect(
        SessionStatusIdleEventSchema.safeParse({
          ...storedSamples['session.status_idle'],
          consumes: [consumed],
        }).success,
        consumed,
      ).toBe(false)
    }
  })

  it('carries the user events the request claims, and the model that served it', () => {
    const first = newEventId()
    const second = newEventId()
    const parsed = ModelRequestStartEventSchema.parse({
      ...storedSamples['span.model_request_start'],
      consumes: [first, second],
      model: 'anthropic/claude-sonnet-5',
    })
    expect(parsed.consumes).toEqual([first, second])
    expect(parsed.model).toBe('anthropic/claude-sonnet-5')
  })

  it('accepts an empty consumes array, and a `provider/model` model string', () => {
    expect(
      ModelRequestStartEventSchema.safeParse({
        ...storedSamples['span.model_request_start'],
        consumes: [],
        model: 'mistral/codestral',
      }).success,
    ).toBe(true)
  })

  it('rejects a consumed id that is not a `sevt_` id', () => {
    for (const consumed of ['user_01H…', 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7', 'nope']) {
      expect(
        ModelRequestStartEventSchema.safeParse({
          ...storedSamples['span.model_request_start'],
          consumes: [consumed],
        }).success,
        consumed,
      ).toBe(false)
    }
  })

  it('rejects a model that is not a non-empty string', () => {
    for (const model of ['', 42, null]) {
      expect(
        ModelRequestStartEventSchema.safeParse({
          ...storedSamples['span.model_request_start'],
          model,
        }).success,
        String(model),
      ).toBe(false)
    }
  })
})

describe('supersedes (D9)', () => {
  it('accepts a range on the message that replaces its chunks', () => {
    const parsed = AgentMessageEventSchema.parse({
      ...storedSamples['agent.message'],
      supersedes: { from_seq: 10, to_seq: 14 },
    })
    expect(parsed.supersedes).toEqual({ from_seq: 10, to_seq: 14 })
  })

  it('accepts a range on the span end that closes a request without a message', () => {
    for (const error of [undefined, { type: 'interrupted' }, { type: 'brain_lost' }]) {
      expect(
        ModelRequestEndEventSchema.safeParse({
          ...storedSamples['span.model_request_end'],
          supersedes: { from_seq: 7, to_seq: 7 },
          ...(error === undefined ? {} : { is_error: true, error }),
        }).success,
        error?.type ?? 'no error',
      ).toBe(true)
    }
  })

  it('accepts a single-event range: a request that streamed no text supersedes its start', () => {
    expect(SupersedesSchema.safeParse({ from_seq: 5, to_seq: 5 }).success).toBe(true)
  })

  it('rejects a range whose from_seq is after its to_seq', () => {
    expect(SupersedesSchema.safeParse({ from_seq: 9, to_seq: 3 }).success).toBe(false)
    expect(
      StoredEventSchema.safeParse({
        ...storedSamples['agent.message'],
        supersedes: { from_seq: 9, to_seq: 3 },
      }).success,
    ).toBe(false)
    expect(
      ModelRequestEndEventSchema.safeParse({
        ...storedSamples['span.model_request_end'],
        supersedes: { from_seq: 9, to_seq: 3 },
      }).success,
    ).toBe(false)
  })

  it('rejects a seq bound that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(
        SupersedesSchema.safeParse({ from_seq: bad, to_seq: 4 }).success,
        `from_seq ${bad}`,
      ).toBe(false)
      expect(
        SupersedesSchema.safeParse({ from_seq: 1, to_seq: bad }).success,
        `to_seq ${bad}`,
      ).toBe(false)
    }
  })

  it('leaves supersedes off events that supersede nothing: pre-D9 events still parse', () => {
    expect(StoredEventSchema.safeParse(storedSamples['agent.message']).success).toBe(true)
    const parsed = AgentMessageEventSchema.parse(storedSamples['agent.message'])
    expect(parsed.supersedes).toBeUndefined()
  })
})

describe('stored chunks (D9)', () => {
  it('parses a stored event_start as a stored event', () => {
    const parsed = StoredEventSchema.parse(storedSamples.event_start)
    expect(parsed.type).toBe('event_start')
    expect(StoredEventStartSchema.safeParse(storedSamples.event_start).success).toBe(true)
    expect(parsed.type === 'event_start' && parsed.event.id).toBe(
      storedSamples.event_start.event.id,
    )
  })

  it('parses a stored event_delta as a stored event', () => {
    const parsed = StoredEventSchema.parse(storedSamples.event_delta)
    expect(parsed.type).toBe('event_delta')
    expect(StoredEventDeltaSchema.safeParse(storedSamples.event_delta).success).toBe(true)
    expect(parsed.type === 'event_delta' && parsed.event_id).toBe(
      storedSamples.event_delta.event_id,
    )
    expect(parsed.type === 'event_delta' && parsed.delta.content.text).toBe('Here')
  })

  it('rejects a chunk without the stored envelope: there is no preview form left', () => {
    const { id: _id, seq: _seq, processed_at: _processedAt, ...start } = storedSamples.event_start
    expect(StoredEventSchema.safeParse(start).success).toBe(false)
    expect(StreamEventSchema.safeParse(start).success).toBe(false)
  })

  it('carries the chunk as a stored event of the stream union', () => {
    for (const sample of [storedSamples.event_start, storedSamples.event_delta]) {
      expect(StreamEventSchema.safeParse(sample).success, sample.type).toBe(true)
      expect(isStoredEvent(StreamEventSchema.parse(sample))).toBe(true)
    }
  })
})

describe('the readonly event types (D9)', () => {
  it('makes a stored event and everything inside it readonly', () => {
    const event: StoredEvent = StoredEventSchema.parse(storedSamples['agent.message'])

    // Each assignment below is a compile error — the `@ts-expect-error` is what proves it.
    // They run against a throwaway parsed value, so nothing here is frozen or observed.
    // @ts-expect-error — `seq` is readonly: a stored event is never renumbered
    event.seq = 2
    // @ts-expect-error — `id` is readonly, and it is still the branded `EventId`
    event.id = newEventId()
    if (event.type === 'agent.message') {
      // @ts-expect-error — nested fields are readonly: the text of an event never changes
      event.content[0]!.text = 'rewritten'
      // @ts-expect-error — and so is the array: content cannot be replaced block by block
      event.content[0] = { type: 'text', text: 'appended' }
      // @ts-expect-error — a `supersedes` range is readonly through and through
      event.supersedes = { from_seq: 1, to_seq: 2 }
    }

    expect(event.type).toBe('agent.message')
  })

  it('makes every event member and every domain sub-union readonly', () => {
    const message: UserMessageEvent = UserMessageEventSchema.parse(storedSamples['user.message'])
    // @ts-expect-error — a user event's `processed_at` is derived, never written by a reader
    message.processed_at = '2026-03-15T10:00:00Z'
    // @ts-expect-error — the content blocks are readonly through the union too
    message.content = []

    const unionEvent: UserEvent = UserEventSchema.parse(storedSamples['user.interrupt'])
    // @ts-expect-error — the domain sub-unions are the readonly members
    unionEvent.seq = 9

    const start: StoredEventStart = StoredEventStartSchema.parse(storedSamples.event_start)
    // @ts-expect-error — a stored chunk is as immutable as any other event
    start.event.id = newEventId()

    const end: ModelRequestEndEvent = ModelRequestEndEventSchema.parse(
      storedSamples['span.model_request_end'],
    )
    // @ts-expect-error — so is a span end
    end.is_error = true
    const idle: SessionStatusIdleEvent = SessionStatusIdleEventSchema.parse(
      storedSamples['session.status_idle'],
    )
    // @ts-expect-error — and a status event
    idle.stop_reason = { type: 'end_turn' }

    expect(message.type).toBe('user.message')
  })

  it('keeps branded ids usable: DeepReadonly must not turn `EventId` into an object', () => {
    const event: UserMessageEvent = UserMessageEventSchema.parse(storedSamples['user.message'])
    const id: EventId = event.id
    expect(id).toBe(storedSamples['user.message'].id)

    const typed: AgentMessageEvent = AgentMessageEventSchema.parse(storedSamples['agent.message'])
    expect(typed.content.map((block) => block.text)).toEqual(['hi'])
  })
})
