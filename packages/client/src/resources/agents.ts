import { API_VERSION_PREFIX, AgentSchema, ListAgentsResponseSchema } from '@openharness/protocol'
import type {
  Agent,
  CreateAgentRequest,
  ListAgentsQuery,
  ListAgentsResponse,
  UpdateAgentRequest,
} from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The `agent` endpoints: a reusable configuration that sessions are created from.
 *
 * ```
 * POST /v1/agents        create  -> agent
 * GET  /v1/agents        list    -> { data: agent[], next_page }
 * GET  /v1/agents/{id}   get     -> agent
 * POST /v1/agents/{id}   update  -> agent
 * ```
 *
 * A session snapshots its agent at creation time, so updating an agent never rewrites what an
 * existing session runs.
 */
export interface AgentsResource {
  /**
   * Create an agent.
   *
   * @param body the agent's fields; `model.id` is a model id, `provider/model`
   * @param options request options (cancellation)
   */
  create(body: CreateAgentRequest, options?: RequestOptions): Promise<Agent>

  /**
   * Read one agent.
   *
   * @param agentId the `agent_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such agent
   */
  get(agentId: string, options?: RequestOptions): Promise<Agent>

  /**
   * Read one page of agents, oldest first.
   *
   * The result is the wire envelope: `data` holds the agents, and `next_page` is the opaque
   * cursor to hand back as `page` for the next one — or `null` at the end of the list. This
   * package never decodes a cursor.
   *
   * @param params `limit` and `page`
   * @param options request options (cancellation)
   */
  list(params?: ListAgentsQuery, options?: RequestOptions): Promise<ListAgentsResponse>

  /**
   * Update an agent. Omitted fields keep their value; `null` clears a nullable one.
   *
   * @param agentId the `agent_` id
   * @param body the fields to change
   * @param options request options (cancellation)
   */
  update(agentId: string, body: UpdateAgentRequest, options?: RequestOptions): Promise<Agent>
}

/** Build the agents resource over a transport. */
export function createAgentsResource(transport: Transport): AgentsResource {
  const path = `${API_VERSION_PREFIX}/agents`

  return {
    create(body, options) {
      return transport.json(AgentSchema, {
        method: 'POST',
        path,
        body,
        signal: options?.signal,
      })
    },

    get(agentId, options) {
      return transport.json(AgentSchema, {
        method: 'GET',
        path: `${path}/${agentId}`,
        signal: options?.signal,
      })
    },

    list(params, options) {
      return transport.json(ListAgentsResponseSchema, {
        method: 'GET',
        path,
        query: { limit: params?.limit, page: params?.page },
        signal: options?.signal,
      })
    },

    update(agentId, body, options) {
      return transport.json(AgentSchema, {
        method: 'POST',
        path: `${path}/${agentId}`,
        body,
        signal: options?.signal,
      })
    },
  }
}
