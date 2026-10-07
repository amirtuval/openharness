import { Box, Text, useInput, usePaste } from 'ink'
import { useRef, useState } from 'react'

import type { PromptHistory } from '../history'

/**
 * How many characters a paste may hold before the prompt shows it collapsed (#206).
 *
 * Below this the pasted text lands in the buffer as typed. Above it the buffer still holds
 * every character — it is what gets sent — but the screen shows a `[pasted N lines]` label
 * in its place, so pasting a file cannot push the prompt (and the reply being streamed)
 * off the screen.
 */
export const LARGE_PASTE_CHARS = 2000

/** What the user typed, where the cursor sits, and which runs are shown collapsed. */
interface Buffer {
  /** The text as it will be sent: a collapsed paste is here in full. */
  readonly value: string
  /** Where the cursor is, as an index into {@link value}. */
  readonly cursor: number
  /** The runs of {@link value} that render as a label instead of their own characters. */
  readonly collapsed: readonly Collapse[]
}

/** A pasted run kept out of the way: `value.slice(start, end)` renders as `label`. */
interface Collapse {
  readonly start: number
  readonly end: number
  readonly label: string
}

/** One run of the buffer as the screen lays it out, and where in both coordinate systems it sits. */
interface Piece {
  readonly realFrom: number
  readonly realTo: number
  readonly displayFrom: number
  readonly displayTo: number
  /** True for a collapsed run's label, whose characters are not the buffer's. */
  readonly collapsed: boolean
}

/** The buffer as the screen shows it. */
interface Display {
  /** The text on screen: the buffer's own characters, with a label standing in for each run. */
  readonly text: string
  /** Where the cursor is in {@link text}. */
  readonly cursor: number
  /** The runs {@link text} is built from, for mapping one coordinate system to the other. */
  readonly pieces: readonly Piece[]
  /** Where the buffer ends, in buffer coordinates: what lies past the last piece. */
  readonly end: number
}

const EMPTY: Buffer = { value: '', cursor: 0, collapsed: [] }

export interface PromptInputProps {
  /** Called with the buffer on Enter; an empty buffer is not sent, but is cleared. */
  readonly onSubmit: (text: string) => void
  /** Called on every keystroke that touches the buffer, so the screen can drop hints. */
  readonly onActivity?: (() => void) | undefined
  /** What ↑ and ↓ walk back through; without one the arrows only move between lines (#206). */
  readonly history?: PromptHistory | undefined
}

/**
 * The multi-line prompt.
 *
 * The key bindings are the interesting part, because "Shift+Enter" is not a thing a
 * terminal can send: most terminals send the same `\r` for Enter and Shift+Enter, so the
 * newline needs a binding that is actually distinguishable —
 *
 * - **Enter** sends. It also sends while a reply is streaming, which is what steering is.
 * - **Ctrl+J** inserts a newline. It is a control character of its own (line feed, `0x0A`,
 *   against Enter's carriage return, `0x0D`), so every terminal can send it and no
 *   terminal confuses it with Enter.
 * - **Alt+Enter** does the same, for terminals and muscle memory that prefer it (it is
 *   `ESC` + `\r`, which Ink reports as Enter with the meta flag).
 *
 * The editing keys are the readline ones (#206), so muscle memory from a shell carries over:
 *
 * - ←/→ move the cursor, Home/End and **Ctrl+A** or **Ctrl+E** go to the ends of the line,
 *   Backspace deletes behind the cursor and Delete deletes at it;
 * - **Ctrl+U** deletes to the start of the line and **Ctrl+K** to its end;
 * - **Ctrl+W** and **Alt+Backspace** delete the word before the cursor;
 * - **Alt+B**, **Alt+F**, **Ctrl+←** and **Ctrl+→** jump a word at a time;
 * - ↑/↓ walk the history, and first move between the lines of a multi-line buffer;
 * - **Ctrl+L** is the screen's (it clears the screen and keeps the session).
 *
 * A paste arrives as one bracketed-paste event — Ink's `usePaste` turns the terminal's
 * bracketed paste mode on for as long as this prompt is up — so an embedded `\r` in what
 * was pasted is a newline in the buffer, never a send. The cursor is drawn as an
 * inverse-video cell, so it is visible on every line including an empty one.
 */
