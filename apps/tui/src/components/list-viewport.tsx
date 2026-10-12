import { Box, Text } from 'ink'
import type { ReactElement, ReactNode } from 'react'

/**
 * A scrolling list viewport: the rows that fit, the cursor always among them, and a count of
 * what is out of sight (#335).
 *
 * The terminal's height is a fact every list here has to live with, and until this module each
 * screen either drew its whole list — which is what a reader of `/mcp` reported, where a server
 * with sixty tools pushed the selected row off the bottom of the screen and the list itself out
 * of the terminal — or hand-rolled the arithmetic (the model picker's ten rows). This is the
 * one place that arithmetic lives now, so a screen says how many rows of chrome it draws and
 * gets back the slice to render.
 *
 * What it is not: a cursor and a list of its own. A screen keeps its own `index` (and its own
 * `useInput`), because what Enter or ←/→ *does* on the highlighted row is the screen's business;
 * the viewport only answers "which rows are on screen, and where is the cursor among them".
 *
 * ```tsx
 * const window = listWindow(index, items.length, viewportRows(rows, 4))
 * ```
 *
 * The cursor is kept visible by centring the window on it, exactly as the model picker does: the
 * window is *derived* from the index rather than kept beside it in state, so the two cannot get
 * out of step when a list grows under the cursor (a read answers, a server is deleted) — which
 * is the bug the picker's own comment records.
 */

/** The fewest rows a viewport will show, however short the terminal is. */
export const MIN_VIEWPORT_ROWS = 3

/** The height assumed when the terminal does not report one (a test frame, a piped stdout). */
export const DEFAULT_TERMINAL_ROWS = 24

/**
 * How many rows a list may draw: the terminal's height less the lines its screen draws around
 * it, never fewer than {@link MIN_VIEWPORT_ROWS}.
 *
 * The floor matters more than it looks: three rows plus the `↑ N more` / `↓ N more` markers is
 * the smallest frame in which a reader can still see that there is more, and a terminal
 * shorter than its own chrome would otherwise ask for a list of no rows at all.
 */
export function viewportRows(terminalRows: number | undefined, chromeRows: number): number {
  const rows = terminalRows === undefined || terminalRows <= 0 ? DEFAULT_TERMINAL_ROWS : terminalRows
  return Math.max(MIN_VIEWPORT_ROWS, rows - chromeRows)
}

/** The slice of a list that is on screen, and what is not. */
export interface ListWindow {
  /** The index of the first visible item. */
  readonly first: number
  /** How many items are visible (`0` for an empty list). */
  readonly count: number
  /** How many are out of sight above the window. */
  readonly above: number
  /** How many are out of sight below it. */
  readonly below: number
  /** Where the cursor is drawn, clamped into the list (and into the window). */
  readonly index: number
}

/**
 * What a list of `length` items shows when the cursor is at `index` and `capacity` rows fit.
 *
 * `index` is clamped into the list rather than trusted: a read can shorten a list under the
 * cursor (a server is deleted, a filter narrows), and the very next render must not point past
 * the end. The window is centred on the cursor wherever it can be, and pressed against an end
 * of the list where it cannot — so the cursor is in frame at both ends and in the middle.
 */
export function listWindow(index: number, length: number, capacity: number): ListWindow {
  const size = Math.max(1, Math.floor(capacity))
  if (length <= 0) {
    return { first: 0, count: 0, above: 0, below: 0, index: 0 }
  }
  const at = Math.min(Math.max(Math.floor(index), 0), length - 1)
  const count = Math.min(length, size)
  const first = clamp(at - Math.floor(count / 2), 0, length - count)
  return { first, count, above: first, below: length - first - count, index: at }
}

/** The marker a selected row carries. A glyph, so it reads with colour off (`NO_COLOR`). */
export const SELECTED_MARKER = '❯'

/** The marker an unselected row carries: a space, so the rows stay in one column. */
export const UNSELECTED_MARKER = ' '

/** The line a window shows when items are out of sight. `null` when there are none. */
export function moreMarker(direction: 'above' | 'below', count: number): string | null {
  if (count <= 0) return null
  return direction === 'above' ? `↑ ${count} more` : `↓ ${count} more`
}

/** The hint a viewport owes a reader once its list is longer than the screen. */
export const VIEWPORT_HINT = 'PgUp/PgDn, Home/End jump'

/** The keys a list's cursor moves on. The subset of Ink's key flags this module reads. */
export interface ListKey {
  readonly upArrow?: boolean | undefined
  readonly downArrow?: boolean | undefined
  readonly pageUp?: boolean | undefined
  readonly pageDown?: boolean | undefined
  readonly home?: boolean | undefined
  readonly end?: boolean | undefined
}

/**
 * Where a jump key moves the cursor, or `null` when the key is not one of them.
 *
 * A page is `page` rows — the rows on screen, so a PgDn lands the reader a screen further on
 * with the cursor at the same place in the window. Up/Down are **not** handled here: a screen
 * whose Enter or ←/→ acts on the highlighted row owns those, and this module only takes the keys
 * no screen has claimed.
 */
export function listJump(index: number, length: number, key: ListKey, page: number): number | null {
  if (length <= 0) return null
  const last = length - 1
  const at = Math.min(Math.max(index, 0), last)
  const step = Math.max(1, Math.floor(page))
  if (key.pageUp) return Math.max(at - step, 0)
  if (key.pageDown) return Math.min(at + step, last)
  if (key.home) return 0
  if (key.end) return last
  return null
}

export interface ScrollingListProps<T> {
  readonly items: readonly T[]
  /** The cursor's position in `items`; clamped into the list. */
  readonly index: number
  /** The terminal's height, from `useStdout().stdout.rows`; `undefined` uses the default. */
  readonly rows: number | undefined
  /** How many lines the screen draws around the list: a title, an error, the key hints. */
  readonly chrome?: number
  /**
   * One row's element. `marker` is the selection glyph — `❯` or a space — which **must** be
   * drawn: it is how the selected row reads with colour off, and a test holds every screen to it.
   */
  readonly renderRow: (item: T, position: number, marker: string) => ReactNode
  /**
   * A row pinned above the window, always on screen — `/mcp`'s "all tools" row, which is the
   * server's whole tool set taken together and must not scroll away with the tools under it.
   */
  readonly pinned?: ReactNode
}

/**
 * The rows that fit, with the markers that say what is out of sight.
 *
 * The list itself is a plain column: no frame, no border, no colour of its own — the caller
 * draws the row and the viewport draws what surrounds it, so a screen keeps the styling it had.
 */
export function ScrollingList<T>({
  items,
  index,
  rows,
  chrome = 0,
  renderRow,
  pinned = null,
}: ScrollingListProps<T>): ReactElement {
  const window = listWindow(index, items.length, viewportRows(rows, chrome))
  const above = moreMarker('above', window.above)
  const below = moreMarker('below', window.below)
  return (
    <Box flexDirection="column">
      {pinned}
      {above === null ? null : <Text dimColor>{`  ${above}`}</Text>}
      {items.slice(window.first, window.first + window.count).map((item, offset) => {
        const position = window.first + offset
        const marker = position === window.index ? SELECTED_MARKER : UNSELECTED_MARKER
        return (
          <Box key={position} flexDirection="column">
            {renderRow(item, position, marker)}
          </Box>
        )
      })}
      {below === null ? null : <Text dimColor>{`  ${below}`}</Text>}
    </Box>
  )
}

/** Keep a number inside `[low, high]`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}
