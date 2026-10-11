import { z } from 'zod'

import { TimestampSchema } from '../common'
import { McpServerIdSchema } from '../ids'
import { UserIdSchema } from './user'

/**
 * The remote-MCP-server resource and the endpoints that manage it:
 *
 * - `POST   /v1/me/mcp_servers`
 * - `GET    /v1/me/mcp_servers`
 * - `GET    /v1/me/mcp_servers/{mcp_server_id}`
 * - `POST   /v1/me/mcp_servers/{mcp_server_id}` (update)
 * - `DELETE /v1/me/mcp_servers/{mcp_server_id}`
 * - `POST   /v1/me/mcp_servers/{mcp_server_id}/test`      (connection check)
 * - `POST   /v1/me/mcp_servers/{mcp_server_id}/connect`   (start OAuth; answers an authorization URL)
 * - `POST   /v1/me/mcp_servers/{mcp_server_id}/disconnect`(drop the stored tokens)
 * - `GET    /v1/me/mcp_servers/oauth/callback`            (the provider's redirect back)
 *
 * // extension: Anthropic's Managed Agents API has `mcp_servers` on an agent or a session as a
 * per-run reference (`{ type: 'url', url, name }`) — Anthropic holds the servers and their
 * credentials. openharness does not: a **user** registers remote MCP servers they operate
 * (epic #303, X10), each with the URL and the authentication it needs, and the servers are a
 * per-user resource like a mode or a provider credential. MCP tools reach a chat through this
 * resource, never through the model context's own configuration. There is no tool calling in
 * this change (#312); what is here is the resource, its sealed secrets and its OAuth 2.1
 * client.
 *
 * ## Streamable HTTP only
 *
 * A remote server is addressed by an absolute `http`/`https` URL and spoken to over MCP's
 * **Streamable HTTP** transport. The other transports (stdio, the deprecated HTTP+SSE) are not
 * supported: stdio is a local process this server does not spawn, and Streamable HTTP is what
 * the `2026-03` protocol revision settles on. An address that resolves to a private, loopback
 * or link-local host is refused unless the deployment's self-host setting is on (the same
 * `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS` flag the custom OpenAI-compatible credential
 * uses, #249) — an MCP server on an internal network is a real self-hosted case, and an SSRF
 * is a real attack.
 *
 * ## Secrets
 *
 * A server authenticated with `headers` carries a name/value map the user supplies (an API
 * key header, say). The map is **write-only**: it is sealed with `@openharness/vault`, exactly
 * like a provider credential, and never returned — the resource lists the header **names**
 * only. An `oauth` server carries the tokens its authorization granted, sealed the same way
 * and refreshed automatically. Nothing on this path is ever put in an event or in a model
 * request's context (epic #303, X11).
 */

/**
 * Longest MCP server name the API accepts.
 *
 * Capped short because the name is a tool-name prefix a model sees once tools land (#312): a
 * remote tool is `<server name>__<tool name>`, so a long server name would spend a model's
 * tool-name budget before the tool's own name says anything. Same 32 characters a named
 * provider credential takes, for the same reason.
 */
export const MCP_SERVER_NAME_MAX_LENGTH = 32

/**
 * The shape of a server name: lowercase letters, digits and interior dashes.
 *
 * A name has to be usable as a tool-name prefix, and tool names are `[a-zA-Z0-9_-]` in
 * practice — so the vocabulary is narrowed to what every provider's tool-name rules accept
 * without a rewrite: no dots, no underscores (the `__` separator owns those), no uppercase,
 * and no leading or trailing dash. The same pattern a named credential's name takes
 * (`CREDENTIAL_NAME_PATTERN`), restated here because the two are free to diverge.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Whether `value` can be an MCP server name. */
export function isMcpServerName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MCP_SERVER_NAME_MAX_LENGTH &&
    MCP_SERVER_NAME_PATTERN.test(value)
  )
}

/** A server name: the rule {@link isMcpServerName} checks, as a schema. */
export const McpServerNameSchema = z.string().refine(isMcpServerName, {
  error:
    `a server name is 1–${MCP_SERVER_NAME_MAX_LENGTH} lowercase letters, digits and ` +
    'interior dashes, e.g. `notes` or `my-notes`',
})

export type McpServerName = z.infer<typeof McpServerNameSchema>

/**
 * How many MCP servers one user may hold.
 *
 * Lower than the provider-credential count and equal to `MAX_MODES_PER_USER`: every enabled
 * server contributes its whole tool list to **every** request once tools land (#312, #307), so
 * this is a context budget as much as a row count. Twenty servers' worth of tools is already
 * far more than a model takes well; a user past it disables some rather than adding more.
 */
export const MAX_MCP_SERVERS_PER_USER = 20

/** Most header pairs one `headers`-authenticated server may carry. */
export const MAX_MCP_HEADERS = 16

