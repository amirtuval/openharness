import type { TodoList, TodoStatus } from '@openharness/protocol'
import { Box, Text, useStdout } from 'ink'

import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { truncateSpans, type Line, type Span } from '../markdown/text'
import { CURSOR_COLUMNS } from './message-view'
import { useTerminalTheme } from './theme'

/**
 * The chat's task list, as a compact block (epic #303, X5; #305; issue #308).
 *
 * The terminal's half of the web's pinned panel: a model working through steps writes a list with
 * `todo_write`, the list it last wrote is the current state, and this draws it under the
 * transcript while the chat has one. A terminal has no pinned chrome, so the block sits where the
 * notices do — between the transcript and the input section — and is redrawn in place as the model
 * rewrites it.
 *
 * Every item is one line: a mark for its state and its text. The three marks are distinct glyphs
 * rather than colours alone (`☐`, `◐`, `☑`), so the list still reads under `NO_COLOR` — which is
 * what a terminal is for. The header says how many are done, because counting a list is exactly
 * the work the reader should not have to do.
 */

/**
 * What the terminal falls back to when it will not say how wide it is — the same number
 * `message-view.tsx` and `status-line.tsx` use, so the block and the transcript agree.
 */
const FALLBACK_COLUMNS = 80

/** One state's mark. Distinct glyphs, so the states survive a terminal with no colour at all. */
const MARKS: Readonly<Record<TodoStatus, string>> = {
  pending: '☐',
  in_progress: '◐',
  done: '☑',
}

export function TodoPanel({
  todos,
  width,
}: {
  readonly todos: TodoList
  /** How wide the terminal is, when the caller knows better than Ink does (the test seam). */
  readonly width?: number | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const lines = todoLines(todos, width ?? stdout.columns ?? FALLBACK_COLUMNS, theme)

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
 */
export function todoLines(todos: TodoList, columns: number, theme: TerminalTheme): Line[] {
  const width = Math.max(1, columns - CURSOR_COLUMNS)
  const dim = { color: paint(theme, PALETTE.chrome), dim: true }
  const done = todos.filter((item) => item.status === 'done').length
  const progress = todos.length === 0 ? 'cleared' : `${done} of ${todos.length} done`

  const lines: Line[] = [
    truncateSpans(
      [
        { text: 'tasks', ...dim },
        { text: ` · ${progress}`, ...dim },
      ],
      width,
    ),
  ]
  for (const item of todos) {
    const state: Span = {
      text: `${MARKS[item.status]} `,
      ...(item.status === 'in_progress'
        ? { color: paint(theme, PALETTE.busy) }
        : item.status === 'done'
          ? dim
          : {}),
    }
    lines.push(
      truncateSpans([state, { text: item.content, ...(item.status === 'done' ? dim : {}) }], width),
    )
  }
  return lines
}
