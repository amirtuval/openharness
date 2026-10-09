import { Box, Text, useInput, usePaste } from 'ink'
import { useCallback, useRef, useState } from 'react'

/**
 * A one-line input for a secret: no echo, masked, and never anywhere a typed line is kept
 * (#210, X7 — the API key the terminal asks for).
 *
 * It is deliberately **not** `PromptInput`. That component is a readline editor for a message:
 * it echoes what it holds, it hands every line it submits to the prompt history, and pasting a
 * file into it is a feature. None of that may happen to a key. So this keeps its own tiny
 * buffer, renders `•` per character and nothing else, and calls back only when the whole value
 * is submitted — the plaintext exists in a ref and in the argument of {@link onSubmit}, and
 * nowhere else: not in a prop, not in state, and therefore never in a frame.
 *
 * **Bracketed paste works**, because a pasted key is the normal case — copying it from the
 * provider's console is the only thing anyone does. Ink's `usePaste` turns the terminal's
 * bracketed-paste mode on while this is mounted, so the key arrives as one string rather than
 * as a burst of keypresses, and a `\n` inside it is stripped rather than submitted.
 *
 * The ref is the value of record for the same reason the prompt's is: Ink hands `useInput` a
 * callback that sees the latest committed render, and a terminal can deliver several keystrokes
 * inside one render — so reading state there would drop all but the last of them.
 */
export interface SecretInputProps {
  /**
   * The whole value was submitted (Enter). Never called with an empty or blank value — unless
   * {@link SecretInputProps.optional} says the field may be skipped.
   */
  readonly onSubmit: (value: string) => void
  /** The user gave up (Esc). */
  readonly onCancel: () => void
  /** What the input shows while it is empty; usually the provider's key format. */
  readonly placeholder?: string | undefined
  /** Suppress keys while a save is in flight — the value is already on its way. */
  readonly busy?: boolean | undefined
  /**
   * One printable character, before it is inserted into the secret: how a flow binds a key of
   * its own — `o` for "open the provider's key page" — without the letter ending up in the key.
   * Returning `true` means it was handled and is not inserted.
   *
   * It is asked only while the input is **empty**: once a key is being typed, every character
   * is part of it. A key typed by hand — or pasted one character at a time by a terminal
   * without bracketed paste — holds `o`s like any other letter, and claiming them mid-key
   * would open the browser and silently drop them from the secret.
   *
   * One channel rather than a second `useInput`: Ink delivers every key to every mounted
   * handler, so a sibling hook binding `o` would open the page *and* put an `o` in the key.
   */
  readonly onChar?: ((character: string) => boolean) | undefined
  /**
   * Whether the value is drawn as masks (the default) or as what was typed.
   *
   * A secret field is the first thing this component exists for, and it is the default; a field
   * that is **not** a secret — an Azure endpoint, a deployment list — says so, and then the
   * reader can see what they typed. Nothing else about the component changes: the value still
   * lives in a ref, and only a masked field's frame is free of it by construction.
   */
  readonly mask?: boolean | undefined
  /**
   * Whether an empty answer is a value.
   *
   * A required field — every secret but a custom endpoint's key (#249) — refuses a blank
   * submission: Enter on an empty box is not a save of "". An **optional** one submits its empty
   * value, so the flow can move on and simply omit the field from the body.
   */
  readonly optional?: boolean | undefined
}

/** The character a typed key is drawn as. Never the character itself. */
export const SECRET_MASK = '•'

export function SecretInput({
  onSubmit,
  onCancel,
  placeholder,
  busy = false,
  onChar,
  mask = true,
  optional = false,
}: SecretInputProps) {
  // What was typed lives here and only here; the render knows how many characters it holds,
  // never which ones. A frame can therefore not contain the secret, and neither can a
  // snapshot of the tree React draws from.
  const value = useRef('')
  const [length, setLength] = useState(0)

  const set = useCallback((next: string): void => {
    value.current = next
    setLength(next.length)
  }, [])

  useInput((input, key) => {
    if (busy) return

    if (key.escape) {
      set('')
      onCancel()
      return
    }

    if (key.return) {
      const entered = value.current.trim()
      // An empty submission is nothing to validate and nothing to send; Enter on an empty box
      // is not a save of "". An optional field is the exception (#249): its empty answer is a
      // value the flow omits from the body, so Enter moves on with "".
      if (optional || entered !== '') onSubmit(entered)
      return
    }

    if (key.backspace || key.delete) {
      set(value.current.slice(0, -1))
      return
    }

    // One character, or a fallback paste delivered as a chunk when bracketed paste is off.
    // Ctrl+J's line feed is not text a key can hold.
    if (input.length > 0 && !key.ctrl && !key.meta) {
      insert(input)
    }
  })

  // A real paste: one string, from the terminal's bracketed-paste mode. Line endings are
  // stripped, so a key pasted with its trailing newline does not become a submit.
  usePaste((text) => {
    if (busy) return
    insert(text)
  })

  /** Insert what arrived, minus line endings, giving the flow first refusal on `o`. */
  function insert(text: string): void {
    const stripped = text.replace(/[\r\n]+/gu, '')
    if (stripped.length === 1 && value.current === '' && onChar?.(stripped) === true) return
    set(value.current + stripped)
  }

  return (
    <Box flexDirection="column">
      <Text>
        {'❯ '}
        {length === 0 ? (
          <Text dimColor>{placeholder ?? ''}</Text>
        ) : mask ? (
          SECRET_MASK.repeat(length)
        ) : (
          value.current
        )}
      </Text>
    </Box>
  )
}
