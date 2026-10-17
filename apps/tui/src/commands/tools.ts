import {
  mcpToolPolicyBody,
  NO_ASK_TOOL_NAMES,
  SUBAGENT_ASK_NOTE,
  toolAvailabilityNote,
  toolPolicyNote,
  type Client,
} from '@openharness/client'
import type { ToolPermission, ToolSettingEntry } from '@openharness/protocol'

import type { ToolsPatch } from '../args'
import { reportFailure, type CommandIo } from './io'

/**
 * `oh tools [name] [--on|--off] [--policy <allow|ask|deny>]` (epic #303, X4; #307; the screen is
 * #308; #313) — the terminal's Tools settings.
 *
 * Without an argument it prints the deployment's tools and what the reader has chosen: whether
 * each is on, the permission a call is evaluated under, and whether this server registers it at
 * all. With a name and one flag it changes that tool — the same `PUT /v1/me/tools` the web app's
 * Settings → Tools card makes, and a merge, so one tool's change never touches another's.
 *
 * A tool this deployment does not register is printed rather than hidden, with `not available`
 * beside it: it is never offered to a model whatever the switch says, and a reader who wonders
 * why their search does nothing has the answer on this line.
 *
 * The same settings are in a chat, as `/tools` (#335), and this listing says so: a reader who
 * ran this to change one thing should not have to leave the conversation to change the next.
 *
 * **The listing is this build's own tools and nothing else** (#313). A remote MCP tool belongs to
 * a server — no on/off of its own, and a permission set per server on `/mcp`'s tools face — so
 * mixing them in made this list as long as every server's tool list put together and put two
 * different kinds of setting under one heading. The last line says where they are, because a tool
 * that vanished from a list reads as one that does not exist. A **name** still reaches a remote
 * tool's permission (`--policy`, the map a remote tool's permission really lives in); `--on`/
 * `--off` is refused for one, because whether a remote tool is in play is its server's `enabled`.
 */
export async function runTools(client: Client, io: CommandIo, patch: ToolsPatch): Promise<number> {
  try {
    // The write replaces a tool's whole setting (the schema requires both halves), so the list
    // is read first and the half the flags did not name keeps what is stored — which is also
    // where a name this deployment does not register is noticed.
    const before = await client.tools.list()
    if (patch.name === undefined) {
      for (const line of formatTools(before.data)) {
        io.stdout(line)
      }
      return 0
    }

    const current = before.data.find((entry) => entry.name === patch.name)
    if (current === undefined) {
      io.stderr(`oh: no tool named ${patch.name} is registered on this server.`)
      return 1
    }

    // **A subagent call cannot be asked about** (epic #340, S9; issue #368). Four of the five
    // subagent tools are kept out of the transcript's tool calls — a card stands in for the
    // `agent` call, and the other three are task machinery — so there is no prompt any client
    // could draw, and the server refuses the write. The settings screen offers the tool without
    // the value; this command refuses it rather than sending a write that comes back refused.
    // `agent_wait` is unaffected: its own pause (the tasks it named) outranks the permission.
    if (patch.policy === 'ask' && NO_ASK_TOOL_NAMES.includes(patch.name)) {
      io.stderr(`oh: ${patch.name} cannot take \`ask\`. ${SUBAGENT_ASK_NOTE}`)
      return 2
    }

    // A remote MCP tool's on/off is its server's, so `--on`/`--off` name the wrong thing for
    // one — that is what `/mcp` (and its server row) is for. Its permission does live in the
    // per-tool settings, in the `mcp` map keyed by the offered name, which is a different map
    // than a built-in's: writing `builtin` here would store a choice the server lists as an
    // unavailable tool and never applies to the call.
    if (current.source === 'mcp') {
      if (patch.enabled !== undefined) {
        io.stderr(
          `oh: ${patch.name} is a remote MCP tool; turn the server it belongs to on or off with \`/mcp\`.`,
        )
        return 2
      }
      const after = await client.tools.put(
        mcpToolPolicyBody(patch.name, patch.policy ?? current.policy),
      )
      io.stdout(`Saved ${patch.name}: ${patch.policy ?? current.policy}.`)
      for (const line of formatTools(after.data)) {
        io.stdout(line)
      }
      return 0
    }

    const after = await client.tools.put({
      builtin: {
        [patch.name]: {
          enabled: patch.enabled ?? current.enabled,
          policy: patch.policy ?? current.policy,
        },
      },
    })
    io.stdout(
      `Saved ${patch.name}: ${(patch.enabled ?? current.enabled) ? 'on' : 'off'}, ${patch.policy ?? current.policy}.`,
    )
    for (const line of formatTools(after.data)) {
      io.stdout(line)
    }
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/**
 * The tool list as the lines this command prints.
 *
 * Exported for the test that holds the words still: the on/off word, the permission, the note
 * that it is the tool's own default, and the "not available" case are the whole of what a reader
 * learns here.
 *
 * A **remote MCP entry is not printed** (#313): its permission is set per server on `/mcp`, and a
 * list that mixed a dozen of them with this build's own tools is what the reader reported. A line
 * saying how many were left out and where they are is printed in their place, so a remote tool
 * that is missing here is named as one that is set elsewhere rather than lost.
 */
export function formatTools(entries: readonly ToolSettingEntry[]): string[] {
  const builtin = entries.filter((entry) => entry.source !== 'mcp')
  const remote = entries.length - builtin.length
  const lines =
    builtin.length === 0 ? ['No tools are registered on this server.'] : builtinLines(builtin)
  if (remote > 0) {
    lines.push(
      `${remote === 1 ? '1 tool comes' : `${remote} tools come`} from MCP servers; their permissions are set per server with \`/mcp\`.`,
    )
  }
  // The in-chat counterpart, named where a reader of this listing is already looking (#335):
  // the same settings, without leaving the conversation.
  if (builtin.length > 0) {
    lines.push('In a chat, `/tools` sets these without leaving it.')
  }
  return lines
}

/** One line per built-in tool, its name column padded to the widest of them. */
function builtinLines(entries: readonly ToolSettingEntry[]): string[] {
  const width = Math.max(...entries.map((entry) => entry.name.length))
  return entries.map((entry) => {
    const state = entry.enabled ? 'on ' : 'off'
    const availability = toolAvailabilityNote(entry)
    return `${entry.name.padEnd(width)}  ${state}  ${toolPolicyNote(entry)}${
      availability === null ? '' : ` · ${availability}`
    }`
  })
}

/** The three permission words, for the argument error a bad `--policy` gets. */
export const TOOL_POLICIES: readonly ToolPermission[] = ['allow', 'ask', 'deny']
