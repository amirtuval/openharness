import { describe, expect, it } from 'vitest'

import {
  AgentSchema,
  EventDeltaSchema,
  EventStartSchema,
  ModelRequestEndEventSchema,
  ModelRequestStartEventSchema,
  SendEventsRequestSchema,
  SendEventsResponseSchema,
  SessionEventSchema,
  SessionSchema,
  StoredEventDeltaSchema,
  StoredEventSchema,
  StoredEventStartSchema,
  StreamEventSchema,
  UserEventSchema,
  UserMessageEventSchema,
} from '../index'
import {
  FIXTURE_MODEL_USAGE,
  fixtureTimestamp,
  makeAgent,
  makeAgentMessage,
  makeContentDelta,
  makeEventDelta,
  makeEventStart,
  makeModelRequestEnd,
  makeModelRequestStart,
  makeSession,
  makeSessionAgent,
  makeSessionError,
  makeStatusIdle,
  makeStatusRescheduled,
  makeStatusRunning,
  makeStoredEventDelta,
  makeStoredEventStart,
  makeUserInterrupt,
  makeUserMessage,
  sampleAgent,
  sampleSession,
  sampleSessionHistory,
  sampleStreamPreview,
} from './index'

describe('fixture builders', () => {
  it('build resources that parse', () => {
    expect(AgentSchema.safeParse(makeAgent()).success).toBe(true)
    expect(AgentSchema.safeParse(sampleAgent).success).toBe(true)
    expect(SessionSchema.safeParse(makeSession()).success).toBe(true)
    expect(SessionSchema.parse(sampleSession).agent).toEqual(sampleSession.agent)
    expect(sampleSession.agent.id).toBe(sampleAgent.id)
  })

  it('build every stored event type so that it parses against its schema', () => {
    const start = makeModelRequestStart()
    const previewed = makeUserMessage('hi').id
    const built = [
      makeUserMessage('hi'),
      makeUserInterrupt(),
      makeAgentMessage('hi'),
      makeStatusRunning(),
      makeStatusIdle(),
      makeStatusRescheduled(),
      makeSessionError(),
      start,
      makeModelRequestEnd(start),
      makeStoredEventStart(previewed),
      makeStoredEventDelta(previewed, 'fragment'),
    ]
    for (const event of built) {
      expect(StoredEventSchema.safeParse(event).success, event.type).toBe(true)
      expect(StreamEventSchema.safeParse(event).success, event.type).toBe(true)
    }
    expect(built).toHaveLength(11)
  })

  it('build stream-only events that parse', () => {
    const id = makeUserMessage('hi').id
    expect(EventStartSchema.safeParse(makeEventStart(id)).success).toBe(true)
    expect(EventDeltaSchema.safeParse(makeEventDelta(id, 'fragment')).success).toBe(true)
    expect(makeEventDelta(id, 'fragment').delta.content.text).toBe('fragment')
    expect(makeContentDelta('fragment', { index: 2 }).index).toBe(2)
  })

  it('build stored chunks that parse, previewing the same id as the stream-only ones', () => {
    const previewed = makeUserMessage('hi').id
    const start = makeStoredEventStart(previewed)
    const delta = makeStoredEventDelta(previewed, 'fragment')

    expect(StoredEventStartSchema.safeParse(start).success).toBe(true)
    expect(StoredEventDeltaSchema.safeParse(delta).success).toBe(true)
    // The envelope id is the chunk's own; `event.id` / `event_id` is the previewed message.
    expect(start.id).not.toBe(previewed)
    expect(start.event.id).toBe(previewed)
    expect(delta.event_id).toBe(previewed)
    // The stored chunk is the preview plus the envelope: dropping the envelope parses it as
    // the stream-only form of the same event.
    expect(EventStartSchema.safeParse(start).success).toBe(true)
    expect(EventDeltaSchema.safeParse(delta).success).toBe(true)
    expect(delta.delta.content.text).toBe('fragment')
  })

  it('carries the D9 fields on the events they belong to', () => {
    const consumed = makeUserMessage('hi').id
    const start = makeModelRequestStart({
      consumes: [consumed],
      model: 'anthropic/claude-sonnet-5',
    })
    expect(start.consumes).toEqual([consumed])
    expect(start.model).toBe('anthropic/claude-sonnet-5')

    const message = makeAgentMessage('hi', { supersedes: { from_seq: 10, to_seq: 14 } })
    expect(message.supersedes).toEqual({ from_seq: 10, to_seq: 14 })

    const end = makeModelRequestEnd(makeModelRequestStart(), {
      supersedes: { from_seq: 10, to_seq: 14 },
    })
    expect(end.supersedes).toEqual({ from_seq: 10, to_seq: 14 })
  })

  it('assigns increasing seq numbers to events built in order', () => {
    const first = makeUserMessage('one')
    const second = makeUserMessage('two')
    expect(second.seq).toBe(first.seq + 1)
  })

  it('applies overrides', () => {
    expect(makeUserMessage('hi', { seq: 99 }).seq).toBe(99)
    expect(makeStatusIdle({ processed_at: '2026-03-15T10:00:00Z' }).stop_reason).toEqual({
      type: 'end_turn',
    })
    expect(makeSessionError().error.retry_status.type).toBe('retrying')
    expect(makeModelRequestEnd(makeModelRequestStart()).model_usage).toEqual(FIXTURE_MODEL_USAGE)
  })

  it('routes each built event to the union for its domain', () => {
    expect(UserEventSchema.safeParse(makeUserMessage('hi')).success).toBe(true)
    expect(SessionEventSchema.safeParse(makeStatusIdle()).success).toBe(true)
    expect(ModelRequestStartEventSchema.safeParse(makeModelRequestStart()).success).toBe(true)
    expect(
      ModelRequestEndEventSchema.safeParse(makeModelRequestEnd(makeModelRequestStart())).success,
    ).toBe(true)
  })

  it('formats timestamps the way the API does', () => {
    expect(fixtureTimestamp()).toBe('2026-03-15T10:00:00.000Z')
    expect(fixtureTimestamp(60)).toBe('2026-03-15T10:01:00.000Z')
  })

  it('builds a session agent that fits inside a session', () => {
    expect(SessionSchema.parse(makeSession({ agent: makeSessionAgent() })).agent.name).toBe(
      'Summarizer',
    )
  })
})

