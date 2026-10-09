import { EVENT_TYPES } from '@openharness/protocol'
import type { EventId, SessionId, StoredEvent } from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

import type { Logger } from '../types'
import type { AttributeValue, Span, Tracer } from './tracing'

/**
 * Spans built from the session log (issue #158).
 *
 * The event log is already the trace of a conversation: a turn brackets its model requests, a
 * `span.model_request_start`/`_end` pair brackets each request with its token usage, and the
 * status events delimit the turn. Cloud Trace wants the same shape as spans, so this turns the
 * log into them, one turn span per `session.status_running`…`session.status_idle` and one child
 * span per model request.
 *
 * The log is fed in through {@link withSessionTraces}, which wraps the store's `appendEvents`:
 * whatever a brain writes — here or on another instance, since the spans are built from the
 * events as they are appended — becomes a span. Nothing is read back and nothing is stored:
 * a span lives only as long as the export it produces.
 *
 * **Tool calls are not traced, because v1 has none.** `hands` is unused and the protocol has no
 * tool-call event (`agent.tool_use` is a real Anthropic type this subset does not store); when
 * one lands, it is one more case here, with the turn span as its parent.
 *
 * A span is opened when its start event is appended and closed when its end event is: an
 * append that never arrives (a brain that died mid-request) leaves the span open, which is what
 * Cloud Trace shows for an unfinished operation. The map is keyed per session and an open
 * request is dropped when its end arrives or its session's next turn begins.
 */
export class SessionTraces {
  /** Per session: the open turn, and the model requests inside it, keyed by their start event. */
  readonly #open = new Map<SessionId, { turn: Span | undefined; requests: Map<EventId, Span> }>()

  constructor(
    private readonly tracer: Tracer,
    private readonly logger: Logger,
  ) {}

  /**
   * Record the events of one append as spans.
   *
   * Events are taken in the order they were stored, so a `span.model_request_start` and the
   * `span.model_request_end` that closes it are handled in the order the log holds them, even
   * when a store returns a whole batch at once. A span call that throws is logged and dropped:
   * tracing is never allowed to fail a write that already succeeded.
   */
  record(sessionId: SessionId, events: readonly StoredEvent[]): void {
    try {
      for (const event of events) {
        this.#recordOne(sessionId, event)
      }
    } catch (error) {
      this.logger.error('recording session spans failed', error)
    }
  }

  #recordOne(sessionId: SessionId, event: StoredEvent): void {
    switch (event.type) {
      case EVENT_TYPES.sessionStatusRunning:
        this.#startTurn(sessionId)
        break
      case EVENT_TYPES.sessionStatusIdle:
        this.#endTurn(sessionId, true)
        break
      case EVENT_TYPES.sessionStatusRescheduled:
        // A retry keeps the same turn open: the reschedule is a pause inside it, not a new one.
        break
      case EVENT_TYPES.modelRequestStart:
        this.#startRequest(sessionId, event.id, event.model)
        break
      case EVENT_TYPES.modelRequestEnd:
        this.#endRequest(sessionId, event)
        break
      default:
        break
    }
  }

  /** Open a turn span, closing one a previous turn left open (a brain that died mid-turn). */
  #startTurn(sessionId: SessionId): void {
    const state = this.#state(sessionId)
    if (state.turn !== undefined) {
      state.turn.end()
    }
    state.turn = this.tracer.startSpan('session.turn', {
      kind: 'internal',
      attributes: { 'session.id': sessionId },
    })
  }

  #endTurn(sessionId: SessionId, ok: boolean): void {
    const state = this.#open.get(sessionId)
    if (state?.turn === undefined) {
      return
    }
    state.turn.setStatus(ok)
    state.turn.end()
    state.turn = undefined
    // Nothing is streaming once a turn is idle, so any request span still open belongs to a
    // turn that never closed it; end it too rather than let it dangle for the process's life.
    for (const [, span] of state.requests) {
      span.setStatus(false)
      span.end()
    }
    state.requests.clear()
  }

  #startRequest(sessionId: SessionId, eventId: EventId, model: string | undefined): void {
    const state = this.#state(sessionId)
    const attributes: Record<string, AttributeValue> = { 'session.id': sessionId }
    if (model !== undefined) {
      attributes['gen_ai.request.model'] = model
    }
    state.requests.set(
      eventId,
      this.tracer.startSpan('model_request', {
        kind: 'internal',
        attributes,
        // The turn is the request's parent, so a conversation's requests nest under it.
        parent: state.turn ?? null,
      }),
    )
  }

  #endRequest(
    sessionId: SessionId,
    event: StoredEvent & { type: typeof EVENT_TYPES.modelRequestEnd },
  ): void {
    const state = this.#open.get(sessionId)
    const span = state?.requests.get(event.model_request_start_id)
    if (state === undefined || span === undefined) {
      // No start in this process's view: the log tail began mid-request, or the append that
      // opened it was never seen. There is nothing to close, so nothing is written.
      return
    }
    state.requests.delete(event.model_request_start_id)
    const usage = event.model_usage
    span.setAttribute('gen_ai.usage.input_tokens', usage.input_tokens)
    span.setAttribute('gen_ai.usage.output_tokens', usage.output_tokens)
    span.setAttribute('gen_ai.usage.cache_read.input_tokens', usage.cache_read_input_tokens)
    span.setAttribute('gen_ai.usage.cache_creation.input_tokens', usage.cache_creation_input_tokens)
    span.setAttribute('gen_ai.response.model_request_start_id', event.model_request_start_id)
    if (event.is_error === true) {
      const reason = event.error?.type ?? 'model_error'
      span.setAttribute('error.type', reason)
      span.setStatus(false)
      span.recordError(new Error(event.error?.message ?? reason))
    } else {
      span.setStatus(true)
    }
    span.end()
  }

  #state(sessionId: SessionId): { turn: Span | undefined; requests: Map<EventId, Span> } {
    let state = this.#open.get(sessionId)
    if (state === undefined) {
      state = { turn: undefined, requests: new Map() }
      this.#open.set(sessionId, state)
    }
    return state
  }
}

/** The `appendEvents` of a store, before wrapping: what {@link withSessionTraces} calls through. */
type AppendEvents = SessionStore['appendEvents']

/**
 * A store whose every append is also recorded as spans.
 *
 * Only `appendEvents` is intercepted; every other call goes straight to the store, so this
 * changes nothing about how the server uses it. A proxy is used rather than a hand-written
 * delegate because `SessionStore` has thirty methods and forwarding them by hand would be
 * thirty places to forget one. It is applied only when tracing is on ({@link Tracer.enabled}),
 * so an untraced server passes its store around unchanged.
 *
 * `createSession`'s `initial_events` are not seen here — they are stored inside the creation
 * transaction — so a session created with events gets its first turn's span only from the
 * model requests appended after it. That is a boundary, not a loss of the request spans.
 *
 * @param store the store to wrap
 * @param traces the recorder the appended events are handed to
 */
export function withSessionTraces(store: SessionStore, traces: SessionTraces): SessionStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'appendEvents') {
        const append = target.appendEvents.bind(target)
        return async (
          sessionId: Parameters<AppendEvents>[0],
          events: Parameters<AppendEvents>[1],
          options?: Parameters<AppendEvents>[2],
        ) => {
          const stored = await append(sessionId, events, options)
          traces.record(sessionId, stored)
          return stored
        }
      }
      const value = Reflect.get(target, property, receiver) as unknown
      return typeof value === 'function'
        ? (value as (...args: readonly unknown[]) => unknown).bind(target)
        : value
    },
  })
}
