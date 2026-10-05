/**
 * When the auto-update runs at all (issue #157, D10), as plain decisions over plain values.
 *
 * There are two independent questions, and keeping them apart is what makes the feature
 * testable without spawning anything: *may this run update?* (the off switches, below) and
 * *is it time to check again?* (the throttle). Both answer from values the caller has already
 * read — the environment, the config file, the state file's timestamp — so every combination
 * is a unit test rather than a subprocess.
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
