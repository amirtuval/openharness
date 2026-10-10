import { z } from 'zod'

import { EventIdSchema, SessionIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { EVENT_TYPES, EventSeqSchema, ProcessedAtSchema, SupersedesSchema } from './common'
import { ModelUsageSchema } from './span'

/**
 * Events the session itself emits: status transitions, errors, the running usage of the turn
 * (epic #245, A2), the rewind that restarts the conversation from an earlier message (#238) and
 * the summary that replaces older history for the model (epic #277, K1; #278).
 *
 * They bracket a turn — `session.status_running` opens it, `session.status_idle` closes it —
 * so replaying just these events gives the session's state at any point in the log. A
 * `session.rewind` is the one member a client asks for rather than the brain writing it, and
 * the one that changes what the log *means* rather than what the session is doing: it is a
 * statement about the transcript, not about a turn. A `session.context_summary` is the other
 * kind of statement: it changes nothing about the log or the transcript, and only says what the
 * *model* is told about the history it no longer sees.
 */

/**
 * Why the agent stopped.
 *
 * v1 only ever produces `end_turn`, which is what a turn that finishes on its own *and* a
 * turn cut short by a `user.interrupt` both report; there is no stop reason specific to
 * interruption. Anthropic's union also has `requires_action`, `retries_exhausted` and
 * `budget_reached`, none of which openharness emits yet (see `AGENTS.md`).
 */
export const StopReasonSchema = z.object({
  type: z.literal('end_turn'),
})

export type StopReason = z.infer<typeof StopReasonSchema>

/** The agent is actively working. Emitted at the start of every turn. */
export const SessionStatusRunningEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.sessionStatusRunning),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
})

/** A stored `session.status_running`, deep-readonly (D9, issue #46). */
export type SessionStatusRunningEvent = DeepReadonly<
  z.infer<typeof SessionStatusRunningEventSchema>
>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link SessionStatusRunningEvent}. */
export type ImmutableSessionStatusRunningEvent = SessionStatusRunningEvent

/** The agent finished its turn and is waiting for input. Closes every turn. */
export const SessionStatusIdleEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.sessionStatusIdle),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  stop_reason: StopReasonSchema,
  /**
   * // extension: the user events this turn end claims (P4).
   *
   * A `user.interrupt` that arrived with no model request running — no brain had started a
   * turn, or the interrupt landed between requests — is answered by the turn ending: the
   * `session.status_idle` that closes the turn claims its ids, so it reads processed and is
   * not reached again. The claim rules are {@link ModelRequestStartEventSchema}'s `consumes`
   * (atomic, insert-only, refused whole on a conflict). The brain writes the list when it
   * ended the turn on an interrupt; a turn that ends on its own carries none. Optional so a
   * log stored before P4 keeps validating.
   */
  consumes: z.array(EventIdSchema).optional(),
})

/** A stored `session.status_idle`, deep-readonly (D9, issue #46). */
export type SessionStatusIdleEvent = DeepReadonly<z.infer<typeof SessionStatusIdleEventSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link SessionStatusIdleEvent}. */
export type ImmutableSessionStatusIdleEvent = SessionStatusIdleEvent

/**
 * A transient error occurred and the session is retrying automatically.
 *
 * Always preceded by a `session.error` and followed by a `session.status_running`.
 */
export const SessionStatusRescheduledEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.sessionStatusRescheduled),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
})

/** A stored `session.status_rescheduled`, deep-readonly (D9, issue #46). */
export type SessionStatusRescheduledEvent = DeepReadonly<
  z.infer<typeof SessionStatusRescheduledEventSchema>
>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link SessionStatusRescheduledEvent}. */
export type ImmutableSessionStatusRescheduledEvent = SessionStatusRescheduledEvent

/**
 * What a client should do about a `session.error`, from Anthropic's
 * `BetaManagedAgentsRetryStatus*` union.
 */
