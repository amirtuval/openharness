import {
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  AGENT_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '@openharness/protocol'
import type { ToolPermission, ToolSettingEntry } from '@openharness/protocol'

import { TOOL_POLICIES } from './mcp'

/**
 * The settings view of a tool: which permission it may take, what a cycling key does, and the
 * words a row is drawn with (epic #303, X4; #335).
 *
 * The web app's Settings → Tools card and the terminal's `/tools` screen ask the same three
 * questions about every tool — is it on, what permission does a call run under, and is it
 * available to this chat at all — and they have to answer them the same way. The pieces that
 * are not just the wire's vocabulary live here: the cycle a permission key walks, which is
 * **not** the same for every tool, and the two notes a row owes the reader.
 *
 * Everything is a plain function of an entry, so the rules are tested without a screen.
 */

/**
 * The tools whose calls **cannot pause for the reader** (epic #340, S9; issue #368).
 *
 * `ask` is the pause #309 answers: the call is stored, nothing runs it, and the turn ends
 * `requires_action` until one `user.tool_confirmation` answers it. That needs a client that can
 * *draw* the prompt, and these four are deliberately kept out of the transcript's `toolCalls`
 * (S9) — a card stands in for the `agent` call, and the other three are task machinery rather
 * than work worth a line — so `pendingCalls(toolCalls)` holds nothing for either frontend to
 * hang a prompt under. A policy of `ask` on one of them paused the parent's turn with no way to
 * answer it, reachable from Settings → Tools, which listed them like any other built-in.
 *
 * The decision (2026-10-13) is that these tools **do not support `ask`**, and the server refuses
 * the write; this list is the frontends' half of it, so a settings screen never offers a switch
 * the save would reject. `agent_wait` is **not** here: its own pause (waiting for the tasks it
 * names) outranks the permission, and a `deny` on it is still refused by the loop.
 */
export const NO_ASK_TOOL_NAMES: readonly string[] = [
  AGENT_TOOL_NAME,
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_STOP_TOOL_NAME,
  MESSAGE_PARENT_TOOL_NAME,
]

/**
 * Whether `ask` is a permission this tool may take.
 *
 * False for the two kinds of tool that cannot pause: a **provider-executed** one (`web_search`
 * runs inside the model request, so there is no moment at which this build could ask — the
 * server refuses the write, #335) and the four **subagent** ones ({@link NO_ASK_TOOL_NAMES},
 * whose calls are not in `toolCalls` and so have no prompt a client could draw).
 *
 * @param name the offered name — a built-in's own, or a remote tool's `<server>__<tool>`
 */
export function toolSupportsAsk(name: string): boolean {
  return name !== WEB_SEARCH_TOOL_NAME && !NO_ASK_TOOL_NAMES.includes(name)
}

/**
 * What a row says instead of offering `ask` for a tool that cannot take it (issue #368).
 *
 * Short, and it names the reason rather than the rule: a reader who wanted "pause and let me
 * decide" needs to know there is nobody to pause for, not that this build dislikes the value.
 */
export const SUBAGENT_ASK_NOTE = 'Subagents run in the background — allow or deny it.'

/**
 * The permissions a cycling key walks for a tool, in order.
 *
 * `ask` is missing for a tool that cannot pause — see {@link toolSupportsAsk}. Leaving it in the
 * cycle would offer a reader a switch that the save then rejects (a search) or one that leaves the
 * turn paused with nothing to answer it (a subagent call); `allow` → `deny` is the whole of what
 * cycling one of those means.
 */
export function toolPolicyChoices(name: string): readonly ToolPermission[] {
  return toolSupportsAsk(name) ? TOOL_POLICIES : TOOL_POLICIES.filter((p) => p !== 'ask')
}

/**
 * Where a cycle key takes a tool's permission: `current` moved by `delta` (usually ±1), through
 * {@link toolPolicyChoices} and wrapping.
 *
 * `null` is "no permission to start from" — a row whose tools disagree (the `/mcp` tools face's
 * mixed state) — and the walk then starts **at the end it is walked from**: a forward step takes
 * the first choice and a backward one the last, so a first press lands on a permission that is
 * really written rather than on an arbitrary one. A `current` the tool may not take (a stored
 * `ask` on `web_search`, which the server reads back as `allow`) is treated the same way,
 * because the value a reader sees is the one the write will leave behind.
 */
export function cycleToolPolicy(
  name: string,
  current: ToolPermission | null,
  delta: number,
): ToolPermission {
  const choices = toolPolicyChoices(name)
  const at = current === null ? -1 : choices.indexOf(current)
  if (at === -1) {
    return (delta >= 0 ? choices[0] : choices[choices.length - 1]) ?? 'allow'
  }
  const index = (at + delta + choices.length) % choices.length
  return choices[index] ?? choices[0] ?? 'allow'
}

/**
 * The permission column of a tool's row: the permission, and the default it agrees with.
 *
 * `allow` alone when the tool's own declaration is `allow` (the permission in force **is** the
 * default, so there is nothing to say), `deny (default ask)` when the reader chose against the
 * declaration, and `ask (default)` when they chose the one it happens to equal. A tool this
 * deployment does not register (`default_policy: null`) has no declaration to agree with, so it
 * reads as itself.
 *
 * The rule lives here rather than in each screen because the shell's `oh tools` and the chat's
 * `/tools` must not come to spell the same permission differently.
 */
export function toolPolicyNote(entry: ToolSettingEntry): string {
  if (entry.default_policy === null) return entry.policy
  return entry.policy === entry.default_policy
    ? `${entry.policy} (default)`
    : `${entry.policy} (default ${entry.default_policy})`
}

/**
 * Why a tool cannot be used here, or `null` when it can.
 *
 * The server's own `reason` where it sent one — `This model has no web search.` is the sentence
 * a reader gets when their chat's model has no native search — and the plain note that this
 * deployment does not register the tool otherwise. `available: false` has more than one cause
 * and a settings screen owes the reader the one that applies rather than a single phrase for
 * both.
 */
export function toolAvailabilityNote(entry: ToolSettingEntry): string | null {
  if (entry.available) return null
  return entry.reason ?? NOT_REGISTERED_NOTE
}

/** What an unavailable tool is called when the server named no reason for it. */
export const NOT_REGISTERED_NOTE = 'not available on this server'
