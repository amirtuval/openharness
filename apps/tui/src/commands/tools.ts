import type { Client } from '@openharness/client'
import type { ToolPermission, ToolSettingEntry } from '@openharness/protocol'

import type { ToolsPatch } from '../args'
import { reportFailure, type CommandIo } from './io'

/**
 * `oh tools [name] [--on|--off] [--policy <allow|ask|deny>]` (epic #303, X4; #307; the screen is
 * #308) — the terminal's Tools settings.
 *
 * Without an argument it prints the deployment's tools and what the reader has chosen: whether
 * each is on, the permission a call is evaluated under, and whether this server registers it at
 * all. With a name and one flag it changes that tool — the same `PUT /v1/me/tools` the web app's
 * Settings → Tools card makes, and a merge, so one tool's change never touches another's.
 *
 * A tool this deployment does not register is printed rather than hidden, with `not available`
 * beside it: it is never offered to a model whatever the switch says, and a reader who wonders
 * why their search does nothing has the answer on this line.
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
 */
export function formatTools(entries: readonly ToolSettingEntry[]): string[] {
  if (entries.length === 0) {
    return ['No tools are registered on this server.']
  }
  const width = Math.max(...entries.map((entry) => entry.name.length))
  return entries.map((entry) => {
    const state = entry.enabled ? 'on ' : 'off'
    const availability = entry.available ? '' : ' · not available on this server'
    const policy =
      entry.policy === entry.default_policy
        ? `${entry.policy} (default)`
        : entry.default_policy === null
          ? entry.policy
          : `${entry.policy} (default ${entry.default_policy})`
    return `${entry.name.padEnd(width)}  ${state}  ${policy}${availability}`
  })
}

/** The three permission words, for the argument error a bad `--policy` gets. */
export const TOOL_POLICIES: readonly ToolPermission[] = ['allow', 'ask', 'deny']
