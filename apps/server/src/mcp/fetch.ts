import {
  safeFetch,
  type AddressResolver,
  type McpFetch,
  type SafeFetchTransport,
} from '@openharness/hands'

/**
 * The guarded fetch every MCP request goes through (epic #303, X10).
 *
 * A remote MCP server's URL is a URL the user typed, so it is fetched through `safeFetch` and
 * nothing else — the same guard a custom OpenAI-compatible endpoint uses (#249, M4): the
 * hostname is resolved here, every address is checked, a private or loopback address is refused
 * unless the deployment's self-host setting allows it, and the socket is pinned to what was
 * checked. The OAuth flow's own endpoints (discovery, registration, the token endpoint) go
 * through the same wrapper, so a metadata document pointing at a private host is refused rather
 * than dialled.
 *
 * The limits are the streaming ones plus a deadline: a body is uncapped and a stalled stream
 * gets {@link STREAMING_LIMITS}' idle window, because an MCP response is an event stream, while
 * {@link DEFAULT_MCP_FETCH_TIMEOUT_MS} bounds the whole call so a hung server cannot hold a
 * connection check open forever. A caller that needs a longer stream (the tool loop, #312)
 * builds its own wrapper with a larger `timeoutMs`.
 */

/** How long one MCP request may take end to end, when the caller says nothing. */
export const DEFAULT_MCP_FETCH_TIMEOUT_MS = 15_000

/** How long an MCP body may stall between chunks. */
export const MCP_IDLE_TIMEOUT_MS = 120_000

/** How {@link createMcpFetch} is configured. */
export interface McpFetchOptions {
  /**
   * Whether a private, loopback or link-local address may be reached — the deployment's
   * self-host setting (`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS`, #249, M4). Off by default.
   */
  readonly allowPrivate?: boolean
  /** The deadline for one request; {@link DEFAULT_MCP_FETCH_TIMEOUT_MS} by default, `null` for none. */
  readonly timeoutMs?: number | null
  /** How hostnames resolve; `node:dns` by default. Injectable for tests. */
  readonly resolver?: AddressResolver
  /** How a request is actually made; undici over a pinned dispatcher by default. Injectable for tests. */
  readonly transport?: SafeFetchTransport
}

/** Build the guarded {@link McpFetch} the MCP service and the OAuth client use. */
export function createMcpFetch(options: McpFetchOptions = {}): McpFetch {
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_MCP_FETCH_TIMEOUT_MS : options.timeoutMs
  return (url, init) =>
    safeFetch(url, init ?? {}, {
      // No size cap and no total deadline of safeFetch's own: an MCP response is an event
      // stream, and the caller's deadline above is the one that bounds it. The idle window is
      // what catches a stream that has gone quiet.
      maxBytes: null,
      timeoutMs,
      idleTimeoutMs: MCP_IDLE_TIMEOUT_MS,
      // A provider API call has no business following a redirect elsewhere; a user-typed MCP
      // URL is the same.
      maxRedirects: 0,
      ...(options.allowPrivate === true ? { allowPrivate: true } : {}),
      ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      ...(options.transport === undefined ? {} : { transport: options.transport }),
    })
}
