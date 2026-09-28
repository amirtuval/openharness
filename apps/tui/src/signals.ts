/** The signals a terminal chat has to clean up after. */
export type SignalName = 'SIGINT' | 'SIGTERM' | 'SIGHUP'

/** What to do when each signal arrives. */
export interface SignalHandlers {
  /** Ctrl+C outside raw mode — before Ink has the terminal, or with stdin piped. */
  readonly onInterrupt?: (() => void) | undefined
  /** The process was asked to stop: `SIGTERM`, or a terminal that went away (`SIGHUP`). */
  readonly onTerminate?: (() => void) | undefined
}

/** The part of `process` this needs, so a test can pass an `EventEmitter` instead. */
export interface SignalHost {
  on(event: SignalName, listener: () => void): unknown
  off(event: SignalName, listener: () => void): unknown
}

/**
 * Handle the signals that would otherwise kill the CLI mid-render.
 *
 * While Ink is in raw mode, Ctrl+C never becomes a `SIGINT` — it arrives as input and the
 * chat handles it itself. These handlers are for every other way the process is asked to
 * stop: during startup, with a piped stdin, on `SIGTERM` from a supervisor, or when the
 * terminal closes under it. Each one restores the terminal before leaving.
 *
 * @returns a disposer that removes every handler again, so a second `run()` in the same
 *   process (a test, a REPL) does not stack them up
 */
export function installSignals(host: SignalHost, handlers: SignalHandlers): () => void {
  const interrupt = handlers.onInterrupt
  const terminate = handlers.onTerminate
  const bound: readonly (readonly [SignalName, () => void])[] = [
    ['SIGINT', () => interrupt?.()],
    ['SIGTERM', () => terminate?.()],
    ['SIGHUP', () => terminate?.()],
  ]

  for (const [signal, listener] of bound) {
    host.on(signal, listener)
  }

  return () => {
    for (const [signal, listener] of bound) {
      host.off(signal, listener)
    }
  }
}
