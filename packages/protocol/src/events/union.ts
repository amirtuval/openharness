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
import { StoredEventDeltaSchema, StoredEventStartSchema } from './stream'
import { UserInterruptEventSchema, UserMessageEventSchema } from './user'

/**
 * The event unions a consumer should code against.
 *
 * Pick the narrowest one that fits: {@link StoredEventSchema} for anything read out of the
 * log, {@link StreamEventSchema} for anything read off a stream, and
 * {@link UserEventInputSchema} (in `events/user.ts`) for anything a client sends.
 *
 * Since D9 (issue #46) a streamed reply is stored chunk by chunk, so a stream and the log
 * carry the same events: {@link StreamEvent} is {@link StoredEvent}. The pre-D9 stream-only
 * previews — `event_start` / `event_delta` with no envelope, never stored — were removed in
 * phase P4, when nothing wrote them any more.
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
])

/**
 * Every event a session can store, discriminated on `type`.
 *
 * The nine core members are one discriminated union; the two stored chunks are members too,
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
 * Every event a stream can deliver: the stored events, and nothing else.
 *
 * Before phase P4 this union also held the stream-only previews of `event_start` /
 * `event_delta`; the brain stores its chunks since P3, so there is no second form left. A
 * payload from a pre-P4 server that carries a seq-less chunk does not parse and is skipped by
 * a reader, the way any event a reader does not know is.
 */
export const StreamEventSchema = StoredEventSchema

/** A stream event, deep-readonly (D9, issue #46). The stream carries the log, so this is {@link StoredEvent}. */
export type StreamEvent = StoredEvent

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link StreamEvent}. */
export type ImmutableStreamEvent = StreamEvent

/**
 * Whether a stream event was persisted, i.e. whether it is a {@link StoredEvent}.
 *
 * Every event a P4 server delivers is stored, so this is `true` for anything that parses; the
 * `seq` test stays because it is the honest runtime check against a value that did not come
 * from the schemas — a seq-less `event_start` from a pre-D9 server, for one — and because it
 * is what told the two chunk forms apart before P4.
 */
export function isStoredEvent(event: StreamEvent): event is StoredEvent {
  return 'seq' in event
}
