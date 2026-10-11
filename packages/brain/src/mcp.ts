import type { ToolDefinition, ToolRegistry } from '@openharness/hands'
import { createToolRegistry } from '@openharness/hands'
import type { ModeToolOverride, UserId } from '@openharness/protocol'

/**
 * The remote MCP tools a request may offer (epic #303, X10; #312).
 *
 * MCP is the half of the tool loop the brain cannot resolve itself: a server's tools have to be
 * *asked for* — a network call, with a credential the host holds — and which servers are in
 * force is the user's settings and the request's mode. So the host injects a resolver, the same
 * seam `resolveMode` and `toolSettings` use, and this module is what the loop does with its
 * answer: one registry to offer and run, the pair behind every offered name, and the failures
 * worth telling the user about.
 *
 * The listing is asked for **once per request**, not once per turn, because a server switched
 * off, removed or fixed applies from the next request on — and the host is expected to make
 * that cheap with a short cache (the server's does). What the loop guarantees is narrower and
 * is the part a reader can rely on: what this returns is what the request offered, and the span
 * records it.
 */

/** One remote tool a host listed, ready to be offered. */
export interface McpOfferedTool {
  /** The server it belongs to, by name — what the call event records. */
  readonly serverName: string
  /** The tool's own name on that server. */
  readonly toolName: string
  /**
   * The tool as the loop runs it (`@openharness/hands`' `createMcpTool`), whose `name` is the
   * model-facing offered name.
   */
  readonly definition: ToolDefinition
}

/**
 * Why a server could not be listed (epic #303, X10).
 *
 * The two are told apart because they mean different things to the user: a connection failure is
 * a server that is down or unreachable, an authentication failure is a token that has to be
 * connected again — and the host marks the server `needs_reconnect` for the second, which is
 * what the settings screen offers the flow from.
 */
export type McpFailureKind = 'connection' | 'authentication'

/** One server that could not be listed, and why. */
export interface McpListingFailure {
  /** The server's name — the only identity a failure is reported by. */
  readonly serverName: string
  /** Which failure it was. */
  readonly kind: McpFailureKind
  /** What to tell the user; never a secret, and never a URL's credentials. */
  readonly message: string
}

/** What one request's listing produced: the tools, and the servers that could not be listed. */
export interface McpToolOffer {
  readonly tools: readonly McpOfferedTool[]
  readonly failures: readonly McpListingFailure[]
}

/**
 * Where a request's remote tools come from (epic #303, #312).
 *
 * A resolver rather than a registry, for the reason every other seam here is one: which servers
 * are in force belongs to the session's owner, the credentials live in the host's vault, and the
 * listing is a network call nothing in this package makes. It is asked once per request with the
 * owner and the tool override of the mode that request resolved to — the *same* answer the
 * settings resolver is asked with, so a chat's built-in tools and its servers cannot disagree.
 *
 * A host that wired none, and a user with no servers, answer an empty offer; a server that could
 * not be listed is a **failure** rather than an error, because the turn goes on without it.
 */
export type McpToolProvider = (
  ownerId: UserId,
  modeOverride: ModeToolOverride | null,
) => Promise<McpToolOffer> | McpToolOffer

/** Which server and tool an offered name stands for (epic #303, #312). */
export interface McpToolRef {
  readonly serverName: string
  readonly toolName: string
}

/** What {@link resolveMcpTools} answers: the registry to offer, and the pairs behind its names. */
export interface ResolvedMcpTools {
  /** The remote tools as a registry, or `undefined` when the offer held none. */
  readonly registry: ToolRegistry | undefined
  /** Which server and tool each offered name belongs to, for the call event (#312). */
  readonly refs: ReadonlyMap<string, McpToolRef>
  /** The servers that could not be listed, deduplicated by server. */
  readonly failures: readonly McpListingFailure[]
}

/** The offer of a request that has no remote tools: nothing, and no failure to report. */
export const NO_MCP_TOOLS: ResolvedMcpTools = {
  registry: undefined,
  refs: new Map(),
  failures: [],
}

/**
 * Resolve one request's remote tools (epic #303, X10; #312).
 *
 * The host is asked once, and its answer is normalized into the three things the loop needs.
 * Two rules are this module's:
 *
 * - **A name is claimed once.** A model-facing name is a pure function of the server and the
 *   tool (`mcpToolOfferedName`), so two pairs that sanitize to the same name cannot be told
 *   apart by anything a reader of the log has — the **first** claim wins and the later tool is
 *   not offered. That is the one reading that keeps the name recomputable from a call event,
 *   which is what every cap, approval and rebuilt request depends on. A remote tool can never
 *   collide with a built-in (`<server>__<tool>` carries a double underscore and no built-in
 *   does), but the check is against the deployment's names anyway, so what is offered is what a
 *   registry can hold.
 * - **A failure is per server.** A host that reports the same server twice (a retry it made
 *   itself, say) is reported once.
 *
 * @param provider where the listing comes from, or `undefined` for a host with no MCP at all
 * @param base the tools the deployment registers, whose names claim a place first
 * @param ownerId the session's owner
 * @param modeOverride the tool override of the mode the request resolved to, or `null`
 */
export async function resolveMcpTools(
  provider: McpToolProvider | undefined,
  base: ToolRegistry | undefined,
  ownerId: UserId,
  modeOverride: ModeToolOverride | null,
): Promise<ResolvedMcpTools> {
  if (provider === undefined) {
    return NO_MCP_TOOLS
  }
  const offer = await provider(ownerId, modeOverride)
  const taken = new Set(base?.tools.map((tool) => tool.name) ?? [])
  const definitions: ToolDefinition[] = []
  const refs = new Map<string, McpToolRef>()
  for (const tool of offer.tools) {
    const name = tool.definition.name
    if (taken.has(name)) {
      continue
    }
    taken.add(name)
    definitions.push(tool.definition)
    refs.set(name, { serverName: tool.serverName, toolName: tool.toolName })
  }
  const failures = new Map<string, McpListingFailure>()
  for (const failure of offer.failures) {
    failures.set(failure.serverName, failure)
  }
  return {
    registry: definitions.length === 0 ? undefined : createToolRegistry(definitions),
    refs,
    failures: [...failures.values()],
  }
}

/**
 * The tools one request offers, deployment and remote together (epic #303, #312).
 *
 * One registry rather than two, because everything downstream is keyed by a tool's name and
 * knows nothing about where it came from — the settings' on/off, the permission a call is
 * evaluated under, the step that runs it, the result's cap. What tells the two apart is the
 * call event the loop writes and the `refs` map beside this, not a second code path.
 *
 * `undefined` when neither side offers anything, which is how "this request offers no tools"
 * stays one value: a deployment with no registry, a model that cannot call tools, and a user
 * who turned everything off all build the request tools never existed for.
 */
export function combineTools(
  base: ToolRegistry | undefined,
  remote: ToolRegistry | undefined,
): ToolRegistry | undefined {
  if (base === undefined) {
    return remote
  }
  if (remote === undefined) {
    return base
  }
  return createToolRegistry([...base.tools, ...remote.tools])
}