export function PromptInput({ onSubmit, onActivity, history }: PromptInputProps) {
  const [buffer, setBuffer] = useState<Buffer>(EMPTY)

  // The buffer the handlers read.
  //
  // Ink hands `useInput` a callback that sees the latest *committed* render, and a terminal
  // can deliver several keystrokes inside one render — a paste, or a fast typist pressing
  // Enter. Reading React state there would read the buffer from before those keystrokes, so
  // "hi" + Enter could send "" (or send "h"). The ref is the buffer of record; the state
  // exists to render it.
  const bufferRef = useRef<Buffer>(EMPTY)

  // Where ↑/↓ browsing stands: `null` at the draft (what was typed before the first ↑),
  // otherwise the history entry on screen and the draft to go back to.
  const browsingRef = useRef<{ readonly index: number; readonly draft: Buffer } | null>(null)

  const commit = (next: Buffer, options: { readonly activity?: boolean } = {}): void => {
    bufferRef.current = next
    setBuffer(next)
    if (options.activity !== false) {
      onActivity?.()
    }
  }

  const edit = (
    change: (buffer: Buffer) => Buffer,
    options: { readonly activity?: boolean } = {},
  ): void => {
    commit(change(bufferRef.current), options)
  }

  const insert = (text: string, label?: string): void => {
    edit((current) => insertAt(current, current.cursor, text, label))
  }

  /** Move the cursor, stepping over a collapsed run rather than into it. */
  const moveCursor = (delta: number): void => {
    // Moving the cursor is not typing, so it does not dismiss the exit hint.
    edit(
      (current) => {
        const target = current.cursor + delta
        if (target < 0 || target > current.value.length) return current
        const run = current.collapsed.find(
          (candidate) => target > candidate.start && target < candidate.end,
        )
        if (run === undefined) return { ...current, cursor: target }
        return { ...current, cursor: delta > 0 ? run.end : run.start }
      },
      { activity: false },
    )
  }

  const submit = (): void => {
    const { value } = bufferRef.current
    history?.add(value)
    browsingRef.current = null
    commit(EMPTY, { activity: false })
    if (value.trim() !== '') {
      onSubmit(value)
    }
  }

  /** ↑/↓ outside a multi-line buffer: walk the history, keeping the draft. */
  const browse = (delta: number): void => {
    const entries = history?.entries() ?? []
    const browsing = browsingRef.current

    if (browsing === null) {
      // ↓ at the draft stays at the draft — there is nothing newer than what is on screen.
      if (delta > 0 || entries.length === 0) return
      const index = entries.length - 1
      browsingRef.current = { index, draft: bufferRef.current }
      commit(recalled(entries[index] ?? ''))
      return
    }

    const index = browsing.index + delta
    if (index < 0) return
    if (index >= entries.length) {
      // Past the newest entry is the draft again, exactly as it was left.
      browsingRef.current = null
      commit(browsing.draft)
      return
    }
    browsingRef.current = { index, draft: browsing.draft }
    commit(recalled(entries[index] ?? ''))
  }

  /** ↑/↓: between the lines first, and out of the buffer only at its first or last one. */
  const vertical = (delta: number): void => {
    const display = displayOf(bufferRef.current)
    const target =
      delta < 0 ? lineUp(display.text, display.cursor) : lineDown(display.text, display.cursor)

    if (target === null) {
      browse(delta)
      return
    }
    edit((current) => ({ ...current, cursor: realIndex(display, target) }), { activity: false })
  }

  /** Jump a word: Alt+B / Alt+F and Ctrl+← / Ctrl+→ (#206). */
  const jumpWord = (delta: number): void => {
    edit(
      (current) => {
        const display = displayOf(current)
        const target =
          delta < 0
            ? wordStart(display.text, display.cursor)
            : wordEnd(display.text, display.cursor)
        return { ...current, cursor: realIndex(display, target) }
      },
      { activity: false },
    )
  }

  const toLineStart = (): void => {
    edit(
      (current) => {
        const display = displayOf(current)
        return { ...current, cursor: realIndex(display, lineStart(display.text, display.cursor)) }
      },
      { activity: false },
    )
  }

  const toLineEnd = (): void => {
    edit(
      (current) => {
        const display = displayOf(current)
        return { ...current, cursor: realIndex(display, lineEnd(display.text, display.cursor)) }
      },
      { activity: false },
    )
  }

  /** Delete the run a display-space boundary describes: Ctrl+U, Ctrl+K, Ctrl+W (#206). */
  const deleteTo = (boundary: (text: string, cursor: number) => number): void => {
    edit((current) => {
      const display = displayOf(current)
      const target = realIndex(display, boundary(display.text, display.cursor))
      return target <= current.cursor
        ? deleteRange(current, target, current.cursor)
        : deleteRange(current, current.cursor, target)
    })
  }

  useInput((input, key) => {
    // Ctrl+C is the screen's: it interrupts, and it exits on the second idle press.
    if (key.ctrl && input === 'c') return

    // Ctrl+J arrives as a bare line feed: it is a newline, not a send.
    if (input === '\n') {
      insert('\n')
      return
    }

    if (key.return) {
      if (key.meta || key.shift) {
        insert('\n')
      } else {
        submit()
      }
      return
    }

    // Words: the readline bindings, checked before the plain arrows they share a key with.
    if (key.meta && input === 'b') return jumpWord(-1)
    if (key.meta && input === 'f') return jumpWord(1)
    if (key.ctrl && key.leftArrow) return jumpWord(-1)
    if (key.ctrl && key.rightArrow) return jumpWord(1)

    if (key.backspace) {
      // Alt+Backspace is Ctrl+W under another name (Ink reports it as meta backspace).
      if (key.meta) return deleteTo(wordStart)
      edit((current) =>
        current.cursor === 0 ? current : deleteRange(current, current.cursor - 1, current.cursor),
      )
      return
    }

    if (key.delete) {
      edit((current) =>
        current.cursor >= current.value.length
          ? current
          : deleteRange(current, current.cursor, current.cursor + 1),
      )
      return
    }

    if (key.ctrl && input === 'a') return toLineStart()
    if (key.ctrl && input === 'e') return toLineEnd()
    if (key.ctrl && input === 'u') return deleteTo(lineStart)
    if (key.ctrl && input === 'k') return deleteTo(lineEnd)
    if (key.ctrl && input === 'w') return deleteTo(wordStart)

    if (key.leftArrow) return moveCursor(-1)
    if (key.rightArrow) return moveCursor(1)
    if (key.home) return toLineStart()
    if (key.end) return toLineEnd()
    if (key.upArrow) return vertical(-1)
    if (key.downArrow) return vertical(1)
    if (key.pageUp || key.pageDown || key.tab || key.escape) return

    // Everything else is text: one character, or a fallback paste as a single chunk.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      insert(input)
    }
  })

  // A real paste, through the terminal's bracketed paste mode: one string, newlines and all.
  // Ink's parser keeps it off the key channel entirely, so nothing inside it can be read as
  // a keypress — which is the whole point, because a pasted line ending must not send.
  usePaste((text) => {
    // A terminal sends `\r` (or `\r\n`) for the line endings inside a paste; the buffer's
    // own newline is `\n`, so normalize before it becomes part of what is sent.
    const pasted = text.replace(/\r\n?/gu, '\n')
    if (pasted.length > LARGE_PASTE_CHARS) {
      const lines = pasted.split('\n').length
      insert(pasted, lines === 1 ? '[pasted 1 line]' : `[pasted ${lines} lines]`)
      return
    }
    insert(pasted)
  })

  return <BufferView buffer={buffer} />
}

