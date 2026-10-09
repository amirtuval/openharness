import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Everything that runs npm for the auto-update (issue #157, D10; #197), in one place: the
 * lookups (`npm view`, `npm root -g`), the foreground install `oh update` runs, and the
 * detached child the background check leaves behind — which does the whole check itself
 * ({@link updateWrapperSource}).
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

/** What the detached check is told, and where it writes. */
export interface DetachedCheck {
  readonly statePath: string
  readonly logPath: string
  /**
   * The module directory this `oh` runs from ({@link globalModuleDirectory}) — the half of the
   * global-install check the child cannot work out for itself, because the CLI decided it from
   * `process.argv[1]` and a `node -e` program has no bundle to read.
   */
  readonly moduleDirectory: string
  /** The version the bundle that spawned it was built with. */
  readonly runningVersion: string
}

/**
 * The npm side of the auto-update, as one value.
 *
 * The background check and `oh update` take one of these rather than calling npm directly, so
 * their decisions — is it due, where is npm's global root, what gets started — can be tested
 * without a registry, a network or a subprocess.
 */
export interface UpdateRunner {
  /** `npm root -g` — the directory a global install lives in. */
  resolveGlobalRoot(): Promise<NpmOutcome>
  /** Start the detached check-and-install; its pid, or `undefined` when it could not start. */
  startDetachedCheck(check: DetachedCheck): number | undefined
}

/** The real runner: npm over `PATH`, in the environment given. */
export function createUpdateRunner(options: NpmOptions = {}): UpdateRunner {
  return {
    resolveGlobalRoot: () => resolveGlobalRoot(options),
    startDetachedCheck: (check) => spawnDetachedCheck(check, options),
  }
}

/**
 * Start the background check — `npm root -g` if it is not cached, the version lookup, and the
 * install when there is one to make — as a detached, `unref`'d child, and return at once.
 *
 * This is the one thing in the auto-update that outlives the run (D10, #197). A command that
 * prints and stops gives its process back in milliseconds, so anything the check does after
 * that has to happen in a process of its own: a fresh `node`, detached from this one, with its
 * own stdout and stderr on the null device. The whole check travels with it — the lookup, the
 * comparison and, when the published version is newer, the install — and its findings go to
 * the state file and the log, because a detached child has no way to say anything to the run
 * that started it. The next run reads what it left behind and prints the one line.
 *
 * The environment is passed through on purpose: the child runs the npm this CLI was installed
 * with, which is the one on the user's `PATH`.
 *
 * @returns the child's pid — the CLI claims the check under it — or `undefined` when the
 * child could not be started at all.
 */
export function spawnDetachedCheck(
  check: DetachedCheck,
  options: NpmOptions = {},
): number | undefined {
  try {
    const child = spawn(
      process.execPath,
      [
        '-e',
        updateWrapperSource(),
        check.statePath,
        check.logPath,
        check.moduleDirectory,
        check.runningVersion,
      ],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        ...(options.env === undefined ? {} : { env: options.env }),
      },
    )
    // A child that cannot start says so asynchronously; there is nobody left to tell, and the
    // check simply happens again on the next run.
    child.on('error', () => {})
    child.unref()
    return child.pid
  } catch {
    return undefined
  }
}

/**
 * The program `node -e` runs for the background check: look, compare, install, remember.
 *
 * It is a string rather than a module because the CLI is one file: there is nothing beside
 * `dist/index.js` for a detached child to import, so the whole program travels in the `-e`
 * argument. It is written to run as either CommonJS or ESM (`await import()` is fine in
 * both), because the input type of `-e` depends on the package.json nearest the user's
 * working directory.
 *
 * It is spawned with four arguments — the state file, the log file, the module directory this
 * `oh` runs from, and the version it is — see {@link spawnDetachedCheck}. `String.raw` so the
 * regexes below survive as written; nothing inside may use a template literal, or it would be
 * substituted into this one.
 */
