import { spawn, type ChildProcess } from 'node:child_process'
import type { Socket } from 'node:net'

/**
 * Everything that runs npm for the auto-update (issue #157, D10), in one place: the checks
 * (`npm view`, `npm root -g`), the foreground install `oh update` runs, and the detached
 * install the background check leaves behind.
 *
 * The CLI never speaks to the npm *registry* itself — it does not have an HTTP client, and
 * D10 hands the whole thing to the tool the user installed it with — so npm is the only thing
 * spawned here, and only ever as an argument list (never a shell string): versions come from
 * npm's own output, and a shell would make that output executable.
 */

/** This package's published name — the scoped `@openh/cli` (#194, #152). */
const PACKAGE_NAME = '@openh/cli'

/**
 * How long a check may take before it is killed. The checks are background work with nothing
 * waiting on them, but a hung npm would hold a socket open for the rest of the run.
 */
const DEFAULT_TIMEOUT_MS = 15_000

/** How much of a command's output is kept: enough for a reason, not the whole install log. */
const MAX_CAPTURED_CHARS = 64 * 1024

/** How an npm run ended, in the shape the callers actually need. */
export interface NpmOutcome {
  readonly ok: boolean
  /** stdout, trimmed — the version from `view`, the directory from `root -g`. */
  readonly output: string
  /** One line saying why it failed: the exit code or signal, and npm's own tail. */
  readonly detail: string
}

/** Where a run reads its environment from, and how long it may take. */
export interface NpmOptions {
  /** The environment for the child; defaults to the process's own. */
  readonly env?: Record<string, string | undefined> | undefined
  /** The platform choosing the command; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined
  /** Milliseconds before the child is killed; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined
  /**
   * Forward the child's output as it arrives as well as capturing it — npm's own progress,
   * which is what `oh update` promises. Nothing is forwarded when this is absent.
   */
  readonly progress?: NpmOutput | undefined
  /**
   * Run without holding the process open: the child, its pipes and the timeout are all
   * `unref`'d, so a command that has already finished does not linger for a background
   * lookup. The background check sets this; `oh update` does not, because it is waiting.
   *
   * `child.unref()` alone is not enough. A spawned child's pipes are handles of their own, and
   * with a `'data'` listener attached they keep the event loop alive until the child's output
   * ends — a second of npm before the shell prompt comes back, for a lookup nobody asked for.
   */
  readonly unref?: boolean | undefined
}

/** Where a run's live output goes when the caller wants to watch it. */
export interface NpmOutput {
  readonly stdout: (chunk: string) => void
  readonly stderr: (chunk: string) => void
}

/**
 * The npm command for a platform, and whether it needs a shell.
 *
 * Windows' npm is a `npm.cmd` batch file, which `CreateProcess` will not start directly — the
 * shell is what makes the detached install work there instead of failing with the `EINVAL`
 * Node raises for a `.cmd` without one.
 */
export function npmCommandFor(platform: NodeJS.Platform = process.platform): {
  readonly command: string
  readonly shell: boolean
} {
  return platform === 'win32'
    ? { command: 'npm.cmd', shell: true }
    : { command: 'npm', shell: false }
}

/** The published version, or a failure: `npm view @openh/cli version`. */
export async function viewPublishedVersion(options: NpmOptions = {}): Promise<NpmOutcome> {
  const outcome = await runNpm(['view', PACKAGE_NAME, 'version'], options)
  return outcome.ok ? { ...outcome, output: firstLine(outcome.output) } : outcome
}

/** npm's global module directory, or a failure: `npm root -g`. */
export async function resolveGlobalRoot(options: NpmOptions = {}): Promise<NpmOutcome> {
  const outcome = await runNpm(['root', '-g'], options)
  return outcome.ok ? { ...outcome, output: firstLine(outcome.output) } : outcome
}

/** `npm install -g @openh/cli@<version>`, captured — the foreground `oh update` streams it. */
export async function installGlobally(
  version: string,
  options: NpmOptions = {},
): Promise<NpmOutcome> {
  return await runNpm(['install', '-g', `${PACKAGE_NAME}@${version}`], options)
}

