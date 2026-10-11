import type { McpListingFailure, McpOfferedTool, McpToolProvider } from '@openharness/brain'
import type { McpFetch, ToolDefinition } from '@openharness/hands'
import { createMcpTool, openMcpClient, scrubText } from '@openharness/hands'
import type { McpServer, McpToolDefinition, ModeToolOverride, UserId } from '@openharness/protocol'
import { MCP_LAST_ERROR_MAX_LENGTH } from '@openharness/protocol'

import type { Logger } from '../types'
import { listMcpServersInForce } from './in-force'
import type { McpServerService } from './service'

/**
 * The remote tools a request may offer, listed from the in-force servers (epic #303, X10; #312).
 *
 * This is the server's half of the seam `@openharness/brain`'s `./mcp` defines: the brain asks
 * once per request which tools the chat's servers offer, and this answers with the tools, the
 * server each belongs to, and the servers that could not be listed. Everything the brain must
 * not know about lives here — which servers are in force, where their credentials come from,
 * what a guarded fetch is, and how long a listing is worth keeping.
 *
 * Three decisions are worth stating plainly, because each is a trade-off:
 *
 * - **A listing is cached briefly, keyed per user and server.** A turn makes one model request
 *   per step and each one asks for the listing, so without a cache a fifty-step turn would
 *   handshake with every server fifty times. {@link DEFAULT_MCP_TOOL_CACHE_TTL_MS} is the
 *   window: long enough to cover a turn, short enough that a tool a server just added shows up
 *   in the next chat. What makes it *correct* rather than merely fast is the second half of the
 *   key — the server's `updated_at`, read from the list this needs anyway — so an update, a
 *   connection check, a token refresh or a disconnect invalidates the entry immediately,
 *   wherever it happened, without a hook anybody could forget to call.
 * - **A server that cannot be listed is a failure, never an error.** The turn goes on without
 *   its tools and the user is told (`session.error`); what would be worse is a chat that cannot
 *   answer because somebody else's server is down.
 * - **A call opens its own connection.** `createMcpTool` connects per call, which keeps the
 *   connection's lifetime inside the call's: a client kept across a turn would outlive the
 *   token it was built with and would have to be re-validated after every sleep and abort.
 */

/** How long one server's listed tools are reused before the server is asked again. */
export const DEFAULT_MCP_TOOL_CACHE_TTL_MS = 30_000

/** How long one listing may take: an `initialize` and a `tools/list`, not a tool call. */
export const DEFAULT_MCP_LISTING_TIMEOUT_MS = 10_000

/** What {@link createMcpToolProvider} is wired with. */
export interface McpToolProviderOptions {
  /**
   * The service that lists a user's servers and resolves one's URL and auth headers. Only the
   * three methods used are required, so a test can supply exactly those.
   */
  readonly service: Pick<McpServerService, 'list' | 'resolve' | 'disconnect'>
  /** The guarded fetch every listing and every call goes through — the service's own wrapper. */
  readonly fetch: McpFetch
  /** The clock, for the cache window; injectable for tests. */
  readonly now?: () => Date
  /** Where a listing's failure is logged. Silent by default. */
  readonly logger?: Logger
  /** How long a listing is reused; {@link DEFAULT_MCP_TOOL_CACHE_TTL_MS} by default. */
  readonly cacheTtlMs?: number
  /** How long one listing may take; {@link DEFAULT_MCP_LISTING_TIMEOUT_MS} by default. */
  readonly listingTimeoutMs?: number
  /** The most one remote tool call may take; `@openharness/hands`' default when omitted. */
  readonly toolTimeoutMs?: number
}

/** One server's listing, as the cache keeps it. */
interface CachedListing {
  /** The `updated_at` the server had when this was listed; a change invalidates the entry. */
  readonly updatedAt: string
  /** When it was listed, from the injected clock. */
  readonly at: number
  readonly listing: ServerListing
}

/** What listing one server produced: where it is and what it offers, or why it could not be. */
type ServerListing =
  | {
      readonly ok: true
      readonly url: string
      readonly headers: Readonly<Record<string, string>>
      readonly tools: readonly McpToolDefinition[]
    }
  | { readonly ok: false; readonly failure: McpListingFailure }

/**
 * Build the {@link McpToolProvider} the server hands the brain.
 *
 * The returned function is asked once per model request (`@openharness/brain`'s `./mcp`), and it
 * answers the **in-force** servers' tools: the user's `enabled` servers with the request's mode
 * override applied, which is what makes a server switched off, removed or connected apply from
 * the next request on. It never throws: a server that cannot be listed is reported as a failure
 * so the turn can carry on without it.
 */