export function updateWrapperSource(): string {
  return String.raw`
(async () => {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')

  const [statePath, logPath, moduleDirectory, runningVersion] = process.argv.slice(1)
  const PACKAGE = '@openh/cli'
  // The same two numbers the foreground check uses (DEFAULT_TIMEOUT_MS, CHECK_CLAIM_TTL_MS),
  // repeated because the child has no module to import them from.
  const TIMEOUT_MS = 15000
  const CLAIM_TTL_MS = 300000
  const MAX_CAPTURED = 65536

  const readState = () => {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (typeof state === 'object' && state !== null && !Array.isArray(state)) return state
    } catch {
      // A missing or unreadable state file is an empty one.
    }
    return {}
  }

  // Read-modify-write, as the CLI does it: both processes keep things in this file, and
  // neither may erase what the other put there. A field set to undefined is removed.
  const patchState = (fields) => {
    const state = readState()
    for (const key of Object.keys(fields)) {
      if (fields[key] === undefined) delete state[key]
      else state[key] = fields[key]
    }
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      const temporary = statePath + '.' + process.pid + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n')
      fs.renameSync(temporary, statePath)
    } catch {
      // Nothing to be done from here: the next run just has nothing to report.
    }
  }

  const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code !== 'ESRCH'
    }
  }

  // Is another check running? Two oh started together must not both install the same version.
  // The CLI claims the check under this process's pid just before spawning it, so a claim that
  // names us is ours; one that names a process that has since gone is stale, and looking again
  // is exactly what should happen then.
  const claimedElsewhere = () => {
    const claim = readState().checking
    if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) return false
    if (typeof claim.at !== 'string' || typeof claim.pid !== 'number') return false
    if (claim.pid === process.pid) return false
    const at = Date.parse(claim.at)
    if (Number.isNaN(at) || Date.now() - at >= CLAIM_TTL_MS) return false
    return alive(claim.pid)
  }

  if (claimedElsewhere()) return

  const firstLine = (text) => {
    const line = text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '')
    return line === undefined ? '' : line
  }

  // npm, with its output captured and a timeout, the way the CLI used to run it: the output is
  // the answer, and a hung npm must not hold the claim — and so the next hour's checks — open.
  const runNpm = (args) =>
    new Promise((resolve) => {
      let child
      try {
        child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
          windowsHide: true,
        })
      } catch {
        resolve({ ok: false, output: '' })
        return
      }

      let done = false
      let timer
      const settle = (result) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(result)
      }

      let output = ''
      child.stdout?.on('data', (chunk) => {
        if (output.length < MAX_CAPTURED) output += chunk
      })

      child.on('error', () => settle({ ok: false, output: '' }))
      child.on('close', (code) => settle({ ok: code === 0, output: output }))

      timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle({ ok: false, output: '' })
      }, TIMEOUT_MS)
    })

  // A check that is over, however it ended, holds nothing.
  const release = (patch) => patchState(Object.assign({ checking: undefined }, patch))

  // npm root -g, cached beside the node that answered it, exactly as the CLI caches it: an
  // nvm use changes both.
  const globalRoot = async () => {
    const state = readState()
    if (
      typeof state.globalRoot === 'string' &&
      state.globalRoot !== '' &&
      state.globalRootNode === process.execPath
    ) {
      return state.globalRoot
    }
    const outcome = await runNpm(['root', '-g'])
    if (!outcome.ok) return undefined
    const root = firstLine(outcome.output)
    if (root === '') return undefined
    patchState({ globalRoot: root, globalRootNode: process.execPath })
    return root
  }

  const realpath = (value) => {
    try {
      return fs.realpathSync(value)
    } catch {
      return path.normalize(value)
    }
  }

  // The other half of the CLI's global-install check: the module directory this oh runs from
  // has to be the one npm names. Windows paths compare case-insensitively.
  const isThisInstall = (root) => {
    const mine = realpath(moduleDirectory)
    const theirs = realpath(root)
    return process.platform === 'win32'
      ? mine.toLowerCase() === theirs.toLowerCase()
      : mine === theirs
  }

  // The newest published version wins, semver-style. This mirrors src/update/semver.ts: the
  // CLI is one self-contained file, so a detached child has no comparator to import, and the
  // copy is what makes "is there an update" answerable here at all. npm.test.ts drives it
  // through this wrapper over the same version pairs semver.test.ts asserts on, so the two
  // cannot drift apart without a test failing.
  const parseVersion = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      String(value).trim(),
    )
    if (match === null) return undefined
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease:
        match[4] === undefined
          ? []
          : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
    }
  }

  const compareIdentifiers = (left, right) => {
    // A numeric identifier ranks below an alphanumeric one (semver 11.4.1).
    if (typeof left === 'number' && typeof right === 'number') {
      return left === right ? 0 : left < right ? -1 : 1
    }
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return left === right ? 0 : left < right ? -1 : 1
  }

  const isNewer = (candidate, current) => {
    const published = parseVersion(candidate)
    const running = parseVersion(current)
    if (published === undefined || running === undefined) return false

    for (let index = 0; index < 3; index += 1) {
      if (published.numbers[index] !== running.numbers[index]) {
        return published.numbers[index] > running.numbers[index]
      }
    }
    if (published.prerelease.length === 0 || running.prerelease.length === 0) {
      return published.prerelease.length === 0 && running.prerelease.length !== 0
    }
    const shared = Math.min(published.prerelease.length, running.prerelease.length)
    for (let index = 0; index < shared; index += 1) {
      const compared = compareIdentifiers(published.prerelease[index], running.prerelease[index])
      if (compared !== 0) return compared > 0
    }
    return published.prerelease.length > running.prerelease.length
  }

  /** The last few non-empty lines of the install log, flattened onto one line. */
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

  const root = await globalRoot()
  if (root === undefined || !isThisInstall(root)) {
    release({})
    return
  }

  const view = await runNpm(['view', PACKAGE, 'version'])
  if (!view.ok) {
    // No answer, no hour spent: the next run asks again rather than waiting one out.
    release({})
    return
  }

  const published = firstLine(view.output)
  // The lookup answered, so this hour has been checked — whether or not there is an update.
  release({ lastCheck: new Date().toISOString() })

  if (!isNewer(published, runningVersion)) return

  const record = (result) => {
    patchState({
      result: Object.assign({ at: new Date().toISOString(), version: published }, result),
    })
  }

  // The install: redirected to the log file, and its outcome recorded for the next run.
  let log = 'ignore'
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    log = fs.openSync(logPath, 'w')
  } catch {
    log = 'ignore'
  }

  let child
  try {
    child = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '-g', PACKAGE + '@' + published],
      {
        stdio: ['ignore', log, log],
        shell: process.platform === 'win32',
        windowsHide: true,
      },
    )
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
