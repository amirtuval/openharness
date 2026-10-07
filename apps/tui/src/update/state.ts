import { randomBytes } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { configDirPath } from '../config'

/**
 * The auto-update's memory (issue #157, D10): when the last check ran, where npm's global
 * `node_modules` turned out to be, and how the last install ended.
 *
 * It lives beside the config and credentials files — `$XDG_CONFIG_HOME/openharness/`
 * (`~/.config/openharness/`), the same {@link configDirPath} they follow, so one
 * `XDG_CONFIG_HOME` moves the CLI's whole footprint at once.
 *
 * Every read here is forgiving and every write is best-effort. This file is a cache, not a
 * setting: a missing, empty, truncated or hand-mangled one must leave `oh` completely
 * unaffected, and must never be the reason a command exits non-zero. The detached installer
 * writes the same file (see `npm.ts`), so the format is shared by hand across the process
 * boundary — the `result` object below is what the `node -e` wrapper reconstructs.
 */

/** The state file's name under the openharness config directory. */
export const UPDATE_STATE_FILE_NAME = 'update-state.json'

/** The log the detached installer's npm output is redirected to, in the same directory. */
export const UPDATE_LOG_FILE_NAME = 'update.log'

/** Where the state file lives. */
export function updateStatePath(env: Record<string, string | undefined> = process.env): string {
  return join(configDirPath(env), UPDATE_STATE_FILE_NAME)
}

/** Where the installer's log lives. */
export function updateLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(configDirPath(env), UPDATE_LOG_FILE_NAME)
}

/** How the last install ended, as the detached child left it behind to be printed once. */
export interface UpdateResult {
  readonly status: 'success' | 'failure'
  /** The version that was being installed. */
  readonly version: string
  /** Why it failed: npm's exit code and the tail of its output. */
  readonly reason?: string
  /** npm could not write to its global prefix, which is worth a sudo/prefix hint. */
  readonly permission?: boolean
  /** When the install ended, ISO 8601. */
  readonly at: string
}

/**
 * A check that is under way, as the run that started it left it behind (#197).
 *
 * The background check is a detached child, so nothing stops a second `oh` from starting a
 * second one while the first is still asking npm — and two checks that both see a newer
 * version both install it. The marker is how one of them stands down: the claim says when it
 * was made and which process holds it, and a claim whose process is gone is stale, so a check
 * that was killed does not keep the next run from trying.
 */
export interface UpdateCheck {
  /** When the check was claimed, ISO 8601. */
  readonly at: string
  /** The process holding it — the detached child. An absent pid is a stale claim. */
  readonly pid?: number
}

/** What the state file holds. Every field is optional: any of it may be missing. */
export interface UpdateState {
  /** When the last background check ran, ISO 8601. */
  readonly lastCheck?: string
  /** The check that is claimed right now, if any (#197). */
  readonly checking?: UpdateCheck
  /**
   * `npm root -g`'s answer — the directory `npm i -g` installs into — cached so the
   * global-install check does not have to spawn npm on every startup.
   */
  readonly globalRoot?: string
  /** `process.execPath` when {@link globalRoot} was resolved: a node switch re-resolves it. */
  readonly globalRootNode?: string
  /** The install outcome waiting to be reported, once, on the next run. */
  readonly result?: UpdateResult
}

/** The mutable shape {@link readUpdateState} builds up before returning it read-only. */
interface MutableState {
  lastCheck?: string
  checking?: UpdateCheck
  globalRoot?: string
  globalRootNode?: string
  result?: UpdateResult
}

/**
 * Read the state file, answering `{}` for anything that is not a usable one.
 *
 * A file that is missing, unreadable, not JSON, not an object, or holds fields of the wrong
 * type is all the same thing here — nothing to remember — because the file is the CLI's own
 * scratch space and a bad one is never the user's problem.
 */
export function readUpdateState(path: string): UpdateState {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

  const record = parsed as Record<string, unknown>
  const state: MutableState = {}

  const lastCheck = stringField(record, 'lastCheck')
  if (lastCheck !== undefined) state.lastCheck = lastCheck
  const checking = parseCheck(record['checking'])
  if (checking !== undefined) state.checking = checking
  const globalRoot = stringField(record, 'globalRoot')
  if (globalRoot !== undefined) state.globalRoot = globalRoot
  const globalRootNode = stringField(record, 'globalRootNode')
  if (globalRootNode !== undefined) state.globalRootNode = globalRootNode

  const result = parseResult(record['result'])
  if (result !== undefined) state.result = result

  return state
}

/**
 * Write the state file, best-effort: `true` when it landed, `false` when it did not.
 *
 * The write is atomic — a temp file beside it, then a rename — because the detached installer
 * and the running CLI can both touch this file, and a half-written state would be read as
 * "nothing to remember" at best. A write that fails is not raised: nothing `oh` does depends
 * on this file having been written.
 */
export function writeUpdateState(path: string, state: UpdateState): boolean {
  // A stable field order, so the file a person opens does not depend on which process wrote it.
  const contents = `${JSON.stringify(
    {
      lastCheck: state.lastCheck,
      checking: state.checking,
      globalRoot: state.globalRoot,
      globalRootNode: state.globalRootNode,
      result: state.result,
    },
    undefined,
    2,
  )}\n`

  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)

  try {
    mkdirSync(directory, { recursive: true })
    try {
      const handle = openSync(temporary, 'wx', 0o600)
      try {
        writeSync(handle, contents)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, path)
      return true
    } catch {
      rmSync(temporary, { force: true })
      return false
    }
  } catch {
    return false
  }
}

/**
 * Read the state, merge `patch` into it, and write it back.
 *
 * @returns the state as written — `patch` applied to whatever was on disk.
 */
export function patchUpdateState(path: string, patch: Partial<UpdateState>): UpdateState {
  const next = { ...readUpdateState(path), ...patch }
  writeUpdateState(path, next)
  return next
}

/**
 * Take the pending install outcome, leaving the state without it.
 *
 * Reading and clearing in one call is what makes the notice once-only: the caller prints what
 * it got back, and the next run finds nothing to print. A state file that cannot be
 * rewritten still hands the result over — one repeated line is a better failure than a
 * silently dropped one.
 */
export function consumeUpdateResult(path: string): UpdateResult | undefined {
  const state = readUpdateState(path)
  if (state.result === undefined) return undefined
  const { result, ...rest } = state
  writeUpdateState(path, rest)
  return result
}

/** A field that is a non-empty string, or `undefined`. */
function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * The `checking` field, when it says enough to act on: a claim has to name *when* it was made
 * before anything can decide whether it is stale. The pid is optional — a claim without one is
 * read, and treated as stale, rather than as a mangled file.
 */
function parseCheck(value: unknown): UpdateCheck | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>

  const at = stringField(record, 'at')
  if (at === undefined) return undefined
  const pid = record['pid']
  return { at, ...(typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}) }
}

/** The `result` field, when it has everything a notice needs. */
function parseResult(value: unknown): UpdateResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>

  const status = record['status']
  if (status !== 'success' && status !== 'failure') return undefined
  const version = stringField(record, 'version')
  if (version === undefined) return undefined
  const at = stringField(record, 'at')
  if (at === undefined) return undefined

  const reason = stringField(record, 'reason')
  return {
    status,
    version,
    at,
    ...(reason === undefined ? {} : { reason }),
    ...(record['permission'] === true ? { permission: true } : {}),
  }
}
