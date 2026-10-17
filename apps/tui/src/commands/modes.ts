import type { Client } from '@openharness/client'
import { MODE_NAME_MAX_LENGTH, type Mode } from '@openharness/protocol'

import type { CommandIo } from './io'
import { reportFailure } from './io'
import { isSubagentType, modeLabel } from '../modes'
import { pad } from './list'

/** `oh modes` — the user's modes, and what each resolves to (#245, M6; types: #340, #342; #347). */
export async function runModes(client: Client, io: CommandIo): Promise<number> {
  try {
    writeLines(io.stdout, formatModes((await client.modes.list()).data))
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
 * the effort ({@link modeLabel}). The name is padded to the protocol's longest name, so the
 * second column lines up whatever the user called their modes.
 *
 * **A subagent type is marked, and says what it is** (epic #340, S2; #342; the refinement for
 * #347): the mode's `subagent_description` is the sentence a parent model chooses the type by,
 * so it is drawn under the mode's own line, indented to the second column, and never edited
 * here — the web app's Settings → Modes is where a description is written. The mark is what
 * tells a reader which of their presets their helpers can be started from.
 */
export function formatModes(modes: readonly Mode[]): readonly string[] {
  if (modes.length === 0) {
    return ['No modes yet. Create one in the web app under Settings → Modes, then run `oh` again.']
  }

  const indent = ' '.repeat(MODE_NAME_MAX_LENGTH + 2)
  const lines = modes.flatMap((mode) => {
    const head = [
      pad(mode.name, MODE_NAME_MAX_LENGTH),
      modeLabel(mode),
      ...(isSubagentType(mode) ? [SUBAGENT_TYPE_MARK] : []),
    ]
      .join('  ')
      .trimEnd()
    const description = mode.subagent_description
    return description === null ? [head] : [head, `${indent}${description}`]
  })

  return lines.some((line) => line.includes(SUBAGENT_TYPE_MARK))
    ? [...lines, SUBAGENT_TYPE_HINT]
    : lines
}

/** Write lines one at a time, so the caller's sink sees them in order. */
function writeLines(write: (line: string) => void, lines: readonly string[]): void {
  for (const line of lines) write(line)
}
