import { summaryDescription } from '@openharness/client'
import type { TranscriptSummary } from '@openharness/client'
import { Box, Text, useStdout } from 'ink'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import {
  spanWidth,
  textSpans,
  truncateSpans,
  wrapSpans,
  type Line,
  type Span,
} from '../markdown/text'
import { CURSOR_COLUMNS } from './message-view'
import { useTerminalTheme } from './theme'

/**
 * The "conversation summarized" divider (epic #277, K10; #280).
 *
 * The terminal's half of the mark the web app draws: a chat that filled its context had its
 * older history summarized, the summary supersedes **nothing**, and this line says where the
 * model stops reading verbatim — the history above it stays in the scrollback. The label carries
 * the reason, the model and the number of passes, from the same `summaryDescription` the web
 * divider uses.
 *
 * **The summary is on the line below rather than behind a key.** A terminal has no disclosure
 * control: there is nothing to click and no per-block state a reader could toggle, so the choice
 * is between printing the summary or hiding it behind an invented key binding. It is printed,
 * dim and wrapped to the transcript's width, which is what the web divider shows when it is
 * opened.
 *
 * It is structure, so it is drawn the way the transcript draws structure (X4): the `chrome`
 * colour and dim, the rule character the input section and the tables use, and nothing at all
 * under `NO_COLOR`.
 */

/**
 * What the terminal falls back to when it will not say how wide it is — the same number
 * `message-view.tsx` and `status-line.tsx` use, so the divider and the transcript agree.
 */
const FALLBACK_COLUMNS = 80

/** The character a rule is drawn with, as the input section draws its own. */
const RULE = '─'

export function SummaryDivider({
  summary,
  width,
}: {
  readonly summary: TranscriptSummary
  /**
   * How wide the terminal is, when the caller knows better than Ink does — the test seam the
   * frame tests draw at a width they can read, as `MessageView` and `StatusLine` have.
   */
  readonly width?: number | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const lines = summaryDividerLines(summary, width ?? stdout.columns ?? FALLBACK_COLUMNS, theme)

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // A divider's lines have no identity of their own; their order is it.
        <Text key={index}>
          {line.map((span, position) => (
            <Text key={position} color={span.color} dimColor={span.dim}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  )
}

/**
 * The divider as the lines of spans it is drawn from — the whole decision, in one place and
 * without a terminal, as {@link summaryDividerLines} is for the rule under it.
 *
 * The first line is the mark: the title with the reason, the model and the passes, ruled to the
 * width the transcript uses (the terminal's, less the column it reserves for its streaming
 * cursor). The lines after it are the summary itself.
 *
 * @param summary the divider's summary, from the transcript
 * @param columns how wide the terminal is
 * @param theme the terminal's colours, for `NO_COLOR` and the colour level
 */
export function summaryDividerLines(
  summary: TranscriptSummary,
  columns: number,
  theme: TerminalTheme,
): Line[] {
  const width = Math.max(1, columns - CURSOR_COLUMNS)
  const chrome = { color: paint(theme, PALETTE.chrome), dim: true }
  const label: Span = { text: ` ${dividerLabel(summary)} `, ...chrome }
  // The rule is what is left after the label, split either side of it — and the whole line is
  // truncated if a narrow terminal cannot hold even the label, exactly as the status line is.
  const room = Math.max(0, width - spanWidth([label]))
  const head = RULE.repeat(Math.floor(room / 2))
  const tail = RULE.repeat(room - Math.floor(room / 2))
  const lines: Line[] = [
    truncateSpans([{ text: head, ...chrome }, label, { text: tail, ...chrome }], width),
  ]

  const text = summary.summary.trim()
  if (text !== '') {
    // `text` mode, so the summary's own line breaks survive: it is prose from a model, not
    // something this view re-flows into a paragraph.
    for (const line of wrapSpans(textSpans(text, { dim: true }), width, 'text')) {
      lines.push(line)
    }
  }
  return lines
}

/** What the divider says: the mark, then the same reason · model · passes the web divider draws. */
function dividerLabel(summary: TranscriptSummary): string {
  return `conversation summarized · ${summaryDescription(summary)}`
}