export const RetryStatusTypeSchema = z.enum([
  /** The server is retrying automatically; wait. */
  'retrying',
  /** The turn is dead and the session is going idle; a new prompt will work. */
  'exhausted',
  /** The session hit a terminal error and will transition to `terminated`. */
  'terminal',
])

export type RetryStatusType = z.infer<typeof RetryStatusTypeSchema>

/** `retry_status`: an object with a `type`, exactly as Anthropic shapes it. */
export const RetryStatusSchema = z.object({
  type: RetryStatusTypeSchema,
})

export type RetryStatus = z.infer<typeof RetryStatusSchema>

/** The error kinds a `session.error` can carry, from Anthropic's union. */
export const SessionErrorTypeSchema = z.enum([
  /** Fallback for anything without a more specific type. */
  'unknown_error',
  /** The model is overloaded, after automatic retries were exhausted. */
  'model_overloaded_error',
  /** The model request was rate-limited. */
  'model_rate_limited_error',
  /** A model request failed for a reason other than overload or rate limiting. */
  'model_request_failed_error',
  /** Connecting to an MCP server failed. */
  'mcp_connection_failed_error',
  /** Authenticating to an MCP server failed. */
  'mcp_authentication_failed_error',
  /** The organization or workspace cannot make model requests. */
  'billing_error',
  /** A credential's allowed hosts are not permitted by the environment's network policy. */
  'credential_host_unreachable_error',
  /**
   * // extension: the session owner has no stored credential for the model's provider
   * (epic #65, A5). The server never uses provider keys of its own, so the turn cannot make
   * a model request at all; the `message` names the provider (`anthropic`, `openai`, …) so a
   * client can point the user at the right Settings entry.
   *
   * **Non-retryable.** Nothing is rescheduled: the turn ends with `session.status_idle`, and
   * `retry_status.type` is `exhausted` — {@link SessionErrorSchema} refuses the pairing with
   * any other retry status. A new prompt after the credential is added works.
   */
  'missing_provider_credential',
])

export type SessionErrorType = z.infer<typeof SessionErrorTypeSchema>

/** The `error` object of a `session.error` event. */
export const SessionErrorSchema = z
  .object({
    type: SessionErrorTypeSchema,
    message: z.string(),
    retry_status: RetryStatusSchema,
  })
  .refine(
    (error) =>
      error.type !== 'missing_provider_credential' || error.retry_status.type === 'exhausted',
    {
      error:
        'missing_provider_credential is never retried: retry_status must be `exhausted` (epic #65, A5)',
    },
  )

export type SessionError = z.infer<typeof SessionErrorSchema>

/**
 * Something went wrong during the turn.
 *
 * A retryable error is followed by `session.status_rescheduled` and then a fresh
 * `session.status_running`. When the retries run out, or the error was never retryable, the
 * turn ends with `session.status_idle { stop_reason: { type: "end_turn" } }`.
 */
export const SessionErrorEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.sessionError),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  error: SessionErrorSchema,
})

/** A stored `session.error`, deep-readonly (D9, issue #46). */
export type SessionErrorEvent = DeepReadonly<z.infer<typeof SessionErrorEventSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link SessionErrorEvent}. */
export type ImmutableSessionErrorEvent = SessionErrorEvent

/**
 * // extension: the session this stream was following was deleted (#111, epic #116 U5).
 *
 * **Stream-only.** A `DELETE /v1/sessions/{session_id}` removes the session and its whole
 * log, so there is nowhere to store this event: it names the session that is gone and is
 * never in it. A server sends it as the **last** event on every open stream for the session
 * and closes the stream after it, so a subscriber learns the session was deleted — an end
 * state — instead of reconnecting to a session that no longer exists. It carries no `seq`
 * and no envelope: it is not a position in a log.
 *
 * Anthropic has no equivalent: session deletion is an openharness extension. Note it is the
 * one event type in {@link EVENT_TYPES} that is not in {@link STORED_EVENT_TYPES}.
 */