/** One line of the prompt as it is drawn. */
export interface PromptLine {
  /** The line's characters, and only those: the `❯` marker is added by the renderer. */
  readonly text: string
  /** The index in {@link text} of the cursor cell, or `null` when the cursor is elsewhere. */
  readonly cursor: number | null
}

/**
 * The prompt as it is drawn from a plain buffer — the text and where the cursor is in it.
 *
 * Split out from the component because the inverse-video cursor is invisible in a test's
 * frame (Ink drops styling when the stream is not a terminal), and where the cursor is drawn
 * is exactly what the editing keys are about (#206).
 */
export function promptLines(value: string, cursor: number): readonly PromptLine[] {
  return linesOf({ value, cursor, collapsed: [] })
}

/** {@link promptLines} for a buffer, collapsed pastes and all. */
function linesOf(buffer: Buffer): readonly PromptLine[] {
  const display = displayOf(buffer)
  // Which line the cursor is on, and how far into it: counted in display characters, because
  // that is what the lines below are made of.
  const before = display.text.slice(0, display.cursor)
  const row = countNewlines(before)
  const column = display.cursor - lastNewline(before)

  return display.text
    .split('\n')
    .map((text, index) => ({ text, cursor: index === row ? column : null }))
}

/** The buffer, line by line, with the cursor drawn as an inverse cell. */
function BufferView({ buffer }: { readonly buffer: Buffer }) {
  return (
    <Box flexDirection="column">
      {linesOf(buffer).map((line, index) => (
        // The buffer's lines have no identity of their own; their order is the identity.
        <Text key={index}>
          {index === 0 ? '❯ ' : '  '}
          {line.cursor === null ? (
            line.text
          ) : (
            <>
              {line.text.slice(0, line.cursor)}
              {/* At the end of a line the cursor is a cell of its own; the inverse video is
                  the only thing that makes it visible, so it is drawn either way. */}
              <Text inverse>{line.text[line.cursor] ?? ' '}</Text>
              {line.text.slice(line.cursor + 1)}
            </>
          )}
        </Text>
      ))}
    </Box>
  )
}

