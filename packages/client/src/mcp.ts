import type {
  McpAuthType,
  McpServer,
  McpServerStatus,
  PutToolSettingsRequest,
  ToolPermission,
  ToolSettingEntry,
} from '@openharness/protocol'
import { DEFAULT_MCP_TOOL_PERMISSION, mcpToolOfferedName } from '@openharness/protocol'

import { sleep as defaultSleep } from './internal/async'

/**
 * The remote-MCP view both frontends share (epic #303, X10; issue #313).
 *
 * A server settings screen and a call line have to say the same things — what a server's status
 * is, how its authentication is spelled, what its tool definitions cost, which tools belong to
 * it and under what permission — and so does the notice a failed turn is owed. Those words and
 * derivations live here once, so the page and the terminal cannot disagree, and so a component
 * does not have to know the wire's field names.
 *
 * The wire half is {@link
 * import('./resources/mcp-servers').McpServersResource} (`/v1/me/mcp_servers`) and
 * `client.tools` (`/v1/me/tools`, whose `mcp` map holds a remote tool's permission). The tool
 * summaries a server's last check listed are on the resource itself; a tool's **policy** is the
 * settings' answer, and {@link mcpServerTools} joins the two.
 */

/** How a server authenticates, in the order a form offers them (epic #303, X10). */
export const MCP_AUTH_TYPES: readonly McpAuthType[] = ['none', 'headers', 'oauth']

/** The words for an auth type, the same in both frontends. */
const AUTH_LABELS: Readonly<Record<McpAuthType, string>> = {
  none: 'None',
  headers: 'Headers',
  oauth: 'OAuth',
}

/**
 * What an auth type means, as the one-line hint a form shows beside the choice.
 *
 * `headers` and `oauth` are the two secret-carrying kinds, and the hint says which secret the
 * reader will be asked for rather than naming the field, because that is the decision.
 */
const AUTH_HINTS: Readonly<Record<McpAuthType, string>> = {
  none: 'The server needs no credentials — it is open, or it trusts the network.',
  headers: 'Send a header on every request, e.g. an API key the server issued.',
  oauth: 'Sign in to the server with OAuth. You will be sent to its authorization page.',
}

/**
 * The words for an auth type.
 *
 * @param auth the server's authentication
 */
export function mcpAuthLabel(auth: McpAuthType): string {
  return AUTH_LABELS[auth]
}

/**
 * The sentence a form shows for an auth type.
 *
 * @param auth the server's authentication
 */
export function mcpAuthHint(auth: McpAuthType): string {
  return AUTH_HINTS[auth]
}

/** The words for a server's status (epic #303, X10). */
const STATUS_LABELS: Readonly<Record<McpServerStatus, string>> = {
  connected: 'Connected',
  needs_reconnect: 'Needs reconnect',
  error: 'Error',
}

/**
 * How a status reads at a glance: healthy, something the reader should act on, or broken.
 *
 * A frontend maps the tone onto its own colours; the vocabulary is here so both pick the same
 * one, and so `needs_reconnect` reads as a warning (a flow to start again) rather than an
 * error.
 */
export type McpServerTone = 'ok' | 'warning' | 'error'

const STATUS_TONES: Readonly<Record<McpServerStatus, McpServerTone>> = {
  connected: 'ok',
  needs_reconnect: 'warning',
  error: 'error',
}

/**
 * The words for a server's status.
 *
 * @param status the server's `status`
 */
export function mcpStatusLabel(status: McpServerStatus): string {
  return STATUS_LABELS[status]
}

/**
 * The tone a server's status is drawn in.
 *
 * @param status the server's `status`
 */
export function mcpStatusTone(status: McpServerStatus): McpServerTone {
  return STATUS_TONES[status]
}

/**
 * The share of a server's tools that are usable right now, as the sentence under its status.
 *
 * The status is the headline; this is the detail a row shows beneath it — why a server is in
 * `error`, when it was last checked, or that it has never been checked. A server in
 * `needs_reconnect` with a `last_error` shows that error (a failed refresh is the reason the
 * flow is being offered again); a `connected` one shows what its tools cost.
 *
 * @param server the server resource
 */
