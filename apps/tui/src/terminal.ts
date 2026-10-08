/**
 * Terminal hygiene: give the terminal back the way we found it.
 *
 * Ink restores raw mode and the cursor when it unmounts, but unmounting is not the only way
 * out — a `SIGTERM`, an exception thrown before `render()` returns, a second Ctrl+C arriving
 * while teardown is still running — and a terminal left in raw mode is one where the user's
 * shell no longer echoes what they type. {@link restoreTerminal} is the belt to Ink's braces:
 * idempotent, cheap, and safe to call on a stream that is not a TTY.
 */

/** The input half of a terminal, as much of it as restoring needs. */
export interface TerminalInput {
  readonly isTTY?: boolean | undefined
  setRawMode?(mode: boolean): void
}

/** The output half of a terminal, as much of it as restoring needs. */
export interface TerminalOutput {
  readonly isTTY?: boolean | undefined
  write(chunk: string): unknown
}

/** The streams to restore; both default to the process's. */
export interface TerminalTargets {
  readonly stdin?: TerminalInput | undefined
  readonly stdout?: TerminalOutput | undefined
}

/** Show the cursor again, in case something hid it and did not get to put it back. */
const SHOW_CURSOR = '\u001B[?25h'

/**
 * Wipe the screen: erase what is displayed, erase the scrollback behind it, and put the
 * cursor back at the top-left corner.
 *
 * Ink owns everything below that line, so this is written straight to the stream rather than
 * through a component — and it is the one drawing trick the CLI does by hand. The scrollback
 * half (`\u001B[3J`) is what makes it a *clear* rather than a scroll: settled messages live in
 * the terminal's scrollback through Ink's `<Static>`, and leaving them behind would mean
 * Ctrl+L only moved the prompt up the screen. What goes is the view of the session (#206):
 * the session itself is untouched, and everything sent after the clear is printed as usual.
 */
const CLEAR_SCREEN = '\u001B[2J\u001B[3J\u001B[H'

/**
 * Clear the screen, when there is a screen to clear.
 *
 * A stream that is not a TTY — a pipe, a test's stand-in — is left alone: there is no screen,
 * and the escape sequence would only end up in the output a person is reading.
 */
export function clearScreen(targets: TerminalTargets = {}): void {
  const stdout = targets.stdout ?? process.stdout
  if (stdout.isTTY !== true) return
  stdout.write(CLEAR_SCREEN)
}

/**
 * Leave the terminal usable: line-mode input (raw mode off) and a visible cursor.
 *
 * Called from every exit path, so it must be safe to call twice and safe to call when
 * nothing was ever mounted.
 */
export function restoreTerminal(targets: TerminalTargets = {}): void {
  const stdin = targets.stdin ?? process.stdin
  const stdout = targets.stdout ?? process.stdout

  if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
    try {
      stdin.setRawMode(false)
    } catch {
      // A stdin that refuses to change mode is already not our problem: there is nothing
      // else to restore, and throwing here would mask the error on the way out.
    }
  }

  if (stdout.isTTY === true) {
    stdout.write(SHOW_CURSOR)
  }
}
