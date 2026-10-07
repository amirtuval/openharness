import { useEffect, useRef } from 'react'

import { isTypingTarget, shortcutFor, type ShortcutId } from '../lib/shortcuts'

/** What the shell does for each shortcut it handles. Anything absent is not bound. */
export type ShortcutHandlers = Partial<Record<ShortcutId, () => void>>

/**
 * Bind the app's shortcuts to the document, for as long as the caller is mounted (#212).
 *
 * One listener on `document`, in the capture-less bubbling phase — so a dialog or a menu that
 * has already handled a key can `stopPropagation` and keep it, and so nothing here fights the
 * controls the reader is actually using.
 *
 * The handlers are read from a ref rather than captured: they close over the shell's state
 * (the route, whether the sidebar is put away), so they are a new object on every render —
 * and re-binding a document listener on every render, or listing five callbacks as
 * dependencies, would make a rule about keystrokes depend on render timing.
 *
 * The keystroke is the matcher's to interpret ({@link shortcutFor}) and the handler's to
 * honour; anything the matcher does not claim — Ctrl+R, a bare letter, Escape — is left
 * entirely alone, which is what keeps the browser's own keys working.
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const id = shortcutFor(event, isTypingTarget(event.target))
      const handler = id === null ? undefined : latest.current[id]
      if (handler === undefined) {
        return
      }
      event.preventDefault()
      handler()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
