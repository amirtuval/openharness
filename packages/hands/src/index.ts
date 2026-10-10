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
 * tools themselves arrive with #305 and live here.
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
  DEFAULT_TOOL_TIMEOUT_MS,
  errorResult,
  textResult,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './tool'

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
  isBlockedAddress,
  isMetadataHostname,
  isPublicAddress,
  parseIPv4,
  parseIPv6,
  parseIpAddress,
  type ParsedAddress,
} from './ssrf'
