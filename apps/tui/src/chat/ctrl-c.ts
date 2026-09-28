/** What a Ctrl+C should do, given what the session is doing. */
export type CtrlCAction = 'interrupt' | 'arm' | 'exit'

/** How long an idle Ctrl+C stays armed: press the second one within this and the CLI exits. */
export const CTRL_C_WINDOW_MS = 2000

/** The inputs to the decision: what is running, and whether we are already armed. */
export interface CtrlCPress {
  /** Whether a turn is in flight. */
  readonly running: boolean
  /** The current time, in milliseconds — injected so a test can move the clock. */
  readonly now: number
  /** When the previous idle Ctrl+C armed the exit, or `null` when it did not. */
  readonly armedAt: number | null
  /** How long an armed exit stays armed. */
  readonly windowMs?: number | undefined
}

/** The decision, and the arming state to keep for the next press. */
export interface CtrlCDecision {
  readonly action: CtrlCAction
  readonly armedAt: number | null
}

/**
 * The Ctrl+C rules, in one place because two things deliver it: Ink's input handler when
 * stdin is a TTY, and the process's `SIGINT` handler when it is not.
 *
 * While a turn is running, Ctrl+C interrupts it — the reply stops, what was produced is
 * kept, and the session goes idle. When idle, one press only arms the exit (and the UI says
 * so); a second press inside the window exits. That is what keeps a stray Ctrl+C from
 * throwing away a session, and what makes "Ctrl+C twice" an explicit instruction rather
 * than a race.
 */
export function decideCtrlC(press: CtrlCPress): CtrlCDecision {
  if (press.running) {
    return { action: 'interrupt', armedAt: null }
  }

  const windowMs = press.windowMs ?? CTRL_C_WINDOW_MS
  if (press.armedAt !== null && press.now - press.armedAt <= windowMs) {
    return { action: 'exit', armedAt: null }
  }

  return { action: 'arm', armedAt: press.now }
}
