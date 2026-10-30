import type { ModeItemDefault, ModeToolOverride, ToolPermission } from '@openharness/protocol'

/**
 * The tool settings a form offers, in one place (epic #303, X4; #307; the screen is #308).
 *
 * Two tables, and neither is a restatement of the wire:
 *
 * - {@link TOOL_PERMISSIONS} is the three values of the protocol's `policy`, each with the words
 *   a reader chooses by. `ask` is the pause #309 answers (its prompt is #310), so its label says
 *   what happens rather than what it is called.
 * - {@link ModeToolChoice} is the **tri-state** a mode editor needs and the wire does not have:
 *   a mode's `tools.builtin` is a per-tool boolean patch, and "absent" means "follow my own
 *   setting" — which a two-state switch cannot express. The two helpers read a choice out of an
 *   override and put one back, so the mode form never writes the patch inline.
 *
 * Three things a mode can override are offered through the same tri-state, one per granularity:
 * a **built-in tool** by name ({@link modeToolChoice}), a remote **MCP server** by id
 * ({@link modeMcpServerChoice}, #311/#313) and an imported **skill** by id
 * ({@link modeSkillChoice}, epic #349 K8/#353). Each `with…` carries the other two through a
 * save unchanged rather than dropping them with the patch it rebuilds.
 */

/** One permission a form offers: the protocol's value and what it does. */
export interface ToolPermissionOption {
  readonly value: ToolPermission
  readonly label: string
  /** A one-line explanation, for a `title` or a hint row. */
  readonly hint: string
}

/**
 * The three permissions, in the order a select offers them.
 *
 * A **row** offers fewer when the tool cannot take one: `toolPolicyChoices` (`@openharness/client`)
 * is the one rule for that — `ask` is missing for a provider-executed search and for the four
 * subagent calls whose prompt no client could draw (issue #368) — and the settings card filters
 * this list with it rather than restating which tools those are.
 */
export const TOOL_PERMISSIONS: readonly ToolPermissionOption[] = [
  { value: 'allow', label: 'Allow', hint: 'run the call' },
  { value: 'ask', label: 'Ask me first', hint: 'pause the turn until you answer' },
  { value: 'deny', label: 'Deny', hint: 'refuse it without running it' },
]

/**
 * What a mode says about one tool (epic #303, X4; #307).
 *
 * `follow` is the absence of a choice — the chat uses the reader's own setting for that tool —
 * and is what `null` (or a patch that never names the tool) means.
 */
export type ModeToolChoice = 'follow' | 'on' | 'off'

/**
 * The choice an override holds for one tool.
 *
 * @param override the mode's `tools`, or `null` for a mode that says nothing
 * @param name the tool's name
 */
export function modeToolChoice(override: ModeToolOverride | null, name: string): ModeToolChoice {
  const chosen = override?.builtin?.[name]
  if (chosen === undefined) {
    return 'follow'
  }
  return chosen ? 'on' : 'off'
}

/**
 * The override a choice makes: the patch with one tool set, or `null` when nothing is overridden.
 *
 * A patch that ends up empty is returned as `null` rather than `{ builtin: {} }` — the two mean
 * the same thing to the server, and `null` is the reading a reader sees ("follow my settings").
 *
 * **The other halves are carried through untouched** (#311, #312; #349 K8). `tools.mcp_servers`
 * and `tools.skills` are per-server and per-skill on/off patches, edited by
 * {@link withModeMcpServerChoice} and {@link withModeSkillChoice}, so a mode a reader edits here
 * must keep what it already says about them: the form writes back the whole `tools` value, and
 * rebuilding it from `builtin` alone would silently drop those choices on the next save. A patch
 * holding only one of the other halves is not empty — it is a mode that says something — so it is
 * returned as it stands rather than folded to `null`.
 *
 * @param override the mode's current `tools`
 * @param name the tool to set
 * @param choice what to set it to
 */
export function withModeToolChoice(
  override: ModeToolOverride | null,
  name: string,
  choice: ModeToolChoice,
): ModeToolOverride | null {
  const builtin: Record<string, boolean> = { ...(override?.builtin ?? {}) }
  if (choice === 'follow') {
    delete builtin[name]
  } else {
    builtin[name] = choice === 'on'
  }
  return rebuild(override, builtin)
}

/**
 * What a mode says about one remote MCP server (epic #303, X10; #311; #313).
 *
 * The same tri-state a built-in tool gets, at **server** granularity: a mode turns a whole
 * server on or off for the chats that follow it, and there is no per-MCP-tool switch anywhere
 * (a remote tool has no on/off of its own). `follow` is the absence of the server's id in the
 * patch.
 *
 * @param override the mode's `tools`, or `null` for a mode that says nothing
 * @param serverId the `mcps_` id
 */
export function modeMcpServerChoice(
  override: ModeToolOverride | null,
  serverId: string,
): ModeToolChoice {
  const patch: Record<string, boolean> | undefined = override?.mcp_servers
  const chosen = patch?.[serverId]
  if (chosen === undefined) {
    return 'follow'
  }
  return chosen ? 'on' : 'off'
}

/**
 * The override a server's choice makes, keeping every other choice exactly as it was (#311).
 *
 * @param override the mode's current `tools`
 * @param serverId the server to set
 * @param choice what to set it to
 */
export function withModeMcpServerChoice(
  override: ModeToolOverride | null,
  serverId: string,
  choice: ModeToolChoice,
): ModeToolOverride | null {
  const mcpServers: Record<string, boolean> = { ...(override?.mcp_servers ?? {}) }
  if (choice === 'follow') {
    delete mcpServers[serverId]
  } else {
    mcpServers[serverId] = choice === 'on'
  }
  return rebuild(override, { ...(override?.builtin ?? {}) }, mcpServers)
}

