import type { TodoList, TodoStatus } from '@openharness/protocol'
import { Box, Text, useStdout } from 'ink'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { truncateSpans, type Line, type Span } from '../markdown/text'
import { CURSOR_COLUMNS } from './message-view'
import { useTerminalTheme } from './theme'

/**
 * The chat's task list, pinned above the prompt (epic #303, X5; #305; issue #308).
 *
 * The terminal's half of the web's pinned panel: a model working through steps writes a list
 * with `todo_write`, the list it last wrote is the current state, and this draws it **always** —
 * while a turn runs, while the chat is idle, and after a resume — in the live area just above
 * the input section, where it can be redrawn in place as the model rewrites it.
 *
 * A terminal has no pinned chrome, so "pinned" here means the one place on screen below the
 * scrollback: a right-hand column would need a second layout region beside the transcript, and
 * Ink's `<Static>` scrollback is a single full-width stream — anything drawn beside it would be
 * redrawn by every frame and would reflow the history above it. See `apps/tui/AGENTS.md`.
 *
 * Every item is one line: a mark for its state and its text. The three marks are distinct glyphs
 * rather than colours alone (`☐`, `◐`, `☑`), so the list still reads under `NO_COLOR` — which is
 * what a terminal is for. The header says how many are done, because counting a list is exactly
 * the work the reader should not have to do.
 *
 * **The list folds.** A list longer than {@link TODO_AUTO_FOLD_THRESHOLD} items starts folded —
 * the header and the item in progress on one line — and **Ctrl+T** folds or unfolds it, the
 * choice kept per chat for the process lifetime (`chat/todo-fold.ts`). A list too long for the
 * screen shows the item in progress and its neighbours, with `+K more` counting what is out of
 * view, so the panel can never push the prompt off the terminal.
 */

/**
 * What the terminal falls back to when it will not say how wide it is — the same number
 * `message-view.tsx` and `status-line.tsx` use, so the block and the transcript agree.
 */
const FALLBACK_COLUMNS = 80

/** What the terminal falls back to when it will not say how tall it is. */
const FALLBACK_ROWS = 24

/** A list longer than this starts folded; the reader's own Ctrl+T choice then wins. */
export const TODO_AUTO_FOLD_THRESHOLD = 5

/**
 * How many rows of the terminal the panel leaves to everything else — the rule, the status line,
 * the prompt, the menu under it and a few lines of the transcript above. What is left over is how
 * many item lines the list may draw.
 */
const CHROME_ROWS = 12

/** The fewest and most item lines a windowed list draws, whatever the terminal says. */
const MIN_ITEM_ROWS = 3
const MAX_ITEM_ROWS = 8

/**
 * How many item lines a list may draw on a terminal this tall: enough room for the transcript and
 * the input section, and bounded both ways so a very short terminal keeps a usable window and a
 * very tall one does not turn the panel into the screen.
 */
export function todoItemRows(rows: number = FALLBACK_ROWS): number {
  return Math.max(MIN_ITEM_ROWS, Math.min(MAX_ITEM_ROWS, rows - CHROME_ROWS))
}

/** One state's mark. Distinct glyphs, so the states survive a terminal with no colour at all. */
const MARKS: Readonly<Record<TodoStatus, string>> = {
  pending: '☐',
  in_progress: '◐',
  done: '☑',
}

/** How the panel is drawn, beyond the list itself (see {@link todoLines}). */
export interface TodoPanelOptions {
  /** The header and the item in progress alone, on one line. */
  readonly folded?: boolean | undefined
  /** How many item lines the list may draw before it windows; see {@link todoItemRows}. */
  readonly maxItems?: number | undefined
}

