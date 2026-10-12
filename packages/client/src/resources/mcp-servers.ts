import {
  API_VERSION_PREFIX,
  ConnectMcpServerResponseSchema,
  ListMcpServersResponseSchema,
  McpServerSchema,
} from '@openharness/protocol'
import type {
  ConnectMcpServerRequest,
  ConnectMcpServerResponse,
  CreateMcpServerRequest,
  ListMcpServersResponse,
  McpServer,
  UpdateMcpServerRequest,
} from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The caller's own remote MCP servers (epic #303, X10; the screen is #313).
 *
 * ```
 * POST   /v1/me/mcp_servers                          create  -> 201 mcp_server
 * GET    /v1/me/mcp_servers                          list    -> { data: mcp_server[] }
 * GET    /v1/me/mcp_servers/{id}                     get     -> mcp_server
 * POST   /v1/me/mcp_servers/{id}                     update  -> mcp_server
 * DELETE /v1/me/mcp_servers/{id}                     delete  -> 204
 * POST   /v1/me/mcp_servers/{id}/test                check   -> mcp_server
 * POST   /v1/me/mcp_servers/{id}/connect             start   -> { authorization_url }
 * POST   /v1/me/mcp_servers/{id}/disconnect          drop    -> mcp_server
 * ```
 *
 * A server is per user — its routes live under `/v1/me`, its owner is the authenticated caller,
 * and another user's server is a 404 — and it bundles a URL, how requests authenticate
 * (`none`, `headers` or `oauth`) and whether it is on by default. The list has no pagination:
 * a user holds at most `MAX_MCP_SERVERS_PER_USER` servers, so a settings screen shows them all
 * at once.
 *
 * Secrets never come back. A `headers` server reports the header **names** it sends, an `oauth`
 * one reports only its `status`, and a `create` or `update` that carries a header map replaces
 * the sealed one — omitting it leaves the stored map alone, so a rename or an enable does not
 * require re-entering a secret.
 *
 * `test` runs the connection check now: the server is initialized, its tools are listed and
 * each definition's token cost is estimated, and the refreshed server (with `tools`,
 * `definition_tokens`, `status` and `last_error`) comes back. `connect` starts the OAuth flow
 * and answers the authorization URL to open; the provider then redirects the browser back to
 * the server's own callback route, which completes the flow, and the app's settings screen is
 * where a web flow lands (`?mcp_connected=<id>`).
 */
export interface McpServersResource {
  /**
   * Register a server. The connection check runs on save for a `none` or `headers` server, so
   * it comes back with its tools and its status.
   *
   * @param body the server's fields; `auth` selects which of them apply
   * @param options request options (cancellation)
   * @throws ApiError with `conflict_error` (409) for a name the caller already has, or when
   * they already hold `MAX_MCP_SERVERS_PER_USER` servers
   */
  create(body: CreateMcpServerRequest, options?: RequestOptions): Promise<McpServer>

  /**
   * List the caller's servers, oldest first.
   *
   * @param options request options (cancellation)
   */
  list(options?: RequestOptions): Promise<ListMcpServersResponse>

  /**
   * Read one server.
   *
   * @param serverId the `mcps_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such server, or it is another
   * user's
   */
  get(serverId: string, options?: RequestOptions): Promise<McpServer>

  /**
   * Update a server. Omitted fields keep their value; `headers` replaces the sealed map.
   *
   * @param serverId the `mcps_` id
   * @param body the fields to change
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such server
   */
  update(
    serverId: string,
    body: UpdateMcpServerRequest,
    options?: RequestOptions,
  ): Promise<McpServer>

  /**
   * Delete a server and its pending OAuth states.
   *
   * @param serverId the `mcps_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such server
   */
  delete(serverId: string, options?: RequestOptions): Promise<void>

  /**
   * Run the connection check now and read the refreshed server back.
   *
   * @param serverId the `mcps_` id
   * @param options request options (cancellation)
   */
  test(serverId: string, options?: RequestOptions): Promise<McpServer>

  /**
   * Start the OAuth 2.1 flow: discovery, dynamic client registration, PKCE.
   *
   * @param serverId the `mcps_` id
   * @param body where the flow was started — `web` (the app, the default) or `cli` (`oh`), which
   * changes how the callback answers
   * @param options request options (cancellation)
   * @throws ApiError with `mcp_connection_error` (422) when the server cannot be reached,
   * discovered or registered as a client
   */
  connect(
    serverId: string,
    body?: ConnectMcpServerRequest,
    options?: RequestOptions,
  ): Promise<ConnectMcpServerResponse>

  /**
   * Drop an `oauth` server's tokens. The server lands on `needs_reconnect`.
   *
   * @param serverId the `mcps_` id
   * @param options request options (cancellation)
   */
  disconnect(serverId: string, options?: RequestOptions): Promise<McpServer>
}

/** Build the MCP servers resource over a transport. */
export function createMcpServersResource(transport: Transport): McpServersResource {
  const path = `${API_VERSION_PREFIX}/me/mcp_servers`

  return {
    create(body, options) {
      return transport.json(McpServerSchema, {
        method: 'POST',
        path,
        body,
        signal: options?.signal,
      })
    },

    list(options) {
      return transport.json(ListMcpServersResponseSchema, {
        method: 'GET',
        path,
        signal: options?.signal,
      })
    },

    get(serverId, options) {
      return transport.json(McpServerSchema, {
        method: 'GET',
        path: `${path}/${serverId}`,
        signal: options?.signal,
      })
    },

    update(serverId, body, options) {
      return transport.json(McpServerSchema, {
        method: 'POST',
        path: `${path}/${serverId}`,
        body,
        signal: options?.signal,
      })
    },

    delete(serverId, options) {
      return transport.noContent({
        method: 'DELETE',
        path: `${path}/${serverId}`,
        signal: options?.signal,
      })
    },

    test(serverId, options) {
      return transport.json(McpServerSchema, {
        method: 'POST',
        path: `${path}/${serverId}/test`,
        signal: options?.signal,
      })
    },

    connect(serverId, body, options) {
      return transport.json(ConnectMcpServerResponseSchema, {
        method: 'POST',
        path: `${path}/${serverId}/connect`,
        // The route accepts a request with no body at all (#311), and `web` is what an omitted
        // `client` means — so a caller that starts a web flow sends none.
        body: body ?? {},
        signal: options?.signal,
      })
    },

    disconnect(serverId, options) {
      return transport.json(McpServerSchema, {
        method: 'POST',
        path: `${path}/${serverId}/disconnect`,
        signal: options?.signal,
      })
    },
  }
}
