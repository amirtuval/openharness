import type { Client } from '@openharness/client'
import { MODE_NAME_MAX_LENGTH, type Mode, type Skill } from '@openharness/protocol'

import type { CommandIo } from './io'
import { reportFailure } from './io'
import { isSubagentType, modeLabel } from '../modes'
import { pad } from './list'

/**
 * `oh modes` — the user's modes, and what each resolves to (#245, M6; types: #340, #342; #347).
 *
 * A mode may also override which **skills** are on for the chats that follow it (epic #349, K8:
 * `Mode.tools.skills`, an on/off map by skill id). `oh` does not edit modes — that is the web
 * app's Settings → Modes — so the override is shown **read-only** here, by name, rather than
 * being editable: a reader who wonders why a chat on a mode is not offered a skill finds the
 * answer on the mode's line.
 *
 * A mode carrying a `subagent_description` is a **subagent type** (epic #340, S2; #342): the
 * sentence a parent model chooses it by is drawn under the mode's line, and never edited here
 * for the same reason.
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

/** The word that marks a mode the parent model can start as a helper (epic #340, S2; #342). */
export const SUBAGENT_TYPE_MARK = 'subagent type'

/**
 * The line {@link formatModes} closes with when the account has a subagent type, so the word
 * means something to a reader who has not met one — and so the one thing `oh` cannot do about a
 * type is said out loud rather than discovered.
 */
export const SUBAGENT_TYPE_HINT =
  'A subagent type is a mode a chat’s model may start as a helper; `oh` shows it read-only.'

/**
 * One line per mode: its name and what it resolves to — the model (or "my default model") and
 * the effort ({@link modeLabel}) — then the skills it turns on or off, when it overrides any.
 * The name is padded to the protocol's longest name, so the second column lines up whatever the
 * user called their modes.
 *
 * **A subagent type is marked, and says what it is** (epic #340, S2; #342; the refinement for
 * #347): the mode's `subagent_description` is the sentence a parent model chooses the type by,
 * so it is drawn under the mode's own line, indented to the second column, and never edited
 * here — the web app's Settings → Modes is where a description is written. The mark is what
 * tells a reader which of their presets their helpers can be started from.
 */
export function formatModes(
  modes: readonly Mode[],
  skills: readonly Skill[] = [],
): readonly string[] {
  if (modes.length === 0) {
    return ['No modes yet. Create one in the web app under Settings → Modes, then run `oh` again.']
  }

  const names = new Map(skills.map((skill) => [skill.id, skill.name]))
  const indent = ' '.repeat(MODE_NAME_MAX_LENGTH + 2)
  const lines = modes.flatMap((mode) => {
    const line = [
      pad(mode.name, MODE_NAME_MAX_LENGTH),
      modeLabel(mode),
      ...(isSubagentType(mode) ? [SUBAGENT_TYPE_MARK] : []),
    ]
      .join('  ')
      .trimEnd()
    const overrides = skillOverridesLabel(mode, names)
    const head = overrides === null ? line : `${line}  ·  ${overrides}`
    const description = mode.subagent_description
    return description === null ? [head] : [head, `${indent}${description}`]
  })

  return lines.some((line) => line.includes(SUBAGENT_TYPE_MARK))
    ? [...lines, SUBAGENT_TYPE_HINT]
    : lines
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