/** A history entry as a buffer: the text, with the cursor at its end, ready to keep typing. */
function recalled(entry: string): Buffer {
  return { value: entry, cursor: entry.length, collapsed: [] }
}

/** The buffer as the screen shows it: a label for each collapsed run, and the cursor's place in it. */
function displayOf(buffer: Buffer): Display {
  const pieces: Piece[] = []
  let text = ''
  let at = 0

  const plain = (from: number, to: number): void => {
    pieces.push({
      realFrom: from,
      realTo: to,
      displayFrom: text.length,
      displayTo: text.length + (to - from),
      collapsed: false,
    })
    text += buffer.value.slice(from, to)
  }

  for (const run of [...buffer.collapsed].sort((a, b) => a.start - b.start)) {
    plain(at, run.start)
    pieces.push({
      realFrom: run.start,
      realTo: run.end,
      displayFrom: text.length,
      displayTo: text.length + run.label.length,
      collapsed: true,
    })
    text += run.label
    at = run.end
  }
  plain(at, buffer.value.length)

  return {
    text,
    cursor: displayIndex(text, pieces, buffer.cursor),
    pieces,
    end: buffer.value.length,
  }
}

/** Where the cursor is in display characters, given where it is in the buffer. */
function displayIndex(text: string, pieces: readonly Piece[], cursor: number): number {
  for (const piece of pieces) {
    if (cursor >= piece.realFrom && cursor <= piece.realTo) {
      // Inside a collapsed run the cursor sits at its edge — the nearer one, so leaving the
      // middle of a label costs the fewest characters in the direction it was going.
      if (piece.collapsed && cursor > piece.realFrom && cursor < piece.realTo) {
        return (
          piece.displayFrom +
          (cursor - piece.realFrom < piece.realTo - cursor
            ? 0
            : piece.displayTo - piece.displayFrom)
        )
      }
      return (
        piece.displayFrom + Math.min(cursor - piece.realFrom, piece.displayTo - piece.displayFrom)
      )
    }
  }
  return text.length
}