export const SessionDeletedEventSchema = z.object({
  type: z.literal(EVENT_TYPES.sessionDeleted),
  /** The deleted session's id — the one the stream was following. */
  session_id: SessionIdSchema,
})

/** A `session.deleted` stream event, deep-readonly like every event. */
export type SessionDeletedEvent = DeepReadonly<z.infer<typeof SessionDeletedEventSchema>>

/**
 * // extension: the session restarts from an earlier `user.message` (#238).
 *
 * Editing a message never changes what is stored: this event supersedes the tail of the log
 * from the message the reader is editing, and the edited text follows it as an ordinary
 * `user.message`. `supersedes.from_seq` is that message's `seq` and `supersedes.to_seq` the
 * last event before this one, so the range runs to the end of the log as it stood — see
 * {@link SupersedesSchema} for what a range means and who reads it. Replay and compaction
 * treat the whole range as gone: a reader that loads the session later never sees the
 * messages it replaced, and a client that was already rendering them drops them when it
 * receives this event (it is never itself superseded, so it is always delivered).
 *
 * The event is the server's, not the brain's, and like the status events it takes effect in
 * the append that writes it: it is stored with its `processed_at` set and is not claimed by
 * any span. A session accepts one only while it is idle — a turn in flight would be appending
 * into the range it just lost — which the server enforces (a 409).
 *
 * Anthropic has no equivalent: editing a sent message is an openharness extension.
 */
export const SessionRewindEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.sessionRewind),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /**
   * The range this rewind replaces: from the edited `user.message` to the last event of the
   * log as it stood. Both ends are `seq`s of this session, and `to_seq` is always the `seq`
   * this event's own `seq` follows — a rewind restarts from a message through the end of what
   * has been written, never a window in the middle.
   */
  supersedes: SupersedesSchema,
})

/** A stored `session.rewind`, deep-readonly like every event (#238). */
export type SessionRewindEvent = DeepReadonly<z.infer<typeof SessionRewindEventSchema>>

/**
 * Why the older history was summarized (epic #277, K1; #278).
 *
 * - `threshold` — the context reached the share of the chat model's budget the settings allow,
 *   so the compaction engine summarized before the provider would have refused the request (K2).
 * - `overflow` — the provider refused a request as too long, so the engine summarized with
 *   tighter caps and retried once (K2).
 * - `manual` — the user asked for it (`/compact`, K8).
 */
export const ContextSummaryReasonSchema = z.enum(['threshold', 'overflow', 'manual'])

export type ContextSummaryReason = z.infer<typeof ContextSummaryReasonSchema>

/**
 * The part of the log a summary replaces **for the model** (epic #277, K1; #278).
 *
 * `to_seq` is the last event the summary covers, inclusive: the context strategy hands the model
 * the summary and then every event **after** it. Nothing here is a supersession — the log, the
 * transcript and replay keep the history whole; the range says only where the model is told to
 * start reading. `seq`-shaped rather than an event id, because it is a position in the log.
 */
export const ContextSummaryCoversSchema = z.object({
  /** The `seq` of the last event the summary replaces for the model, inclusive. */
  to_seq: EventSeqSchema,
})

export type ContextSummaryCovers = z.infer<typeof ContextSummaryCoversSchema>

/**
 * // extension: a summary of the older history, written by the brain (epic #277, K1; #278).
 *
 * When a chat's context fills, the brain summarizes the older messages and continues from the
 * summary plus the recent messages verbatim, instead of dropping the oldest messages (which is
 * what `trimToBudget` in `@openharness/brain` did before this). The summary is an **event**, and
 * it supersedes **nothing**: the log stays append-only, the transcript and replay still show the
 * full history, and the only reader of this event is the context strategy — what the model sees
 * is the system prompt, then the latest non-superseded summary, then every event after
 * `covers.to_seq`.
 *
 * A summary is written by the compaction engine (`packages/brain`, epic #277 C2), never by a
 * client: like `session.usage` it is the brain's own bookkeeping, and it is not queued and never
 * claimed. A later summary replaces an earlier one simply by being newer; a `session.rewind`
 * that reaches back before this event supersedes it along with the rest of the tail it replaced,
 * so it disappears from the strategy's reading the way everything the edit took back does.
 *
 * Anthropic has no equivalent: its API has no server-side brain to summarize with, and no
 * compaction event that leaves the transcript intact.
 */