describe('sampleSessionHistory', () => {
  it('parses end to end, every event against the stored-event union', () => {
    expect(sampleSessionHistory.length).toBeGreaterThan(0)
    for (const event of sampleSessionHistory) {
      expect(StoredEventSchema.safeParse(event).success, `${event.type}@${event.seq}`).toBe(true)
    }
  })

  it('numbers seq from 1, without gaps or repeats', () => {
    expect(sampleSessionHistory.map((event) => event.seq)).toEqual(
      sampleSessionHistory.map((_event, index) => index + 1),
    )
  })

  it('tells a full turn: running, a model request, the reply, the usage, idle', () => {
    expect(sampleSessionHistory.slice(0, 6).map((event) => event.type)).toEqual([
      'session.status_running',
      'user.message',
      'span.model_request_start',
      'agent.message',
      'span.model_request_end',
      'session.status_idle',
    ])
  })

  it('carries a steering message the running turn picks up', () => {
    const steering = sampleSessionHistory[7]
    expect(steering?.type).toBe('user.message')
    expect(sampleSessionHistory[6]?.type).toBe('session.status_running')
    expect(steering?.processed_at).not.toBeNull()
  })

  it('carries an interrupt: partial text kept, span closed with an error, turn still end_turn', () => {
    const interruptIndex = sampleSessionHistory.findIndex(
      (event) => event.type === 'user.interrupt',
    )
    expect(interruptIndex).toBeGreaterThan(0)
    const interrupt = sampleSessionHistory[interruptIndex]
    expect(interrupt?.processed_at).not.toBeNull()

    // The partial reply the interrupt cut short is stored, right after the interrupt.
    expect(sampleSessionHistory[interruptIndex + 1]?.type).toBe('agent.message')

    const end = sampleSessionHistory[interruptIndex + 2]
    expect(end?.type).toBe('span.model_request_end')
    expect(end?.type === 'span.model_request_end' && end.error?.type).toBe('interrupted')
    expect(end?.type === 'span.model_request_end' && end.is_error).toBe(true)

    // The turn ends with a normal stop reason: there is no interrupt-specific one.
    const idle = sampleSessionHistory[interruptIndex + 3]
    expect(idle?.type).toBe('session.status_idle')
    expect(idle?.type === 'session.status_idle' && idle.stop_reason.type).toBe('end_turn')
  })

  it('carries a retried error: error, rescheduled, running again, then success', () => {
    const errorIndex = sampleSessionHistory.findIndex((event) => event.type === 'session.error')
    expect(errorIndex).toBeGreaterThan(0)
    expect(
      sampleSessionHistory.slice(errorIndex, errorIndex + 3).map((event) => event.type),
    ).toEqual(['session.error', 'session.status_rescheduled', 'session.status_running'])
    const error = sampleSessionHistory[errorIndex]
    expect(error?.type === 'session.error' && error.error.retry_status.type).toBe('retrying')

    // The failed model request closed its own span with an error before the session error.
    expect(sampleSessionHistory[errorIndex - 1]?.type).toBe('span.model_request_end')

    // The retry succeeds and the turn ends normally.
    expect(sampleSessionHistory.at(-2)?.type).toBe('session.status_running')
    expect(sampleSessionHistory.at(-1)?.type).toBe('user.message')
  })

  it('ends with a queued user message: sent, not yet processed', () => {
    const last = sampleSessionHistory.at(-1)
    expect(last?.type).toBe('user.message')
    expect(last?.processed_at).toBeNull()
  })

  it('is a valid history to send: every user event is a valid input', () => {
    const inputs = sampleSessionHistory
      .filter((event) => event.type.startsWith('user.'))
      .map((event) =>
        event.type === 'user.message'
          ? { type: event.type, content: event.content }
          : { type: event.type },
      )
    expect(SendEventsRequestSchema.safeParse({ events: inputs }).success).toBe(true)
  })

  it('returns stored user events the way the send endpoint does', () => {
    const userEvents = sampleSessionHistory.filter(
      (event) => event.type === 'user.message' || event.type === 'user.interrupt',
    )
    expect(SendEventsResponseSchema.safeParse({ data: userEvents }).success).toBe(true)
    expect(UserMessageEventSchema.safeParse(userEvents[0]).success).toBe(true)
  })
})

