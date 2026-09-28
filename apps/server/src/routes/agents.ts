import type { Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  CreateAgentRequestSchema,
  ListAgentsQuerySchema,
  UpdateAgentRequestSchema,
} from '@openharness/protocol'

import type { AppEnv } from '../types'
import { agentIdParam, parseBody, parseQuery } from '../http/request'
import { notFoundError } from '../http/errors'
import type { RouteDeps } from './deps'

/**
 * The agent endpoints.
 *
 * An agent is a reusable configuration — name, model, system prompt — and a session snapshots
 * the parts it needs when it is created, so editing an agent never rewrites what an existing
 * session is running (see the protocol's `SessionAgent`).
 */
export function registerAgentRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const agents = `${API_VERSION_PREFIX}/agents`

  app.post(agents, async (c) => {
    const body = await parseBody(c, CreateAgentRequestSchema)
    return c.json(await deps.store.createAgent(body), 201)
  })

  app.get(agents, async (c) => {
    const query = parseQuery(c, ListAgentsQuerySchema)
    return c.json(await deps.store.listAgents(query))
  })

  app.get(`${agents}/:agent_id`, async (c) => {
    const agentId = agentIdParam(c, 'agent_id')
    const agent = await deps.store.getAgent(agentId)
    if (agent === null) {
      throw notFoundError(`no agent with id ${agentId}`)
    }
    return c.json(agent)
  })

  app.post(`${agents}/:agent_id`, async (c) => {
    const agentId = agentIdParam(c, 'agent_id')
    const body = await parseBody(c, UpdateAgentRequestSchema)
    const agent = await deps.store.updateAgent(agentId, body)
    if (agent === null) {
      throw notFoundError(`no agent with id ${agentId}`)
    }
    return c.json(agent)
  })
}
