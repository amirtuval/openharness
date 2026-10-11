import type { ModeToolOverride, ToolPermission } from '@openharness/protocol'

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
 * Only the `builtin` half is offered here: a mode's `tools.mcp_servers` is a per-**server**
 * patch whose editor is #313, and {@link withModeToolChoice} carries it through a save
 * unchanged rather than dropping it with the patch it rebuilds.
 */

/** One permission a form offers: the protocol's value and what it does. */
export interface ToolPermissionOption {
  readonly value: ToolPermission
  readonly label: string
  /** A one-line explanation, for a `title` or a hint row. */
  readonly hint: string
}

/** The three permissions, in the order a select offers them. */
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
  const chosen = override?.builtin[name]
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
 * **The MCP half is carried through untouched** (#311, #312). `Mode.tools.mcp_servers` is a
 * per-server on/off patch this editor does not offer yet (its own screen is #313), so a mode a
 * reader edits here must keep whatever it already says about servers: the form writes back the
 * whole `tools` value, and rebuilding it from `builtin` alone would silently drop those choices
 * on the next save. A patch holding only `mcp_servers` is not empty — it is a mode that says
 * something — so it is returned as it stands rather than folded to `null`.
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
  const mcpServers = override?.mcp_servers
  if (Object.keys(builtin).length === 0 && (mcpServers === undefined || isEmpty(mcpServers))) {
    return null
  }
  return mcpServers === undefined ? { builtin } : { builtin, mcp_servers: mcpServers }
}

/** Whether a record holds no entries at all. */
function isEmpty(record: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(record).length === 0
}
