import { Box, Text, useInput } from 'ink'
import { useRef, useState } from 'react'

/** What the user typed, as the buffer and where the cursor sits in it. */
interface Buffer {
  readonly value: string
  readonly cursor: number
}

const EMPTY: Buffer = { value: '', cursor: 0 }

export interface PromptInputProps {
  /** Called with the buffer on Enter; an empty buffer is not sent, but is cleared. */
  readonly onSubmit: (text: string) => void
  /** Called on every keystroke that touches the buffer, so the screen can drop hints. */
  readonly onActivity?: (() => void) | undefined
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
 * - Left/right/Home/End move the cursor, Backspace deletes behind it, Delete deletes at it,
 *   and anything else printable — including a paste, which arrives as one chunk — is
 *   inserted at the cursor.
 */
export function PromptInput({ onSubmit, onActivity }: PromptInputProps) {
  const [buffer, setBuffer] = useState<Buffer>(EMPTY)

  // The buffer the handlers read.
  //
  // Ink hands `useInput` a callback that sees the latest *committed* render, and a terminal
  // can deliver several keystrokes inside one render — a paste, or a fast typist pressing
  // Enter. Reading React state there would read the buffer from before those keystrokes, so
  // "hi" + Enter could send "" (or send "h"). The ref is the buffer of record; the state
  // exists to render it.
  const bufferRef = useRef<Buffer>(EMPTY)

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

  const insert = (text: string): void => {
    edit(({ value, cursor }) => ({
      value: `${value.slice(0, cursor)}${text}${value.slice(cursor)}`,
      cursor: cursor + text.length,
    }))
  }

  const move = (delta: number): void => {
    // Moving the cursor is not typing, so it does not dismiss the exit hint.
    edit(
      ({ value, cursor }) => ({
        value,
        cursor: Math.min(Math.max(cursor + delta, 0), value.length),
      }),
      { activity: false },
    )
  }

  const place = (cursor: number): void => {
    edit((current) => ({ value: current.value, cursor: Math.min(cursor, current.value.length) }))
  }

  const submit = (): void => {
    const { value } = bufferRef.current
    commit(EMPTY, { activity: false })
    if (value.trim() !== '') {
      onSubmit(value)
    }
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

    if (key.backspace) {
      edit(({ value, cursor }) =>
        cursor === 0
          ? { value, cursor }
          : { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 },
      )
      return
    }

    if (key.delete) {
      edit(({ value, cursor }) => ({
        value: value.slice(0, cursor) + value.slice(cursor + 1),
        cursor,
      }))
      return
    }

    if (key.leftArrow) return move(-1)
    if (key.rightArrow) return move(1)
    if (key.home) return place(0)
    if (key.end) return place(Number.POSITIVE_INFINITY)
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.tab || key.escape) return

    // Everything else is text: one character, or a whole paste as a single chunk.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      insert(input)
    }
  })

  const lines = buffer.value.split('\n')

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // The buffer's lines have no identity of their own; their order is the identity.
        <Text key={index}>{index === 0 ? `❯ ${line}` : `  ${line}`}</Text>
      ))}
    </Box>
  )
}
