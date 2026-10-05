import type { CliCommand } from '../args'

import { autoUpdateOffReason, isCheckDue } from './decide'
import { isGlobalInstall, looksLikeGlobalLayout } from './detect'
import { printPendingNotice } from './notice'
import { createUpdateRunner, type UpdateRunner } from './npm'
import { isNewer } from './semver'
import { patchUpdateState, readUpdateState, updateLogPath, updateStatePath } from './state'

/**
 * The auto-update, as the rest of the CLI sees it (issue #157, decision D10).
 *
 * The shape of the feature follows from one property of the package: the CLI is a single
 * self-contained file, so a global `npm install -g openharness@<v>` may replace it on disk
 * while the running copy keeps going. That makes the update a *background* act — this process
 * never becomes the new version and never waits for it:
 *
 * 1. on startup, before any screen is drawn, a pending outcome from the last install is
 *    printed once ({@link printPendingNotice});
 * 2. at most once an hour, a detached-from-startup check asks npm for the published version
 *    and — if it is newer — starts a detached install ({@link checkForUpdate}).
 *
 * Everything here is best-effort by construction: the check never blocks, never rejects, and
 * never throws into the caller. A command the user typed must not fail because an update
 * could not be looked up.
 */

/** What the updater needs to know about the run that just started. */
export interface AutoUpdateContext {
  /** The command being run; `update`, `version` and `help` are the exceptions. */
  readonly command: CliCommand['kind']
  /** The process environment: the off switches, and where the state files live. */
  readonly env: Record<string, string | undefined>
  /** `autoUpdate` from the config file — the off switch that is a setting. */
  readonly configAutoUpdate: boolean
  /** The running entry point (`process.argv[1]`), for the global-install check. */
  readonly scriptPath: string | undefined
  /** The version this bundle was built with. */
  readonly runningVersion: string
  /** One line of output. */
  readonly stdout: (line: string) => void
  /** One line of error output. */
  readonly stderr: (line: string) => void
}

/**
 * The updater, as `run()` calls it: the notice and the check, synchronously entered and never
 * awaited.
 *
 * It is a plain function type so a test can watch what `run()` hands it — which commands ask
 * for an update, and with which environment — without any of this spawning npm.
 */
export type AutoUpdateHook = (context: AutoUpdateContext) => void

/**
 * Report a pending outcome, then start a check if this run is due for one.
 *
 * `--version` and `--help` never get here (the caller returns first): a notice would corrupt
 * the one line a script parses. `oh update` gets here but only for the notice — it does its
 * own check and install in the foreground.
 */
export function autoUpdate(context: AutoUpdateContext): void {
  try {
    const statePath = updateStatePath(context.env)
    const off = autoUpdateOffReason(context.env, context.configAutoUpdate)
    const isUpdateCommand = context.command === 'update'

    // `oh update` is always about updating, so it reports what the last install did whatever
    // the off switches say: the user is looking right at it.
    if (off === undefined || isUpdateCommand) {
      printPendingNotice(statePath, { stdout: context.stdout, stderr: context.stderr })
    }

    if (isUpdateCommand || off !== undefined) return

    void checkForUpdate({
      env: context.env,
      statePath,
      logPath: updateLogPath(context.env),
      runningVersion: context.runningVersion,
      scriptPath: context.scriptPath,
    })
  } catch {
    // Nothing the updater does is worth failing a command over.
  }
}

/** Everything {@link checkForUpdate} reads, with the seams its tests need. */
export interface CheckForUpdateOptions {
  readonly env: Record<string, string | undefined>
  readonly statePath: string
  readonly logPath: string
  readonly runningVersion: string
  readonly scriptPath: string | undefined
  /** The npm seam; defaults to the real one ({@link createUpdateRunner}). */
  readonly runner?: UpdateRunner | undefined
  /** The clock, for the throttle; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined
}

/**
 * One background check, from the global-install gate to the detached install.
 *
 * Resolves when the check itself is done — the install it may have started is detached, and
 * is not waited for. It never rejects, so the caller can leave it running and forget it.
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<void> {
  try {
    // `unref`: this check is background work, and a command that has already printed must not
    // be held back by it — see `NpmOptions.unref`.
    const runner = options.runner ?? createUpdateRunner({ env: options.env, unref: true })
    const now = options.now ?? Date.now

    // The free half of the global-install check first: a checkout, or a copy inside some
    // project, answers "no" here without spawning anything at all.
    if (!looksLikeGlobalLayout(options.scriptPath)) return

    const globalRoot = await globalRootCached(options.statePath, runner)
    if (globalRoot === undefined) return
    if (!isGlobalInstall(options.scriptPath, globalRoot)) return

    const state = readUpdateState(options.statePath)
    if (!isCheckDue(now(), state.lastCheck)) return

    // Record the check *before* making it: a lookup that fails, hangs or is killed still
    // counts as this hour's, so a flaky network cannot make every `oh` pay for a lookup.
    patchUpdateState(options.statePath, { lastCheck: new Date(now()).toISOString() })

    const published = await runner.viewPublishedVersion()
    if (!published.ok) return
    if (!isNewer(published.output, options.runningVersion)) return

    runner.startDetachedInstall(published.output, {
      statePath: options.statePath,
      logPath: options.logPath,
    })
  } catch {
    // As above: the update is a courtesy, and the command is not.
  }
}

/**
 * `npm root -g`, cached in the state file.
 *
 * The lookup is what separates a global install from a package inside a project, and it is
 * the only reason the check would ever spawn npm before it has something to compare — so its
 * answer is kept. It is kept next to the `node` that produced it, because the global root
 * belongs to a node installation: an `nvm use` changes both, and the cache has to notice.
 */
async function globalRootCached(
  statePath: string,
  runner: UpdateRunner,
): Promise<string | undefined> {
  const state = readUpdateState(statePath)
  if (state.globalRoot !== undefined && state.globalRootNode === process.execPath) {
    return state.globalRoot
  }

  const resolved = await runner.resolveGlobalRoot()
  if (!resolved.ok) return undefined
  const root = resolved.output
  if (root === '') return undefined

  patchUpdateState(statePath, { globalRoot: root, globalRootNode: process.execPath })
  return root
}

/** Everything {@link detectGlobalInstall} reads. */
export interface DetectInstallOptions {
  readonly env: Record<string, string | undefined>
  readonly scriptPath: string | undefined
  /** The npm seam; defaults to the real one. */
  readonly runner?: UpdateRunner | undefined
}

/**
 * Is the running `oh` a global npm install? — the answer `oh update` needs before it does
 * anything, asked in the foreground and allowed to take its time.
 *
 * Unlike the background check, which bails on the cheap structural test and only then resolves
 * npm's global root, this asks the authoritative question directly: `oh update` was typed on
 * purpose, and its answer is the difference between updating and refusing.
 */
export async function detectGlobalInstall(options: DetectInstallOptions): Promise<boolean> {
  if (!looksLikeGlobalLayout(options.scriptPath)) return false
  const runner = options.runner ?? createUpdateRunner({ env: options.env })
  const globalRoot = await globalRootCached(updateStatePath(options.env), runner)
  return globalRoot !== undefined && isGlobalInstall(options.scriptPath, globalRoot)
}
