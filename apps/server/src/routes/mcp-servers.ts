import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  ConnectMcpServerResponseSchema,
  CreateMcpServerRequestSchema,
  UpdateMcpServerRequestSchema,
  type McpServerId,
} from '@openharness/protocol'

import { invalidRequest, mcpConnectionError, notFoundError } from '../http/errors'
import { mcpServerIdParam, parseBody } from '../http/request'
import { McpOAuthError } from '../mcp/oauth'
import type { AppEnv } from '../types'
import type { RouteDeps } from './deps'

/**
 * The remote-MCP-server endpoints (epic #303, X10):
 *
 * ```
 * POST   /v1/me/mcp_servers                          create (201)
 * GET    /v1/me/mcp_servers                          the caller's own
 * GET    /v1/me/mcp_servers/{mcp_server_id}          one, or 404
 * POST   /v1/me/mcp_servers/{mcp_server_id}          update
 * DELETE /v1/me/mcp_servers/{mcp_server_id}          204, or 404
 * POST   /v1/me/mcp_servers/{mcp_server_id}/test     the connection check
 * POST   /v1/me/mcp_servers/{mcp_server_id}/connect  start OAuth; answers the authorization URL
 * POST   /v1/me/mcp_servers/{mcp_server_id}/disconnect  drop the tokens
 * GET    /v1/me/mcp_servers/oauth/callback           the provider's redirect back
 * ```
 *
 * Every server belongs to the caller like any other resource (A4): the owner is always
 * `c.get('user').id`, no request carries one, and another user's server answers 404 rather
 * than 403. The routes only read and write; the sealing, the connection check and the OAuth
 * flow are `mcp/service.ts`.
 *
 * Two store refusals reach the client as the protocol's `conflict_error` (409), mapped in
 * `app.ts`: a name the caller already has, and the twenty-first server. A URL the SSRF guard
 * refuses, and a body its auth type cannot take, are the 400 every bad request gets. A
 * discovery, registration or token failure is the extension's 422 `mcp_connection_error`.
 */
export function registerMcpServerRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const servers = `${API_VERSION_PREFIX}/me/mcp_servers`
  const server = (c: Context<AppEnv>): McpServerId => mcpServerIdParam(c, 'mcp_server_id')

  app.post(servers, async (c) => {
    const body = await parseBody(c, CreateMcpServerRequestSchema)
    const created = await deps.mcpServers.create(c.get('user').id, body)
    return c.json(created, 201)
  })

  app.get(servers, async (c) => {
    const data = await deps.mcpServers.list(c.get('user').id)
    return c.json({ data })
  })

  app.get(`${servers}/:mcp_server_id`, async (c) => {
    const serverId = server(c)
    const found = await deps.mcpServers.get(c.get('user').id, serverId)
    if (found === null) {
      throw notFoundError(`no MCP server with id ${serverId}`)
    }
    return c.json(found)
  })

  app.post(`${servers}/:mcp_server_id`, async (c) => {
    const body = await parseBody(c, UpdateMcpServerRequestSchema)
    const serverId = server(c)
    const updated = await deps.mcpServers.update(c.get('user').id, serverId, body)
    if (updated === null) {
      throw notFoundError(`no MCP server with id ${serverId}`)
    }
    return c.json(updated)
  })

  app.delete(`${servers}/:mcp_server_id`, async (c) => {
    const serverId = server(c)
    if (!(await deps.mcpServers.delete(c.get('user').id, serverId))) {
      throw notFoundError(`no MCP server with id ${serverId}`)
    }
    return c.body(null, 204)
  })

  app.post(`${servers}/:mcp_server_id/test`, async (c) => {
    const serverId = server(c)
    const tested = await deps.mcpServers.test(c.get('user').id, serverId)
    if (tested === null) {
      throw notFoundError(`no MCP server with id ${serverId}`)
    }
    return c.json(tested)
  })

  app.post(`${servers}/:mcp_server_id/connect`, async (c) => {
    const serverId = server(c)
    const started = await withOAuthError(async () =>
      deps.mcpServers.connect(c.get('user').id, serverId),
    )
    if (started === null) {
      throw notFoundError(`no MCP server with id ${serverId}`)
    }
    // The response shape is the protocol's; parsing it here is what keeps the route honest
    // about it.
    return c.json(ConnectMcpServerResponseSchema.parse(started))
  })

  app.post(`${servers}/:mcp_server_id/disconnect`, async (c) => {
    const serverId = server(c)
    const updated = await deps.mcpServers.disconnect(c.get('user').id, serverId)
    if (updated === null) {
      throw notFoundError(`no MCP server with id ${serverId}`)
    }
    return c.json(updated)
  })

  app.get(`${servers}/oauth/callback`, async (c) => {
    const error = c.req.query('error')
    if (typeof error === 'string' && error.length > 0) {
      const description = c.req.query('error_description')
      throw invalidRequest(
        `the authorization server refused the request: ${error}` +
          (typeof description === 'string' && description.length > 0 ? ` — ${description}` : ''),
      )
    }
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (code === undefined || code.length === 0 || state === undefined || state.length === 0) {
      throw invalidRequest('the OAuth callback needs both a `code` and a `state`')
    }
    const completed = await withOAuthError(async () =>
      deps.mcpServers.completeCallback(c.get('user').id, { code, state }),
    )
    // Back to the app, which is where the user's browser came from. The query names the server
    // that was connected; the UI that reads it is #313's.
    const target = new URL('/', deps.mcpServers.callbackUrl)
    target.searchParams.set('mcp_connected', completed.id)
    target.hash = '#/settings'
    return c.redirect(target.href, 302)
  })
}

/**
 * Run an OAuth step, mapping its failure to the protocol's 422 `mcp_connection_error`.
 *
 * A discovery, registration or token failure is a well-formed request that could not be
 * brought into a usable state — unprocessable, not a malformed request — and the message the
 * OAuth module built names the endpoint without echoing a secret.
 */
async function withOAuthError<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof McpOAuthError) {
      throw mcpConnectionError(error.message)
    }
    throw error
  }
}
