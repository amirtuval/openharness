import { z } from 'zod'

import { MetadataSchema, PageLimitSchema, TimestampSchema } from '../common'
import {
  COMPACT_INSTRUCTIONS_MAX_LENGTH,
  SessionCompactEventSchema,
  type SessionCompactEvent,
} from '../events/session'
import { UserEventInputSchema } from '../events/user'
import { AgentIdSchema, ModeIdSchema, SessionIdSchema } from '../ids'
import { NextPageSchema, PageCursorStringSchema } from '../pagination'
import { AGENT_NAME_MAX_LENGTH, ModelConfigSchema } from './agent'
import { UserIdSchema } from './user'

/**
 * The `session` resource and the endpoints that manage it:
 *
 * - `POST   /v1/sessions`
 * - `GET    /v1/sessions`
 * - `GET    /v1/sessions/{session_id}`
 * - `DELETE /v1/sessions/{session_id}`
 * - `POST   /v1/sessions/{session_id}/compact` (`/compact [instructions]`, epic #277 K8; #283)
 *
 * A session is a durable, append-only event log; the resource here is the header of that log.
 * Its `status` mirrors the last status event in the log, and its `model` and `system` are the
 * configuration it runs, always set — frozen at creation time, along with the `agent` preset
 * it was created from, when there was one. The one exception to "frozen": a `user.message`
 * carrying a `model` switches what the session runs from that message on (#111), and a
 * `user.message` carrying a `mode` switches — or detaches — the mode a chat follows (#245, M6).
 *
 * `DELETE` answers `204` and removes the session and its whole log (epic #116, U5) — an
 * owner-scoped operation, so another user's session answers `404`. It is the explicit
 * exception to the append-only rule, alongside compaction, and it is irreversible; open
 * streams for the session receive a final `session.deleted` event and close.
 */

/** Longest session title Anthropic accepts. */
export const SESSION_TITLE_MAX_LENGTH = 500

/**
 * How many initial events a session may be created with. Anthropic's limit.
 */
export const MAX_INITIAL_EVENTS = 50

/**
 * The session's state: `idle` when the agent is waiting for input, `running` while it works.
 *
 * Anthropic's `SessionStatus` also has `rescheduling` and `terminated`. openharness models
 * retries as `session.status_rescheduled` events in the log rather than as a resting status,
 * and v1 has no termination, so the resource reports only these two (see `AGENTS.md`). The
 * event log remains the precise record; this field is a summary of it.
 */
export const SessionStatusSchema = z.enum(['idle', 'running'])

export type SessionStatus = z.infer<typeof SessionStatusSchema>

/**
 * The agent a session runs, snapshotted when the session was created — or `null` for a
 * session created from a model alone.
 *
 * Editing the agent afterwards does not change existing sessions: a session replays to the
 * same conversation forever, which is what makes the log the source of truth. The snapshot is
 * the preset the session was created *from*, not the configuration it runs: what it runs is
 * {@link SessionSchema}'s `model` and `system`, which the request may have overridden.
 *
 * Anthropic's `BetaManagedAgentsSessionAgent` also carries `description`, `mcp_servers`,
 * `skills`, `tools` and `version`; v1 keeps the four fields the brain needs (see
 * `AGENTS.md`).
 */
export const SessionAgentSchema = z.object({
  id: AgentIdSchema,
  name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
  model: ModelConfigSchema,
  system: z.string().nullable(),
})

export type SessionAgent = z.infer<typeof SessionAgentSchema>

/** The `session` resource. */
export const SessionSchema = z.object({
  id: SessionIdSchema,
  type: z.literal('session'),
  /**
   * // extension: the user this session belongs to (epic #65, A4).
   *
   * Read-only, set by the server from the authenticated caller at creation; no request ever
   * carries it. A session whose owner is not the caller answers `404`, exactly as an agent
   * does, so a session's existence never leaks across users.
   *
   * Required since #61: the server sets it on every session it creates, so a session without
   * one cannot exist — and a response that omits it fails this schema rather than passing as
   * unowned.
   */
  owner_id: UserIdSchema,
  status: SessionStatusSchema,
  title: z.string().max(SESSION_TITLE_MAX_LENGTH).nullable(),
  metadata: MetadataSchema,
  /**
   * // extension: the configuration the session actually runs, always set (issue #93).
   *
   * A session no longer has to be created from an agent: it is created from a model, and an
   * agent — when there is one — is the preset it snapshotted. `model` is that effective
   * model: the agent's, the request's override of it, or the inline model of an agent-less
   * session. Anthropic has no equivalent field; there the session's `agent` always carries
   * the model.
   */
  model: ModelConfigSchema,
  /**
   * // extension: the effective system prompt, always present (issue #93).
   *
   * The agent's `system`, the request's override of it, or `null` — for an agent-less session
   * whose request named no `system`. Like `model`, an Anthropic session has no field of its
   * own for it.
   */
  system: z.string().nullable(),
  /**
   * // extension: the mode this chat follows (#245, M6), or `null` for a chat without one.
   *
   * A chat started from a mode follows it live: the next request resolves the mode as it is
   * now, and runs its model, effort and prompt addition — even after the mode was edited. It
   * is set by the message or create request that picked the mode, and cleared by a message
   * that picks a plain `model` or by deleting the mode, which lands the chat on the model it
   * last ran. `model` above stays the resolved model the session last ran, so a chat whose
   * mode is gone still has a model to continue on.
   */
  mode: ModeIdSchema.nullable(),
  /**
   * The preset the session was created from, snapshotted — or `null` for a model-first
   * session. `model` and `system` above are what the session runs; this is where it came from.
   */
  agent: SessionAgentSchema.nullable(),
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
})

