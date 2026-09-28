import { z } from 'zod'

import { STREAM_ONLY_EVENT_TYPES } from './common'
import { AgentMessageEventSchema } from './agent'
import {
  SessionErrorEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionStatusRunningEventSchema,
} from './session'
import { ModelRequestEndEventSchema, ModelRequestStartEventSchema } from './span'
import { EventDeltaSchema, EventStartSchema } from './stream'
import { UserInterruptEventSchema, UserMessageEventSchema } from './user'

/**
 * The event unions a consumer should code against.
 *
 * Pick the narrowest one that fits: {@link StoredEventSchema} for anything read out of the
 * log, {@link StreamEventSchema} for anything read off a stream, and
 * {@link UserEventInputSchema} (in `events/user.ts`) for anything a client sends.
 */

/** Every event a session can store, discriminated on `type`. */
export const StoredEventSchema = z.discriminatedUnion('type', [
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

export type StoredEvent = z.infer<typeof StoredEventSchema>

/**
 * Every event a stream can deliver: the stored events plus the stream-only previews.
 *
 * Discriminate on `type` and handle `event_start` / `event_delta` first — they are the only
 * members without a `seq`.
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  UserMessageEventSchema,
  UserInterruptEventSchema,
  AgentMessageEventSchema,
  SessionStatusRunningEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionErrorEventSchema,
  ModelRequestStartEventSchema,
  ModelRequestEndEventSchema,
  EventStartSchema,
  EventDeltaSchema,
])

export type StreamEvent = z.infer<typeof StreamEventSchema>

const STREAM_ONLY_EVENT_TYPE_SET = new Set<string>(STREAM_ONLY_EVENT_TYPES)

/**
 * Whether a stream event was persisted, i.e. whether it is a {@link StoredEvent}.
 *
 * False for `event_start` and `event_delta`, the only stream members without a `seq`.
 */
export function isStoredEvent(event: StreamEvent): event is StoredEvent {
  return !STREAM_ONLY_EVENT_TYPE_SET.has(event.type)
}
