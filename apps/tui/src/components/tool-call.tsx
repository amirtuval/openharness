import {
  formatToolInput,
  mcpServerMarker,
  toolCallSummary,
  toolStatusLabel,
} from '@openharness/client'
import type { TranscriptToolCall, ToolCallStatus } from '@openharness/client'
import { TODO_WRITE_TOOL_NAME } from '@openharness/protocol'
import { Box, Text, useStdout } from 'ink'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { truncateSpans, wrapSpans, type Line, type Span } from '../markdown/text'
import { CURSOR_COLUMNS } from './message-view'
import { useTerminalTheme } from './theme'

/**
 * One tool call in the transcript (epic #303, X1/X5; issue #308).
 *
 * The terminal's half of the web's tool-call line, drawn the way Claude Code draws one: **one
 * line per call** — the status mark, the tool's name, what it was asked (the same
 * `toolCallSummary`, which is the URL or the query) and its state — and **one indented line
 * under it** carrying what came back, introduced by `⎿`: `fetched 12 KB`, `5 results`,
 * `denied: …`, or the first line of a failure. The full input and a capped result are what
 * **Ctrl+O** opens (`detail`); a terminal has no disclosure control, so what the page hides
 * behind a click is either a summary line here or one keypress away.
 *
 * The short result line is derived by {@link callResultLine}, from the same log both frontends
 * read. A provider-executed search keeps its pages as well: one line per source under the
 * summary (#335), because the URL *is* the source a terminal can show.
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

/** The glyph a result's summary line is introduced with, as Claude Code introduces one. */
export const RESULT_MARK = '⎿'

/** How far a call's result line and its opened detail are indented. */
const RESULT_INDENT = '  '
const DETAIL_INDENT = '    '

/** How many lines of a result the detail view shows before it says how much it left out. */
export const DETAIL_RESULT_MAX_LINES = 20

