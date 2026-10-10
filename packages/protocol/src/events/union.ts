import { z } from 'zod'

import type { DeepReadonly } from '../readonly'
import { AgentMessageEventSchema } from './agent'
import {
  ContextSummaryEventSchema,
  ContextSummaryProgressEventSchema,
  SessionCompactEventSchema,
  SessionCompactionEventSchema,
  SessionDeletedEventSchema,
  SessionErrorEventSchema,
  SessionRewindEventInputSchema,
  SessionRewindEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionStatusRunningEventSchema,
  SessionUsageEventSchema,
} from './session'
import { ModelRequestEndEventSchema, ModelRequestStartEventSchema } from './span'
import { StoredEventDeltaSchema, StoredEventStartSchema } from './stream'
import { UserEventInputSchema, UserInterruptEventSchema, UserMessageEventSchema } from './user'

/**
 * The event unions a consumer should code against.
 *
 * Pick the narrowest one that fits: {@link StoredEventSchema} for anything read out of the
 * log, {@link StreamEventSchema} for anything read off a stream, and {@link EventInputSchema}
 * for anything a client sends — the user's own events, and the one rewind instruction whose
 * event the server writes (#238).
 *
 * Since D9 (issue #46) a streamed reply is stored chunk by chunk, so a stream carries the
 * log's events; the one exception is `session.deleted` (#111), which is stream-only because
 * the log it would belong to has just been deleted. The pre-D9 stream-only previews —
 * `event_start` / `event_delta` with no envelope, never stored — were removed in phase P4,
 * when nothing wrote them any more.
 *
 * Every event type is deep-readonly: the log is immutable, and the types say so — `event.seq
 * = …` is a compile error, and the stores hand out deep-frozen events so it would throw at
 * runtime too. The `Immutable*` names still exist as deprecated aliases of the plain ones.
 */

/**
 * The stored events whose `type` string no stream-only event shares.
 *
 * `event_start` and `event_delta` join {@link StoredEventSchema} beside this union rather than
 * inside it: a zod discriminated union cannot hold two options with one discriminator value
 * (it throws when it parses), and their schemas are built from their own bodies.
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
  SessionRewindEventSchema,
  SessionUsageEventSchema,
  ContextSummaryEventSchema,
  ContextSummaryProgressEventSchema,
  SessionCompactEventSchema,
  SessionCompactionEventSchema,
])

/**
 * Every event a session can store, discriminated on `type`.
 *
 * The core members are one discriminated union; the two stored chunks are members too,
 * reached first by `type` and then by shape.
 */
export const StoredEventSchema = z.union([
  StoredEventCoreSchema,
  StoredEventStartSchema,
  StoredEventDeltaSchema,
])

/** A stored event, deep-readonly (D9, issue #46): the shape a store returns. */
export type StoredEvent = DeepReadonly<z.infer<typeof StoredEventSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link StoredEvent}. */
export type ImmutableStoredEvent = StoredEvent

/**
 * Every event a stream can deliver: the stored events, and one that is not.
 *
 * Before phase P4 this union also held the stream-only previews of `event_start` /
 * `event_delta`; the brain stores its chunks since P3, so there is no second form left. A
 * payload from a pre-P4 server that carries a seq-less chunk does not parse and is skipped by
 * a reader, the way any event a reader does not know is.
 *
 * `session.deleted` is the one member that is **not** stored (#111): it announces that the
 * session — and its log with it — is gone, so it can never be a `StoredEvent`. A server
 * sends it as the last event on every open stream for the session, before the stream closes.
 */
export const StreamEventSchema = z.union([StoredEventSchema, SessionDeletedEventSchema])

/** A stream event, deep-readonly (D9, issue #46): a {@link StoredEvent}, or `session.deleted`. */
export type StreamEvent = DeepReadonly<z.infer<typeof StreamEventSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link StreamEvent}. */
export type ImmutableStreamEvent = StreamEvent

/**
 * Whether a stream event was persisted, i.e. whether it is a {@link StoredEvent}.
 *
 * True for everything but `session.deleted`, which names a session whose log no longer
 * exists. The `seq` test is what tells them apart — the stored envelope is exactly what
 * `session.deleted` does not have — so it is honest both for a value from the schemas and for
 * a value that did not come from them (a seq-less `event_start` from a pre-D9 server, say).
 */
export function isStoredEvent(event: StreamEvent): event is StoredEvent {
  return 'seq' in event
}

/**
 * Every event a client may append to a session's log, as it sends it.
 *
 * The user's own events — `user.message` and `user.interrupt` — plus one instruction the
 * server turns into a session event of its own: a `session.rewind` (#238). A rewind is not a
 * user event — the session's status events are no more the user's for being asked for — but
 * the client is the one that knows which message the reader edited, so it travels on the same
 * `events` array and the same request as the message that follows it, which is what makes the
 * two atomic: either the session is rewound and the edited message is stored, or neither is.
 * A batch carries **at most one rewind, and it comes first**: see `SendEventsRequestSchema`
 * for why anything else would be swallowed by the range the rewind records.
 *
 * This is the member type of `SendEventsRequest.events`; read a log with
 * {@link StoredEventSchema} and a stream with {@link StreamEventSchema}.
 */
export const EventInputSchema = z.union([UserEventInputSchema, SessionRewindEventInputSchema])

export type EventInput = z.infer<typeof EventInputSchema>