export function mcpStatusDetail(server: McpServer): string {
  if (server.status === 'error' || server.last_error !== null) {
    return server.last_error ?? 'The last check failed.'
  }
  if (server.status === 'needs_reconnect') {
    return 'Sign in to the server to use its tools.'
  }
  if (server.last_tested_at === null) {
    return 'Not checked yet.'
  }
  if (server.tools.length === 0) {
    return 'No tools listed.'
  }
  return `${server.tools.length === 1 ? '1 tool' : `${server.tools.length} tools`}, about ${estimatedTokensLabel(server.definition_tokens)}.`
}

/**
 * An estimated token count, written as the estimate it is (epic #303, X6).
 *
 * The number is the protocol's cheap four-characters-per-token rule, not a tokenizer — it is
 * what tells a reader one server costs about 2k tokens of a request's context and another about
 * 200 — so it is always prefixed with `~` and never presented as a measurement. Above a
 * thousand it is abbreviated (`~2.1k tokens`), which is the precision the estimate has anyway.
 *
 * @param tokens the estimate, in tokens
 */
export function estimatedTokensLabel(tokens: number): string {
  if (tokens < 1000) {
    return `~${tokens} tokens`
  }
  const thousands = tokens / 1000
  // One decimal below ten thousand, none above: `~2.1k` is honest about an estimate, `~21k` is
  // what a reader wants from a bigger one.
  const rounded = thousands < 10 ? Math.round(thousands * 10) / 10 : Math.round(thousands)
  return `~${rounded}k tokens`
}

/** What a connection check came to, as the one line an inline result shows (issue #314). */
export interface McpTestOutcome {
  /** Whether the check listed the server's tools. */
  readonly ok: boolean
  /** The sentence to show beside the row: the tool count, or why there is none. */
  readonly message: string
}

/**
 * What to say after a **Test** (issue #314).
 *
 * Testing a server that cannot answer used to look like nothing happened: the row's status went
 * back to the same value and no line was drawn, so a reader pressed the button again. This is
 * the one line both frontends draw instead, and it is deliberately explicit about the two cases
 * that are not failures of the server:
 *
 * - an **`oauth` server that is not connected** never ran a check at all — the resolve finds no
 *   token and answers `null` — so the result is "Connect first", not an empty success. A caller
 *   should not offer Test until then, but a race (a token dropped in another tab) can still
 *   reach this, and a reader deserves the real reason;
 * - a **connected** server reports what its last check listed, in the same estimate the row's
 *   detail line uses, so the result confirms something rather than restating the status.
 *
 * Every other outcome carries the server's own `last_error`, which now names the HTTP status
 * and quotes the body (the server's report, not this module's).
 *
 * @param server the refreshed server a `test` answered with
 */
export function mcpTestOutcome(server: McpServer): McpTestOutcome {
  if (server.status === 'connected') {
    if (server.tools.length === 0) {
      return { ok: true, message: 'Connected. The server lists no tools.' }
    }
    const count = server.tools.length === 1 ? '1 tool' : `${server.tools.length} tools`
    return {
      ok: true,
      message: `Connected. Listed ${count}, about ${estimatedTokensLabel(server.definition_tokens)}.`,
    }
  }
  // A reason the check recorded always wins: it is what really happened — a 401 with its body
  // excerpt, a server that could not be reached — and an `oauth` server that failed a check
  // carries one too (its status drops to `needs_reconnect`, which is what offers Connect again).
  if (server.last_error !== null) {
    return { ok: false, message: server.last_error }
  }
  if (server.auth === 'oauth') {
    return { ok: false, message: 'Connect first — this server needs a sign-in.' }
  }
  return { ok: false, message: 'The check failed.' }
}