describe('sampleStreamPreview', () => {
  it('parses as stream events', () => {
    for (const event of sampleStreamPreview) {
      expect(StreamEventSchema.safeParse(event).success, event.type).toBe(true)
    }
  })

  it('previews the stored message under the same event id', () => {
    const start = sampleStreamPreview[0]
    const message = sampleStreamPreview.at(-1)
    expect(start?.type).toBe('event_start')
    expect(message?.type).toBe('agent.message')

    const previewedId = start?.type === 'event_start' ? start.event.id : undefined
    expect(message?.type === 'agent.message' ? message.id : undefined).toBe(previewedId)

    for (const event of sampleStreamPreview.slice(1, -1)) {
      expect(event.type).toBe('event_delta')
      expect(event.type === 'event_delta' ? event.event_id : undefined).toBe(previewedId)
    }
  })

  it('previews an event that really is in the sample history', () => {
    // The preview is only useful if the client can reconcile it: the `event_start` id must be
    // the id of a stored event in the history, and the stored event must be the same one.
    const start = sampleStreamPreview[0]
    if (start?.type !== 'event_start') {
      throw new Error('sampleStreamPreview must open with an event_start')
    }

    const stored = sampleSessionHistory.find(
      (event) => event.type === 'agent.message' && event.id === start.event.id,
    )
    expect(stored).toBe(sampleStreamPreview.at(-1))
  })

  it('accumulates its deltas into a prefix of the stored text', () => {
    const message = sampleStreamPreview.at(-1)
    const deltas = sampleStreamPreview.filter((event) => event.type === 'event_delta')
    const accumulated = deltas
      .map((event) => (event.type === 'event_delta' ? event.delta.content.text : ''))
      .join('')
    const storedText =
      message?.type === 'agent.message'
        ? message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
        : ''
    expect(storedText.startsWith(accumulated)).toBe(true)
  })
})
