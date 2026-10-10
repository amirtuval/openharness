import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { type McpToolDefinition } from '@openharness/protocol'

/**
 * The remote-MCP client: one connection to a **Streamable HTTP** MCP server, over the official
 * `@modelcontextprotocol/sdk` (epic #303, X10).
 *
 * It lives in `@openharness/hands` because that is the package that acts on the world, and this
 * is the piece the server's connection check (#311) and the tool loop (#312) both need. It is
 * deliberately thin and dependency-free of anything but the protocol: it opens a transport,
 * initializes, lists tools — and answers the URL and headers it was **given**. The server
 * injects both, so this package never learns where a credential comes from and never reaches a
 * user-supplied URL by itself; `safeFetch` (also here) is what the server passes as `fetch` so
 * every request goes through the SSRF guard.
 *
 * Only Streamable HTTP is supported. The stdio transport spawns a local process, which this
 * server does not do, and the deprecated HTTP+SSE transport is what Streamable HTTP replaced.
 */

/** The client name the SDK announces in `initialize`. */
export const MCP_CLIENT_NAME = 'openharness'

/** The client version the SDK announces in `initialize`. */
export const MCP_CLIENT_VERSION = '1.0.0'

/**
 * How the transport makes a request. Matches the SDK's own `FetchLike`, so a `safeFetch`
 * wrapper (or `globalThis.fetch`) is assignable.
 */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

/** Everything {@link openMcpClient} takes. */
export interface McpClientOptions {
  /** The server's Streamable HTTP endpoint. */
  readonly url: string
  /**
   * Headers to send on every request — a `headers` server's sealed map, or an `oauth` server's
   * `Authorization: Bearer …`. The caller builds them and is the only one who ever sees them.
   */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * The fetch the transport uses. The server passes a `safeFetch` wrapper so a user-supplied
   * URL is guarded; the default is the platform `fetch`.
   */
  readonly fetch?: McpFetch
  /**
   * How long one request may take, passed to the SDK's `RequestOptions`. The default is the
   * SDK's own; a connection check sets a short one so a hung server cannot hold a request open.
   */
  readonly timeoutMs?: number
  /** The client name announced in `initialize`; {@link MCP_CLIENT_NAME} by default. */
  readonly clientName?: string
  /** The client version announced in `initialize`; {@link MCP_CLIENT_VERSION} by default. */
  readonly clientVersion?: string
}

/**
 * An initialized connection to one MCP server.
 *
 * `listTools` reads the server's whole tool list, following pagination; `close` ends the
 * transport. The underlying SDK `client` is exposed so the tool loop (#312) can call tools
 * without this module inventing a call API the connection check does not need.
 */
export interface McpClientSession {
  /** The tools the server offers, as this protocol's definitions. */
  listTools(): Promise<McpToolDefinition[]>
  /** The underlying SDK client, for a caller that needs more than {@link McpClientSession.listTools}. */
  readonly client: Client
  /** End the transport. Idempotent. */
  close(): Promise<void>
}

/**
 * Open and initialize a connection to a remote MCP server.
 *
 * The caller owns the returned session and must `close()` it. A transport or initialization
 * failure rejects — the connection check turns that into the server's `status: 'error'`, and a
 * chat never fails on it (epic #303).
 */
export async function openMcpClient(options: McpClientOptions): Promise<McpClientSession> {
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    ...(options.headers === undefined ? {} : { requestInit: { headers: { ...options.headers } } }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  })
  const client = new Client(
    {
      name: options.clientName ?? MCP_CLIENT_NAME,
      version: options.clientVersion ?? MCP_CLIENT_VERSION,
    },
    { capabilities: {} },
  )
  await client.connect(transport)
  const requestOptions = options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }
  return {
    client,
    async listTools(): Promise<McpToolDefinition[]> {
      const definitions: McpToolDefinition[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor }, requestOptions)
        for (const tool of page.tools) {
          definitions.push(mcpToolDefinition(tool))
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return definitions
    },
    async close(): Promise<void> {
      await client.close()
    },
  }
}

/**
 * One SDK tool as this protocol's definition: the name, the description (or `null`) and the
 * input schema exactly as the server sent it.
 */
export function mcpToolDefinition(tool: Tool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description ?? null,
    input_schema: tool.inputSchema ?? {},
  }
}
