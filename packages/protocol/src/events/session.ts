import { z } from 'zod'

import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { EVENT_TYPES, EventSeqSchema, ProcessedAtSchema } from './common'

/**
 * Events the session itself emits: status transitions and errors.
 *
 * They bracket a turn — `session.status_running` opens it, `session.status_idle` closes it —
 * so replaying just these events gives the session's state at any point in the log.
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

/** Any stored session event. */
export const SessionEventSchema = z.discriminatedUnion('type', [
  SessionStatusRunningEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionErrorEventSchema,
])

/** Any stored session event, deep-readonly (D9, issue #46). */
export type SessionEvent = DeepReadonly<z.infer<typeof SessionEventSchema>>
