import { useCallback, useEffect, useRef, useState } from 'react'

import { writeToClipboard } from '../lib/clipboard'

/**
 * How long a Copy button says "Copied".
 *
 * Long enough to be seen, short enough that it is not a state the reader has to undo.
 */
export const COPIED_MS = 1500

/**
 * The copy button, minus the markup: put {@link text} on the clipboard and say so for a moment.
 *
 * Both of the app's copy affordances use it — a code block's header (#204) and a message's
 * actions (#212) — because they are the same gesture and the same three rules: the clipboard
 * may refuse (then nothing is claimed), the confirmation is temporary, and a second copy while
 * the first is still showing restarts the clock rather than stacking timers.
 *
 * `copied` resets whenever the text changes: a streaming code block's copy is of the text that
 * was on screen when the button was pressed, and the confirmation must not outlive it.
 */
export function useCopy(text: string): { readonly copied: boolean; readonly copy: () => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  // The one timer, cleared on unmount: a component that goes away mid-confirmation must not
  // leave a `setState` behind it.
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    setCopied(false)
  }, [text])

  const copy = useCallback((): void => {
    void writeToClipboard(text).then((written) => {
      if (!written) {
        return
      }
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        setCopied(false)
      }, COPIED_MS)
    })
  }, [text])

  return { copied, copy }
}
