import type { UpdateCheck } from './state'

/**
 * When the auto-update runs at all (issue #157, D10; #197), as plain decisions over plain
 * values.
 *
 * There are three independent questions, and keeping them apart is what makes the feature
 * testable without spawning anything: *may this run update?* (the off switches, below), *is it
 * time to check again?* (the throttle), and *is someone already checking?* (the claim, #197).
 * Each answers from values the caller has already read — the environment, the config file, the
 * state file — so every combination is a unit test rather than a subprocess. The one thing the
 * caller has to bring is the process table, for the claim: whether the check that wrote it is
 * still running is not something this file can know on its own.
 */

/**
 * How long a check is good for: an hour.
 *
 * The check is a network call to the npm registry that nobody is waiting for, so it is worth
 * doing once per session at most; a day-old CLI that is opened every morning still finds its
 * update on the first run of the day.
 */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Why the auto-update is off, or `undefined` when it is on. */
export type AutoUpdateOffReason = 'env' | 'config' | 'ci'

/**
 * The off switches, in the order they are reported.
 *
 * 1. `OH_NO_AUTO_UPDATE=1` — the escape hatch, and what a person sets when they want to
 *    update on their own schedule;
 * 2. `autoUpdate: false` in the config file — the same decision, made once;
 * 3. `CI` set — a runner is not a person, and a CI job installing npm packages in the
 *    background is not an update, it is a surprise.
 *
 * What is deliberately *not* here: the global-install check, which needs to look at the
 * filesystem, and `oh update`, which is the one command that is always about updating.
 */
export function autoUpdateOffReason(
  env: Record<string, string | undefined>,
  configAutoUpdate: boolean,
): AutoUpdateOffReason | undefined {
  if (flagIsSet(env['OH_NO_AUTO_UPDATE'])) return 'env'
  if (!configAutoUpdate) return 'config'
  if (flagIsSet(env['CI'])) return 'ci'
  return undefined
}

/**
 * Is the last check old enough to run another one?
 *
 * A missing or unreadable timestamp is due — that is the first run, and a state file a previous
 * version wrote. A timestamp in the future (a clock that moved back) is not due, which is the
 * conservative answer: waiting out the hour beats checking on every run until the clock
 * catches up.
 */
export function isCheckDue(nowMs: number, lastCheck: string | undefined): boolean {
  if (lastCheck === undefined) return true
  const last = Date.parse(lastCheck)
  if (Number.isNaN(last)) return true
  return nowMs - last >= CHECK_INTERVAL_MS
}

/**
 * How long a claim is believed when nothing can say whether its process is still there.
 *
 * A check spends at most two npm lookups, each with a 15 s timeout, so a claim that is minutes
 * old belongs to a child that is gone — a machine that rebooted mid-check, a pid that was
 * recycled. This is the backstop, not the rule: {@link isCheckInProgress} asks the process
 * table first, which is what makes a killed check let go immediately instead of at the end of
 * a fixed wait.
 */
export const CHECK_CLAIM_TTL_MS = 5 * 60 * 1000

/**
 * Is a check already under way, and still running?
 *
 * The claim in the state file is what keeps two `oh` started at once from both installing the
 * same version: the second sees a claim whose process is alive and stands down. A claim left
 * by a check that was killed says nothing — its process is gone — so the next run claims the
 * check and looks again, which is the whole of "a killed lookup does not burn the hour".
 *
 * @param nowMs the clock, in milliseconds
 * @param checking the state file's claim, if any
 * @param isAlive the process table; injectable so the decision is a unit test
 */
export function isCheckInProgress(
  nowMs: number,
  checking: UpdateCheck | undefined,
  isAlive: (pid: number) => boolean = processIsAlive,
): boolean {
  if (checking === undefined) return false
  const claimed = Date.parse(checking.at)
  if (Number.isNaN(claimed) || nowMs - claimed >= CHECK_CLAIM_TTL_MS) return false
  return checking.pid !== undefined && isAlive(checking.pid)
}

/**
 * Is there a process with this pid?
 *
 * A signal of `0` is the portable "does it exist" — nothing is sent, and the error says
 * whether there is anything to send it to. `ESRCH` is the only answer that means no: a pid
 * that exists but belongs to somebody else's process raises `EPERM` on Linux, and on Windows
 * an unopenable process raises an error of its own, and neither of those is a process that
 * stopped running.
 */
export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * A switch that is set: present, non-blank, and not one of the words a shell uses for "off".
 *
 * `OH_NO_AUTO_UPDATE=` (an empty export) and `OH_NO_AUTO_UPDATE=0` mean the same thing as not
 * setting it — the same rule `browser.ts` applies to `CI`.
 */
function flagIsSet(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return (
    normalized !== undefined && normalized !== '' && normalized !== '0' && normalized !== 'false'
  )
}
