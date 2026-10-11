import type { Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import {
  API_VERSION_PREFIX,
  ConnectMcpServerRequestSchema,
  ConnectMcpServerResponseSchema,
  CreateMcpServerRequestSchema,
  UpdateMcpServerRequestSchema,
  type McpServerId,
} from '@openharness/protocol'

import { HttpError, invalidRequest, mcpConnectionError, notFoundError } from '../http/errors'
import { mcpServerIdParam, parseBody, parseOptionalBody } from '../http/request'
import { McpOAuthError } from '../mcp/oauth'
import type { AppEnv } from '../types'
import type { RouteDeps } from './deps'

/** Where the MCP server resource lives under the version prefix. */
const MCP_SERVERS_PATH = `${API_VERSION_PREFIX}/me/mcp_servers`

/**
 * The OAuth callback the provider redirects the user's browser back to (epic #303, X10; #311).
 *
 * Registered on its own, ahead of the `/v1` auth guard, by {@link registerMcpOAuthCallbackRoute}
 * — not by {@link registerMcpServerRoutes} like every other route here.
 */
const MCP_OAUTH_CALLBACK_PATH = `${MCP_SERVERS_PATH}/oauth/callback`

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
 * The one route here that is **not** owner-scoped is the callback, which cannot be: it is a
 * browser navigation, not an API call (#311). It authenticates itself by the `state` — see
 * {@link registerMcpOAuthCallbackRoute} — and every other route in this file stays behind the
 * guard.
 *
 * Two store refusals reach the client as the protocol's `conflict_error` (409), mapped in
 * `app.ts`: a name the caller already has, and the twenty-first server. A URL the SSRF guard
 * refuses, and a body its auth type cannot take, are the 400 every bad request gets. A
 * discovery, registration or token failure is the extension's 422 `mcp_connection_error`.
 */
export function registerMcpServerRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const servers = MCP_SERVERS_PATH
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
    // The body is optional (#311): `{ client: 'web' | 'cli' }` says where the flow was started,
    // and a request with no body at all means the web app.
    const body = await parseOptionalBody(c, ConnectMcpServerRequestSchema)
    const serverId = server(c)
    const started = await withOAuthError(async () =>
      deps.mcpServers.connect(c.get('user').id, serverId, body.client),
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
}

/**
 * Register `GET /v1/me/mcp_servers/oauth/callback` (epic #303, X10; #311).
 *
 * **Why it is registered separately.** `app.ts` calls this *before* the `/v1` auth guard, the
 * way it registers `/v1/auth-config`: registration order is dispatch order in Hono, so the
 * guard never runs for this one path and method. It has to be that way — the epic's decision
 * X10 has `oh` start the flow by opening the authorization URL in the **system browser**, and
 * that browser may never have signed in to this server (`oh` authenticates with a bearer token
 * from the device flow), so a signed-in session is not something the callback can require.
 *
 * **What authenticates it instead** is the `state`, and only the `state`: it is high-entropy
 * (32 random bytes), single use (consuming it deletes the row), short-lived (ten minutes) and
 * bound to the user and the server it was minted for (`mcp_oauth_states`). The flow is
 * completed for **that** user and server, read from the state — never for whoever the browser
 * happens to be. A session that *is* present is used for one thing only: if it belongs to a
 * different user than the state's, the callback is refused rather than completed, which is the
 * defence against a confused flow. Unknown, expired, replayed and misused states are all
 * refused, and the state is consumed either way, so a refused callback cannot be retried.
 *
 * **What it answers** is a page, not the protocol's envelope: this is a browser navigation. A
 * success started in the web app is a 302 back to the app's settings screen (as before); one
 * started from the CLI is a small self-contained HTML page the user can close — the CLI is
 * waiting on its own terminal, not on a redirect. Failures, the authorization server's `error`
 * included, are a readable HTML page with a 4xx status. Everything echoed into a page is
 * HTML-escaped — a server name and an `error_description` are both input — and no page is
 * cached.
 */
export function registerMcpOAuthCallbackRoute(app: Hono<AppEnv>, deps: RouteDeps): void {
  app.get(MCP_OAUTH_CALLBACK_PATH, async (c) => {
    // The caller, when there happens to be one. Resolved through Better Auth rather than read
    // from the request context, because no guard ran for this route.
    const caller = await deps.sessionUser(c.req.raw.headers)
    try {
      const completed = await deps.mcpServers.completeCallback(callbackParams(c), {
        ...(caller === null ? {} : { sessionUserId: caller.id }),
      })
      if (completed.client === 'cli') {
        return callbackPage(c, 200, {
          heading: 'Connected',
          message: `Connected ${completed.server.name}. You can close this tab and return to openharness.`,
        })
      }
      // Back to the app, which is where the user's browser came from. The query names the server
      // that was connected; the UI that reads it is #313's.
      const target = new URL('/', deps.mcpServers.callbackUrl)
      target.searchParams.set('mcp_connected', completed.server.id)
      target.hash = '#/settings'
      return c.redirect(target.href, 302)
    } catch (error) {
      // A refusal this route can explain — a bad, expired or misused state, or the
      // authorization server's own answer — is the page. Anything else is a bug here, not
      // something a browser should be told: it is rethrown so `app.onError` logs it and answers
      // the envelope, exactly as it would for any other route.
      if (!(error instanceof HttpError) && !(error instanceof McpOAuthError)) {
        throw error
      }
      const failure = callbackFailure(error)
      return callbackPage(c, failure.status, {
        heading: 'Could not connect',
        message: failure.message,
      })
    }
  })
}

/** The `code` and `state` the callback arrived with, or the refusal that stands in for them. */
function callbackParams(c: Context<AppEnv>): { readonly code: string; readonly state: string } {
  // The authorization server refused before any code was issued: its own `error` and
  // `error_description` are the readable part, bounded and escaped like everything else. Both
  // are the caller's input, so the message is cut to a length before it is rendered.
  const error = c.req.query('error')
  if (typeof error === 'string' && error.length > 0) {
    const description = c.req.query('error_description')
    const detail =
      typeof description === 'string' && description.length > 0 ? ` — ${description}` : ''
    throw invalidRequest(
      `the authorization server refused the request: ${error}${detail}`.slice(0, 300),
    )
  }
  const code = c.req.query('code')
  const state = c.req.query('state')
  if (code === undefined || code.length === 0 || state === undefined || state.length === 0) {
    throw invalidRequest('the OAuth callback needs both a `code` and a `state`')
  }
  return { code, state }
}

/** What a failed callback answers, and the page's own reason for it. */
function callbackFailure(error: HttpError | McpOAuthError): {
  readonly status: ContentfulStatusCode
  readonly message: string
} {
  if (error instanceof HttpError) {
    return { status: error.status as ContentfulStatusCode, message: error.message }
  }
  // The OAuth module's message names the endpoint and carries no secret; the same failure on a
  // `connect` is the extension's 422, so it is answered with the same status here.
  return { status: 422, message: error.message }
}

/** Answer the callback with a small, self-contained HTML page. */
function callbackPage(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  page: { readonly heading: string; readonly message: string },
): Response {
  const title = `${page.heading} — openharness`
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 32rem; padding: 0 1rem; }
      h1 { font-size: 1.25rem; }
      p { line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(page.heading)}</h1>
      <p>${escapeHtml(page.message)}</p>
    </main>
  </body>
</html>
`
  return c.html(body, status, { 'cache-control': 'no-store' })
}

/**
 * HTML-escape a value echoed into a callback page (epic #303, X10; #311).
 *
 * Both things a page carries — a server name the user chose, and the authorization server's
 * `error`/`error_description` — are input from outside this server, and a page is a page: they
 * are escaped rather than trusted, so neither can close a tag and inject script.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
