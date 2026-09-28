import { z } from 'zod'

import { EventIdSchema } from '../ids'
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

export type SessionStatusRunningEvent = z.infer<typeof SessionStatusRunningEventSchema>

/** The agent finished its turn and is waiting for input. Closes every turn. */
export const SessionStatusIdleEventSchema = z.object({
  id: EventIdSchema,
  type: z.literal(EVENT_TYPES.sessionStatusIdle),
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  stop_reason: StopReasonSchema,
})

export type SessionStatusIdleEvent = z.infer<typeof SessionStatusIdleEventSchema>

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

export type SessionStatusRescheduledEvent = z.infer<typeof SessionStatusRescheduledEventSchema>

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
])

export type SessionErrorType = z.infer<typeof SessionErrorTypeSchema>

/** The `error` object of a `session.error` event. */
export const SessionErrorSchema = z.object({
  type: SessionErrorTypeSchema,
  message: z.string(),
  retry_status: RetryStatusSchema,
})

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

export type SessionErrorEvent = z.infer<typeof SessionErrorEventSchema>

/** Any stored session event. */
export const SessionEventSchema = z.discriminatedUnion('type', [
  SessionStatusRunningEventSchema,
  SessionStatusIdleEventSchema,
  SessionStatusRescheduledEventSchema,
  SessionErrorEventSchema,
])

export type SessionEvent = z.infer<typeof SessionEventSchema>