/** Longest header name accepted. HTTP header names are short; this is a bound, not a rule. */
export const MCP_HEADER_NAME_MAX_LENGTH = 256

/** Longest header value accepted. A bearer token or an API key fits well inside it. */
export const MCP_HEADER_VALUE_MAX_LENGTH = 4096

/** Longest `last_error` string a resource reports, so a failure cannot bloat a response. */
export const MCP_LAST_ERROR_MAX_LENGTH = 500

/**
 * How an MCP server authenticates a request (epic #303, X10).
 *
 * - `none` — no credential; the server is open, or trusts the network.
 * - `headers` — a name/value map the user supplies, sent on every request. The values are
 *   sealed and never returned.
 * - `oauth` — OAuth 2.1, with this server as the OAuth **client**: discovery, dynamic client
 *   registration, authorization code with PKCE, and tokens sealed and refreshed automatically.
 */
export const McpAuthTypeSchema = z.enum(['none', 'headers', 'oauth'])

export type McpAuthType = z.infer<typeof McpAuthTypeSchema>

/**
 * The health of an MCP server as far as the server can tell (epic #303, X10).
 *
 * - `connected` — the last request succeeded (or the server needs no auth and the last check
 *   passed).
 * - `needs_reconnect` — an `oauth` server with no live tokens: never connected yet, a refresh
 *   that failed, or a disconnect. The user starts the flow again.
 * - `error` — the last check or request failed for another reason (`last_error` says which).
 *
 * Set by the connection check on save and on demand, and by the credentials resolver when a
 * refresh fails (#312); a failure here never blocks a chat (epic #303).
 */
export const McpServerStatusSchema = z.enum(['connected', 'needs_reconnect', 'error'])

export type McpServerStatus = z.infer<typeof McpServerStatusSchema>

/**
 * The header pairs a `headers`-authenticated server sends, **write-only**.
 *
 * Accepted on a create or an update and stored sealed; never echoed back. Keys are HTTP header
 * names, values the secrets. An empty map is refused — a `headers` server with no headers is a
 * `none` server that says otherwise.
 */
export const McpHeadersSchema = z
  .record(
    z.string().min(1).max(MCP_HEADER_NAME_MAX_LENGTH),
    z.string().min(1).max(MCP_HEADER_VALUE_MAX_LENGTH),
  )
  .refine((headers) => Object.keys(headers).length > 0, {
    error: 'a headers-authenticated server needs at least one header',
  })
  .refine((headers) => Object.keys(headers).length <= MAX_MCP_HEADERS, {
    error: `at most ${MAX_MCP_HEADERS} headers`,
  })

export type McpHeaders = z.infer<typeof McpHeadersSchema>

/**
 * The URL of a remote MCP server: an absolute `http` or `https` URL, with no fragment.
 *
 * The **scheme and shape** are all this schema checks — a private or loopback host is a
 * *server-side* refusal (the SSRF guard), because whether one is acceptable depends on the
 * deployment's self-host setting, not on the syntax. `http` is allowed for the same reason a
 * custom OpenAI-compatible credential allows it: a self-hosted server on a private network is
 * the case the setting exists for. A fragment is refused because it is never sent in a request
 * and could only be a mistake; userinfo is refused because a URL that carries a credential in
 * it would put that credential in a log line.
 */
export const McpServerUrlSchema = z.string().refine(isMcpServerUrl, {
  error:
    'the URL must be an absolute http or https URL with a host, no userinfo and no fragment, ' +
    'e.g. `https://mcp.example.com/mcp`',
})

export type McpServerUrl = z.infer<typeof McpServerUrlSchema>

/** Whether `value` is an acceptable MCP server URL — the rule {@link McpServerUrlSchema} checks. */
export function isMcpServerUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }
  if (url.hostname.length === 0 || url.username !== '' || url.password !== '') {
    return false
  }
  return url.hash === ''
}

/**
 * One tool an MCP server offers, as the protocol carries it.
 *
 * `input_schema` is the tool's JSON Schema exactly as the server sent it — an open object,
 * because it is the server's schema and not this protocol's to model. It is what a tool
 * definition costs tokens on (see {@link estimateToolDefinitionTokens}) and what a model is
 * shown once tools land (#312); this change only lists and measures the tools, it never calls
 * them.
 */
export const McpToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  input_schema: z.record(z.string(), z.unknown()),
})

export type McpToolDefinition = z.infer<typeof McpToolDefinitionSchema>

/**
 * One tool as a **resource** reports it: the name, the description, and what its definition
 * costs in tokens.
 *
 * A summary rather than the whole definition: the resource is a listing, and a settings screen
 * shows names and a cost, not every tool's JSON Schema. The full definition is read live from
 * the server when tools land (#312).
 */
