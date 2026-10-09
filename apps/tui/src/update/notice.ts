import { PERMISSION_HINT } from './npm'
import { consumeUpdateResult, type UpdateResult } from './state'

/**
 * The one line the auto-update says (issue #157, D10).
 *
 * A detached install cannot talk to the run that started it, so it leaves its outcome in the
 * state file and the *next* run reports it — once, before anything else is printed, which is
 * also before the chat's Ink UI mounts or `oh login` starts its device flow. Nothing here
 * ever writes in the middle of a screen.
 */

/** Where a notice goes: the success line is information, the failure line is a problem. */
export interface NoticeStreams {
  readonly stdout: (line: string) => void
  readonly stderr: (line: string) => void
}

/**
 * The line (or lines) an outcome gets.
 *
 * A success is the one line the issue asks for. A failure says what went wrong and repeats the
 * command that would fix it by hand — and, when npm could not write to its global prefix,
 * adds the one hint that would make that command succeed, because retrying it unchanged
 * cannot.
 */
export function noticeLines(result: UpdateResult): readonly string[] {
  if (result.status === 'success') {
    return [`oh updated to v${result.version}`]
  }

  const reason = result.reason?.trim()
  const line = `oh could not update itself: ${
    reason === undefined || reason === '' ? 'the install failed' : reason
  }; run npm i -g @openh/cli`

  if (result.permission !== true) return [line]
  return [line, PERMISSION_HINT]
}

/**
 * Print the pending outcome, if there is one, and forget it — the once-only rule.
 *
 * @returns whether anything was printed.
 */
export function printPendingNotice(statePath: string, streams: NoticeStreams): boolean {
  const result = consumeUpdateResult(statePath)
  if (result === undefined) return false

  const write = result.status === 'success' ? streams.stdout : streams.stderr
  for (const line of noticeLines(result)) write(line)
  return true
}
