import type { Client } from '@openharness/client'
import { MODE_NAME_MAX_LENGTH, type Mode } from '@openharness/protocol'

import type { CommandIo } from './io'
import { reportFailure } from './io'
import { modeLabel } from '../modes'
import { pad } from './list'

/** `oh modes` — the user's modes, and what each resolves to (#245, M6). */
export async function runModes(client: Client, io: CommandIo): Promise<number> {
  try {
    writeLines(io.stdout, formatModes((await client.modes.list()).data))
    return 0
  } catch (error) {
    return reportFailure(io, error)
  }
}

/**
 * One line per mode: its name and what it resolves to — the model (or "my default model") and
 * the effort ({@link modeLabel}). The name is padded to the protocol's longest name, so the
 * second column lines up whatever the user called their modes.
 */
export function formatModes(modes: readonly Mode[]): readonly string[] {
  if (modes.length === 0) {
    return ['No modes yet. Create one in the web app under Settings → Modes, then run `oh` again.']
  }

  return modes.map((mode) =>
    [pad(mode.name, MODE_NAME_MAX_LENGTH), modeLabel(mode)].join('  ').trimEnd(),
  )
}

/** Write lines one at a time, so the caller's sink sees them in order. */
function writeLines(write: (line: string) => void, lines: readonly string[]): void {
  for (const line of lines) write(line)
}
