import type { ToolSettings, ToolSettingsResolver } from '@openharness/brain'
import type { ToolDefinition, ToolRegistry } from '@openharness/hands'
import type {
  ModeId,
  ModeToolOverride,
  ToolPermission,
  ToolSettingEntry,
  UserId,
  UserToolSettings,
} from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

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
 * name to `{ enabled, policy }`); a tool a user has never configured follows **its own
 * declared default**, so the declarations have to be here — this module is the only place the
 * settings and the registry meet.
 */

/**
 * One tool as the effective answer sees it: the choice in force, and the tool this process
 * registers when it has one.
 *
 * `tool` is what tells the two cases apart — a registered tool has a declaration to fall back
 * on and can be offered, a stored setting for a tool that is not here has neither, and is
 * listed as unavailable rather than dropped.
 */
export interface EffectiveTool {
  readonly name: string
  /** Whether the tool is offered at all: the user's choice, or the mode's override of it. */
  readonly enabled: boolean
  /** The permission a call is evaluated under: the user's choice, or the tool's declaration. */
  readonly policy: ToolPermission
  /** The tool this process registers under that name, or `undefined` when it registers none. */
  readonly tool: ToolDefinition | undefined
}

/**
 * The effective state of every tool that can appear: the ones this process registers, in
 * registry order — the order a request offers them in — then any tool a user has a stored
 * setting for that is not registered, by name.
 *
 * The order is the two halves' own: registered tools are the request's offer and keep its
 * order, and the extras are an afterthought a settings screen shows last. A tool named only by
 * a **mode's** override, with no stored setting and no registration, is not listed: this
 * process could not offer it whatever the mode said, and the override is a patch over the
 * user's settings rather than a list of its own.
 *
 * The rules, each in one line:
 *
 * - **enabled**: the mode's override if it names the tool, then the user's choice, then `true`
 *   — a tool nobody turned off is on.
 * - **policy**: the user's choice, then the tool's own declaration, then `deny` — a permission
 *   only a user sets, and a name nothing declares may not be run.
 * - A mode never touches `policy` (E6): its override is on/off only.
 */
export function effectiveTools(
  registry: ToolRegistry | undefined,
  stored: UserToolSettings,
  override: ModeToolOverride | null,
): EffectiveTool[] {
  const registered = registry?.tools ?? []
  const extra = Object.keys(stored.builtin)
    .filter((name) => registry?.get(name) === undefined)
    .sort()
  return [...registered.map((tool) => tool.name), ...extra].map((name) => {
    const tool = registry?.get(name)
    const setting = stored.builtin[name]
    return {
      name,
      enabled: override?.builtin[name] ?? setting?.enabled ?? true,
      policy: setting?.policy ?? tool?.permission ?? 'deny',
      tool,
    }
  })
}

/**
 * The effective settings as the wire's entries: what `GET` and `PUT /v1/me/tools` answer.
 *
 * A registered tool reports its declaration as `default_policy` so a client can show "default"
 * beside a choice that happens to equal it; a tool this process does not register has no
 * declaration to report, and reads as `null` with `available: false`.
 */
export function toolSettingEntries(
  registry: ToolRegistry | undefined,
  stored: UserToolSettings,
  override: ModeToolOverride | null,
): ToolSettingEntry[] {
  return effectiveTools(registry, stored, override).map((tool) => ({
    name: tool.name,
    source: 'builtin',
    enabled: tool.enabled,
    policy: tool.policy,
    default_policy: tool.tool?.permission ?? null,
    available: tool.tool !== undefined,
  }))
}

/**
 * The effective settings as the brain reads them (#307): a decision per tool name, which is
 * what decides the offer a request is built from and the permission a call is evaluated under.
 *
 * The same answer as {@link toolSettingEntries}, projected the way `runTurn` wants it: the
 * entries a client reads and the decisions the loop acts on are one computation, so a settings
 * screen and the request a chat makes cannot disagree.
 */
export function toolDecisions(
  registry: ToolRegistry | undefined,
  stored: UserToolSettings,
  override: ModeToolOverride | null,
): ToolSettings {
  return Object.fromEntries(
    effectiveTools(registry, stored, override).map((tool) => [
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
 */
export function createToolSettingsResolver(deps: ToolSettingsDeps): ToolSettingsResolver {
  return async (ownerId, modeOverride) =>
    toolDecisions(deps.tools, await deps.store.getToolSettings(ownerId), modeOverride)
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
  return toolSettingEntries(deps.tools, stored, override)
}
