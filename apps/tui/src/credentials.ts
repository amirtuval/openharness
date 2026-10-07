import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { configDirPath } from './config'

/**
 * Where `oh login` keeps the session tokens (epic #65, A2).
 *
 * One token per server URL, so `--server` switches identities, in
 * `$XDG_CONFIG_HOME/openharness/credentials.json` (`~/.config/openharness/credentials.json`
 * by default, the same directory as the config file):
 *
 * ```json
 * { "servers": { "https://app.oharness.dev": "<session token>" } }
 * ```
 *
 * The file is written atomically — a temp file beside it, then a rename — and with
 * permissions `0600`; the directory is created `0700`. A missing file is fine (nobody has
 * signed in yet), but a file that exists and cannot be used is an error naming it, the way
 * the config file is.
 */

/** The file's name under the openharness config directory. */
export const CREDENTIALS_FILE_NAME = 'credentials.json'

/**
 * Where the credentials file lives.
 *
 * @param env the environment the location comes from; defaults to `process.env`
 */
export function credentialsFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(configDirPath(env), CREDENTIALS_FILE_NAME)
}

/**
 * The session tokens, as the rest of the CLI uses them.
 *
 * Every method is synchronous and small: the file is read once when the store is opened, and
 * a write is a read-modify-write of this process's own copy — the CLI is short-lived, and no
 * second process is expected to be editing the file at the same time.
 */
export interface CredentialStore {
  /** The file this store reads and writes, for messages that have to name it. */
  readonly path: string
  /** The token stored for a server URL, or `undefined` when there is none. */
  tokenFor(server: string): string | undefined
  /** Store `token` for `server` — replacing what was there — atomically, with mode `0600`. */
  save(server: string, token: string): void
  /** Forget `server`. A server with no stored token is a no-op. */
  remove(server: string): void
}

/** A store, or the message to print before exiting with code 2. */
export type CredentialsOutcome =
  | { readonly ok: true; readonly store: CredentialStore }
  | { readonly ok: false; readonly error: string }

/** Everything {@link openCredentials} reads, with the seams tests need. */
export interface CredentialsInputs {
  /** The environment the file's location comes from; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Override the file's path; defaults to {@link credentialsFilePath}. */
  readonly path?: string | undefined
}

/**
 * Read the credentials file and hand back the store for it.
 *
 * @param inputs where the file is, and where to read it from
 */
export function openCredentials(inputs: CredentialsInputs = {}): CredentialsOutcome {
  const env = inputs.env ?? process.env
  const path = inputs.path ?? credentialsFilePath(env)

  const read = readCredentialsFile(path)
  if (!read.ok) return { ok: false, error: read.error }
  return { ok: true, store: createStore(path, read.value) }
}

/** The servers map, as the file holds it. */
type ServerTokens = Record<string, string>

type ReadResult =
  | { readonly ok: true; readonly value: ServerTokens }
  | { readonly ok: false; readonly error: string }

/** The real file read: `undefined` when there is no file, a message for anything else. */
function readCredentialsFile(path: string): ReadResult {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { ok: true, value: {} }
    return { ok: false, error: `could not read ${path}: ${detailOf(error)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `invalid JSON in ${path}: ${detailOf(error)}` }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${path} must hold a JSON object like { "servers": { ... } }.` }
  }

  const record = parsed as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => key !== 'servers')
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `${path} has unknown ${unknownKeys.length === 1 ? 'key' : 'keys'} ${unknownKeys
        .map((key) => `'${key}'`)
        .join(', ')}; it takes 'servers'.`,
    }
  }

  const servers = record['servers']
  if (servers === undefined) return { ok: true, value: {} }
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return { ok: false, error: `${path}: 'servers' must be an object of server URL to token.` }
  }

  const value: ServerTokens = {}
  for (const [server, token] of Object.entries(servers)) {
    if (server.trim() === '') {
      return { ok: false, error: `${path}: 'servers' has an empty server URL.` }
    }
    if (typeof token !== 'string') {
      return { ok: false, error: `${path}: the token for '${server}' must be a string.` }
    }
    if (token.trim() === '') {
      return { ok: false, error: `${path}: the token for '${server}' is empty.` }
    }
    value[server] = token
  }
  return { ok: true, value }
}

/** The in-memory map and the file it is written back to. */
function createStore(path: string, servers: ServerTokens): CredentialStore {
  const tokens = new Map(Object.entries(servers))

  return {
    path,

    tokenFor(server) {
      return tokens.get(server)
    },

    save(server, token) {
      if (token.trim() === '') {
        throw new Error(`refusing to store an empty token for ${server}.`)
      }
      tokens.set(server, token)
      writeAtomically(path, serialize(tokens))
    },

    remove(server) {
      if (!tokens.delete(server)) return
      writeAtomically(path, serialize(tokens))
    },
  }
}

/**
 * The file's contents for a set of tokens, sorted by server URL: the order `save` was called
 * in does not leak into a file a person opens.
 */
function serialize(tokens: ReadonlyMap<string, string>): string {
  const sorted = Object.fromEntries([...tokens.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  return `${JSON.stringify({ servers: sorted }, null, 2)}\n`
}

/**
 * Write `contents` to `path` without a window in which the file is missing or half-written:
 * a temp file in the same directory with mode `0600`, then a rename over the target.
 *
 * The directory is created `0700` when it does not exist yet — a home directory that only
 * the user may read — and one that already exists but is more open is tightened the same
 * way: the token inside is worth no more than the directory holding it.
 */
function writeAtomically(path: string, contents: string): void {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    tightenDirectory(directory)
    try {
      const handle = openSync(temporary, 'wx', 0o600)
      try {
        writeSync(handle, contents)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  } catch (error) {
    throw new Error(`could not write ${path}: ${detailOf(error)}`, { cause: error })
  }
}

/** Drop group and other access from `directory`, when it has any: `0700` again. */
function tightenDirectory(directory: string): void {
  if ((statSync(directory).mode & 0o077) !== 0) {
    chmodSync(directory, 0o700)
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
