import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Where the server lives when nothing says otherwise. */
export const DEFAULT_SERVER_URL = 'http://localhost:3000'

/** The environment variable holding the server root. */
export const ENV_SERVER_URL = 'OPENHARNESS_URL'

/** The environment variable holding the API key. */
export const ENV_API_KEY = 'OPENHARNESS_API_KEY'

/** Where each setting came from, for `--debug`. */
export type ConfigSource = 'flag' | 'env' | 'file' | 'default' | 'unset'

/** The settings a client needs, and where each one came from. */
export interface ResolvedConfig {
  /** Server root, without a trailing slash. */
  readonly server: string
  /** API key, or `undefined` when the server needs no auth. */
  readonly apiKey: string | undefined
  /** One line per setting, for `--debug`. */
  readonly sources: {
    readonly server: ConfigSource
    readonly apiKey: ConfigSource
  }
}

/** Everything {@link resolveConfig} reads, with the seams tests need. */
export interface ConfigInputs {
  /** The parsed `--server` / `--api-key` flags. */
  readonly flags?:
    { readonly server?: string | undefined; readonly apiKey?: string | undefined } | undefined
  /** The process environment; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Read the config file, or return `undefined` when there is none. */
  readonly readFile?: ((path: string) => string | undefined) | undefined
  /** Override the config file's path; defaults to {@link configFilePath}. */
  readonly path?: string | undefined
}

/** A resolved configuration, or the message to print before exiting with code 2. */
export type ConfigOutcome =
  | { readonly ok: true; readonly config: ResolvedConfig }
  | { readonly ok: false; readonly error: string }

/**
 * Where the config file lives: `$XDG_CONFIG_HOME/openharness/config.json`, falling back to
 * `~/.config/openharness/config.json`.
 *
 * An `XDG_CONFIG_HOME` that is not absolute is ignored the way the XDG spec asks, so a
 * relative value cannot quietly put the config in the working directory.
 */
export function configFilePath(env: Record<string, string | undefined> = process.env): string {
  const xdg = env['XDG_CONFIG_HOME']?.trim()
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
  return join(base, 'openharness', 'config.json')
}

/**
 * The precedence, highest first: flags, then `OPENHARNESS_URL` / `OPENHARNESS_API_KEY`, then
 * the config file, then the default `http://localhost:3000`. The API key has no default.
 *
 * A missing config file is fine — the CLI runs against a local server out of the box — but a
 * file that exists and cannot be used is an error, reported with its path.
 */
export function resolveConfig(inputs: ConfigInputs = {}): ConfigOutcome {
  const env = inputs.env ?? process.env
  const path = inputs.path ?? configFilePath(env)

  const file = readConfigFile(path, inputs.readFile ?? defaultRead)
  if (!file.ok) return { ok: false, error: file.error }

  const server = firstDefined([
    ['flag', inputs.flags?.server],
    ['env', env[ENV_SERVER_URL]],
    ['file', file.value.server],
    ['default', DEFAULT_SERVER_URL],
  ])
  const apiKey = firstDefined([
    ['flag', inputs.flags?.apiKey],
    ['env', env[ENV_API_KEY]],
    ['file', file.value.apiKey],
  ])

  const normalized = normalizeServerUrl(server.value, server.source)
  if (!normalized.ok) return normalized

  return {
    ok: true,
    config: {
      server: normalized.value,
      apiKey: apiKey.value,
      sources: { server: server.source, apiKey: apiKey.source },
    },
  }
}

/** The settings the config file may hold. */
interface FileConfig {
  readonly server?: string | undefined
  readonly apiKey?: string | undefined
}

const FILE_KEYS = ['server', 'apiKey'] as const

type ReadResult =
  { readonly ok: true; readonly value: FileConfig } | { readonly ok: false; readonly error: string }

/**
 * The real file read: `undefined` when there is no file, and a throw for anything else —
 * a directory in the way, a permission problem — which {@link readConfigFile} turns into
 * a message naming the path.
 */
function defaultRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

function readConfigFile(path: string, read: (path: string) => string | undefined): ReadResult {
  let raw: string | undefined
  try {
    raw = read(path)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `could not read ${path}: ${detail}` }
  }

  if (raw === undefined) return { ok: true, value: {} }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `invalid JSON in ${path}: ${detail}` }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `${path} must hold a JSON object like { "server": "..." }.` }
  }

  const record = parsed as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter(
    (key) => !(FILE_KEYS as readonly string[]).includes(key),
  )
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `${path} has unknown ${unknownKeys.length === 1 ? 'key' : 'keys'} ${unknownKeys
        .map((key) => `'${key}'`)
        .join(', ')}; it takes ${FILE_KEYS.map((key) => `'${key}'`).join(' and ')}.`,
    }
  }

  const value: { server?: string; apiKey?: string } = {}
  for (const key of FILE_KEYS) {
    const entry = record[key]
    if (entry === undefined) continue
    if (typeof entry !== 'string') {
      return { ok: false, error: `${path}: '${key}' must be a string.` }
    }
    if (entry.trim() === '') {
      return { ok: false, error: `${path}: '${key}' is empty.` }
    }
    value[key] = entry.trim()
  }

  return { ok: true, value }
}

/** The first defined value among the sources, and which source it was. */
function firstDefined(candidates: readonly (readonly [ConfigSource, string | undefined])[]): {
  readonly value: string | undefined
  readonly source: ConfigSource
} {
  for (const [source, value] of candidates) {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed !== '') return { value: trimmed, source }
  }
  return { value: undefined, source: 'unset' }
}

type UrlResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string }

/** Reject what `fetch` would reject confusingly — a bare host, a protocol typo — early. */
function normalizeServerUrl(value: string | undefined, source: ConfigSource): UrlResult {
  if (value === undefined) {
    // Only reachable when a caller hands in an empty candidate list; the default covers it.
    return { ok: false, error: 'no server URL: pass --server <url>.' }
  }

  if (!/^https?:\/\//iu.test(value)) {
    return {
      ok: false,
      error: `the server URL ${describeSource(source)} is '${value}', which is not a URL. Expected something like http://localhost:3000.`,
    }
  }

  try {
    new URL(value)
  } catch {
    return {
      ok: false,
      error: `the server URL ${describeSource(source)} is '${value}', which could not be parsed.`,
    }
  }

  // A trailing slash is ignored by the client either way, but normalizing here keeps the
  // status output and the resume hint identical for `--server http://x` and `--server http://x/`.
  return { ok: true, value: value.replace(/\/+$/u, '') }
}

function describeSource(source: ConfigSource): string {
  switch (source) {
    case 'flag':
      return '(--server)'
    case 'env':
      return `(${ENV_SERVER_URL})`
    case 'file':
      return 'in the config file'
    default:
      return source
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
