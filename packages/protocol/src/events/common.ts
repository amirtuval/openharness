import { z } from 'zod'

import { TimestampSchema } from '../common'

/**
 * The event vocabulary, and the fields every stored event carries.
 *
 * Event type strings follow Anthropic's `{domain}.{action}` convention — `user.message`,
 * `span.model_request_end` — with one exception, the stream-only preview events
 * `event_start` and `event_delta`.
 *
 * See `AGENTS.md` for how to add a new event type.
 */

/** Every event type string in the protocol. */
export const EVENT_TYPES = {
  /** A user message: the user talking to the agent. */
  userMessage: 'user.message',
  /** Stop the agent mid-execution. */
  userInterrupt: 'user.interrupt',
  /** The agent's reply, as text blocks. */
  agentMessage: 'agent.message',
  /** The agent started working. */
  sessionStatusRunning: 'session.status_running',
  /** The agent finished its turn and is waiting for input. */
  sessionStatusIdle: 'session.status_idle',
  /** A transient error; the session is retrying automatically. */
  sessionStatusRescheduled: 'session.status_rescheduled',
  /** Something went wrong during the turn. */
  sessionError: 'session.error',
  /** A model request started. */
  modelRequestStart: 'span.model_request_start',
  /** A model request finished, with its token usage. */
  modelRequestEnd: 'span.model_request_end',
  /** Stream-only: a previewed event started generating. */
  eventStart: 'event_start',
  /** Stream-only: incremental content for a previewed event. */
  eventDelta: 'event_delta',
} as const

/** An event type string, stored or stream-only. */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]

/** Event types that are persisted in the session log. */
export const STORED_EVENT_TYPES = [
  EVENT_TYPES.userMessage,
  EVENT_TYPES.userInterrupt,
  EVENT_TYPES.agentMessage,
  EVENT_TYPES.sessionStatusRunning,
  EVENT_TYPES.sessionStatusIdle,
  EVENT_TYPES.sessionStatusRescheduled,
  EVENT_TYPES.sessionError,
  EVENT_TYPES.modelRequestStart,
  EVENT_TYPES.modelRequestEnd,
] as const

/** A persisted event type. */
export type StoredEventType = (typeof STORED_EVENT_TYPES)[number]

/** Event types that exist only on a live stream, and are never written to the log. */
export const STREAM_ONLY_EVENT_TYPES = [EVENT_TYPES.eventStart, EVENT_TYPES.eventDelta] as const

/** A stream-only event type. */
export type StreamOnlyEventType = (typeof STREAM_ONLY_EVENT_TYPES)[number]

/**
 * // extension: the per-session running number of a stored event.
 *
 * Anthropic orders the event log by `processed_at`; timestamps collide at millisecond
 * resolution, and they are not monotonic across a crash, so openharness also stamps each
 * stored event with `seq`. It starts at `1` for the first event of a session and increases by
 * exactly one per event, making it the ordering key, the pagination cursor and the SSE
 * `last-event-id` resume position all at once. Stream-only events have no `seq`.
 */
export const EventSeqSchema = z.number().int().positive()

export type EventSeq = z.infer<typeof EventSeqSchema>

/**
 * The `after_seq` query parameter, an openharness extension.
 *
 * Returns only events with a `seq` strictly greater than this, so `after_seq=0` means "from
 * the beginning of the session" and `after_seq=<last seen seq>` is an exact resume.
 */
export const AfterSeqSchema = z.coerce.number().int().nonnegative()

export type AfterSeq = z.infer<typeof AfterSeqSchema>

/**
 * `processed_at` on a user event.
 *
 * User events are appended to the log immediately but processed later, when the brain folds
 * them into a turn, so their `processed_at` is `null` while they are queued. Anthropic
 * documents the field as `optional string or null`; openharness always writes the key.
 */
export const QueuedProcessedAtSchema = TimestampSchema.nullable()

/**
 * `processed_at` on an event the server produced itself (agent, session and span events).
 * These are written when they happen, so their timestamp is never null.
 */
export const ProcessedAtSchema = TimestampSchema
