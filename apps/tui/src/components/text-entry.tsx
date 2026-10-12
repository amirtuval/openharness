import { Box, Text, useInput } from 'ink'
import { useRef, useState } from 'react'

/**
 * One line of text, read in the prompt slot (epic #303, #310).
 *
 * The prompt slot's flows own the input area, and a flow sometimes needs a line of text the
 * chat's own prompt cannot give it — an `ask_user` question's answer, a write-in, a denial's
 * message. This is that one line: it echoes what is typed (nothing here is a secret — the
 * masked entry is `secret-input.tsx`), Enter settles it, Esc settles `null` for "never mind".
 *
 * Deliberately smaller than {@link ../components/prompt-input}: no history, no multi-line
 * editing, no command menu. A flow that needs one of those is a different flow.
 */
export function TextEntry({
  label,
  initial = '',
  onSubmit,
  onCancel,
}: {
  /** What is being asked, drawn to the left of the field. */
  readonly label: string
  /** What the field starts with, so a reader can correct what they already said. */
  readonly initial?: string | undefined
  /** Settle with what was typed. An empty line is a real answer: `''`. */
  readonly onSubmit: (text: string) => void
  /** Settle with nothing — Esc, or Ctrl+C. */
  readonly onCancel: () => void
}) {
  // The value of record is the ref; the state is what renders. Ink hands `useInput` a callback
  // that sees the latest committed render, and a terminal can deliver several keystrokes inside
  // one — typing then Enter arrives as a burst — so Enter must settle with what the last
  // keystroke left, not with what the render it closed over still held.
  const [value, setValue] = useState(initial)
  const valueRef = useRef(initial)
  const set = (next: string): void => {
    valueRef.current = next
    setValue(next)
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      onCancel()
      return
    }
    if (key.return) {
      onSubmit(valueRef.current)
      return
    }
    if (key.escape) {
      onCancel()
      return
    }
    if (key.backspace || key.delete) {
      set(valueRef.current.slice(0, -1))
      return
    }
    // A bracketed paste arrives as one string, newlines and all; a field of one line keeps it
    // on one line rather than inventing a second.
    if (input !== '' && !key.ctrl && !key.meta) {
      set(`${valueRef.current}${input.replace(/\r?\n/gu, ' ')}`)
    }
  })

  return (
    <Box>
      <Text dimColor>{label} › </Text>
      <Text>{value}</Text>
      {/* The cursor, drawn as an inverse cell so it is visible on an empty field. */}
      <Text inverse> </Text>
    </Box>
  )
}
