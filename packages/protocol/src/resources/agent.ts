import { z } from 'zod'

import { PageLimitSchema, TimestampSchema } from '../common'
import { AgentIdSchema } from '../ids'
import { NextPageSchema, PageCursorStringSchema } from '../pagination'
import { UserIdSchema } from './user'

/**
 * The `agent` resource and the endpoints that manage it:
 *
 * - `POST   /v1/agents`
 * - `GET    /v1/agents`
 * - `GET    /v1/agents/{agent_id}`
 * - `POST   /v1/agents/{agent_id}` (update)
 *
 * An agent is a reusable configuration. Sessions snapshot the fields they need at creation
 * time (see `SessionAgentSchema`), so editing an agent never rewrites history.
 */

/** Longest agent name Anthropic accepts. */
export const AGENT_NAME_MAX_LENGTH = 256

/** Longest agent description Anthropic accepts. */
export const AGENT_DESCRIPTION_MAX_LENGTH = 2048

/**
 * The model an agent runs, e.g. `{ "id": "anthropic/claude-sonnet-5" }`.
 *
 * `id` is a **Mastra model-router string**, `provider/model` — not a bare Anthropic model id.
 * Anthropic's object also carries `effort`, `inference_geo` and `speed`; this is the subset
 * v1 stores, and unknown fields are dropped rather than rejected so that a real Anthropic
 * response still parses.
 */
export const ModelConfigSchema = z.object({
  id: z.string().min(1),
})

export type ModelConfig = z.infer<typeof ModelConfigSchema>

/** The `agent` resource as Anthropic defines it, limited to the fields v1 stores. */
export const AgentSchema = z.object({
  id: AgentIdSchema,
  type: z.literal('agent'),
  /**
   * // extension: the user this agent belongs to (epic #65, A4).
   *
   * Read-only, set by the server from the authenticated caller: no request ever carries it —
   * `POST /v1/agents` takes the owner from the session that made the call — and it never
   * changes afterwards. Together with a `404` for anything another user owns, it is the whole
   * of v1 isolation: nothing is shared.
   *
   * Optional only during the transition: while the server still serves pre-auth data
   * (through #61) it may be absent. From #61 on the server sets it on every agent, and it is
   * to become required.
   */
  owner_id: UserIdSchema.optional(),
  name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
  description: z.string().max(AGENT_DESCRIPTION_MAX_LENGTH).nullable(),
  model: ModelConfigSchema,
  system: z.string().nullable(),
  created_at: TimestampSchema,
  /** When the agent was last changed. Set on update; equal to `created_at` at creation. */
  updated_at: TimestampSchema,
})

export type Agent = z.infer<typeof AgentSchema>

/** Body of `POST /v1/agents`. Response: {@link AgentSchema}. */
export const CreateAgentRequestSchema = z.object({
  name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH),
  description: z.string().max(AGENT_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  model: ModelConfigSchema,
  system: z.string().nullable().optional(),
})

export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>

/**
 * Body of `POST /v1/agents/{agent_id}`. Every field is optional; omitted fields keep their
 * stored value, and `null` clears a nullable one. Response: {@link AgentSchema}.
 */
export const UpdateAgentRequestSchema = z.object({
  name: z.string().min(1).max(AGENT_NAME_MAX_LENGTH).optional(),
  description: z.string().max(AGENT_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  model: ModelConfigSchema.optional(),
  system: z.string().nullable().optional(),
})

export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>

/**
 * Query parameters of `GET /v1/agents`.
 *
 * The list is ordered by `(created_at, id)`; `page` resumes at a keyset position in it.
 */
export const ListAgentsQuerySchema = z.object({
  /** Maximum results per page. Defaults to `DEFAULT_PAGE_LIMIT`, capped at `MAX_PAGE_LIMIT`. */
  limit: PageLimitSchema.optional(),
  /** Cursor from a previous response's `next_page`: the `(created_at, id)` of its last agent. */
  page: PageCursorStringSchema.optional(),
})

export type ListAgentsQuery = z.infer<typeof ListAgentsQuerySchema>

/** Response of `GET /v1/agents`: the Anthropic list envelope. */
export const ListAgentsResponseSchema = z.object({
  data: z.array(AgentSchema),
  next_page: NextPageSchema,
})

export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>
