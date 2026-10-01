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
 * Its `status` mirrors the last status event in the log, and its `agent` block is the
 * configuration the session was created with, frozen at creation time.
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
 * The agent a session runs, snapshotted when the session was created.
 *
 * Editing the agent afterwards does not change existing sessions: a session replays to the
 * same conversation forever, which is what makes the log the source of truth.
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
  agent: SessionAgentSchema,
  created_at: TimestampSchema,
  updated_at: TimestampSchema,
})

export type Session = z.infer<typeof SessionSchema>

/**
 * Body of `POST /v1/sessions`. Response: {@link SessionSchema}.
 *
 * `agent` is an `agent_` id: the session snapshots the current agent configuration, so
 * there is nothing else for a client to say about it. Anthropic additionally accepts an
 * inline agent reference with a `version`, or one with per-session model overrides;
 * openharness has neither agent versioning nor overrides (see `AGENTS.md`).
 */
export const CreateSessionRequestSchema = z.object({
  agent: AgentIdSchema,
  title: z.string().max(SESSION_TITLE_MAX_LENGTH).nullable().optional(),
  metadata: MetadataSchema.optional(),
  /**
   * Events to append to the new session's log, in order, before it starts running. They are
   * stored exactly as events sent later to the events endpoint would be.
   */
  initial_events: z.array(UserEventInputSchema).max(MAX_INITIAL_EVENTS).optional(),
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