/**
 * One of a server's tools, as a settings screen shows it (epic #303, X6; #313).
 *
 * The name the model calls it by (`<server>__<tool>`), the server's own name for it beside it,
 * what its definition costs, and the permission a call to it is evaluated under.
 */
export interface McpServerTool {
  /** The model-facing name the settings are keyed by: `<server>__<tool>`. */
  readonly offeredName: string
  /** The tool's own name on the server. */
  readonly name: string
  /** The tool's description, or `null` when the server gave none. */
  readonly description: string | null
  /** The estimated cost of its definition in tokens, or `null` when no check has listed it. */
  readonly definitionTokens: number | null
  /** The permission a call to it is evaluated under. */
  readonly policy: ToolPermission
  /**
   * Whether the tool is one the last connection check listed.
   *
   * A **stored policy** for a tool the server no longer offers is kept rather than hidden — it
   * is the reader's own choice, and a tool that comes back keeps it — so it is listed with
   * `listed: false` and no cost.
   */
  readonly listed: boolean
}

/**
 * A server's tools, each with the permission it runs under (epic #303, X6; #313).
 *
 * The two halves come from two reads, because they are two facts: the connection check listed
 * the tools and priced their definitions (`McpServer.tools`), and the reader's permission for
 * each is a **tool setting** (`GET /v1/me/tools`, a remote entry under the offered name). A tool
 * the check listed and the settings do not name reads its own declaration — every remote tool
 * declares `ask` (`DEFAULT_MCP_TOOL_PERMISSION`) — and a stored policy for a tool nothing
 * lists is joined in beside them rather than dropped.
 *
 * @param server the server resource, with the tools its last check listed
 * @param entries the tool settings, as `client.tools.list()` answers them
 */
export function mcpServerTools(
  server: McpServer,
  entries: readonly ToolSettingEntry[],
): readonly McpServerTool[] {
  const policies = new Map<string, ToolPermission>()
  const stored: string[] = []
  for (const entry of entries) {
    if (entry.source !== 'mcp' || entry.mcp_server !== server.name) {
      continue
    }
    policies.set(entry.name, entry.policy)
    stored.push(entry.name)
  }

  const tools: McpServerTool[] = server.tools.map((tool) => {
    const offeredName = mcpToolOfferedName(server.name, tool.name)
    return {
      offeredName,
      name: tool.name,
      description: tool.description,
      definitionTokens: tool.definition_tokens,
      policy: policies.get(offeredName) ?? DEFAULT_MCP_TOOL_PERMISSION,
      listed: true,
    }
  })

  const listed = new Set(tools.map((tool) => tool.offeredName))
  for (const offeredName of stored) {
    if (listed.has(offeredName)) {
      continue
    }
    tools.push({
      offeredName,
      name: offeredName.slice(server.name.length + 2),
      description: null,
      definitionTokens: null,
      policy: policies.get(offeredName) ?? DEFAULT_MCP_TOOL_PERMISSION,
      listed: false,
    })
  }
  return tools
}

/**
 * The body that writes one remote tool's permission, and nothing else (epic #303, #312).
 *
 * A remote tool has no on/off of its own — a server is on or off as a resource — so `PUT
 * /v1/me/tools` is asked for a **policy only**, through the `mcp` map. Building it here keeps a
 * screen from writing a `builtin` half it did not mean to touch, which the merge would apply.
 *
 * @param offeredName the tool's model-facing name
 * @param policy the permission to store
 */
export function mcpToolPolicyBody(
  offeredName: string,
  policy: ToolPermission,
): PutToolSettingsRequest {
  return { mcp: { [offeredName]: policy } }
}

/**
 * The body that writes one permission for **every** tool of a server (epic #303, #313).
 *
 * The batch a server's own control sends: one `PUT /v1/me/tools` naming every tool the server
 * has — the ones its last check listed and a stored choice for a tool it no longer offers —
 * each at the same permission, and the `builtin` half untouched. Building it here rather than in
 * a component is what keeps the two frontends sending the same single request for the same set:
 * a screen that looped over its rows would send one `PUT` per tool (and two writes for a reader
 * who pressed twice).
 *
 * A server with no tools answers `null` — there is nothing to set, and a `{ mcp: {} }` write
 * would be a request that changes nothing.
 *
 * @param tools the server's tools, as {@link mcpServerTools} joins them
 * @param policy the permission to store for all of them
 */
