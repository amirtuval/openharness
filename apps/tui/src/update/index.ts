import type { CliCommand } from '../args'

import { autoUpdateOffReason, isCheckDue, isCheckInProgress } from './decide'
import { globalModuleDirectory, isGlobalInstall } from './detect'
import { printPendingNotice } from './notice'
import { createUpdateRunner, type UpdateRunner } from './npm'
import { patchUpdateState, readUpdateState, updateLogPath, updateStatePath } from './state'

/**
 * The auto-update, as the rest of the CLI sees it (issue #157, decision D10; #197).
 *
 * The shape of the feature follows from one property of the package: the CLI is a single
 * self-contained file, so a global `npm install -g @openh/cli@<v>` may replace it on disk
 * while the running copy keeps going. That makes the update a *background* act — this process
 * never becomes the new version and never waits for it:
 *
 * 1. on startup, before any screen is drawn, a pending outcome from the last install is
 *    printed once ({@link printPendingNotice});
 * 2. at most once an hour, and only when nothing else is checking, a **detached** child is
 *    started that does the whole check — the version lookup, the comparison, and the install
 *    when there is one ({@link checkForUpdate}).
 *
 * The child is what makes this work for a command that exits immediately (#197). The check is
 * a network call to the npm registry: microseconds after it starts, a fast command like
 * `oh whoami` has already printed and gone, and anything still running in this process dies
 * with it — which is what used to happen, hour after hour, to someone who mostly runs commands
 * that print and stop. So this process only decides *whether* a check is worth starting, from
 * things it can read without npm (the state file, and the layout of the bundle it is running
 * from), and the child does the rest.
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
 * The updater, as `run()` calls it: the notice, and the decision to start a check.
 *
 * It is a plain function type so a test can watch what `run()` hands it — which commands ask
 * for an update, and with which environment — without any of this spawning npm. That it is
 * synchronous is the point (#197): everything the foreground does is a read of the state file
 * and a `spawn`, so nothing in a command's own path waits for npm.
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

    checkForUpdate({
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
  /** The clock, for the throttle and the claim; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined
}

/**
 * Start a background check, if this run is the one that should.
 *
 * Everything decided here is decided *now*, from what can be read without npm, and every one
 * of those answers is a reason not to spawn anything — which is the common case:
 *
 * 1. the layout of the running bundle. A checkout, or the package vendored inside somebody
 *    else's `node_modules`, is not a global install and never gets one; that is a `realpath`
 *    and two directory comparisons ({@link globalModuleDirectory}).
 * 2. the global-install check, when the state file already caches `npm root -g`'s answer for
 *    the node running this. Only the first check after an install (or after an `nvm use`) has
 *    to leave that to the child, which caches it there.
 * 3. the throttle: an hour since the last answer ({@link isCheckDue}).
 * 4. the claim: a check that is already under way stays under way ({@link isCheckInProgress}).
 *
 * What is left is the spawn — a few milliseconds, no npm, no network — of a detached child
 * that does the lookup, the comparison and the install, and writes `lastCheck` itself, when
 * the lookup actually answers (#197). This process never waits for any of it, and the claim it
 * leaves behind names the child, so a second `oh` can see that a check is in progress.
 *
 * It never throws: the update is a courtesy, and the command is not.
 */
export function checkForUpdate(options: CheckForUpdateOptions): void {
  try {
    // The free half of the global-install check first: a checkout, or a copy inside some
    // project, answers "no" here without spawning anything at all. The module directory is
    // also what the child needs to ask npm the rest of the question.
    const moduleDirectory = globalModuleDirectory(options.scriptPath)
    if (moduleDirectory === undefined) return

    const runner = options.runner ?? createUpdateRunner({ env: options.env })
    const now = options.now ?? Date.now
    const state = readUpdateState(options.statePath)

    // The authoritative half, when a previous check already paid for its answer: the module
    // directory npm calls global is the one this `oh` runs from, or it is not. A cached answer
    // is a string comparison, so a package that is *not* the global one costs nothing from
    // here on — the child that cached it is the last one this will ever spawn.
    if (state.globalRoot !== undefined && state.globalRootNode === process.execPath) {
      if (!isGlobalInstall(options.scriptPath, state.globalRoot)) return
    }

    if (!isCheckDue(now(), state.lastCheck)) return
    if (isCheckInProgress(now(), state.checking)) return

    const pid = runner.startDetachedCheck({
      statePath: options.statePath,
      logPath: options.logPath,
      moduleDirectory,
      runningVersion: options.runningVersion,
    })

    // Claim the check under the child that owns it, so a second `oh` standing here a moment
    // from now sees a check in progress rather than starting its own. A child that could not be
    // started has no pid to claim it, and nothing to hold anyone back.
    if (pid !== undefined) {
      patchUpdateState(options.statePath, {
        checking: { at: new Date(now()).toISOString(), pid },
      })
    }
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
 * Unlike the background check, which bails on the cheap structural test and only then asks
 * npm (in a child, #197), this asks both halves itself, here: `oh update` was typed on
 * purpose, and its answer is the difference between updating and refusing.
 */
export async function detectGlobalInstall(options: DetectInstallOptions): Promise<boolean> {
  if (globalModuleDirectory(options.scriptPath) === undefined) return false
  const runner = options.runner ?? createUpdateRunner({ env: options.env })
  const globalRoot = await globalRootCached(updateStatePath(options.env), runner)
  return globalRoot !== undefined && isGlobalInstall(options.scriptPath, globalRoot)
}