export function TodoPanel({
  todos,
  folded = false,
  width,
  rows,
}: {
  readonly todos: TodoList
  /** Whether the reader has folded it, or the list started folded (Ctrl+T). */
  readonly folded?: boolean | undefined
  /** How wide the terminal is, when the caller knows better than Ink does (the test seam). */
  readonly width?: number | undefined
  /** How tall the terminal is, for the windowing rule (the test seam). */
  readonly rows?: number | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const lines = todoLines(todos, width ?? stdout.columns ?? FALLBACK_COLUMNS, theme, {
    folded,
    maxItems: todoItemRows(rows ?? stdout.rows ?? FALLBACK_ROWS),
  })

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
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
 * The block as the lines it is drawn from — the whole decision, in one place and without a
 * terminal, so a frame test reads the words rather than hunting for escape sequences.
 *
 * @param todos the list the chat holds, from the transcript
 * @param columns how wide the terminal is
 * @param theme the terminal's colours, for `NO_COLOR` and the colour level
 * @param options whether it is folded, and how many item lines it may draw
 */
export function todoLines(
  todos: TodoList,
  columns: number,
  theme: TerminalTheme,
  options: TodoPanelOptions = {},
): Line[] {
  const width = Math.max(1, columns - CURSOR_COLUMNS)
  const dim = { color: paint(theme, PALETTE.chrome), dim: true }
  const done = todos.filter((item) => item.status === 'done').length
  const progress = todos.length === 0 ? 'cleared' : `${done} of ${todos.length} done`
  const head: Span = { text: 'Tasks', ...dim }

  if (options.folded === true) {
    // Folded: the header and the item in progress on one line. A list with nothing in progress
    // has nothing to name, so the header stands alone rather than naming a finished item.
    const current = todos.find((item) => item.status === 'in_progress')
    const spans: Span[] = [head, { text: ` · ${progress}`, ...dim }]
    if (current !== undefined) {
      spans.push({ text: ' · ', ...dim })
      spans.push(markspan(current.status, theme))
      spans.push({ text: current.content, ...(current.status === 'done' ? dim : {}) })
    }
    return [truncateSpans(spans, width)]
  }

  const lines: Line[] = [truncateSpans([head, { text: ` · ${progress}`, ...dim }], width)]
  if (todos.length === 0) {
    lines.push(hintLine(theme, width))
    return lines
  }

  const max = Math.max(1, options.maxItems ?? MAX_ITEM_ROWS)
  // The window keeps the item in progress in view: a list too long to draw is cut around the one
  // thing the reader is looking for, and what is left out is counted rather than hidden.
  const focus = todos.findIndex((item) => item.status === 'in_progress')
  const at = focus === -1 ? 0 : focus
  const before = Math.floor((max - 1) / 2)
  const start = Math.max(0, Math.min(at - before, todos.length - max))
  const visible = todos.slice(start, start + max)

  if (start > 0) {
    lines.push(truncateSpans([{ text: `+${start} more`, ...dim }], width))
  }
  for (const item of visible) {
    lines.push(
      truncateSpans(
        [
          markspan(item.status, theme),
          { text: item.content, ...(item.status === 'done' ? dim : {}) },
        ],
        width,
      ),
    )
  }
  const after = todos.length - (start + visible.length)
  if (after > 0) {
    lines.push(truncateSpans([{ text: `+${after} more`, ...dim }], width))
  }
  lines.push(hintLine(theme, width))
  return lines
}

/**
 * The one line saying which keys the live area answers to (issue #308; the detail view, X5).
 *
 * A terminal has no pointer and no menu of its own, so the two things a reader can do to what is
 * drawn here — fold the list, and open a call's full input — are named where they apply rather
 * than only in `/help`.
 */
export const LIVE_AREA_HINT = 'Ctrl+T folds this list · Ctrl+O shows call details'

function hintLine(theme: TerminalTheme, width: number): Line {
  return truncateSpans(
    [{ text: LIVE_AREA_HINT, color: paint(theme, PALETTE.chrome), dim: true }],
    width,
  )
}

/** The colour-carrying mark of one item, so a state is readable before the words are. */
function markspan(status: TodoStatus, theme: TerminalTheme): Span {
  const mark = `${MARKS[status]} `
  if (status === 'in_progress') {
    return { text: mark, color: paint(theme, PALETTE.busy) }
  }
  if (status === 'done') {
    return { text: mark, color: paint(theme, PALETTE.chrome), dim: true }
  }
  return { text: mark }
}
