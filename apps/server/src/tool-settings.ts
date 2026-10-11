import type { ToolSettings, ToolSettingsResolver } from '@openharness/brain'
import type { ToolDefinition, ToolRegistry } from '@openharness/hands'
import type {
  McpServer,
  ModeId,
  ModeToolOverride,
  ToolPermission,
  ToolSettingEntry,
  UserId,
  UserToolSettings,
} from '@openharness/protocol'
import { DEFAULT_MCP_TOOL_PERMISSION, mcpToolOfferedName } from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

import { listMcpServersInForce } from './mcp/in-force'
import type { McpServerService } from './mcp/service'
import { requireOwnedMode } from './modes'

/**
 * The per-user tool settings, server-side (epic #303, X4; issue #307): which built-in tools a
 * user's chats may offer, the permission each call is evaluated under, and the one place the
 * **effective** answer — the user's choices with a mode's override applied over them — is
 * computed.
 *
 * Three readers want that answer, and they must not disagree:
 *
 * - `GET /v1/me/tools` (optionally for a chat's mode) lists it for a client, one entry per
 *   tool, with the facts a settings screen needs (`available`, the tool's own `default_policy`);
 * - `PUT /v1/me/tools` answers the same shape after writing;
 * - the brain asks for it once per request through {@link createToolSettingsResolver}, and
 *   builds the request's **offer** from it: a disabled tool is not in the offer at all, and a
 *   permission is what a call to an offered tool is evaluated under.
 *
 * The store holds only the user's own choices (`SessionStore.getToolSettings`, a map of tool
 * name to `{ enabled, policy }` and a map of remote tool name to a policy); a tool a user has
 * never configured follows **its own declared default**, so the declarations have to be here —
 * this module is the only place the settings, the registry and the user's MCP servers meet.
 */

/**
 * One tool as the effective answer sees it: the choice in force, and the tool this process
 * registers (or the server that offers it) when it has one.
 *
 * `tool` and `server` are what tell the cases apart — a registered tool has a declaration to
 * fall back on and can be offered, a remote tool's declaration is `ask` and its server says
 * where it is from, and a stored setting for neither is listed as unavailable rather than
 * dropped.
 */
export interface EffectiveTool {
  readonly name: string
  /** Which half of the settings the tool belongs to. */
  readonly source: 'builtin' | 'mcp'
  /** Whether the tool is offered at all: the user's choice, or the mode's override of it. */
  readonly enabled: boolean
  /** The permission a call is evaluated under: the user's choice, or the tool's declaration. */
  readonly policy: ToolPermission
  /** The tool this process registers under that name, or `undefined` when it registers none. */
  readonly tool: ToolDefinition | undefined
  /** The name of the in-force MCP server that offers it, for a remote tool. */
  readonly server?: string
}

/**
 * The effective state of every tool that can appear: the ones this process registers, in
 * registry order — the order a request offers them in — then the tools of the user's in-force
 * remote MCP servers, then any tool a user has a stored setting for that is neither.
 *
 * The order is the halves' own: registered tools are the request's offer and keep its order,
 * remote tools follow their servers (oldest first, the store's order), and the extras are an
 * afterthought a settings screen shows last. A tool named only by a **mode's** override, with no
 * stored setting and no registration, is not listed: this process could not offer it whatever
 * the mode said, and the override is a patch over the user's settings rather than a list of its
 * own.
 *
 * The rules, each in one line:
 *
 * - **enabled**: the mode's override if it names the tool, then the user's choice, then `true`
 *   — a tool nobody turned off is on. A remote tool has no choice of its own: its server is in
 *   the list precisely because it is in force, so it reads `true`, and a mode that turns the
 *   server off takes its tools out of the list entirely.
 * - **policy**: the user's choice, then the tool's own declaration, then `deny` — a permission
 *   only a user sets, and a name nothing declares may not be run. A remote tool's declaration is
 *   `ask` (X6): a third party's tool is not run without the user saying so.
 * - A mode never touches `policy` (E6): its override is on/off only.
 */
export function effectiveTools(
  registry: ToolRegistry | undefined,
  stored: UserToolSettings,
  override: ModeToolOverride | null,
  servers: readonly McpServer[] = [],
): EffectiveTool[] {
  const registered = registry?.tools ?? []
  const builtin: EffectiveTool[] = registered.map((tool) => {
    const setting = stored.builtin[tool.name]
    return {
      name: tool.name,
      source: 'builtin',
      enabled: override?.builtin[tool.name] ?? setting?.enabled ?? true,
      policy: setting?.policy ?? tool.permission,
      tool,
    }
  })
  // A remote tool is offered under the model-facing name the call is recorded by
  // (`mcpToolOfferedName`), which is what its policy is keyed under — so a settings screen, the
  // brain's decisions and the log all speak of the same tool.
  const remote: EffectiveTool[] = servers.flatMap((server) =>
    server.tools.map((summary) => {
      const name = mcpToolOfferedName(server.name, summary.name)
      return {
        name,
        source: 'mcp' as const,
        enabled: true,
        policy: stored.mcp[name] ?? DEFAULT_MCP_TOOL_PERMISSION,
        tool: undefined,
        server: server.name,
      }
    }),
  )
  const listed = new Set([...builtin, ...remote].map((tool) => tool.name))
  // A stored choice for a tool that is not here: a built-in this deployment does not register, a
  // remote tool of a server that is gone or off, or one whose listing changed around it. Listed
  // rather than hidden, so a user can see why a tool they switched on is not working.
  const extra: EffectiveTool[] = [
    ...Object.keys(stored.builtin)
      .filter((name) => !listed.has(name))
      .map((name) => ({
        name,
        source: 'builtin' as const,
        enabled: override?.builtin[name] ?? stored.builtin[name]?.enabled ?? true,
        policy: stored.builtin[name]?.policy ?? 'deny',
        tool: undefined,
      })),
    ...Object.keys(stored.mcp)
      .filter((name) => !listed.has(name))
      .map((name) => ({
        name,
        source: 'mcp' as const,
        enabled: true,
        policy: stored.mcp[name] ?? DEFAULT_MCP_TOOL_PERMISSION,
        tool: undefined,
      })),
  ].sort((left, right) => left.name.localeCompare(right.name))
  return [...builtin, ...remote, ...extra]
}

