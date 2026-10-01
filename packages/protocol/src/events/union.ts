import { z } from 'zod'

import type { DeepReadonly } from '../readonly'
import { AgentMessageEventSchema } from './agent'
import {
  SessionErrorEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionStatusRunningEventSchema,
} from './session'
import { ModelRequestEndEventSchema, ModelRequestStartEventSchema } from './span'
import { StoredEventDeltaSchema, StoredEventStartSchema, StreamOnlyEventSchema } from './stream'
import { UserInterruptEventSchema, UserMessageEventSchema } from './user'

/**
 * The event unions a consumer should code against.
 *
 * Pick the narrowest one that fits: {@link StoredEventSchema} for anything read out of the
 * log, {@link StreamEventSchema} for anything read off a stream, and
 * {@link UserEventInputSchema} (in `events/user.ts`) for anything a client sends.
 *
 * Since D9 (issue #46) a streamed reply is stored chunk by chunk, so the stored union includes
 * the stored forms of `event_start` and `event_delta`. Each event type also has a deep-readonly
 * alias — {@link ImmutableStoredEvent}, {@link ImmutableStreamEvent} and one per member — which
 * is the view a store hands out: the log is immutable, and the aliases say so in the types.
 * The `z.infer` types below stay as they are for the transition; the store, brain and server
 * phases move to the `Immutable*` names as they take the D9 rules on.
 */

/**
 * The stored events whose `type` string no stream-only event shares.
 *
 * `event_start` and `event_delta` are the exceptions: their stored forms carry the same
 * `type` as their stream-only counterparts, and a zod discriminated union cannot hold two
 * options with one discriminator value (it throws when it parses), so those two join
 * {@link StoredEventSchema} beside this union instead of inside it.
 */
const StoredEventCoreSchema = z.discriminatedUnion('type', [
  UserMessageEventSchema,
  UserInterruptEventSchema,
  AgentMessageEventSchema,
  SessionStatusRunningEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionErrorEventSchema,
  ModelRequestStartEventSchema,
  ModelRequestEndEventSchema,
])

/**
 * Every event a session can store, discriminated on `type`.
 *
 * The nine core members are one discriminated union; the two stored chunks are members too,
 * reached first by `type` and then by shape. A stored chunk is never ambiguous: it is the
 * stream-only preview plus the envelope, so an input with an `id`, a `seq` and a `processed_at`
 * parses as the stored form, and one without parses only as the stream-only form in
 * {@link StreamEventSchema}.
 */
export const StoredEventSchema = z.union([
  StoredEventCoreSchema,
  StoredEventStartSchema,
  StoredEventDeltaSchema,
])

export type StoredEvent = z.infer<typeof StoredEventSchema>

/** {@link StoredEvent}, deep-readonly: the shape a store returns (D9, issue #46). */
export type ImmutableStoredEvent = DeepReadonly<StoredEvent>

/**
 * Every event a stream can deliver: the stored events plus the stream-only previews.
 *
 * Discriminate on `type` and handle `event_start` / `event_delta` with care — both forms
 * exist, and which one a value is, is `seq`: present on the stored form, absent on the
 * preview. That is what {@link isStoredEvent} answers.
 */
export const StreamEventSchema = z.union([StoredEventSchema, StreamOnlyEventSchema])

export type StreamEvent = z.infer<typeof StreamEventSchema>

/** {@link StreamEvent}, deep-readonly: the shape a reader that does not mutate can hold (D9). */
export type ImmutableStreamEvent = DeepReadonly<StreamEvent>

/**
 * Whether a stream event was persisted, i.e. whether it is a {@link StoredEvent}.
 *
 * `seq` is the test, not the event type: since D9 an `event_start` / `event_delta` may be
 * either a stored event (with an `id`, a `seq` and a `processed_at`) or a stream-only preview
 * (with none of them). Every other event type is always stored.
 */
export function isStoredEvent(event: StreamEvent): event is StoredEvent {
  return 'seq' in event
}
