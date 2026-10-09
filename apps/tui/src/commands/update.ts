import {
  installGlobally,
  looksLikePermissionError,
  PERMISSION_HINT,
  viewPublishedVersion,
  type NpmOptions,
  type NpmOutcome,
} from '../update/npm'
import { isNewer } from '../update/semver'

/**
 * `oh update` (issue #157, D10): the auto-update, done on purpose.
 *
 * Everything the background check does quietly, this does in the foreground and out loud — a
 * version lookup, npm's own install output as the progress, and an exit code that says
 * whether it worked. It is the same npm and the same install the background path uses; the
 * only differences are that a person is watching, and that a failure is the command's failure
 * rather than a line the next run will print.
 */

/** The version lookup's outcome, in the shape the command reports. */
export type ViewOutcome =
  { readonly ok: true; readonly version: string } | { readonly ok: false; readonly detail: string }

/** The install's outcome, with the permission case the command has a hint for. */
export type InstallOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string; readonly permission: boolean }

/** The npm calls `oh update` makes; injected so its tests never spawn anything. */
export interface NpmPort {
  /** The published version. */
  view(): Promise<ViewOutcome>
  /** Install `version` globally, streaming npm's progress to the caller's output. */
  install(version: string): Promise<InstallOutcome>
}

/** Everything {@link createNpmPort} needs: the environment, and where progress is written. */
export interface NpmPortOptions {
  readonly env: Record<string, string | undefined>
  /** Where npm's live output goes; nothing is shown when this is absent. */
  readonly progress?: NpmOptions['progress'] | undefined
}

/** The real port: npm over `PATH`, with the install's output watched while it runs. */
export function createNpmPort(options: NpmPortOptions): NpmPort {
  const base: NpmOptions = { env: options.env }
  // Progress is the install's alone: the version lookup's output is its answer, and echoing
  // it would print the version twice — once raw, once in the line below.
  const installing: NpmOptions =
    options.progress === undefined ? base : { ...base, progress: options.progress }

  return {
    async view(): Promise<ViewOutcome> {
      const outcome: NpmOutcome = await viewPublishedVersion(base)
      return outcome.ok
        ? { ok: true, version: outcome.output }
        : { ok: false, detail: outcome.detail }
    },

    async install(version: string): Promise<InstallOutcome> {
      const outcome = await installGlobally(version, installing)
      if (outcome.ok) return { ok: true }
      // `detail` carries npm's own tail, which is where the EACCES the hint is about shows up.
      return {
        ok: false,
        detail: outcome.detail,
        permission: looksLikePermissionError(outcome.detail),
      }
    },
  }
}

/** What `oh update` writes to, and what it needs to decide and act. */
export interface UpdateCommandIo {
  /** One line of output. */
  readonly stdout: (line: string) => void
  /** One line of error output. */
  readonly stderr: (line: string) => void
  /** The running version, compared against the published one. */
  readonly runningVersion: string
  /** Whether this `oh` is a global npm install, from {@link detectGlobalInstall}. */
  readonly isGlobalInstall: boolean
  /** The npm calls, injectable. */
  readonly npm: NpmPort
}

/**
 * Run `oh update` and return its exit code.
 *
 * `0` when the CLI is current or just became current; `1` when npm could not be asked or the
 * install failed; `2` when this `oh` is not a global install, so there is nothing here to
 * update — the same "this command cannot do anything here" answer a chat with no terminal gets.
 */
export async function runUpdate(io: UpdateCommandIo): Promise<number> {
  if (!io.isGlobalInstall) {
    io.stderr('oh: this `oh` is not a global npm install, so it cannot update itself.')
    io.stderr('  install it with `npm i -g @openh/cli` to get self-updates.')
    return 2
  }

  io.stdout('Checking npm for a newer openharness…')
  const view = await io.npm.view()
  if (!view.ok) {
    io.stderr(`oh: could not check for updates: ${view.detail}`)
    return 1
  }

  if (!isNewer(view.version, io.runningVersion)) {
    io.stdout(`oh is up to date (v${io.runningVersion}).`)
    return 0
  }

  io.stdout(`Updating to v${view.version}…`)
  const install = await io.npm.install(view.version)
  if (!install.ok) {
    io.stderr(`oh: could not update itself: ${install.detail}; run npm i -g @openh/cli`)
    if (install.permission) io.stderr(PERMISSION_HINT)
    return 1
  }

  io.stdout(`oh updated to v${view.version}.`)
  return 0
}
