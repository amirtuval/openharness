import { z } from 'zod'

import { TimestampSchema } from '../common'

/**
 * The event vocabulary, and the fields every stored event carries.
 *
 * Event type strings follow Anthropic's `{domain}.{action}` convention — `user.message`,
 * `span.model_request_end` — with one exception, the preview events `event_start` and
 * `event_delta`, whose names are Anthropic's verbatim.
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
  /** A previewed event started generating. Stored since D9; stream-only before it. */
  eventStart: 'event_start',
  /** Incremental content for a previewed event. Stored since D9; stream-only before it. */
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
  EVENT_TYPES.eventStart,
  EVENT_TYPES.eventDelta,
] as const

/** A persisted event type. */
export type StoredEventType = (typeof STORED_EVENT_TYPES)[number]

/**
 * Event types whose stream-only form still exists: `event_start` and `event_delta`.
 *
 * Since D9 (issue #46) these *are* stored events — they are in {@link STORED_EVENT_TYPES} too,
 * and a stored one carries an `id`, a `seq` and a `processed_at` like any other event. What
 * this list still names is the envelope-less form: the preview a live connection receives
 * while the brain streams a reply on servers that publish previews rather than storing chunks
 * (the brain stores chunks from phase P3 on). A reader tells the two forms apart by `seq` —
 * the stored one has it, the preview does not — which is what {@link isStoredEvent} checks;
 * `StreamOnlyEventSchema` and this list go away in phase P4, when there are no previews left.
 */
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

/**
 * // extension: the range of stored events a later event replaces (D9, issue #46).
 *
 * A streamed reply is stored twice over: once as the chunks it arrived in — the stored
 * `event_start` and `event_delta` events — and once as the finished `agent.message`. The
 * finished event carries `supersedes` over the chunks it replaces: `from_seq` is its own
 * `event_start` and `to_seq` its last `event_delta`, inclusive on both ends. An interrupt
 * stores the partial `agent.message` the same way, and a request that ends without one — a
 * crash the recovering brain closes with `span.model_request_end { brain_lost }`, or a message
 * that streamed no text at all — carries the range on that span end instead.
 *
 * Readers use it for one thing: replay (and the client's transcript) **skips superseded
 * chunks**, so a client that resumes by `seq` sees the reply once, whole, however far into the
 * stream it was when it disconnected. A later background job deletes the range physically,
 * after the retention window, without changing what any reader sees.
 *
 * `from_seq <= to_seq`, and both are positive `seq` values of the same session — this is a
 * position in the log, not an `EventId`, which is why the fields are `seq`-shaped rather than
 * ids.
 */
export const SupersedesSchema = z
  .object({
    /** The `seq` of the first replaced event: the reply's `event_start`. */
    from_seq: EventSeqSchema,
    /** The `seq` of the last replaced event: the reply's final `event_delta`. */
    to_seq: EventSeqSchema,
  })
  .refine((range) => range.from_seq <= range.to_seq, {
    error: 'from_seq must not be greater than to_seq',
  })

export type Supersedes = z.infer<typeof SupersedesSchema>