/**
 * What a mode says about one of the reader's imported skills (epic #349, K8; #353).
 *
 * The same tri-state again, at **skill** granularity: a mode turns a whole skill on or off for
 * the chats that follow it — the sibling of its `mcp_servers` patch, keyed by a `skl_` id — and
 * a skill the patch does not name follows the reader's own `enabled` on the resource. There is
 * no per-file or per-command switch: a skill is one thing.
 *
 * @param override the mode's `tools`, or `null` for a mode that says nothing
 * @param skillId the `skl_` id
 */
export function modeSkillChoice(
  override: ModeToolOverride | null,
  skillId: string,
): ModeToolChoice {
  const patch: Record<string, boolean> | undefined = override?.skills
  const chosen = patch?.[skillId]
  if (chosen === undefined) {
    return 'follow'
  }
  return chosen ? 'on' : 'off'
}

/**
 * The override a skill's choice makes, keeping every other choice exactly as it was (K8).
 *
 * @param override the mode's current `tools`
 * @param skillId the skill to set
 * @param choice what to set it to
 */
export function withModeSkillChoice(
  override: ModeToolOverride | null,
  skillId: string,
  choice: ModeToolChoice,
): ModeToolOverride | null {
  const skills: Record<string, boolean> = { ...(override?.skills ?? {}) }
  if (choice === 'follow') {
    delete skills[skillId]
  } else {
    skills[skillId] = choice === 'on'
  }
  return rebuild(
    override,
    { ...(override?.builtin ?? {}) },
    { ...(override?.mcp_servers ?? {}) },
    skills,
  )
}

/** The three sections a mode's editor has a "not listed below" default for (epic #349, B8). */
export type ModeSection = 'builtin' | 'mcp_servers' | 'skills'

/** The mode's default for one section — `follow` when it has none (epic #349, B8). */
export function modeSectionDefault(
  override: ModeToolOverride | null,
  section: ModeSection,
): ModeItemDefault {
  return (
    override?.[
      section === 'builtin'
        ? 'builtin_default'
        : section === 'mcp_servers'
          ? 'mcp_servers_default'
          : 'skills_default'
    ] ?? 'follow'
  )
}

/**
 * The override a section default makes, keeping every map and every other default exactly as
 * it was (epic #349, B8).
 *
 * `follow` is the absence of the field — the value every mode created before this setting
 * reads as — so choosing it removes the key rather than storing `'follow'`. An override that
 * says nothing at all afterwards folds back to `null`.
 */
export function withModeSectionDefault(
  override: ModeToolOverride | null,
  section: ModeSection,
  value: ModeItemDefault,
): ModeToolOverride | null {
  const defaults: Partial<
    Pick<ModeToolOverride, 'builtin_default' | 'mcp_servers_default' | 'skills_default'>
  > = {
    builtin_default: override?.builtin_default,
    mcp_servers_default: override?.mcp_servers_default,
    skills_default: override?.skills_default,
  }
  // `undefined` is written rather than the key deleted: `rebuild` uses the key's **presence**
  // to tell "the caller decided this" from "the caller said nothing", and deleting would let
  // the stored value fall back in — which is exactly what choosing Follow must undo.
  defaults[`${section}_default`] = value === 'follow' ? undefined : value
  return rebuild(
    override,
    { ...(override?.builtin ?? {}) },
    { ...(override?.mcp_servers ?? {}) },
    { ...(override?.skills ?? {}) },
    defaults,
  )
}

/**
 * Fold the halves back into one override, or `null` when none of them says anything.
 *
 * A patch that ends up empty is `null` — the reading a reader sees ("follow my settings") and
 * the value the server treats as no override (epic #349, B8 made `builtin` optional, so a mode
 * that says something only about servers is `{ mcp_servers: { … } }`). An empty map is left out
 * altogether — it means the same thing as none, and the patch a reader's choice produces
 * should be the smallest one that says it. A section default that is not `follow` is part of
 * what the patch says, so a mode with one and no entries is still not `null`.
 */
function rebuild(
  override: ModeToolOverride | null,
  builtin: Record<string, boolean>,
  mcpServers: Record<string, boolean> = override?.mcp_servers ?? {},
  skills: Record<string, boolean> = override?.skills ?? {},
  defaults: Partial<
    Pick<ModeToolOverride, 'builtin_default' | 'mcp_servers_default' | 'skills_default'>
  > = {},
): ModeToolOverride | null {
  // Presence, not truthiness: a key the caller wrote as `undefined` means "clear this default",
  // while a key the caller did not write at all means "keep the stored one".
  const taken = (key: keyof typeof defaults, stored: ModeItemDefault | undefined) =>
    Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : stored
  const builtinDefault = taken('builtin_default', override?.builtin_default)
  const mcpDefault = taken('mcp_servers_default', override?.mcp_servers_default)
  const skillsDefault = taken('skills_default', override?.skills_default)
  const next: ModeToolOverride = {
    ...(isEmpty(builtin) ? {} : { builtin }),
    ...(isEmpty(mcpServers) ? {} : { mcp_servers: mcpServers }),
    ...(isEmpty(skills) ? {} : { skills }),
    ...(builtinDefault === undefined || builtinDefault === 'follow'
      ? {}
      : { builtin_default: builtinDefault }),
    ...(mcpDefault === undefined || mcpDefault === 'follow'
      ? {}
      : { mcp_servers_default: mcpDefault }),
    ...(skillsDefault === undefined || skillsDefault === 'follow'
      ? {}
      : { skills_default: skillsDefault }),
  }
  return Object.keys(next).length === 0 ? null : next
}

/** Whether a record holds no entries at all. */
function isEmpty(record: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(record).length === 0
}
