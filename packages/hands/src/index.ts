import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'

/**
 * `@openharness/hands` — the sandboxes and tools behind `execute(name, input)`, and the one
 * outbound-request guard the rest of openharness uses.
 *
 * The tools are not built yet, but `safeFetch` is: a URL a **user** supplied may be fetched
 * through it and nothing else (epic #245, A3a, decision M1), because a provider credential's
 * endpoint is a URL the user typed and a request to one is exactly what needs an SSRF guard —
 * and the tools' own `web_fetch` will reuse it.
 *
 * `openMcpClient` (epic #303, X10) is the other piece: a Streamable HTTP client for a remote
 * MCP server, over the official `@modelcontextprotocol/sdk`. The server injects the URL, the
 * auth headers and the guarded `fetch`; this package never learns where a credential comes from.
 */

/** This package's name. */
export const PACKAGE_NAME = '@openharness/hands'

/**
 * Proof that the hands → protocol edge resolves through built output (`@openharness/protocol`'s
 * `exports` → `dist/`), which is what fixes the build order.
 */
export const PROTOCOL_DEPENDENCY = PROTOCOL_PACKAGE_NAME

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  SAVE_TIME_LIMITS,
  STREAMING_IDLE_TIMEOUT_MS,
  STREAMING_LIMITS,
  SafeFetchError,
  isSafeFetchError,
  safeFetch,
  type AddressResolver,
  type SafeFetchErrorCode,
  type SafeFetchOptions,
  type SafeFetchRequest,
  type SafeFetchTransport,
} from './safe-fetch'
export {
  MCP_CLIENT_NAME,
  MCP_CLIENT_VERSION,
  mcpToolDefinition,
  openMcpClient,
  type McpClientOptions,
  type McpClientSession,
  type McpFetch,
} from './mcp-client'
export {
  isBlockedAddress,
  isMetadataHostname,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
  parseIpAddress,
  type ParsedAddress,
} from './ssrf'