export const McpToolSummarySchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable(),
  /** The tool's estimated definition size, in tokens (see {@link estimateToolDefinitionTokens}). */
  definition_tokens: z.number().int().min(0),
})

export type McpToolSummary = z.infer<typeof McpToolSummarySchema>

/**
 * How many characters of a definition this package counts as one token.
 *
 * The estimator is deliberately the cheap, provider-agnostic one — roughly four characters per
 * token, the rule of thumb for English and JSON — because the real tokenizer belongs to the
 * model that will read the definitions and nothing in this pure package can run it. It is an
 * **estimate** and is named as one everywhere it is reported (epic #303, X6): its job is to
 * tell a settings screen that one server's tools cost ~2k tokens and another's ~200, not to
 * predict a bill.
 */
export const TOKENS_PER_CHARACTER_RATIO = 4

/**
 * The estimated token cost of one tool's definition.
 *
 * Counts the three fields a model is shown — the name, the description and the input schema —
 * as compact JSON, so the size tracks what really travels. A definition that cannot be
 * serialized (a circular schema, which an MCP server should not send) counts as the name and
 * description alone rather than throwing: a listing is not the place to fail over one tool.
 */
export function estimateToolDefinitionTokens(tool: McpToolDefinition): number {
  const definition = {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }
  let json: string
  try {
    json = JSON.stringify(definition) ?? ''
  } catch {
    json = JSON.stringify({ name: tool.name, description: tool.description }) ?? ''
  }
  return Math.ceil(json.length / TOKENS_PER_CHARACTER_RATIO)
}

/** The estimated token cost of a whole tool list: the sum of its tools' definitions. */
export function estimateToolsTokens(tools: readonly McpToolDefinition[]): number {
  let total = 0
  for (const tool of tools) {
    total += estimateToolDefinitionTokens(tool)
  }
  return total
}

/** The {@link McpToolSummary} of one tool definition. */
export function mcpToolSummary(tool: McpToolDefinition): McpToolSummary {
  return {
    name: tool.name,
    description: tool.description,
    definition_tokens: estimateToolDefinitionTokens(tool),
  }
}

/**
 * A user's remote MCP server, as the API returns it.
 *
 * Never carries a secret. A `headers`-authenticated server reports the header **names** it
 * sends (`header_names`) so a settings screen can say what is configured — the values stay
 * sealed. An `oauth` server reports nothing about its tokens at all: `status` is the whole
 * story a caller gets, and a token is refreshed behind it without the resource changing shape.
 */
export const McpServerSchema = z.object({
  id: McpServerIdSchema,
  /**
   * // extension: the discriminant, so the resource can be told from an agent or a session in
   * a bag of mixed resources. Anthropic has no per-user MCP server resource.
   */
  type: z.literal('mcp_server'),
  /**
   * // extension: the user this server belongs to (epic #65, A4). Read-only: the server sets it
   * from the caller, no request carries it, and another user's server is answered as missing.
   */
  owner_id: UserIdSchema,
  /** The name, unique among its owner's servers and used as a tool-name prefix. */
  name: McpServerNameSchema,
  /** The server's Streamable HTTP endpoint. */
  url: z.string(),
  /** How requests authenticate: `none`, `headers` or `oauth`. */
  auth: McpAuthTypeSchema,
  /**
   * Whether the server is on by default for this user's chats (epic #303, X6).
   *
   * The user default only. A mode may later override which servers are on, at **server**
   * granularity — there is no per-tool switch — but that override is #307 and is deliberately
   * not modelled here; this field is the default a mode would override, not the effective set.
   */
  enabled: z.boolean(),
  /** Whether the server is reachable and authenticated right now. */
  status: McpServerStatusSchema,
  /** Why the last check or request failed, or `null`. Never a secret. */
  last_error: z.string().nullable(),
  /**
   * The header names a `headers`-authenticated server sends, in insertion order, and `[]` for
   * every other auth type. The values are sealed and never appear here.
   */
  header_names: z.array(z.string()),
  /** The tools the last connection check listed, or `[]` before one has run. */
  tools: z.array(McpToolSummarySchema),
  /**
   * The estimated token cost of `tools` — what the server's tool definitions spend of a
   * request's context (epic #303, X6). `0` before a check has listed any.
   */
  definition_tokens: z.number().int().min(0),
  /** When the tools above were last listed, or `null` before a check has run. */
  last_tested_at: TimestampSchema.nullable(),
  created_at: TimestampSchema,
  /** When the server was last changed, or its tokens last refreshed. Set on update. */
  updated_at: TimestampSchema,
})

export type McpServer = z.infer<typeof McpServerSchema>

/**
 * The fields every create body carries, whatever the auth type. Split out so each union member
 * repeats only its own authentication.
 */