export function mcpServerPolicyBody(
  tools: readonly McpServerTool[],
  policy: ToolPermission,
): PutToolSettingsRequest | null {
  if (tools.length === 0) {
    return null
  }
  return { mcp: Object.fromEntries(tools.map((tool) => [tool.offeredName, policy])) }
}

/**
 * What a server's tools say about their permission, taken together (epic #303, #313).
 *
 * `uniform` when every tool runs under the same permission — the state a reader's "Ask (all)"
 * is about — and `mixed` when they differ, which is what a control that sets them all at once
 * has to say before it does. `null` for a server with no tools: there is no state, because there
 * is nothing to agree or disagree.
 */
export type McpToolPolicyState =
  { readonly kind: 'uniform'; readonly policy: ToolPermission } | { readonly kind: 'mixed' }

/**
 * The state of a server's tools as one value.
 *
 * @param tools the server's tools, as {@link mcpServerTools} joins them
 */
export function mcpToolPolicyState(tools: readonly McpServerTool[]): McpToolPolicyState | null {
  const first = tools[0]
  if (first === undefined) {
    return null
  }
  const uniform = tools.every((tool) => tool.policy === first.policy)
  return uniform ? { kind: 'uniform', policy: first.policy } : { kind: 'mixed' }
}

/**
 * The words for that state — "Ask (all)" for a permission every tool shares, "Mixed" when they
 * differ — the same in both frontends.
 *
 * @param state the state {@link mcpToolPolicyState} answered
 */
export function mcpToolPolicyStateLabel(state: McpToolPolicyState): string {
  return state.kind === 'mixed' ? 'Mixed' : `${toolPolicyLabel(state.policy)} (all)`
}

/** The permissions a per-tool picker offers, in the order it offers them. */
export const TOOL_POLICIES: readonly ToolPermission[] = ['allow', 'ask', 'deny']

/** The words for a permission, the same in both frontends. */
const POLICY_LABELS: Readonly<Record<ToolPermission, string>> = {
  allow: 'Allow',
  ask: 'Ask',
  deny: 'Deny',
}

/**
 * The words for a permission.
 *
 * @param policy `allow`, `ask` or `deny`
 */
export function toolPolicyLabel(policy: ToolPermission): string {
  return POLICY_LABELS[policy]
}

/** The remote tool entries of a tool-settings list, grouped by the server they belong to. */
export function mcpToolEntriesByServer(
  entries: readonly ToolSettingEntry[],
): ReadonlyMap<string, readonly ToolSettingEntry[]> {
  const groups = new Map<string, ToolSettingEntry[]>()
  for (const entry of entries) {
    if (entry.source !== 'mcp' || entry.mcp_server === undefined) {
      continue
    }
    const group = groups.get(entry.mcp_server)
    if (group === undefined) {
      groups.set(entry.mcp_server, [entry])
    } else {
      group.push(entry)
    }
  }
  return groups
}

/**
 * The server a `mcp_server` name stands for, or `null` (epic #303, X10).
 *
 * A settings read names a server by its **name** and the resource carries both a name and an
 * id; this is the one place the two are put together, so a screen does not grow its own
 * `find`.
 *
 * @param servers the caller's servers
 * @param name the name the tool settings carry
 */
export function mcpServerByName(
  servers: readonly McpServer[],
  name: string | undefined,
): McpServer | null {
  if (name === undefined) {
    return null
  }
  return servers.find((server) => server.name === name) ?? null
}

/**
 * The server an id names, or `null`.
 *
 * @param servers the caller's servers
 * @param id the `mcps_` id
 */
