import { newEventId, newSessionId } from '@openharness/protocol'
import {
  makeModelRequestEnd,
  makeModelRequestStart,
  makeStatusIdle,
  makeStatusRescheduled,
  makeStatusRunning,
} from '@openharness/protocol/fixtures'
import type { SessionId, StoredEvent } from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { silentLogger } from '../types'
import { SessionTraces, withSessionTraces } from './session-traces'
import type { Span, StartSpanOptions, Tracer } from './tracing'

/** A span a test can read back. */
interface RecordedSpan {
  readonly name: string
  readonly options: StartSpanOptions | undefined
  readonly attributes: Record<string, string | number | boolean>
  ended: boolean
  status: boolean | undefined
  errors: unknown[]
}

/** A {@link Tracer} that records spans instead of exporting them. */
class RecordingTracer implements Tracer {
  readonly enabled = true

  readonly spans: RecordedSpan[] = []

  startSpan(name: string, options?: StartSpanOptions): Span {
    const attributes: Record<string, string | number | boolean> = { ...options?.attributes }
    const recorded: RecordedSpan = {
      name,
      options,
      attributes,
      ended: false,
      status: undefined,
      errors: [],
    }
    this.spans.push(recorded)
    // Each span gets its own ids, so a child's parent is distinguishable from its grandparent.
    const index = this.spans.length
    return {
      traceId: 'a'.repeat(32),
      spanId: index.toString(16).padStart(16, '0'),
      sampled: true,
      setAttribute: (key, value) => {
        attributes[key] = value
      },
      setStatus: (ok) => {
        recorded.status = ok
      },
      recordError: (error) => {
        recorded.errors.push(error)
      },
      end: () => {
        recorded.ended = true
      },
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

/** Run a list of stored events through a fresh recorder and hand back both. */
function record(events: readonly StoredEvent[], sessionId: SessionId = newSessionId()) {
  const tracer = new RecordingTracer()
  const traces = new SessionTraces(tracer, silentLogger)
  traces.record(sessionId, events)
  return { tracer, sessionId }
}

describe('SessionTraces', () => {
  it('opens a turn span and a child model-request span, closed with their usage', () => {
    const start = makeModelRequestStart({ model: 'openai/gpt-4o' })
    const { tracer } = record([
      makeStatusRunning(),
      start,
      makeModelRequestEnd(start, {
        model_usage: {
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 2,
          input_tokens: 42,
          output_tokens: 17,
        },
      }),
      makeStatusIdle(),
    ])

    expect(tracer.spans.map((span) => span.name)).toEqual(['session.turn', 'model_request'])
    const [turn, request] = tracer.spans
    expect(turn?.attributes['session.id']).toBeDefined()
    expect(turn?.ended).toBe(true)
    expect(turn?.status).toBe(true)
    // The request is a child of the turn, not a second root: the parent it was started with
    // is the turn span's own context.
    expect(request?.options?.parent).toMatchObject({
      traceId: 'a'.repeat(32),
      spanId: '0000000000000001',
    })
    expect(request?.attributes).toMatchObject({
      'gen_ai.request.model': 'openai/gpt-4o',
      'gen_ai.usage.input_tokens': 42,
      'gen_ai.usage.output_tokens': 17,
      'gen_ai.usage.cache_read.input_tokens': 2,
      'gen_ai.usage.cache_creation.input_tokens': 1,
    })
    expect(request?.ended).toBe(true)
    expect(request?.status).toBe(true)
  })

  it('marks a failed request with its reason, and ends the span', () => {
    const start = makeModelRequestStart()
    const { tracer } = record([
      makeStatusRunning(),
      start,
      makeModelRequestEnd(start, {
        is_error: true,
        error: { type: 'model_error', message: 'the provider said no' },
      }),
    ])
    const request = tracer.spans[1]
    expect(request?.status).toBe(false)
    expect(request?.attributes['error.type']).toBe('model_error')
    expect(request?.errors).toHaveLength(1)
    expect(request?.ended).toBe(true)
  })

  it('keeps one turn open across a reschedule, and closes it on idle', () => {
    const first = makeModelRequestStart()
    const { tracer } = record([
      makeStatusRunning(),
      first,
      makeModelRequestEnd(first),
      makeStatusRescheduled(),
      makeModelRequestStart(),
      makeStatusIdle(),
    ])
    // One turn, two model requests — the reschedule is a pause inside the turn, not a new one.
    expect(tracer.spans.filter((span) => span.name === 'session.turn')).toHaveLength(1)
    expect(tracer.spans.filter((span) => span.name === 'model_request')).toHaveLength(2)
  })

  it('closes a request a turn left open rather than letting it dangle', () => {
    const { tracer } = record([makeStatusRunning(), makeModelRequestStart(), makeStatusIdle()])
    const request = tracer.spans[1]
    expect(request?.ended).toBe(true)
    expect(request?.status).toBe(false)
  })

  it('ignores an end whose start it never saw', () => {
    const start = makeModelRequestStart()
    const orphan = { ...makeModelRequestEnd(start), model_request_start_id: newEventId() }
    const tracer = new RecordingTracer()
    const traces = new SessionTraces(tracer, silentLogger)
    // Recording the orphan end must not throw and must not open a span of its own.
    expect(() => traces.record(newSessionId(), [orphan as StoredEvent])).not.toThrow()
    expect(tracer.spans).toHaveLength(0)
  })
})

describe('withSessionTraces', () => {
  it('records an append, and forwards every other call untouched', async () => {
    const sessionId = newSessionId()
    const start = makeModelRequestStart()
    const stored = [
      makeStatusRunning(),
      start,
      makeModelRequestEnd(start),
    ] as readonly StoredEvent[]
    const appended: unknown[] = []
    let getSessionCalls = 0
    const inner = {
      appendEvents: (id: SessionId, events: unknown) => {
        appended.push([id, events])
        return Promise.resolve(stored)
      },
      getSession: () => {
        getSessionCalls += 1
        return Promise.resolve(null)
      },
    } as unknown as SessionStore

    const tracer = new RecordingTracer()
    const store = withSessionTraces(inner, new SessionTraces(tracer, silentLogger))

    const answer = await store.appendEvents(sessionId, [])
    expect(answer).toBe(stored)
    expect(appended).toEqual([[sessionId, []]])
    expect(tracer.spans.map((span) => span.name)).toEqual(['session.turn', 'model_request'])

    // The proxy is transparent: an untouched method reaches the store and answers its value.
    expect(await store.getSession(sessionId, { ownerId: 'user_1' })).toBeNull()
    expect(getSessionCalls).toBe(1)
  })
})