/**
 * The effective settings as the wire's entries: what `GET` and `PUT /v1/me/tools` answer.
 *
 * A registered tool reports its declaration as `default_policy` so a client can show "default"
 * beside a choice that happens to equal it; a remote tool reports `ask`; a tool neither this
 * process nor an in-force server offers has no declaration to report, and reads as `null` with
 * `available: false`. A remote entry carries `mcp_server`, which is what a settings screen groups
 * remote tools by.
 */
export function toolSettingEntries(
  registry: ToolRegistry | undefined,
  stored: UserToolSettings,
  override: ModeToolOverride | null,
  servers: readonly McpServer[] = [],
): ToolSettingEntry[] {
  return effectiveTools(registry, stored, override, servers).map((tool) => ({
    name: tool.name,
    source: tool.source,
    enabled: tool.enabled,
    policy: tool.policy,
    default_policy:
      tool.source === 'mcp'
        ? tool.server === undefined
          ? null
          : DEFAULT_MCP_TOOL_PERMISSION
        : (tool.tool?.permission ?? null),
    available: tool.source === 'mcp' ? tool.server !== undefined : tool.tool !== undefined,
    ...(tool.server === undefined ? {} : { mcp_server: tool.server }),
  }))
}

/**
 * The effective settings as the brain reads them (#307; the remote half: #312): a decision per
 * tool name, which is what decides the offer a request is built from and the permission a call
 * is evaluated under.
 *
 * The same answer as {@link toolSettingEntries}, projected the way `runTurn` wants it: the
 * entries a client reads and the decisions the loop acts on are one computation, so a settings
 * screen and the request a chat makes cannot disagree.
 */
export function toolDecisions(
  registry: ToolRegistry | undefined,
  stored: UserToolSettings,
  override: ModeToolOverride | null,
  servers: readonly McpServer[] = [],
): ToolSettings {
  return Object.fromEntries(
    effectiveTools(registry, stored, override, servers).map((tool) => [
      tool.name,
      { enabled: tool.enabled, permission: tool.policy },
    ]),
  )
}

/**
 * What the tool-settings half needs: the store, and the tools this process runs.
 *
 * The store is the settings' own read and the mode read beside it — the listing may be asked
 * for a chat's mode, and a mode the caller does not own is the 404 `requireOwnedMode` raises.
 */
export interface ToolSettingsDeps {
  /** The stored per-user tool choices, and the modes an override may come from. */
  readonly store: Pick<SessionStore, 'getToolSettings' | 'getMode' | 'getPreferences'>
  /** The tools this process registers, or `undefined` for none. */
  readonly tools: ToolRegistry | undefined
  /**
   * The user's remote MCP servers (epic #303, X10; #312), or `undefined` for a deployment with
   * no MCP at all. Only `list` is used: the entries are built from each server's listed tool
   * **names** — the summaries the last connection check stored — rather than by asking every
   * server again, because a settings read is about policy and not about a schema.
   */
  readonly mcpServers?: Pick<McpServerService, 'list'>
}

/** The user's servers in force for this read, or none for a deployment without MCP. */
async function serversInForce(
  deps: ToolSettingsDeps,
  ownerId: UserId,
  override: ModeToolOverride | null,
): Promise<readonly McpServer[]> {
  return deps.mcpServers === undefined
    ? []
    : listMcpServersInForce({ mcpServers: deps.mcpServers }, ownerId, override)
}

/**
 * The {@link ToolSettingsResolver} the server hands the brain: the session owner's stored
 * choices with the mode's override applied, answered per request.
 *
 * It reads the store once per request — the same price the compaction and mode resolvers pay —
 * which is what makes a settings change, or a mode edit, apply from the next request on. The
 * override arrives as an argument because the mode a chat follows is resolved by the host
 * before this is asked (`modes.ts`), so the two answers come from one place and the loop never
 * merges them itself.
 *
 * The remote half is read from the same override (#312), so the tools this says are offered and
 * the servers the loop lists cannot disagree: a server a mode turned off contributes neither.
 */
export function createToolSettingsResolver(deps: ToolSettingsDeps): ToolSettingsResolver {
  return async (ownerId, modeOverride) => {
    const stored = await deps.store.getToolSettings(ownerId)
    return toolDecisions(
      deps.tools,
      stored,
      modeOverride,
      await serversInForce(deps, ownerId, modeOverride),
    )
  }
}

/**
 * Read the effective settings, as a chat on `modeId` would see them when one is named.
 *
 * A mode id the caller does not own is the 404 every other mode read gives (A4) — the same
 * `requireOwnedMode` the mode routes use — and a mode with no tool override changes nothing.
 */
export async function listToolSettings(
  deps: ToolSettingsDeps,
  ownerId: UserId,
  modeId: ModeId | undefined,
): Promise<ToolSettingEntry[]> {
  const stored = await deps.store.getToolSettings(ownerId)
  const override =
    modeId === undefined ? null : (await requireOwnedMode(deps, ownerId, modeId)).tools
  return toolSettingEntries(
    deps.tools,
    stored,
    override,
    await serversInForce(deps, ownerId, override),
  )
}
