import { PACKAGE_NAME as PROTOCOL_PACKAGE_NAME } from '@openharness/protocol'

/**
 * `@openharness/hands` — the tools behind `execute(name, input)`, the registry that runs one,
 * and the one outbound-request guard the rest of openharness uses.
 *
 * A tool is a name, a description a model reads, an input schema, a default permission and a
 * timeout; {@link createToolRegistry} holds a host's tools and {@link ToolRegistry.execute}
 * runs one call of one, turning every outcome — a result, a refusal, a timeout, an interrupt —
 * into the `ToolResult` the brain stores. The conformance a real tool needs (a guarded fetch
 * for a user-supplied URL) is {@link safeFetch} (epic #245, A3a, decision M1); the built-in
 * tools of #305 — `web_fetch`, `web_search` and `todo_write` — live here.
 *
 * `openMcpClient` and `createMcpTool` (epic #303, X10; #312) are the other half: a Streamable
 * HTTP client for a remote MCP server, over the official `@modelcontextprotocol/sdk`, and the
 * `ToolDefinition` that makes one of its tools an ordinary tool the registry runs. The server
 * injects the URL, the auth headers and the guarded `fetch`; this package never learns where a
 * credential comes from.
 */

/** This package's name. */
export const PACKAGE_NAME = '@openharness/hands'

/**
 * Proof that the hands → protocol edge resolves through built output (`@openharness/protocol`'s
 * `exports` → `dist/`), which is what fixes the build order.
 */
export const PROTOCOL_DEPENDENCY = PROTOCOL_PACKAGE_NAME

export {
  createToolRegistry,
  scrubText,
  REDACTED_PLACEHOLDER,
  type ToolRegistry,
  type ToolRunContext,
} from './registry'
export {
  DEFAULT_TOOL_RESULT_TOKENS,
  DEFAULT_TOOL_TIMEOUT_MS,
  errorResult,
  textResult,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './tool'

export { htmlToMarkdown } from './markdown'
export {
  DEFAULT_MAX_FETCH_CHARS,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_TOOL_NAME,
  WebFetchInputSchema,
  createWebFetchTool,
  safePageFetch,
  type PageFetch,
  type WebFetchInput,
  type WebFetchOptions,
} from './web-fetch'
export {
  BRAVE_MAX_COUNT,
  BRAVE_SEARCH_ENDPOINT,
  BRAVE_SEARCH_PROVIDER,
  BRAVE_TIMEOUT_MS,
  SUPPORTED_SEARCH_PROVIDERS,
  SearchResultSchema,
  createBraveSearchProvider,
  type BraveSearchOptions,
  type SearchProvider,
  type SearchProviderName,
  type SearchRequest,
  type SearchRequestInit,
  type SearchResponse,
  type SearchResult,
  type SearchTransport,
} from './search'
export {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  WEB_SEARCH_API_KEY,
  WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_TOOL_NAME,
  WebSearchInputSchema,
  createWebSearchTool,
  type WebSearchInput,
  type WebSearchToolOptions,
} from './web-search'
export { todoWriteTool } from './todo'

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
  safeFetchResult,
  type AddressResolver,
  type SafeFetchErrorCode,
  type SafeFetchOptions,
  type SafeFetchRequest,
  type SafeFetchResult,
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
  DEFAULT_MCP_TOOL_TIMEOUT_MS,
  createMcpTool,
  mcpResult,
  type McpResultOptions,
  type McpToolOptions,
} from './mcp-tool'
export {
  isBlockedAddress,
  isMetadataHostname,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
  parseIpAddress,
  type ParsedAddress,
} from './ssrf'