export function createMcpToolProvider(options: McpToolProviderOptions): McpToolProvider {
  const cache = new Map<string, CachedListing>()
  const ttl = options.cacheTtlMs ?? DEFAULT_MCP_TOOL_CACHE_TTL_MS
  const clock = options.now ?? (() => new Date())

  /** One server's listing, from the cache when it is fresh and the server unchanged. */
  async function listingFor(server: McpServer): Promise<ServerListing> {
    const key = `${server.owner_id}|${server.id}`
    const now = clock().getTime()
    const cached = cache.get(key)
    if (cached !== undefined && cached.updatedAt === server.updated_at && now - cached.at < ttl) {
      return cached.listing
    }
    const listing = await listServer(server)
    // A failure is not cached: the next request tries again, which is what makes a server that
    // comes back mid-chat usable again without waiting the window out.
    if (listing.ok) {
      cache.set(key, { updatedAt: server.updated_at, at: now, listing })
    }
    return listing
  }

  /** Resolve one server's credentials and read its tool list. Never throws. */
  async function listServer(server: McpServer): Promise<ServerListing> {
    const resolved = await options.service.resolve(server.owner_id, server.id)
    if (resolved === null) {
      // The service answers `null` when there is no usable credential — an OAuth token that
      // could not be refreshed, or one never granted — and it has already marked the server
      // `needs_reconnect`. That is an authentication failure: the user starts the flow again.
      return {
        ok: false,
        failure: {
          serverName: server.name,
          kind: 'authentication',
          message: 'the server is not connected: its credentials could not be used.',
        },
      }
    }
    const status = recordingFetch(options.fetch)
    const secrets = Object.values(resolved.headers)
    try {
      const session = await openMcpClient({
        url: resolved.url,
        headers: resolved.headers,
        fetch: status.fetch,
        timeoutMs: options.listingTimeoutMs ?? DEFAULT_MCP_LISTING_TIMEOUT_MS,
      })
      try {
        const tools = await session.listTools()
        return { ok: true, url: resolved.url, headers: resolved.headers, tools }
      } finally {
        await session.close().catch(() => undefined)
      }
    } catch (error) {
      return { ok: false, failure: await failureOf(server, error, status.lastStatus(), secrets) }
    }
  }

  /**
   * A listing that failed, as a bounded, secret-free failure.
   *
   * The status the guarded fetch saw is what tells the two kinds apart — a 401 or a 403 is the
   * server refusing this deployment's credentials, anything else (including no response at all)
   * is a server that could not be reached. An OAuth server whose token was rejected has its
   * tokens dropped, so the settings screen offers the flow again rather than leaving a token
   * that will keep failing; a `headers` server has nothing to reconnect, so it is only reported.
   */
  async function failureOf(
    server: McpServer,
    error: unknown,
    httpStatus: number | undefined,
    secrets: readonly string[],
  ): Promise<McpListingFailure> {
    const authentication = httpStatus === 401 || httpStatus === 403
    if (authentication && server.auth === 'oauth') {
      await options.service.disconnect(server.owner_id, server.id).catch(() => null)
    }
    const message = bound(scrubText(messageOf(error), secrets))
    options.logger?.debug?.(`mcp server ${server.name} could not be listed: ${message}`, {
      server_id: server.id,
      status: httpStatus,
    })
    return {
      serverName: server.name,
      kind: authentication ? 'authentication' : 'connection',
      message,
    }
  }

  /** One listed tool, as the registry will run it. */
  function definitionOf(
    tool: McpToolDefinition,
    server: McpServer,
    listing: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
  ): ToolDefinition {
    return createMcpTool({
      serverName: server.name,
      toolName: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.input_schema,
      url: listing.url,
      headers: listing.headers,
      // The same guarded fetch the listing went through: a remote call is a user-supplied URL
      // like any other, and this is the one place it is guarded.
      fetch: options.fetch,
      ...(options.toolTimeoutMs === undefined ? {} : { timeoutMs: options.toolTimeoutMs }),
    })
  }

  return async (ownerId: UserId, modeOverride: ModeToolOverride | null) => {
    const servers = await listMcpServersInForce(
      { mcpServers: options.service },
      ownerId,
      modeOverride,
    )
    const listed = await Promise.all(
      servers.map(async (server) => ({ server, listing: await listingFor(server) })),
    )
    const tools: McpOfferedTool[] = []
    const failures: McpListingFailure[] = []
    // In the servers' order (oldest first), and each server's tools in its own listing order:
    // the order a request offers them in, which is the order its span records them in.
    for (const { server, listing } of listed) {
      if (!listing.ok) {
        failures.push(listing.failure)
        continue
      }
      for (const tool of listing.tools) {
        tools.push({
          serverName: server.name,
          toolName: tool.name,
          definition: definitionOf(tool, server, listing),
        })
      }
    }
    return { tools, failures }
  }
}

/** A fetch that remembers the last HTTP status it saw, so a failure can be classified. */
function recordingFetch(base: McpFetch): { fetch: McpFetch; lastStatus: () => number | undefined } {
  let last: number | undefined
  return {
    fetch: async (url, init) => {
      const response = await base(url, init)
      last = response.status
      return response
    },
    lastStatus: () => last,
  }
}

/** An error's message, and never its stack: the message is what a user reads. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  return 'the server did not answer'
}

/** A failure message a client can show, bounded like every other MCP last-error string. */
function bound(message: string): string {
  return message.length > MCP_LAST_ERROR_MAX_LENGTH
    ? `${message.slice(0, MCP_LAST_ERROR_MAX_LENGTH)}…`
    : message
}
