import { z } from 'zod'

import { ContentBlocksSchema } from '../content'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { EVENT_TYPES, EventSeqSchema, QueuedProcessedAtSchema } from './common'

/**
 * Events the user sends to a session.
 *
 * These are the only events a client may append; `POST /v1/sessions/{session_id}/events`
 * accepts them and nothing else. A user event is written to the log the moment it is
 * accepted, with `processed_at: null`, and its `processed_at` is filled in later, when the
 * brain actually folds it into a turn. The `null` is what tells a client that the agent has
 * not seen the message yet.
 */

/** A message from the user to the agent. v1 carries text blocks only. */
export const UserMessageEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.userMessage),
  seq: EventSeqSchema,
  processed_at: QueuedProcessedAtSchema,
  content: ContentBlocksSchema,
})

export type UserMessageEvent = z.infer<typeof UserMessageEventSchema>

/** {@link UserMessageEvent}, deep-readonly: the shape a store returns (D9). */
export type ImmutableUserMessageEvent = DeepReadonly<UserMessageEvent>

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

export type UserInterruptEvent = z.infer<typeof UserInterruptEventSchema>

/** {@link UserInterruptEvent}, deep-readonly: the shape a store returns (D9). */
export type ImmutableUserInterruptEvent = DeepReadonly<UserInterruptEvent>

/** Any stored user event. */
export const UserEventSchema = z.discriminatedUnion('type', [
  UserMessageEventSchema,
  UserInterruptEventSchema,
])

export type UserEvent = z.infer<typeof UserEventSchema>

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