export function mcpServerById(
  servers: readonly McpServer[],
  id: string | null | undefined,
): McpServer | null {
  if (id === null || id === undefined) {
    return null
  }
  return servers.find((server) => server.id === id) ?? null
}

/**
 * A turn's MCP failure, as a notice a reader is shown (epic #303, X10; #313).
 *
 * The brain writes one `session.error` per server per turn — `mcp_connection_failed_error` or
 * `mcp_authentication_failed_error` — and **the chat carries on without that server's tools**,
 * so it is a warning rather than an ending. The message is the brain's own, and it names the
 * server in quotes (`The MCP server "notes" could not be used: …`); {@link
 * mcpServerFromError} reads that name back out so a screen can offer the one action that helps —
 * reconnecting that server.
 */
export interface McpFailureNotice {
  /** The server's name, or `null` when the message did not name one. */
  readonly server: string | null
  /** The brain's own sentence, shown whole. */
  readonly message: string
  /**
   * Whether the failure is one an OAuth flow fixes, so a Reconnect action is worth offering.
   *
   * Both MCP error types are: a connection failure may be a token that expired and a refresh
   * that could not run, and an authentication failure always is. What a Reconnect does is start
   * the flow again, which is the only answer a client has.
   */
  readonly reconnectable: boolean
}

/** The marker the brain's MCP failure message opens with, and the name it quotes there. */
const MCP_FAILURE_PREFIX = 'The MCP server '
const MCP_FAILURE_SUFFIX = ' could not be used:'

/**
 * The MCP failure a transcript's `lastError` is, or `null` (epic #303, X10; #313).
 *
 * `null` for anything else — a step limit, a provider error, no error at all — so a screen
 * shows this notice for exactly the two errors it is about. The server name is read from the
 * message the brain writes (`The MCP server "<name>" could not be used: …`), which is the only
 * place the log carries it: the error's `type` says a server failed, not which one.
 *
 * @param error the transcript's `lastError`
 */
export function mcpFailureNotice(
  error: { readonly type: string; readonly message: string } | null,
): McpFailureNotice | null {
  if (error === null) {
    return null
  }
  if (
    error.type !== 'mcp_connection_failed_error' &&
    error.type !== 'mcp_authentication_failed_error'
  ) {
    return null
  }
  return { server: mcpServerFromError(error.message), message: error.message, reconnectable: true }
}

/**
 * The server name inside a `mcp_*` error message, or `null`.
 *
 * The brain quotes it (`The MCP server "notes" could not be used: …`), and that is the
 * sentence's own shape rather than a wire field — so this is a **reading of the message**,
 * guarded to the prefix rather than a search for the first quoted word anywhere in the text. A
 * message that does not open that way answers `null`, and a screen falls back to showing the
 * failure without a reconnect target rather than pointing at a server it guessed.
 *
 * @param message the `session.error` message
 */
export function mcpServerFromError(message: string): string | null {
  if (!message.startsWith(MCP_FAILURE_PREFIX)) {
    return null
  }
  const rest = message.slice(MCP_FAILURE_PREFIX.length)
  const end = rest.indexOf(MCP_FAILURE_SUFFIX)
  if (end <= 0) {
    return null
  }
  return unquote(rest.slice(0, end))
}

/** Strip the quotes the brain wraps a name in, when it did. */
function unquote(value: string): string | null {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
  }
  return value.length > 0 ? value : null
}

/** The query parameter the OAuth callback answers a web flow with (epic #303, X10; #311). */
export const MCP_CONNECTED_PARAM = 'mcp_connected'

/**
 * The server id an OAuth callback named, or `null` (epic #303, X10; #311; #313).
 *
 * A web flow's callback redirects the browser to the app's settings screen with
 * `?mcp_connected=<id>#/settings`, and the app is what confirms the connection and refreshes the
 * server's status. This reads that parameter out of a URL's **search** half — a caller passes
 * `location.search` or a whole URL — and keeps the `#` fragment out of the way, because the
 * query lands before the hash.
 *
 * @param search a query string (`?mcp_connected=…`), a URL, or `''`
 */