/**
 * Does npm's output say it could not write to its global prefix?
 *
 * The auto-update's one actionable failure: a global prefix under `/usr` that a user cannot
 * write to. It is worth its own hint — sudo, or a prefix of their own — because retrying the
 * same command will fail the same way.
 */
export function looksLikePermissionError(text: string): boolean {
  return /EACCES|EPERM|permission denied|not permitted|access is denied/iu.test(text)
}

/**
 * The one hint that makes a permission failure actionable.
 *
 * Both the background notice and `oh update` print it, because in both cases the command the
 * message repeats — `npm i -g @openh/cli` — would fail the same way, and neither sudo nor a
 * prefix of one's own is obvious from the error npm prints.
 */
export const PERMISSION_HINT =
  '  npm could not write to its global prefix. Retry with sudo, or point npm at a prefix you ' +
  'own: npm config set prefix ~/.npm-global'

/**
 * Run npm with its output captured, resolving once it has ended (or been killed).
 *
 * `spawn` without a shell resolves `npm` on `PATH`, which is where it has to be: it is the
 * npm that installed this CLI. A child that cannot be started at all (no npm on `PATH`) comes
 * back as a failure with the reason, never a throw.
 */
async function runNpm(args: readonly string[], options: NpmOptions = {}): Promise<NpmOutcome> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { command, shell } = npmCommandFor(platform)

  const progress = options.progress

  return await new Promise<NpmOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        env,
        shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, output: '', detail: `could not run npm: ${messageOf(error)}` })
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURED_CHARS) stdout += chunk
      progress?.stdout(chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURED_CHARS) stderr += chunk
      progress?.stderr(chunk)
    })

    // The timeout answers on the spot rather than waiting for the killed child to be reaped:
    // killing npm does not necessarily kill what npm started, and none of that should hold a
    // background check open.
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
      resolve({
        ok: false,
        output: '',
        detail: `npm did not answer within ${Math.round(timeoutMs / 1000)}s`,
      })
    }, timeoutMs)

    if (options.unref === true) {
      // After the listeners, so the pipes are the ones that would have held the loop open.
      timer.unref()
      child.unref()
      const pipes: readonly (Socket | null)[] = [
        child.stdout as Socket | null,
        child.stderr as Socket | null,
      ]
      for (const pipe of pipes) pipe?.unref()
    }

    child.on('error', (error) => {
      clearTimeout(timer)
      if (timedOut) return
      resolve({ ok: false, output: '', detail: `could not run npm: ${messageOf(error)}` })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) return
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim(), detail: '' })
        return
      }
      resolve({ ok: false, output: '', detail: failureDetail(code, signal, stderr) })
    })
  })
}

/** The one line a failed npm run leaves behind. */
function failureDetail(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const tail = tailOf(stderr)
  const ended =
    code === null
      ? `npm was killed (${signal ?? 'unknown signal'})`
      : `npm exited with code ${code}`
  return tail === '' ? ended : `${ended}: ${tail}`
}

/**
 * The last few non-empty lines of some output, flattened into one line.
 *
 * npm's errors are several lines of `npm error ...`; the useful part is the end, and the
 * notice that carries it to the user is a single line.
 */
export function tailOf(text: string, limit = 300): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.slice(-3).join(' ').replace(/\s+/gu, ' ').slice(0, limit).trim()
}

/** The first non-empty line of a command's output. */
function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  return line ?? ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Where the detached installer keeps its two files. */
export interface DetachedInstallPaths {
  readonly statePath: string
  readonly logPath: string
}

/**
 * The npm side of the auto-update, as one value.
 *
 * The background check and `oh update` take one of these rather than calling npm directly, so
 * their decisions — is it due, is it newer, what gets started — can be tested without a
 * registry, a network or a subprocess.
 */
export interface UpdateRunner {
  /** `npm root -g` — the directory a global install lives in. */
  resolveGlobalRoot(): Promise<NpmOutcome>
  /** `npm view @openh/cli version` — the published version. */
  viewPublishedVersion(): Promise<NpmOutcome>
  /** Start the detached install; `true` when the child was started. */
  startDetachedInstall(version: string, paths: DetachedInstallPaths): boolean
}