export type Session = z.infer<typeof SessionSchema>

/**
 * Body of `POST /v1/sessions`. Response: {@link SessionSchema}.
 *
 * A session is created from an agent, a model, or both, and **at least one of the two is
 * required** — the refinement below is where the requirement is stated, so a request naming
 * neither fails with a clear message rather than creating a session that cannot run.
 *
 * - **From an agent.** `agent` is an `agent_` id: the session snapshots the current agent
 *   configuration (its name, model and system) and runs it. An explicit `model` or `system`
 *   in the request overrides what the agent contributes.
 * - **From a model.** Without an `agent`, `model` is required and `system` defaults to
 *   `null`: this is model-first chat, where the user picks a model and the agent is an
 *   optional preset (epic #92).
 * - **From a mode** (#245, M6). `mode` is a `mode_` id: the session is created on the user's
 *   mode, which the server resolves to a model for the session's header. A `mode` this way
 *   stands in for `model`, and the session follows the mode live from then on.
 *
 * Anthropic additionally accepts an inline agent reference with a `version`, or one with
 * per-session model overrides; openharness has neither agent versioning nor overrides in that
 * shape (see `AGENTS.md`) — its overrides are these top-level `model` and `system` fields.
 */
export const CreateSessionRequestSchema = z
  .object({
    /** The agent whose configuration the session snapshots. Required unless `model` is given. */
    agent: AgentIdSchema.optional(),
    /** The model the session runs, `provider/model`. Overrides the agent's; required without one. */
    model: ModelConfigSchema.optional(),
    /** The system prompt the session runs with. Overrides the agent's; `null` without one. */
    system: z.string().nullable().optional(),
    /**
     * // extension: the id of the user's mode the session is created on (#245, M6). The
     * server resolves it to the session's header model; the chat then follows the mode live.
     */
    mode: ModeIdSchema.optional(),
    title: z.string().max(SESSION_TITLE_MAX_LENGTH).nullable().optional(),
    metadata: MetadataSchema.optional(),
    /**
     * Events to append to the new session's log, in order, before it starts running. They are
     * stored exactly as events sent later to the events endpoint would be.
     */
    initial_events: z.array(UserEventInputSchema).max(MAX_INITIAL_EVENTS).optional(),
  })
  .refine(
    (request) =>
      request.agent !== undefined || request.model !== undefined || request.mode !== undefined,
    {
      message:
        'a session needs an agent, a model or a mode: pass "agent", "model" for a model-first ' +
        'session, or "mode" for one on a mode',
    },
  )

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>

/**
 * Body of `POST /v1/sessions/{session_id}/compact` (epic #277, K8; #283).
 *
 * The user's optional guidance for the summary — "keep the API decisions in detail" — bounded by
 * {@link COMPACT_INSTRUCTIONS_MAX_LENGTH}. The request always produces a stored `session.compact`
 * event; the body has no `type` because the endpoint, not the caller, decides that. Omit it (or
 * send `{}`) for a plain `/compact`.
 */
export const CompactSessionRequestSchema = z.object({
  /** The user's guidance for the summary, or omitted for none. */
  instructions: z.string().min(1).max(COMPACT_INSTRUCTIONS_MAX_LENGTH).optional(),
})

export type CompactSessionRequest = z.infer<typeof CompactSessionRequestSchema>

/**
 * Response of `POST /v1/sessions/{session_id}/compact`: the stored — or already pending —
 * `session.compact` request, deep-readonly.
 *
 * The route is idempotent while a request is pending, so `data` is the request this call
 * produced, or the one already waiting for an answer. A client reads the outcome, when there is
 * one, from the log or the stream — a `session.compaction` after this event.
 */
export const CompactSessionResponseSchema = z.object({
  data: SessionCompactEventSchema,
})

export interface CompactSessionResponse {
  readonly data: SessionCompactEvent
}

/**
 * Query parameters of `GET /v1/sessions`.
 *
 * The list is ordered by `(created_at, id)`, newest first, and `page` resumes at a keyset
 * position in it — not at an item offset, which would shift while a client pages through a
 * list that sessions are still being added to.
 */
export const ListSessionsQuerySchema = z.object({
  /** Maximum results per page. Defaults to `DEFAULT_PAGE_LIMIT`, capped at `MAX_PAGE_LIMIT`. */
  limit: PageLimitSchema.optional(),
  /** Cursor from a previous response's `next_page`: the `(created_at, id)` of its last session. */
  page: PageCursorStringSchema.optional(),
  /** Return only sessions created with this agent. Anthropic's `agent_id` filter. */
  agent_id: AgentIdSchema.optional(),
})

export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>

/** Response of `GET /v1/sessions`: the Anthropic list envelope. */
export const ListSessionsResponseSchema = z.object({
  data: z.array(SessionSchema),
  next_page: NextPageSchema,
})

export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>
