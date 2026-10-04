/**
 * A one-line notice for something that happened to the reader, not in front of them.
 *
 * The one caller today is the open chat when the server says it was deleted somewhere else
 * (epic #116, U5): the session is gone, the app leaves the chat, and the screen it lands on
 * — New chat — should say why it is there. A banner in the chat would unmount with the chat;
 * a store the shell renders is the smallest thing that survives the navigation.
 *
 * Same shape as the settings and auth stores: module-level state, subscribe/read for
 * `useSyncExternalStore`, and no React in here.
 */

let current: string | null = null
const listeners = new Set<() => void>()

/** Show a one-line notice in the shell. */
export function showNotice(message: string): void {
  current = message
  notify()
}

/** Take the notice down. */
export function dismissNotice(): void {
  if (current === null) {
    return
  }
  current = null
  notify()
}

/** The notice showing, or `null`. */
export function currentNotice(): string | null {
  return current
}

/** Watch for a notice to appear or be dismissed. */
export function subscribeNotice(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}