export function mcpConnectedServerId(search: string): string | null {
  const query = search.startsWith('?') ? search.slice(1) : search
  const beforeHash = query.split('#', 1)[0] ?? ''
  for (const part of beforeHash.split('&')) {
    const separator = part.indexOf('=')
    if (separator === -1) {
      continue
    }
    if (decodeURIComponent(part.slice(0, separator)) === MCP_CONNECTED_PARAM) {
      const value = decodeURIComponent(part.slice(separator + 1))
      return value.length > 0 ? value : null
    }
  }
  return null
}

/** How often a CLI's connect flow reads the server's status back, in milliseconds. */
export const MCP_CONNECT_POLL_INTERVAL_MS = 2000

/** How long a CLI waits for a browser sign-in to complete, in milliseconds (five minutes). */
export const MCP_CONNECT_TIMEOUT_MS = 300_000

/** What a caller passes {@link waitForMcpConnection}. */
export interface WaitForMcpConnectionOptions {
  /** Read the server back; called once before the first wait, then after every interval. */
  readonly get: (options?: { readonly signal?: AbortSignal | undefined }) => Promise<McpServer>
  /** How often to read, in milliseconds. Defaults to {@link MCP_CONNECT_POLL_INTERVAL_MS}. */
  readonly intervalMs?: number | undefined
  /** How long to wait before giving up. Defaults to {@link MCP_CONNECT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined
  /** Cancels the wait; the last server read is answered with `stopped`. */
  readonly signal?: AbortSignal | undefined
  /** The wait seam, injectable so a test does not sleep. */
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
}

/** How a connect wait ended (epic #303, X10; #313). */
export interface McpConnectionWait {
  /** `connected` when the flow completed, `failed` when the server landed on `error`, `stopped`. */
  readonly outcome: 'connected' | 'failed' | 'timeout' | 'stopped'
  /** The newest read of the server. */
  readonly server: McpServer
}

/**
 * Wait until a server's OAuth flow completes, reading its status back (epic #303, X10; #313).
 *
 * This is the CLI's half of `connect`: `oh` opens the authorization URL in the **system
 * browser** — a browser that may never have signed in to openharness, which is why the callback
 * authenticates by the `state` alone — and then has nothing to do but watch the server's status
 * change, because the callback lands in that browser rather than in the terminal. A web flow
 * needs none of this: its callback redirects to the app, which refreshes the server itself.
 *
 * It reads the server **before** waiting (a fast sign-in is not missed by a whole interval), and
 * answers as soon as the status stops being the one the flow was started for: `connected` for a
 * success, `failed` for an `error` (the token exchange was refused, say), `timeout` when the
 * deadline passes, and `stopped` when the caller aborts. Nothing here throws for a status: a
 * failure is an answer, and the caller renders it.
 *
 * @param options where to read the server, how often, and how long
 */
export async function waitForMcpConnection(
  options: WaitForMcpConnectionOptions,
): Promise<McpConnectionWait> {
  const intervalMs = options.intervalMs ?? MCP_CONNECT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS
  const sleep = options.sleep ?? defaultSleep
  const startedAt = Date.now()

  for (;;) {
    const server = await options.get({ signal: options.signal })
    if (server.status === 'connected' || server.status === 'error') {
      return { outcome: server.status === 'connected' ? 'connected' : 'failed', server }
    }
    if (aborted(options.signal)) {
      return { outcome: 'stopped', server }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { outcome: 'timeout', server }
    }
    await sleep(intervalMs, options.signal)
    if (aborted(options.signal)) {
      return { outcome: 'stopped', server }
    }
  }
}

/**
 * Whether a wait has been cancelled.
 *
 * A function rather than an inline `signal?.aborted` because the narrowing a first check leaves
 * behind would make the second one a type error — the property is re-read here, which is also
 * what the wait really does between two reads.
 */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