/** The real runner: npm over `PATH`, in the environment given. */
export function createUpdateRunner(options: NpmOptions = {}): UpdateRunner {
  return {
    resolveGlobalRoot: () => resolveGlobalRoot(options),
    viewPublishedVersion: () => viewPublishedVersion(options),
    startDetachedInstall: (version, paths) => spawnDetachedInstall(version, paths, options),
  }
}

/**
 * Start `npm install -g @openh/cli@<version>` in the background, detached, and return at
 * once.
 *
 * The install is the one thing in the auto-update that outlives the run: it is a fresh node
 * process, detached from this one and `unref`'d, so `oh` can exit or stay in a chat while it
 * runs. Its output goes to a log file and its outcome to the state file, because a detached
 * child has no way to say anything to the run that started it — the next run reads what it
 * left behind and prints the one line.
 *
 * @returns whether the child was started.
 */
export function spawnDetachedInstall(
  version: string,
  paths: DetachedInstallPaths,
  options: NpmOptions = {},
): boolean {
  try {
    const child = spawn(
      process.execPath,
      ['-e', installWrapperSource(), paths.statePath, version, paths.logPath],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...(options.env === undefined ? {} : { env: options.env }),
      },
    )
    // A child that cannot start says so asynchronously; there is nobody left to tell, and the
    // state file simply keeps the outcome it had.
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * The program `node -e` runs for the detached install: install, then record what happened.
 *
 * It is a string rather than a module because the CLI is one file: there is nothing beside
 * `dist/index.js` for a detached child to import, so the whole program travels in the `-e`
 * argument. It is written to run as either CommonJS or ESM (`await import()` is fine in
 * both), because the input type of `-e` depends on the package.json nearest the user's
 * working directory.
 *
 * It is spawned with three arguments: the state file, the version to install, and the log
 * file — see {@link spawnDetachedInstall}. `String.raw` so the regexes below survive as
 * written.
 */
export function installWrapperSource(): string {
  return String.raw`
(async () => {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')

  const [statePath, version, logPath] = process.argv.slice(1)
  const spec = '@openh/cli@' + version

  // Read-modify-write: the CLI wrote lastCheck into this file just before spawning us, and
  // it must survive. A file that cannot be parsed starts over — reporting the install matters
  // more than the timestamp.
  const record = (result) => {
    let state = {}
    try {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    } catch {
      state = {}
    }
    if (typeof state !== 'object' || state === null || Array.isArray(state)) state = {}
    state.result = Object.assign({ at: new Date().toISOString(), version: version }, result)
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      const temporary = statePath + '.' + process.pid + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n')
      fs.renameSync(temporary, statePath)
    } catch {
      // Nothing to be done from here: the next run just has nothing to report.
    }
  }

  const tail = () => {
    try {
      const lines = fs
        .readFileSync(logPath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
      return lines.slice(-3).join(' ').replace(/\s+/g, ' ').slice(0, 300).trim()
    } catch {
      return ''
    }
  }

  let log = 'ignore'
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    log = fs.openSync(logPath, 'w')
  } catch {
    log = 'ignore'
  }

  let child
  try {
    child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', spec], {
      stdio: ['ignore', log, log],
      shell: process.platform === 'win32',
      windowsHide: true,
    })
  } catch (error) {
    record({ status: 'failure', reason: 'could not run npm: ' + error.message })
    return
  }

  let finished = false
  const finish = (result) => {
    if (finished) return
    finished = true
    record(result)
  }

  child.on('error', (error) => {
    finish({ status: 'failure', reason: 'could not run npm: ' + error.message })
  })

  child.on('exit', (code) => {
    if (code === 0) {
      finish({ status: 'success' })
      return
    }
    const detail = tail()
    finish({
      status: 'failure',
      reason: 'npm exited with code ' + code + (detail === '' ? '' : ': ' + detail),
      permission: /EACCES|EPERM|permission denied|not permitted|access is denied/i.test(detail),
    })
  })
})()
`
}
