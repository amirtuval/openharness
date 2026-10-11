import { TOOLS_UNSUPPORTED_NOTICE } from '@openharness/client'
import { Box, Text } from 'ink'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { useTerminalTheme } from './theme'

/**
 * The lines a terminal draws because tools were involved (epic #303, X2/X5/X9; issue #308).
 *
 * The web's four notices, as the terminal's plain lines: the step limit, a model that cannot use
 * tools, what a request shortened, and what it cleared. The words are the client's
 * (`stepLimitNotice`, `truncatedResultsNotice`, `clearedResultsNotice`,
 * `TOOLS_UNSUPPORTED_NOTICE`), so both frontends say the same thing — and a terminal has no
 * tooltip, so anything the page keeps in a `title` is in the line here.
 *
 * An amber line is the palette's "something to look at" (X4) for the two that are a consequence
 * of the model's own work; a dim one is chrome, for the notices that are just bookkeeping.
 */
export function ToolNoticesView({
  stepLimit = null,
  unsupported = false,
  truncated = null,
  cleared = null,
}: {
  readonly stepLimit?: string | null
  readonly unsupported?: boolean
  readonly truncated?: string | null
  readonly cleared?: string | null
}) {
  const theme = useTerminalTheme()
  const lines = toolNoticeLines(theme, { stepLimit, unsupported, truncated, cleared })
  if (lines.length === 0) {
    return null
  }
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} color={line.color} dimColor={line.dim}>
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

/** One notice line: what it says, and the colour it is drawn in. */
export interface ToolNoticeLine {
  readonly text: string
  readonly color?: string | undefined
  readonly dim?: boolean | undefined
}

/**
 * The notice lines, without a terminal — the words and their tones are the whole of it, and a
 * test reads them from here.
 */
export function toolNoticeLines(
  theme: TerminalTheme,
  notices: {
    readonly stepLimit?: string | null
    readonly unsupported?: boolean
    readonly truncated?: string | null
    readonly cleared?: string | null
  },
): ToolNoticeLine[] {
  const lines: ToolNoticeLine[] = []
  const amber = { color: paint(theme, PALETTE.busy) }
  const chrome = { color: paint(theme, PALETTE.chrome), dim: true }
  if (notices.stepLimit != null && notices.stepLimit !== '') {
    lines.push({ text: notices.stepLimit, ...amber })
  }
  if (notices.unsupported === true) {
    lines.push({ text: TOOLS_UNSUPPORTED_NOTICE, ...chrome })
  }
  if (notices.truncated != null) {
    lines.push({ text: notices.truncated, ...amber })
  }
  if (notices.cleared != null) {
    lines.push({ text: notices.cleared, ...chrome })
  }
  return lines
}
