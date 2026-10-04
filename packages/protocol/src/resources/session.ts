import { z } from 'zod'

import { MetadataSchema, PageLimitSchema, TimestampSchema } from '../common'
import { UserEventInputSchema } from '../events/user'
import { AgentIdSchema, SessionIdSchema } from '../ids'
import { NextPageSchema, PageCursorStringSchema } from '../pagination'
import { AGENT_NAME_MAX_LENGTH, ModelConfigSchema } from './agent'
import { UserIdSchema } from './user'

/**
 * The `session` resource and the endpoints that manage it:
 *
 * - `POST /v1/sessions`
 * - `GET  /v1/sessions`
 * - `GET  /v1/sessions/{session_id}`
 *
 * A session is a durable, append-only event log; the resource here is the header of that log.
 * Its `status` mirrors the last status event in the log, and its `model` and `system` are the
 * configuration it runs, always set — frozen at creation time, along with the `agent` preset
 * it was created from, when there was one.
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
    title: z.string().max(SESSION_TITLE_MAX_LENGTH).nullable().optional(),
    metadata: MetadataSchema.optional(),
    /**
     * Events to append to the new session's log, in order, before it starts running. They are
     * stored exactly as events sent later to the events endpoint would be.
     */
    initial_events: z.array(UserEventInputSchema).max(MAX_INITIAL_EVENTS).optional(),
  })
  .refine((request) => request.agent !== undefined || request.model !== undefined, {
    message:
      'a session needs an agent or a model: pass "agent", or "model" for a model-first session',
  })

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>

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