export const ContextSummaryEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.sessionContextSummary),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  /** The summary text: what the model is told instead of the events `covers` names. */
  summary: z.string(),
  /** The last event the summary replaces for the model, inclusive. */
  covers: ContextSummaryCoversSchema,
  /** Why the summary was made (K2/K8), recorded so a reader can tell them apart. */
  reason: ContextSummaryReasonSchema,
  /**
   * The context size when the summary was made, in tokens, measured on the chat model before the
   * summary replaced anything. Recorded so the log says how full the context was when it happened
   * (K10's meter reads it back).
   */
  tokens_before: z.number().int().nonnegative(),
  /** The `provider/model` that wrote the summary — the summary model, or the chat model. */
  summary_model: z.string().min(1),
  /** The version of the summary prompt that produced the text (K7), so a later change is visible. */
  prompt_version: z.string().min(1),
  /** How many passes the summary took (K5; the pass limit is a user preference). */
  passes: z.number().int().positive(),
  /**
   * Why the chat model summarized instead of the summary model the user chose (K3/K5).
   *
   * Written only when a fallback happened — no credential for the chosen summary model, or the
   * chosen model would have needed more passes than the limit allows — and absent when the chosen
   * model did the work.
   */
  fallback_reason: z.string().optional(),
})

/** A stored `session.context_summary`, deep-readonly like every event (#278). */
export type ContextSummaryEvent = DeepReadonly<z.infer<typeof ContextSummaryEventSchema>>

/**
 * One model's running total for a session (epic #245, A2; issue #247).
 *
 * The tokens of every request that ran on this model, summed over the session so far. It carries
 * the model id because a session's totals are only priceable per model — a session that switched
 * providers mid-conversation ran some requests at one set of rates and some at another.
 */
export const SessionModelUsageSchema = z.object({
  /** The `provider/model` these requests ran on. */
  model: z.string().min(1),
  /** What they reported, summed. */
  usage: ModelUsageSchema,
  /**
   * How many requests ran on this model so far — at least one, since an entry exists because a
   * request named it.
   *
   * The count is what lets a reader of the running totals price them per model the way the usage
   * routes do: a model nobody publishes a price for contributes `requests` unpriced requests, and
   * a priced one contributes none (#247). It is a fact about the log, not about money — no cost
   * is stored — so it stays true whatever the catalog's prices turn out to be.
   */
  requests: z.number().int().positive(),
})

export type SessionModelUsage = z.infer<typeof SessionModelUsageSchema>

