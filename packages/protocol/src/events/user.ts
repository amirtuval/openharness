import { z } from 'zod'

import { ContentBlocksSchema } from '../content'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { ModelConfigSchema } from '../resources/agent'
import { ReasoningEffortSchema } from '../reasoning'
import { EVENT_TYPES, EventSeqSchema, QueuedProcessedAtSchema } from './common'

/**
 * Events the user sends to a session.
 *
 * These are the events a client appends on its own behalf, and the ones a session queues for
 * the brain: `POST /v1/sessions/{session_id}/events` accepts them, and one instruction more —
 * a `session.rewind` (#238), whose event the server writes. A user event is written to the
 * log the moment it is
 * accepted and is never modified after that (D9, issue #46): it is stored as written — with
 * `processed_at: null` — and the claim the brain takes on it is a fact recorded beside it,
 * so a read derives the `processed_at` it reports from the claim that took the event. `null`
 * (no claim yet) is what tells a client that the agent has not seen the message.
 */

/** A message from the user to the agent. v1 carries text blocks only. */
export const UserMessageEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.userMessage),
  seq: EventSeqSchema,
  processed_at: QueuedProcessedAtSchema,
  content: ContentBlocksSchema,
  /**
   * // extension: switch the session's model for this message and the ones after it (#111).
   *
   * When a message carries a `model`, appending it also sets the session's current model —
   * `Session.model`, the projection — to it, in the same transaction as the append, and the
   * session keeps running that model until another message changes it. The brain makes each
   * model request with the session's current model, so a switch sent while a turn is running
   * applies from the next request. The log stays the source of truth: this field is the
   * record of the switch, and each `span.model_request_start` records the model that ran.
   *
   * Optional: a message without one leaves the session's model alone, which is every message
   * an agent-based client sends. Anthropic has no equivalent — there the model is the
   * agent's, fixed when the session is created.
   */
  model: ModelConfigSchema.optional(),
  /**
   * // extension: run this message's turn at a reasoning effort, and the turns after it (#252).
   *
   * The effort a request runs with is the newest one the log carries: appending a message with
   * one sets it for the turn the message starts and for every turn after it, exactly as a
   * `model` switches the model (#111). `null` asks for the provider's default again, and a
   * message that leaves the field out changes nothing — so a log that never carried an effort
   * replays exactly as it always did.
   *
   * Whether a request *runs* at the effort is the model's business: a model that takes none
   * runs the provider's default, and the request's `span.model_request_start` records what was
   * asked for beside what was applied (see `ReasoningEffortRunSchema`).
   */
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
})

/** A stored `user.message`, deep-readonly (D9, issue #46). */
export type UserMessageEvent = DeepReadonly<z.infer<typeof UserMessageEventSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link UserMessageEvent}. */
export type ImmutableUserMessageEvent = UserMessageEvent

/**
 * Stop the agent mid-execution.
 *
 * The response in flight is cut short: whatever text it had already produced is stored as an
 * `agent.message`, its `span.model_request_end` carries an `interrupted` error, and the turn
 * ends with `session.status_idle { stop_reason: { type: "end_turn" } }`. There is no stop
 * reason specific to interruption.
 */
export const UserInterruptEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.userInterrupt),
  seq: EventSeqSchema,
  processed_at: QueuedProcessedAtSchema,
})

/** A stored `user.interrupt`, deep-readonly (D9, issue #46). */
export type UserInterruptEvent = DeepReadonly<z.infer<typeof UserInterruptEventSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link UserInterruptEvent}. */
export type ImmutableUserInterruptEvent = UserInterruptEvent

/** Any stored user event. */
export const UserEventSchema = z.discriminatedUnion('type', [
  UserMessageEventSchema,
  UserInterruptEventSchema,
])

/** Any stored user event, deep-readonly (D9, issue #46). */
export type UserEvent = DeepReadonly<z.infer<typeof UserEventSchema>>

/**
 * A user event as a client sends it: the same shapes without the fields the server assigns
 * (`id`, `seq`) or fills in later (`processed_at`).
 *
 * Anthropic calls these `...EventParams`; they are the members of the `events` array on
 * `POST /v1/sessions/{session_id}/events` and of `initial_events` on session creation.
 */
export const UserMessageEventInputSchema = z.object({
  type: z.literal(EVENT_TYPES.userMessage),
  content: ContentBlocksSchema,
  /** Switch the session's model for this message and the ones after it (#111). */
  model: ModelConfigSchema.optional(),
  /** Run at a reasoning effort from this message on; `null` returns to the provider's default (#252). */
  reasoning_effort: ReasoningEffortSchema.nullable().optional(),
})

export type UserMessageEventInput = z.infer<typeof UserMessageEventInputSchema>

/** A `user.interrupt` as a client sends it: only the type. */
export const UserInterruptEventInputSchema = z.object({
  type: z.literal(EVENT_TYPES.userInterrupt),
})

export type UserInterruptEventInput = z.infer<typeof UserInterruptEventInputSchema>

/** Any user event a client may send. */
export const UserEventInputSchema = z.discriminatedUnion('type', [
  UserMessageEventInputSchema,
  UserInterruptEventInputSchema,
])

export type UserEventInput = z.infer<typeof UserEventInputSchema>