export function ToolCallView({
  call,
  decision = null,
  detail = false,
  width,
}: {
  readonly call: TranscriptToolCall
  /**
   * What the reader decided about this call, when it waited on them (epic #303, X6; #310):
   * "Allowed once", "Allowed for this chat", "Always allowed". The `user.tool_confirmation` is
   * the log's record, so only it can say **how** a call came to run — its own result is what the
   * tool answered.
   */
  readonly decision?: string | null | undefined
  /** Ctrl+O: draw the whole input and a capped result under the call (issue #308). */
  readonly detail?: boolean | undefined
  /**
   * How wide the terminal is, when the caller knows better than Ink does — the test seam the
   * frame tests draw at a width they can read, as `MessageView` and `SummaryDivider` have.
   */
  readonly width?: number | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const lines = toolCallLines(
    call,
    width ?? stdout.columns ?? FALLBACK_COLUMNS,
    theme,
    decision,
    detail,
  )

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
 * The first line is the call: a mark, the tool's name, the summary and the status. The second is
 * the result, indented under it: what came back, in one phrase (see {@link callResultLine}) — the
 * reason a call failed, the size of what it fetched, how many pages a search found. With
 * `detail` the whole input and a capped result follow it, which is the view **Ctrl+O** switches
 * to.
 *
 * @param call the call, from the transcript
 * @param columns how wide the terminal is
 * @param theme the terminal's colours, for `NO_COLOR` and the colour level
 * @param decision what the reader decided about a call that waited on them, or `null`
 * @param detail draw the full input and the result's head as well (Ctrl+O)
 */
export function toolCallLines(
  call: TranscriptToolCall,
  columns: number,
  theme: TerminalTheme,
  decision: string | null = null,
  detail = false,
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
    // Which server a remote tool came from, after the marker — a terminal has no hover to hide
    // it behind, and two servers' `search` are told apart by exactly this (#312). The words are
    // the client's (`mcpServerMarker`), so the page's badge and this line agree.
    head.push({ text: ` (${mcpServerMarker(call.server)})`, ...dimChrome(theme) })
  }
  if (summary !== null) {
    head.push({ text: ' ', ...dimChrome(theme) })
    head.push({ text: summary, ...dimChrome(theme) })
  }
  head.push({ text: ' · ', ...dimChrome(theme) })
  head.push({ text: status, color: paint(theme, accent) })
  if (decision !== null) {
    head.push({ text: ' · ', ...dimChrome(theme) })
    head.push({ text: decision, ...dimChrome(theme) })
  }

  const lines: Line[] = [truncateSpans(head, width)]

  const result = callResultLine(call)
  if (result !== null) {
    lines.push(
      truncateSpans(
        [{ text: `${RESULT_INDENT}${RESULT_MARK} ${result}`, ...dimChrome(theme) }],
        width,
      ),
    )
  }

  if (detail) {
    for (const line of detailLines(call, theme, width)) {
      lines.push(line)
    }
  }

  // The pages a search found (epic #303, X14; #335). A terminal has no link to open, so the URL
  // *is* the source here — a reader copies it — and the cited passage follows it when the
  // provider gave one. A step of five sources is five short lines, which is what the reader
  // asked for by searching.
  for (const source of call.sources ?? []) {
    const found: Span[] = [{ text: `  ${source.title ?? source.url}`, bold: true }]
    if (source.title !== undefined) {
      found.push({ text: ` — ${source.url}`, ...dimChrome(theme) })
    }
    lines.push(truncateSpans(found, width))
    if (source.cited_text !== undefined) {
      lines.push(
        ...wrapSpans([{ text: `    ${source.cited_text}`, ...dimChrome(theme) }], width, 'flow'),
      )
    }
  }
  return lines
}

/**
 * What a call's result comes to, in one phrase, or `null` while there is nothing to say.
 *
 * This is the `⎿` line, and it is deliberately **a summary and never the result**: a terminal's
 * scrollback is what a reader scrolls back through, and a page of Markdown per call would bury
 * the conversation (the log holds the whole of it, and Ctrl+O opens the head).
 *
 * - A **denied** call says so in the policy's own word, and then whose words refused it.
 * - A **failed** call says why — the brain's own sentence, cut to its first line.
 * - A **search** answers with how many pages it found, which is the number the reader asked for
 *   by searching.
 * - A **fetch** answers with the size of what it read — `fetched 12 KB` is the difference
 *   between a page and a redirect stub.
 * - A **task list** answers with how many items the model wrote, the same count its own line
 *   carries.
 * - Everything else answers with how many lines came back, which is honest for a tool this
 *   build knows nothing about (a remote MCP tool, the test `echo`).
 */
export function callResultLine(call: TranscriptToolCall): string | null {
  const result = call.result
  if (result === undefined) {
    return null
  }
  if (call.status === 'denied') {
    const reason = firstLine(result.content)
    return reason === null ? 'denied' : `denied: ${reason}`
  }
  if (result.isError) {
    return firstLine(result.content) ?? 'failed'
  }
  if (call.sources !== undefined) {
    const found = call.sources.length
    return found === 1 ? '1 result' : `${found} results`
  }
  if (call.name === 'web_fetch') {
    return `fetched ${formatBytes(result.content.length)}`
  }
  if (call.name === TODO_WRITE_TOOL_NAME) {
    const todos = call.input.todos
    if (Array.isArray(todos)) {
      const count = todos.length
      return count === 1 ? '1 task' : `${count} tasks`
    }
  }
  const lines = result.content === '' ? 0 : result.content.split('\n').length
  return lines === 1 ? '1 line' : `${lines} lines`
}

/**
 * The first line of a result, trimmed, or `null` when it says nothing.
 *
 * A result can be pages long; the one thing a reader has to act on is its first line, and the
 * whole of it is in the log (and under Ctrl+O, capped).
 */
function firstLine(content: string): string | null {
  const first = content.split('\n')[0]?.trim() ?? ''
  return first === '' ? null : first
}

/**
 * The reason a call owes the reader beyond its status, or `null` — the error's first line.
 *
 * Kept beside {@link callResultLine} because the two are the same sentence about a failed call:
 * a caller that wants the reason on its own (the pending list, a test) reads it here.
 */
export function callReason(call: TranscriptToolCall): string | null {
  if (call.result === undefined || !call.result.isError) {
    return null
  }
  return firstLine(call.result.content)
}

/**
 * The call as Ctrl+O draws it: the whole input, pretty-printed, then the head of what came back.
 *
 * The input is the one thing the compact line exists to hide, so opening the call shows it in
 * full; the result is **capped** at {@link DETAIL_RESULT_MAX_LINES}, because a result is
 * unbounded and the point of the view is to read the call rather than to page through a log —
 * what the cap leaves out is counted on the line that says so.
 */
function detailLines(call: TranscriptToolCall, theme: TerminalTheme, width: number): Line[] {
  const lines: Line[] = []
  for (const line of formatToolInput(call.input).split('\n')) {
    lines.push(truncateSpans([{ text: `${DETAIL_INDENT}${line}`, ...dimChrome(theme) }], width))
  }
  const result = call.result
  if (result === undefined) {
    return lines
  }
  const all = result.content.split('\n')
  const shown = all.slice(0, DETAIL_RESULT_MAX_LINES)
  for (const line of shown) {
    lines.push(truncateSpans([{ text: `${DETAIL_INDENT}${line}`, ...dimChrome(theme) }], width))
  }
  const left = all.length - shown.length
  if (left > 0) {
    lines.push(
      truncateSpans(
        [
          {
            text: `${DETAIL_INDENT}… ${left} more ${left === 1 ? 'line' : 'lines'}`,
            ...dimChrome(theme),
          },
        ],
        width,
      ),
    )
  }
  return lines
}

/**
 * A byte count as a reader reads it: bytes under a kilobyte, then whole kilobytes, then whole
 * megabytes. Rounded rather than exact — the summary line is a size, not a measurement.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${Math.round(bytes / (1024 * 1024))} MB`
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
