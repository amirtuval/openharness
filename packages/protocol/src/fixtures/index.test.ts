import { describe, expect, it } from 'vitest'

import {
  AgentSchema,
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

  it('build content deltas that parse', () => {
    expect(makeContentDelta('fragment').index).toBe(0)
    expect(makeContentDelta('fragment', { index: 2 }).index).toBe(2)
    expect(makeContentDelta('fragment').content.text).toBe('fragment')
  })

  it('build stored chunks that parse, announced by the stream for the same id', () => {
    const previewed = makeUserMessage('hi').id
    const start = makeStoredEventStart(previewed)
    const delta = makeStoredEventDelta(previewed, 'fragment')

    expect(StoredEventStartSchema.safeParse(start).success).toBe(true)
    expect(StoredEventDeltaSchema.safeParse(delta).success).toBe(true)
    // The envelope id is the chunk's own; `event.id` / `event_id` is the previewed message.
    expect(start.id).not.toBe(previewed)
    expect(start.event.id).toBe(previewed)
    expect(delta.event_id).toBe(previewed)
    expect(delta.delta.content.text).toBe('fragment')
  })

  it('carries the D9 claim fields on the events they belong to', () => {
    const consumed = makeUserMessage('hi').id
    const start = makeModelRequestStart({
      consumes: [consumed],
      model: 'anthropic/claude-sonnet-5',
    })
    expect(start.consumes).toEqual([consumed])
    expect(start.model).toBe('anthropic/claude-sonnet-5')

    const end = makeModelRequestEnd(start, {
      consumes: [consumed],
      is_error: true,
      error: { type: 'interrupted', message: 'Interrupted by the user.' },
    })
    expect(end.consumes).toEqual([consumed])

    const idle = makeStatusIdle({ consumes: [consumed] })
    expect(idle.consumes).toEqual([consumed])
  })

  it('carries a supersedes range on the events that replace chunks', () => {
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

describe('sampleSessionHistory claims', () => {
  it('claims every processed user message in the consumes list of the request that answers it', () => {
    // The request claims exactly the messages queued before it: the retry of a failed request
    // claims none, because the message was already claimed by the attempt that failed.
    let queued: string[] = []
    for (const event of sampleSessionHistory) {
      if (event.type === 'user.message') {
        queued.push(event.id)
      } else if (event.type === 'span.model_request_start') {
        expect(event.consumes, `span at seq ${event.seq}`).toEqual(queued)
        queued = []
      }
    }
    // The last message is unclaimed: the brain has not reached it yet.
    expect(queued).toHaveLength(1)
  })

  it('claims the interrupt on the span end that closed the request it stopped', () => {
    const interrupt = sampleSessionHistory.find((event) => event.type === 'user.interrupt')
    if (interrupt?.type !== 'user.interrupt') {
      throw new Error('sampleSessionHistory must contain a user.interrupt')
    }
    const end = sampleSessionHistory.find(
      (event) => event.type === 'span.model_request_end' && event.error?.type === 'interrupted',
    )
    expect(end?.type === 'span.model_request_end' && end.consumes).toEqual([interrupt.id])
  })

  it('builds a chunk stream for the first reply, under the message it announces', () => {
    // The stored chunks a client following the reply live would see: a stream whose events are
    // all stored, announcing the id of the `agent.message` the history carries.
    const message = sampleSessionHistory.find((event) => event.type === 'agent.message')
    if (message?.type !== 'agent.message') {
      throw new Error('sampleSessionHistory must contain an agent.message')
    }
    const text = message.content.map((block) => block.text).join('')
    const third = Math.ceil(text.length / 3)
    const fragments = [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)]
    const chunks = [
      makeStoredEventStart(message.id),
      ...fragments
        .filter((fragment) => fragment.length > 0)
        .map((fragment) => makeStoredEventDelta(message.id, fragment)),
    ]
    for (const chunk of chunks) {
      expect(StreamEventSchema.safeParse(chunk).success, chunk.type).toBe(true)
    }
    const accumulated = chunks
      .filter((chunk) => chunk.type === 'event_delta')
      .map((chunk) => chunk.delta.content.text)
      .join('')
    expect(text.startsWith(accumulated)).toBe(true)
  })
})
