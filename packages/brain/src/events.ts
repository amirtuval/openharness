import type { AppendableEvent } from '@openharness/session'
import type {
  EventId,
  ModelUsage,
  SessionError,
  SpanError,
  Supersedes,
} from '@openharness/protocol'
import { EVENT_TYPES } from '@openharness/protocol'

/**
 * The events a turn appends, built in one place.
 *
 * Every event the loop writes carries only the fields the caller owns — the store assigns `id`,
 * `seq` and `processed_at` — so these builders are what keeps the wire shapes in one file
 * instead of spread over the loop's branches. The exact order they are written in is the
 * lifecycle the package documents; these are just the pieces.
 *
 * Since D9 (issue #46) three of the pieces carry more than their own payload: the span start
 * lists the user events it claims (`consumes`) and the model that served it, the chunks of a
 * reply are stored events of their own, and the event that finishes a reply `supersedes` the
 * chunk range it replaces.
 */

/** The agent started working. Opens a turn. */
export function statusRunning(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRunning }
}

/**
 * The agent finished its turn. Closes one, whatever the reason.
 *
 * `consumes` claims the queued `user.interrupt` events the turn is ending on (P4): an
 * interrupt that arrived with no model request running — before the turn opened, between two
 * requests, or during a backoff — has no span start to claim it, so the `session.status_idle`
 * that ends the turn does. Omitted when the list is empty: a turn that ends on its own claims
 * nothing.
 */
export function statusIdle(consumes?: readonly EventId[]): AppendableEvent {
  return {
    type: EVENT_TYPES.sessionStatusIdle,
    stop_reason: { type: 'end_turn' },
    ...(consumes === undefined || consumes.length === 0 ? {} : { consumes: [...consumes] }),
  }
}

/** The turn hit a transient error and is waiting to be resumed. */
export function statusRescheduled(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRescheduled }
}

/** Something went wrong during the turn; `error.retry_status` says what happens next. */
export function sessionError(error: SessionError): AppendableEvent {
  return { type: EVENT_TYPES.sessionError, error }
}

/**
 * A model request started — and, since D9, the claim on the user events it answers.
 *
 * `consumes` is the append's claim: the ids of the pending `user.message` / `user.interrupt`
 * events this request folds in. The store records a claim per id in the same transaction, and
 * refuses the whole append (`ClaimConflictError`) when an id is not a pending user event of the
 * session — so two brains can never own the same message. `model` is the `provider/model` that
 * serves the request, recorded per request so a session that changes models keeps, for every
 * request, the model that actually ran.
 *
 * Every span start is a real model request: since P4 an interrupt is never claimed by a span of
 * its own, so there is no such thing as a span start without a request behind it.
 *
 * @param consumes the ids of the pending user events this request answers; `[]` claims nothing
 * @param model the `provider/model` the request is made with, a Mastra router string
 */
export function spanStart(consumes: readonly EventId[], model: string): AppendableEvent {
  return {
    type: EVENT_TYPES.modelRequestStart,
    consumes: [...consumes],
    model,
  }
}

/** What {@link spanEnd} carries beyond the request it closes. */
export interface SpanEndOptions {
  /**
   * Why the request ended without a reply. Written with `is_error: true`; omitted for a
   * request that completed normally.
   */
  readonly error?: SpanError
  /**
   * The chunk range this span end replaces, when the request left stored chunks behind that
   * no `agent.message` will replace — an interrupt before any text was stored, a failure
   * mid-stream, a crash a recovering brain is closing. Replay skips the orphaned range (see
   * {@link agentMessage}).
   */
  readonly supersedes?: Supersedes
  /**
   * The `user.interrupt` events this span end claims (P4): an interrupt that cut the request
   * short is answered by the request's end — no model was called for it — so its ids are
   * claimed here rather than by a span of their own. Omitted (or empty) claims nothing.
   */
  readonly consumes?: readonly EventId[]
}

/**
 * A model request finished — always written, whatever happened to the request.
 *
 * See {@link SpanEndOptions} for what the call can carry beyond the usage: the error that
 * closed the span, the chunk range it supersedes, and the interrupts it claims.
 */
export function spanEnd(
  modelRequestStartId: EventId,
  modelUsage: ModelUsage,
  options: SpanEndOptions = {},
): AppendableEvent {
  const { error, supersedes, consumes } = options
  return {
    type: EVENT_TYPES.modelRequestEnd,
    model_request_start_id: modelRequestStartId,
    model_usage: modelUsage,
    is_error: error === undefined ? null : true,
    ...(error === undefined ? {} : { error }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(consumes === undefined || consumes.length === 0 ? {} : { consumes: [...consumes] }),
  }
}

/**
 * The agent's reply, under the id its `event_start` chunk announced.
 *
 * `id` is the `sevt_` id the stored `event_start` and every `event_delta` carried, which is how
 * a client matches what it accumulated against what was stored: `appendEvents` stores a
 * caller-supplied id exactly as given, so the chunk announcing the message and the message are
 * one id throughout.
 *
 * `supersedes` is the range of the reply's own chunks — its `event_start` through its last
 * `event_delta`, inclusive. Replay skips that range, so a client resuming by `seq` sees the
 * reply once, whole, however far into the stream it was when it disconnected.
 */
export function agentMessage(id: EventId, text: string, supersedes?: Supersedes): AppendableEvent {
  return {
    type: EVENT_TYPES.agentMessage,
    id,
    content: [{ type: 'text', text }],
    ...(supersedes === undefined ? {} : { supersedes }),
  }
}

/**
 * A reply started streaming: the stored chunk that opens the range an `agent.message` will
 * replace.
 *
 * Stored, not ephemeral (D9): the chunk is an ordinary event with a `seq`, so a reply in flight
 * is part of the log and a client reconnecting mid-reply resumes by position like anywhere
 * else.
 */
export function eventStart(messageId: EventId): AppendableEvent {
  return {
    type: EVENT_TYPES.eventStart,
    event: { type: EVENT_TYPES.agentMessage, id: messageId },
  }
}

/** One streamed fragment of that reply, as a stored event of the same range. */
export function eventDelta(messageId: EventId, text: string): AppendableEvent {
  return {
    type: EVENT_TYPES.eventDelta,
    event_id: messageId,
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
  }
}