/** The buffer index a display index stands for. A label has no interior the cursor can be in. */
function realIndex(display: Display, index: number): number {
  for (const piece of display.pieces) {
    if (index >= piece.displayFrom && index <= piece.displayTo) {
      if (piece.collapsed) {
        return index >= piece.displayTo ? piece.realTo : piece.realFrom
      }
      return piece.realFrom + Math.min(index - piece.displayFrom, piece.realTo - piece.realFrom)
    }
  }
  return display.end
}

/** Replace the run `[from, to)` with `text`, keeping what is collapsed consistent with it. */
function splice(buffer: Buffer, from: number, to: number, text: string): Buffer {
  const removed = to - from
  const collapsed: Collapse[] = []
  for (const run of buffer.collapsed) {
    if (run.end <= from) {
      collapsed.push(run)
    } else if (run.start >= to) {
      collapsed.push({
        ...run,
        start: run.start + text.length - removed,
        end: run.end + text.length - removed,
      })
    }
    // A run the edit reached into is gone: see deleteRange and insertAt for why.
  }
  return {
    value: buffer.value.slice(0, from) + text + buffer.value.slice(to),
    cursor: from + text.length,
    collapsed,
  }
}

/** Insert at the cursor. A `label` makes the inserted run a collapsed paste (#206). */
function insertAt(buffer: Buffer, at: number, text: string, label?: string): Buffer {
  const next = splice(buffer, at, at, text)
  if (label === undefined) return next
  return {
    ...next,
    collapsed: [...next.collapsed, { start: at, end: at + text.length, label }].sort(
      (a, b) => a.start - b.start,
    ),
  }
}

/** Delete `[from, to)`, taking whole any collapsed run the range touches. */
function deleteRange(buffer: Buffer, from: number, to: number): Buffer {
  if (to <= from) return buffer

  // A collapsed paste is one thing on screen, so deleting into one deletes all of it: what
  // is inside the label is invisible, and deleting an invisible character is not a promise
  // a backspace can keep.
  let start = from
  let end = to
  for (const run of buffer.collapsed) {
    if (run.start < end && run.end > start) {
      start = Math.min(start, run.start)
      end = Math.max(end, run.end)
    }
  }

  return splice(buffer, start, end, '')
}

/** The start of the line `index` is on. */
function lineStart(text: string, index: number): number {
  const found = text.lastIndexOf('\n', index - 1)
  return found === -1 ? 0 : found + 1
}

/** The end of the line `index` is on: where its newline is, or the end of the buffer. */
function lineEnd(text: string, index: number): number {
  const found = text.indexOf('\n', index)
  return found === -1 ? text.length : found
}

/** The line above, at the same column, clamped to that line's end — or `null` at the top. */
function lineUp(text: string, index: number): number | null {
  const start = lineStart(text, index)
  if (start === 0) return null
  const previousEnd = start - 1
  const previousStart = lineStart(text, previousEnd)
  return Math.min(previousStart + (index - start), previousEnd)
}

/** The line below, at the same column, clamped to that line's end — or `null` at the bottom. */
function lineDown(text: string, index: number): number | null {
  const end = lineEnd(text, index)
  if (end >= text.length) return null
  const nextStart = end + 1
  const nextEnd = lineEnd(text, nextStart)
  return Math.min(nextStart + (index - lineStart(text, index)), nextEnd)
}

/** The start of the word before `index`, skipping the spaces in between. */
function wordStart(text: string, index: number): number {
  let at = index
  while (at > 0 && isSpace(text[at - 1])) at--
  while (at > 0 && !isSpace(text[at - 1])) at--
  return at
}

/** The end of the word after `index`, skipping the spaces in between. */
function wordEnd(text: string, index: number): number {
  let at = index
  while (at < text.length && isSpace(text[at])) at++
  while (at < text.length && !isSpace(text[at])) at++
  return at
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character)
}

/** How many newlines are in `text`. */
function countNewlines(text: string): number {
  return text.split('\n').length - 1
}

/** The index just past the last newline in `text` — every character after it is on its last line. */
function lastNewline(text: string): number {
  return text.lastIndexOf('\n') + 1
}
