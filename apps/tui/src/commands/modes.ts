import type { Client } from '@openharness/client'
import { MODE_NAME_MAX_LENGTH, type Mode, type Skill } from '@openharness/protocol'

import type { CommandIo } from './io'
import { reportFailure } from './io'
import { modeLabel } from '../modes'
import { pad } from './list'

/**
 * `oh modes` — the user's modes, and what each resolves to (#245, M6).
 *
 * A mode may also override which **skills** are on for the chats that follow it (epic #349, K8:
 * `Mode.tools.skills`, an on/off map by skill id). `oh` does not edit modes — that is the web
 * app's Settings → Modes — so the override is shown **read-only** here, by name, rather than
 * being editable: a reader who wonders why a chat on a mode is not offered a skill finds the
 * answer on the mode's line.
 *
 * The skills read is **best effort**: a server that cannot list them costs the extra segment, not
 * the command — a mode's model and effort are still the line this command exists for.
 */
export async function runModes(client: Client, io: CommandIo): Promise<number> {
  try {
    const { data: modes } = await client.modes.list()
    // `oh skills`' own list, only to turn a `skl_` id into the name the reader knows. A failed
    // read answers no names, and the override then reads by id.
    const skills = await client.skills
      .list()
      .then(({ data }) => data)
      .catch(() => [] as readonly Skill[])
    writeLines(io.stdout, formatModes(modes, skills))
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/**
 * One line per mode: its name and what it resolves to — the model (or "my default model") and
 * the effort ({@link modeLabel}) — then the skills it turns on or off, when it overrides any.
 * The name is padded to the protocol's longest name, so the second column lines up whatever the
 * user called their modes.
 */
export function formatModes(
  modes: readonly Mode[],
  skills: readonly Skill[] = [],
): readonly string[] {
  if (modes.length === 0) {
    return ['No modes yet. Create one in the web app under Settings → Modes, then run `oh` again.']
  }

  const names = new Map(skills.map((skill) => [skill.id, skill.name]))
  return modes.map((mode) => {
    const line = [pad(mode.name, MODE_NAME_MAX_LENGTH), modeLabel(mode)].join('  ').trimEnd()
    const overrides = skillOverridesLabel(mode, names)
    return overrides === null ? line : `${line}  ·  ${overrides}`
  })
}

/**
 * The skills a mode turns on or off, as one clause — or `null` when it overrides none.
 *
 * A skill the reader no longer has is named by its id rather than dropped: the protocol stores
 * the map as written and ignores an id nothing answers to, and a line that hid it would leave a
 * reader wondering why their map has an entry that never shows. A skill with a name here is the
 * one the mode really turns on or off (K8).
 */
function skillOverridesLabel(mode: Mode, names: ReadonlyMap<string, string>): string | null {
  const overrides = mode.tools?.skills
  if (overrides === undefined) return null
  const entries = Object.entries(overrides)
  if (entries.length === 0) return null
  return `skills: ${entries
    .map(([id, on]) => `${names.get(id) ?? id} ${on ? 'on' : 'off'}`)
    .join(', ')}`
}

/** Write lines one at a time, so the caller's sink sees them in order. */
function writeLines(write: (line: string) => void, lines: readonly string[]): void {
  for (const line of lines) write(line)
}