const mcpServerBaseFields = {
  name: McpServerNameSchema,
  url: McpServerUrlSchema,
  /** Whether the server is on by default; `true` when omitted. */
  enabled: z.boolean().optional(),
} as const

/**
 * Body of `POST /v1/me/mcp_servers`. Response: {@link McpServerSchema} (201).
 *
 * A discriminated union on `auth`: the two secret-carrying forms each carry their own field,
 * so a body that names `auth: 'oauth'` **cannot** also carry `headers` — an unknown field is
 * stripped like every other object here, and `x-`-style ambiguity is impossible. `name` is
 * unique per user (a duplicate is a 409, as a mode's is).
 */
export const CreateMcpServerRequestSchema = z.discriminatedUnion('auth', [
  z.object({ auth: z.literal('none'), ...mcpServerBaseFields }),
  z.object({ auth: z.literal('headers'), ...mcpServerBaseFields, headers: McpHeadersSchema }),
  z.object({ auth: z.literal('oauth'), ...mcpServerBaseFields }),
])

export type CreateMcpServerRequest = z.infer<typeof CreateMcpServerRequestSchema>

/**
 * Body of `POST /v1/me/mcp_servers/{mcp_server_id}`. Response: {@link McpServerSchema}.
 *
 * Every field is optional; an omitted field keeps its stored value. `headers` is the one
 * write-only field: when present it **replaces** the sealed header map, and when omitted the
 * stored one is left alone — so a rename or an enable does not require re-entering a secret.
 * Changing `auth` away from `headers` drops the sealed headers, and changing it to `oauth`
 * drops any stored headers and requires a fresh `connect`; the route checks those pairings and
 * answers 400 for a body that carries `headers` while the resulting auth is not `headers`.
 */
export const UpdateMcpServerRequestSchema = z.object({
  name: McpServerNameSchema.optional(),
  url: McpServerUrlSchema.optional(),
  enabled: z.boolean().optional(),
  auth: McpAuthTypeSchema.optional(),
  headers: McpHeadersSchema.optional(),
})

export type UpdateMcpServerRequest = z.infer<typeof UpdateMcpServerRequestSchema>

/**
 * Response of `GET /v1/me/mcp_servers`.
 *
 * No pagination envelope, like the mode and credential lists: a user holds at most
 * {@link MAX_MCP_SERVERS_PER_USER}, so the response is bounded and a settings screen shows
 * them all at once.
 */
export const ListMcpServersResponseSchema = z.object({
  data: z.array(McpServerSchema),
})

export type ListMcpServersResponse = z.infer<typeof ListMcpServersResponseSchema>

/**
 * Where an OAuth flow was started (epic #303, X10; #311).
 *
 * The browser that lands on the callback is **not** necessarily signed in to this server: `oh`
 * starts the flow by opening the authorization URL in the system browser, and `oh` itself
 * authenticates with a bearer token from the device flow, so its browser may never have a
 * session here. The callback is therefore authenticated by the `state` alone, and the two
 * callers want different endings — so the flow records which one started it. The web app is
 * sent back to its settings screen; the CLI is shown a plain page to close.
 *
 * // extension: Anthropic has no per-user MCP server resource and no OAuth client flow, so
 * there is no equivalent of a flow's origin to record.
 */
export const McpOAuthClientSchema = z.enum(['web', 'cli'])

export type McpOAuthClient = z.infer<typeof McpOAuthClientSchema>

/**
 * Body of `POST /v1/me/mcp_servers/{mcp_server_id}/connect`.
 *
 * Every field is optional — the route accepts a request with no body at all — and `client`
 * defaults to `web`, which is what the app sends and what every caller meant before #311.
 */
export const ConnectMcpServerRequestSchema = z.object({
  /**
   * Where the flow was started, recorded on the pending `state` so the callback knows how to
   * answer. `web` when omitted.
   */
  client: McpOAuthClientSchema.default('web'),
})

export type ConnectMcpServerRequest = z.infer<typeof ConnectMcpServerRequestSchema>

/**
 * Response of `POST /v1/me/mcp_servers/{mcp_server_id}/connect`: where to send the user to
 * authorize the server.
 *
 * The server is the OAuth **client** (epic #303, X10): it discovers the authorization server,
 * registers itself dynamically when it can, builds the authorization code + PKCE request and
 * answers the URL. The web app and `oh` both open that URL in a browser; the provider then
 * redirects back to this server's own callback route, which completes the flow. `state` binds
 * the round trip to the user and the server, is single use and short-lived, and is not carried
 * here — it is inside `authorization_url`.
 */
export const ConnectMcpServerResponseSchema = z.object({
  /** The authorization URL to open in the user's browser. */
  authorization_url: z.string(),
})

export type ConnectMcpServerResponse = z.infer<typeof ConnectMcpServerResponseSchema>
