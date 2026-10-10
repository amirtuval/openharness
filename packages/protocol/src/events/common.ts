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
  /**
   * The agent asked for a tool.
   *
   * The event's own `id` is the call's id — the same identity trick `agent.message` uses for
   * the chunks it replaces — and the `agent.tool_result` that answers it names that id in its
   * `tool_use_id`. Written by the brain, never by a client: a tool is something the model
   * asked for, and only the brain talks to the model. See {@link AgentToolUseEventSchema}.
   */
  agentToolUse: 'agent.tool_use',
  /**
   * What a tool call produced.
   *
   * Written by the brain, whatever came of the call — a result, a refusal, a timeout, a
   * crash that lost the execution. A client never writes one (epic #303, X1): the loop owns
   * the log, and a tool result is the loop's report of what it ran. See
   * {@link AgentToolResultEventSchema}.
   */
  agentToolResult: 'agent.tool_result',
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
  /**
   * // extension: the session's running totals, after a model request (epic #245, A2; #247).
   *
   * Anthropic has the event; openharness writes it on a different cadence and with the cost
   * left out — see {@link SessionUsageEventSchema} for what it carries and why.
   */
  sessionUsage: 'session.usage',
  /**
   * // extension: the older history was summarized for the model (epic #277, K1; #278).
   *
   * The brain writes it when a chat's context fills: `summary` is the text, `covers.to_seq` the
   * last event it replaces for the model, and the request a client makes of it is the context
   * strategy's — nothing is deleted or superseded. See {@link ContextSummaryEventSchema} for
   * what it carries and why.
   */
  sessionContextSummary: 'session.context_summary',
  /**
   * // extension: a summary is being written, one pass at a time (epic #277, C2; #279).
   *
   * The brain writes it before each pass of the compaction engine, in the same log the summary
   * itself lands in, because everything a client is told goes in the log (D9): a client that
   * reconnects mid-compaction — or loads a session it happened in — sees the same progress the
   * live stream carried. It carries the pass being taken and how many the plan holds; a client
   * shows "summarizing (2/3)" and reads nothing else out of it. Deleting old progress events is
   * follow-up work (#285), not this event's job. See {@link ContextSummaryProgressEventSchema}.
   */
  sessionContextSummaryProgress: 'session.context_summary_progress',
  /**
   * // extension: the user asked for a manual compaction, `/compact [instructions]` (epic #277,
   * K8; #283).
   *
   * A client-requested event like `session.rewind` (#238): the server writes it on the caller's
   * behalf when `POST /v1/sessions/{id}/compact` lands, and the brain answers it — at the next
   * request boundary when a turn is running, or in a turn of its own when the session is idle —
   * with a {@link EVENT_TYPES.sessionCompaction}. It carries the user's optional guidance, which
   * the compaction engine folds into the summary prompt as the user's own instruction. A request
   * already waiting for an answer is not appended again: the route is idempotent while one is
   * pending. See {@link SessionCompactEventSchema}.
   */
  sessionCompact: 'session.compact',
  /**
   * // extension: the answer to a manual compaction request (epic #277, K8; #283).
   *
   * The brain writes it once it has handled the newest pending `session.compact`, whatever came
   * of it: `summarized` (the summary itself is a `session.context_summary` with reason
   * `manual`), `nothing_to_summarize` (there was no older history to fold, or the chat is short),
   * or `failed` (the summarizer failed; the chat carries on). This is the clear, stored outcome
   * a client shows — the request is never a silent no-op — and it is what makes a request no
   * longer pending. See {@link SessionCompactionEventSchema}.
   */
  sessionCompaction: 'session.compaction',
  /** A previewed event started generating. A stored chunk since D9; stream-only before it. */
  eventStart: 'event_start',
  /** Incremental content for a previewed event. A stored chunk since D9; stream-only before it. */
  eventDelta: 'event_delta',
  /**
   * // extension: the session restarts from an earlier `user.message` (#238).
   *
   * The log stays append-only: nothing already stored is changed. A rewind is a superseding
   * event like the one that finishes a reply (see {@link SupersedesSchema}) — it carries a
   * range, replay skips it, and compaction deletes it after the retention window — but the
   * range covers the whole tail of the log from the edited message on, not a reply's chunks.
   * The edited text is then an ordinary `user.message` appended right behind the rewind, so a
   * reader sees the conversation restart from the edit and the model never sees the original.
   *
   * Anthropic has no equivalent: editing a sent message is an openharness extension.
   */
  sessionRewind: 'session.rewind',
  /**
   * // extension: the session this stream was following no longer exists (#111).
   *
   * Stream-only: it is **not** in {@link STORED_EVENT_TYPES} and never lands in a log — the
   * session it names, and the log with it, is gone. A server sends it as the last event on
   * every open stream for the session and then closes the stream, so a subscriber learns that
   * the session was deleted rather than watching a reconnect loop for a session that can
   * never answer. Anthropic has no equivalent event: deleting a session is an openharness
   * extension (epic #116, U5).
   */
  sessionDeleted: 'session.deleted',
} as const

