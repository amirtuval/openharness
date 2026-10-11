import { toolCallSummary, toolStatusLabel } from '@openharness/client'
import type { TranscriptToolCall, ToolCallStatus } from '@openharness/client'
import { Box, Text, useStdout } from 'ink'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { truncateSpans, wrapSpans, type Line, type Span } from '../markdown/text'
import { CURSOR_COLUMNS } from './message-view'
import { useTerminalTheme } from './theme'

/**
 * One tool call in the transcript (epic #303, X1/X5; issue #308).
 *
 * The terminal's half of the web's tool-call line: the tool's name, what it was asked (the same
 * `toolCallSummary`), and its state — the same words `toolStatusLabel` gives the page. **A
 * terminal has no disclosure control**, so what the page hides behind the line is drawn here as
 * it is worth drawing: the status, and the one line of a failed or interrupted result that says
 * why. The full input and result are deliberately not printed — a URL and a page of Markdown
 * per call would make the transcript unreadable, and the log holds them.
 *
 * It draws like the transcript draws structure (X4): named ANSI colours, `chrome` for the
 * ordinary parts, and the palette's warning colour for a call that is waiting on the reader or
 * failed. Nothing survives `NO_COLOR` but the glyphs and the words.
 */

/**
 * What the terminal falls back to when it will not say how wide it is — the same number
 * `message-view.tsx` and `status-line.tsx` use, so the block and the transcript agree.
 */
const FALLBACK_COLUMNS = 80

/** The marks a status is drawn with, so the state is readable before the words are. */
const STATUS_MARKS: Readonly<Record<ToolCallStatus, string>> = {
  running: '◐',
  waiting: '◔',
  done: '●',
  error: '✗',
  denied: '⊘',
  dismissed: '◌',
  interrupted: '◌',
  lost: '?',
}

export function ToolCallView({
  call,
  width,
}: {
  readonly call: TranscriptToolCall
  /**
   * How wide the terminal is, when the caller knows better than Ink does — the test seam the
   * frame tests draw at a width they can read, as `MessageView` and `SummaryDivider` have.
   */
  readonly width?: number | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const lines = toolCallLines(call, width ?? stdout.columns ?? FALLBACK_COLUMNS, theme)

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // A call's lines have no identity of their own; their order is it.
        <Text key={index}>
          {line.map((span, position) => (
            <Text key={position} color={span.color} dimColor={span.dim} bold={span.bold}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

/**
 * The lines one call is drawn from — the whole decision, in one place and without a terminal, so
 * a test can hold the words still.
 *
 * The first line is the call: a mark, the tool's name, the summary and the status. A second,
 * dim line carries the reason a call did not simply finish — the first line of a failed result,
 * or "still waiting" for one that never got an answer — because that is the one thing a reader
 * has to act on.
 *
 * @param call the call, from the transcript
 * @param columns how wide the terminal is
 * @param theme the terminal's colours, for `NO_COLOR` and the colour level
 */
export function toolCallLines(
  call: TranscriptToolCall,
  columns: number,
  theme: TerminalTheme,
): Line[] {
  const width = Math.max(1, columns - CURSOR_COLUMNS)
  const status = toolStatusLabel(call.status)
  const summary = toolCallSummary(call)
  const accent = statusColor(call.status)

  const head: Span[] = [
    { text: `${STATUS_MARKS[call.status]} `, color: paint(theme, accent) },
    // The tool's name is the foreground's own colour, as a message's text is: it is the one
    // part of the line a reader is meant to read first.
    { text: call.name, bold: true },
  ]
  if (call.source === 'mcp') {
    head.push({ text: ' (mcp)', ...dimChrome(theme) })
  }
  if (summary !== null) {
    head.push({ text: ' ', ...dimChrome(theme) })
    head.push({ text: summary, ...dimChrome(theme) })
  }
  head.push({ text: ' · ', ...dimChrome(theme) })
  head.push({ text: status, color: paint(theme, accent) })

  const lines: Line[] = [truncateSpans(head, width)]

  const reason = callReason(call)
  if (reason !== null) {
    for (const line of wrapSpans([{ text: reason, ...dimChrome(theme) }], width, 'flow')) {
      lines.push(line)
    }
  }
  return lines
}

/**
 * The one line a call owes the reader beyond its status, or `null`.
 *
 * A failed or interrupted call says why — the brain's own sentence, cut to its first line, since
 * a result can be pages long. A call waiting on the reader says nothing extra: its status is
 * already the line ("waiting for you"), and what it is waiting for is the question in its input,
 * which #310's prompt draws under it.
 */
export function callReason(call: TranscriptToolCall): string | null {
  if (call.result === undefined || !call.result.isError) {
    return null
  }
  const first = call.result.content.split('\n')[0]?.trim() ?? ''
  return first === '' ? null : first
}

/** The colour a status is drawn in: the alarm for a waiting or failed call, chrome otherwise. */
function statusColor(status: ToolCallStatus): string {
  return status === 'waiting' || status === 'error' || status === 'denied'
    ? PALETTE.alarm
    : PALETTE.chrome
}

/** The dim chrome style, which is what everything that is not the tool's name is drawn in. */
function dimChrome(theme: TerminalTheme): Omit<Span, 'text'> {
  return { color: paint(theme, PALETTE.chrome), dim: true }
}