/**
 * // extension: the session's running totals, written after a model request (epic #245, A2).
 *
 * Anthropic has the event — a `session.usage` snapshot of the session's cumulative usage and its
 * tracked list cost — and openharness keeps its name and its placement in the log. Three things
 * differ, all of them deliberate:
 *
 * - **It is written after every model request, not once per idle.** Anthropic emits one
 *   immediately before the session goes idle, whatever the stop reason. openharness's client
 *   shows the session's cost as the turn runs, and a request that finishes mid-turn is exactly
 *   the moment the number moved, so the event is written there. Fewer events would be cheaper
 *   and a client would have to derive the same totals from the spans it already reads.
 * - **It carries no cost.** Anthropic stamps `list_cost` (platform-computed and stored) onto the
 *   snapshot; here cost is computed when it is read, from the tokens below and the model
 *   catalog's prices, and is never written into the log (epic #245). The tokens are what is
 *   stored, and they are the part that cannot be recovered from anywhere else.
 * - **It breaks the totals down by model.** Anthropic's snapshot is flat — a session there runs
 *   one model — while an openharness session may switch models mid-conversation (epic #116, U3),
 *   and its tokens can only be priced one model at a time.
 *
 * The totals are **cumulative over the whole session**, not per request: a reader that wants
 * what the last request cost subtracts the previous event's totals, and one that wants the
 * session's cost reads the newest event alone. `models` breaks the same totals down, and the
 * four counters beside it are their sum — the schema refuses a snapshot where the two disagree.
 *
 * A session stored before this event existed has none, and its usage is derived on read from the
 * `span.model_request_end` events it does have: the running total an event carries is exactly
 * what a fold over those spans produces, so a log replay answers the same numbers a live stream
 * does, whichever of the two a client is reading.
 */
export const SessionUsageEventSchema = z
  .object({
    id: EventIdSchema,
    type: z.literal(EVENT_TYPES.sessionUsage),
    seq: EventSeqSchema,
    processed_at: ProcessedAtSchema,
    /** Input tokens every request of this session reported, summed. */
    input_tokens: z.number().int().nonnegative(),
    /** Output tokens every request of this session reported, summed. */
    output_tokens: z.number().int().nonnegative(),
    /** Prompt-cache write tokens, summed. */
    cache_creation_input_tokens: z.number().int().nonnegative(),
    /** Prompt-cache read tokens, summed. */
    cache_read_input_tokens: z.number().int().nonnegative(),
    /** The same totals per model, in `model` order. */
    models: z.array(SessionModelUsageSchema),
  })
  .refine(
    (event) =>
      event.models.reduce((sum, entry) => sum + entry.usage.input_tokens, 0) ===
        event.input_tokens &&
      event.models.reduce((sum, entry) => sum + entry.usage.output_tokens, 0) ===
        event.output_tokens &&
      event.models.reduce((sum, entry) => sum + entry.usage.cache_creation_input_tokens, 0) ===
        event.cache_creation_input_tokens &&
      event.models.reduce((sum, entry) => sum + entry.usage.cache_read_input_tokens, 0) ===
        event.cache_read_input_tokens,
    {
      error: 'the totals must be the sum of `models`: the breakdown is the same tokens',
      path: ['models'],
    },
  )

/** A stored `session.usage`, deep-readonly like every event (#247). */
export type SessionUsageEvent = DeepReadonly<z.infer<typeof SessionUsageEventSchema>>

/** @deprecated The plain name is deep-readonly now; use {@link SessionUsageEvent}. */
export type ImmutableSessionUsageEvent = SessionUsageEvent

/**
 * A `session.rewind` as a client sends it: the message the session should restart from.
 *
 * The input names `from_seq` alone. How far the restart reaches is not the caller's to say:
 * a rewind always covers through the end of the log, and the store records that end — the
 * `seq` the rewind event itself follows — in the `supersedes` range of the stored event, in
 * the same append, so there is no window in which the caller's idea of the log's end and the
 * store's could differ.
 */
export const SessionRewindEventInputSchema = z.object({
  type: z.literal(EVENT_TYPES.sessionRewind),
  /** The `seq` of the `user.message` the session restarts from, inclusive. */
  from_seq: EventSeqSchema,
})

export type SessionRewindEventInput = z.infer<typeof SessionRewindEventInputSchema>

/** Any stored session event. */
export const SessionEventSchema = z.discriminatedUnion('type', [
  SessionStatusRunningEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionErrorEventSchema,
  SessionRewindEventSchema,
  SessionUsageEventSchema,
  ContextSummaryEventSchema,
])

/** Any stored session event, deep-readonly (D9, issue #46). */
export type SessionEvent = DeepReadonly<z.infer<typeof SessionEventSchema>>