/** An event type string, stored or stream-only. */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]

/**
 * Event types that are persisted in the session log.
 *
 * Every event type except {@link EVENT_TYPES.sessionDeleted}: that one is stream-only — it
 * announces a session's deletion, so there is no log left to store it in (#111).
 */
export const STORED_EVENT_TYPES = [
  EVENT_TYPES.userMessage,
  EVENT_TYPES.userInterrupt,
  EVENT_TYPES.agentMessage,
  EVENT_TYPES.agentToolUse,
  EVENT_TYPES.agentToolResult,
  EVENT_TYPES.sessionStatusRunning,
  EVENT_TYPES.sessionStatusIdle,
  EVENT_TYPES.sessionStatusRescheduled,
  EVENT_TYPES.sessionError,
  EVENT_TYPES.modelRequestStart,
  EVENT_TYPES.modelRequestEnd,
  EVENT_TYPES.sessionUsage,
  EVENT_TYPES.sessionContextSummary,
  EVENT_TYPES.sessionContextSummaryProgress,
  EVENT_TYPES.sessionCompact,
  EVENT_TYPES.sessionCompaction,
  EVENT_TYPES.eventStart,
  EVENT_TYPES.eventDelta,
  EVENT_TYPES.sessionRewind,
] as const

/** A persisted event type. */
export type StoredEventType = (typeof STORED_EVENT_TYPES)[number]

/**
 * // extension: the per-session running number of a stored event.
 *
 * Anthropic orders the event log by `processed_at`; timestamps collide at millisecond
 * resolution, and they are not monotonic across a crash, so openharness also stamps each
 * stored event with `seq`. It starts at `1` for the first event of a session and increases by
 * exactly one per event, making it the ordering key, the pagination cursor and the SSE
 * `last-event-id` resume position all at once. Every event in the log has one; the stream-only
 * previews that had none were removed in phase P4.
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
 * // extension: the range of stored events a later event replaces (D9, issue #46; #238).
 *
 * Two events supersede a range, and the event that carries it says which kind it is:
 *
 * - **A reply.** A streamed reply is stored twice over: once as the chunks it arrived in — the
 *   stored `event_start` and `event_delta` events — and once as the finished `agent.message`.
 *   The finished event carries `supersedes` over the chunks it replaces: `from_seq` is its own
 *   `event_start` and `to_seq` its last `event_delta`, inclusive on both ends. An interrupt
 *   stores the partial `agent.message` the same way, and a request that ends without one — a
 *   crash the recovering brain closes with `span.model_request_end { brain_lost }`, or a
 *   message that streamed no text at all — carries the range on that span end instead. Only
 *   chunks are ever covered: a range from one of these events replaces the reply's previews
 *   and nothing else.
 * - **A rewind** ({@link EVENT_TYPES.sessionRewind}). `from_seq` is the `user.message` the
 *   session restarts from and `to_seq` the last event before the rewind, so the range covers
 *   the whole tail of the log: the message, its reply, every span and status event between
 *   them. Unlike a reply's range it covers events of any type, and it reaches the log's end —
 *   the event that carries it is the next one written.
 *
 * Readers use it for one thing: replay (and the client's transcript) **skips superseded
 * events**, so a client that resumes by `seq` sees a reply once, whole, however far into the
 * stream it was when it disconnected, and a conversation restarted from an edit without the
 * messages the edit replaced. A later background job deletes the range physically, after the
 * retention window, without changing what any reader sees.
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
