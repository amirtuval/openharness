import type { AppendableEvent } from '@openharness/session'
import type { EventId, ModelUsage, SessionError, SpanError } from '@openharness/protocol'
import { EVENT_TYPES } from '@openharness/protocol'

/**
 * The events a turn appends, built in one place.
 *
 * Every event the loop writes carries only the fields the caller owns — the store assigns `id`,
 * `seq` and `processed_at` — so these builders are what keeps the wire shapes in one file
 * instead of spread over the loop's branches. The exact order they are written in is the
 * lifecycle the package documents; these are just the pieces.
 */

/** The agent started working. Opens a turn. */
export function statusRunning(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRunning }
}

/** The agent finished its turn. Closes one, whatever the reason. */
export function statusIdle(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusIdle, stop_reason: { type: 'end_turn' } }
}

/** The turn hit a transient error and is waiting to be resumed. */
export function statusRescheduled(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRescheduled }
}

/** Something went wrong during the turn; `error.retry_status` says what happens next. */
export function sessionError(error: SessionError): AppendableEvent {
  return { type: EVENT_TYPES.sessionError, error }
}

/** A model request started. */
export function spanStart(): AppendableEvent {
  return { type: EVENT_TYPES.modelRequestStart }
}

/**
 * A model request finished — always written, whatever happened to the request.
 *
 * An `error` closes the span without a reply, and `is_error` is written together with it; a
 * request that completed normally has neither.
 */
export function spanEnd(
  modelRequestStartId: EventId,
  modelUsage: ModelUsage,
  error?: SpanError,
): AppendableEvent {
  return {
    type: EVENT_TYPES.modelRequestEnd,
    model_request_start_id: modelRequestStartId,
    model_usage: modelUsage,
    is_error: error === undefined ? null : true,
    ...(error === undefined ? {} : { error }),
  }
}

/**
 * The agent's reply, under the id its live preview was published with.
 *
 * `id` is the `sevt_` id the `event_start` and every `event_delta` carried, which is how a
 * client matches what it accumulated against what was stored.
 *
 * **Contract gap.** `AppendableEvent` has no `id` — `@openharness/session` says the store
 * assigns it — while `@openharness/protocol` says a stored `agent.message` carries the id its
 * preview announced. The two cannot both hold, and the brain cannot publish a preview under an
 * id it does not choose, so it chooses one and asserts it here: a store that honours a
 * caller-supplied id for an agent event lines up, and `InMemorySessionStore` overwrites it with
 * one of its own. See `AGENTS.md`, "Contract gaps".
 */
export function agentMessage(id: EventId, text: string): AppendableEvent {
  return {
    type: EVENT_TYPES.agentMessage,
    id,
    content: [{ type: 'text', text }],
  } as AppendableEvent
}
