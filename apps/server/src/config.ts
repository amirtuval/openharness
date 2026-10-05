import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { DEFAULT_PARTITION_COUNT } from '@openharness/protocol'
import { DEFAULT_KEY_CACHE_TTL_MS, envKeyProvider, gcpKmsKeyProvider } from '@openharness/vault'

import { DEFAULT_COMPACT_INTERVAL_MS, DEFAULT_DELTA_RETENTION_MS } from './compaction'
import { MOCK_MODEL_ENV_VALUE } from './mock-model'
import { DEFAULT_HEARTBEAT_MS, DEFAULT_LEASE_TTL_MS, DEFAULT_SWEEP_MS } from './partition-scheduler'
import { DEFAULT_DRAIN_TIMEOUT_MS } from './runner'
import { DEFAULT_MAX_CONCURRENT_SESSIONS } from './scheduler'

/**
 * The environment the server is configured by, read in one place.
 *
 * Nothing else in this package touches `process.env`: {@link readServerConfig} turns the
 * environment into a {@link ServerConfig}, and everything downstream takes that value. A test
 * therefore runs against the same code path as production by handing over a config, never by
 * mutating a global.
 *
 * | variable                            | what it does                                                    |
 * | ----------------------------------- | --------------------------------------------------------------- |
 * | `DATABASE_URL`                      | Postgres to run on, migrated on boot; unset means in-memory      |
 * | `SCHEDULER`                         | `local` (default) or `postgres`, the multi-instance scheduler    |
 * | `BETTER_AUTH_SECRET`                | **required**: signs sessions and cookies (epic #65, A2)          |
 * | `BETTER_AUTH_URL`                   | **required**: the public URL; Better Auth's base and the only trusted origin |
 * | `OPENHARNESS_SECRETS_KEY`           | **required** under the default local key provider: the base64 32-byte vault key for provider credentials (A5) |
 * | `OPENHARNESS_KEY_PROVIDER`          | `local` (default) or `gcp-kms`: who wraps the vault's data keys (#150, D6) |
 * | `OPENHARNESS_KMS_KEY`               | **required** when the provider is `gcp-kms`: the Cloud KMS `cryptoKeys/…` key; unused otherwise |
 * | `OPENHARNESS_KEY_CACHE_TTL_MS`      | how long unwrapped data keys stay cached in memory; `300000` (`0` disables) |
 * | `OPENHARNESS_DEV_LOGIN`             | `1` enables the local dev login; localhost public URLs only (A7); with no provider, the only way in |
 * | `GOOGLE_CLIENT_ID`/`_SECRET`        | enable Google sign-in (A1)                                       |
 * | `GITHUB_CLIENT_ID`/`_SECRET`        | enable GitHub sign-in (A1)                                       |
 * | `MICROSOFT_CLIENT_ID`/`_SECRET`     | enable Microsoft sign-in (A1)                                    |
 * | `MICROSOFT_TENANT_ID`               | the Entra tenant; `common` (multi-tenant) by default             |
 * | `PORT`                              | the port to listen on; `3000` by default                         |
 * | `OPENHARNESS_TEST_MODEL`            | `mock` swaps in the deterministic test model (see `mock-model.ts`) |
 * | `OPENHARNESS_WEB_DIR`               | a built web app to serve at `/`                                  |
 * | `OPENHARNESS_TRUSTED_PROXY_HOPS`    | how many proxies append to `x-forwarded-for`; `0` trusts none (#151) |
 * | `OPENHARNESS_CORS_ORIGINS`          | comma-separated origins to allow; unset means no CORS at all     |
 * | `OPENHARNESS_MAX_CONCURRENT_SESSIONS` | how many sessions may run at once; `4` by default               |
 * | `OPENHARNESS_DRAIN_TIMEOUT_MS`      | how long shutdown waits for a turn in flight; `5000` by default  |
 * | `OPENHARNESS_INSTANCE_ID`           | this server's id in the lease table; `host-pid-random` by default |
 * | `OPENHARNESS_PARTITIONS`            | how many partitions the session space has; protocol's `64`       |
 * | `OPENHARNESS_LEASE_TTL_MS`          | how long a partition lease lasts; `30000` by default             |
 * | `OPENHARNESS_HEARTBEAT_MS`          | how often leases are renewed; `10000` by default                 |
 * | `OPENHARNESS_SWEEP_MS`              | how often owned partitions are re-scanned; `60000` by default    |
 * | `OPENHARNESS_DELTA_RETENTION_MS`    | how long superseded chunks are kept before compaction deletes them; `3600000` |
 * | `OPENHARNESS_COMPACT_INTERVAL_MS`   | how often compaction runs; `300000` by default, `0` disables it  |
 *
 * There are **no provider credentials in the environment** any more (epic #65, A5): every
 * model request is made with the session owner's own stored key, and `OPENAI_API_KEY` and
 * friends are not read by anything this server runs.
 *
 * The environment has to carry **a way to sign in**: at least one `*_CLIENT_ID`/`*_SECRET`
 * pair, or `OPENHARNESS_DEV_LOGIN=1` on a localhost URL. A provider is enabled only when both
 * of its variables are set; setting both empty (i.e. unset) hides its button. A server with
 * neither is a boot failure — see {@link readServerConfig}.
 */

/** The environment variable names this package reads. */
export const ENV_VARS = {
  databaseUrl: 'DATABASE_URL',
  scheduler: 'SCHEDULER',
  betterAuthSecret: 'BETTER_AUTH_SECRET',
  betterAuthUrl: 'BETTER_AUTH_URL',
  secretsKey: 'OPENHARNESS_SECRETS_KEY',
  keyProvider: 'OPENHARNESS_KEY_PROVIDER',
  kmsKey: 'OPENHARNESS_KMS_KEY',
  keyCacheTtlMs: 'OPENHARNESS_KEY_CACHE_TTL_MS',
  devLogin: 'OPENHARNESS_DEV_LOGIN',
  googleClientId: 'GOOGLE_CLIENT_ID',
  googleClientSecret: 'GOOGLE_CLIENT_SECRET',
  githubClientId: 'GITHUB_CLIENT_ID',
  githubClientSecret: 'GITHUB_CLIENT_SECRET',
  microsoftClientId: 'MICROSOFT_CLIENT_ID',
  microsoftClientSecret: 'MICROSOFT_CLIENT_SECRET',
  microsoftTenantId: 'MICROSOFT_TENANT_ID',
  port: 'PORT',
  testModel: 'OPENHARNESS_TEST_MODEL',
  webDir: 'OPENHARNESS_WEB_DIR',
  trustedProxyHops: 'OPENHARNESS_TRUSTED_PROXY_HOPS',
  corsOrigins: 'OPENHARNESS_CORS_ORIGINS',
  maxConcurrentSessions: 'OPENHARNESS_MAX_CONCURRENT_SESSIONS',
  drainTimeoutMs: 'OPENHARNESS_DRAIN_TIMEOUT_MS',
  instanceId: 'OPENHARNESS_INSTANCE_ID',
  partitions: 'OPENHARNESS_PARTITIONS',
  leaseTtlMs: 'OPENHARNESS_LEASE_TTL_MS',
  heartbeatMs: 'OPENHARNESS_HEARTBEAT_MS',
  sweepMs: 'OPENHARNESS_SWEEP_MS',
  deltaRetentionMs: 'OPENHARNESS_DELTA_RETENTION_MS',
  compactIntervalMs: 'OPENHARNESS_COMPACT_INTERVAL_MS',
} as const

/** A social provider's configured OAuth client. */
export interface ProviderCredentialsConfig {
  readonly clientId: string
  readonly clientSecret: string
}

/** Everything the server reads from the environment, parsed and checked. */
export interface ServerConfig {
  /** The port to listen on. */
  readonly port: number
  /** The Postgres connection string, or `undefined` for the in-memory store. */
  readonly databaseUrl: string | undefined
  /** Which scheduler runs the brains: this process alone, or partition leases. */
  readonly scheduler: SchedulerKind
  /** `BETTER_AUTH_SECRET`: required, signs cookies and session tokens. */
  readonly betterAuthSecret: string
  /** `BETTER_AUTH_URL`: required, the public URL Better Auth is based at. */
  readonly betterAuthUrl: string
  /** `OPENHARNESS_KEY_PROVIDER`: which key provider wraps the vault's data keys (#150, D6). */
  readonly keyProvider: KeyProviderKind
  /** `OPENHARNESS_SECRETS_KEY`: the base64 32-byte vault master key; required under `local`. */
  readonly secretsKey: string | undefined
  /** `OPENHARNESS_KMS_KEY`: the Cloud KMS key; required when the provider is `gcp-kms`. */
  readonly kmsKey: string | undefined
  /** `OPENHARNESS_KEY_CACHE_TTL_MS`: how long unwrapped data keys stay cached in memory. */
  readonly keyCacheTtlMs: number
  /** `OPENHARNESS_DEV_LOGIN`: the local email/password login, localhost only (A7). */
  readonly devLogin: boolean
  /** Google sign-in, when `GOOGLE_CLIENT_ID` and `_SECRET` are set. */
  readonly google: ProviderCredentialsConfig | undefined
  /** GitHub sign-in, when `GITHUB_CLIENT_ID` and `_SECRET` are set. */
  readonly github: ProviderCredentialsConfig | undefined
  /** Microsoft sign-in, when `MICROSOFT_CLIENT_ID` and `_SECRET` are set. */
  readonly microsoft:
    | (ProviderCredentialsConfig & {
        /** The Entra tenant id; `common` when `MICROSOFT_TENANT_ID` does not say. */
        readonly tenantId: string
      })
    | undefined
  /** The value of `OPENHARNESS_TEST_MODEL`, if any. */
  readonly testModel: string | undefined
  /** A directory of built web assets to serve at `/`. */
  readonly webDir: string | undefined
  /**
   * `OPENHARNESS_TRUSTED_PROXY_HOPS`: how many proxies append to `x-forwarded-for` before
   * this server — `0` (the default) means forwarding headers are not trusted (#151).
   */
  readonly trustedProxyHops: number
  /** Origins allowed to call the API from a browser; empty means no CORS. */
  readonly corsOrigins: readonly string[]
  /** How many sessions may run at once. */
  readonly maxConcurrentSessions: number
  /** How long a shutdown waits for the turns in flight. */
  readonly drainTimeoutMs: number
  /** This instance's id in the lease table; unique among the servers sharing a database. */
  readonly instanceId: string
  /** How many partitions the session space is divided into. */
  readonly partitions: number
  /** How long a partition lease lasts before it has to be renewed. */
  readonly leaseTtlMs: number
  /** How often held leases are renewed and free partitions taken over. */
  readonly heartbeatMs: number
  /** How often owned partitions are re-scanned for work a signal may have missed. */
  readonly sweepMs: number
  /** How long superseded chunks are kept before compaction deletes them. */
  readonly deltaRetentionMs: number
  /** How often the compaction job runs; `0` disables it. */
  readonly compactIntervalMs: number
}

/** Which {@link SessionScheduler} the server runs. */
export type SchedulerKind = 'local' | 'postgres'

/** Which key provider wraps the vault's data keys (#150): the env key, or Cloud KMS. */
export type KeyProviderKind = 'local' | 'gcp-kms'

/** The port a server listens on when `PORT` does not say. */
export const DEFAULT_PORT = 3000

/** The scheduler a server runs when `SCHEDULER` does not say. */
export const DEFAULT_SCHEDULER: SchedulerKind = 'local'

/** The key provider a server uses when `OPENHARNESS_KEY_PROVIDER` does not say. */
export const DEFAULT_KEY_PROVIDER: KeyProviderKind = 'local'

/** The Entra tenant a Microsoft sign-in uses when `MICROSOFT_TENANT_ID` does not say. */
export const DEFAULT_MICROSOFT_TENANT_ID = 'common'

/**
 * How many proxies are trusted to have appended to `x-forwarded-for` when the variable does
 * not say: none (#151). A server that talks to clients directly must not believe a header a
 * client wrote; a deployment behind proxies sets the count it runs.
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0

/**
 * An instance id nobody else is using: this host, this process, and a random suffix.
 *
 * The hostname and the pid make a log line readable; the suffix is what makes two instances
 * on one host unique, which matters because two live instances leasing under one id would
 * fence each other's writes.
 */
export function defaultInstanceId(): string {
  return `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
}

/**
 * Read the server's configuration from an environment.
 *
 * A variable that is set but empty counts as unset: `PORT=` in a shell or a compose file is a
 * variable someone meant to leave alone, not a request to listen on port zero.
 *
 * `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are **required** (epic #65, A2), and so is the
 * key of the vault's key provider (#150, D6): `OPENHARNESS_SECRETS_KEY` under the default
 * `local`, `OPENHARNESS_KMS_KEY` under `gcp-kms` — a key for the other mode is simply not
 * read. Without the first two there is no way to sign anyone in, and without the key no
 * provider credential could ever be stored. A missing one is a boot failure with a message
 * naming the variable, not a server that comes up half-configured.
 *
 * There also has to be a **way to sign in**: at least one social provider (both of its
 * variables set), or the dev login on a localhost URL. With neither, every request would be
 * answered 401 forever, so the boot fails and says how to fix it.
 *
 * @param env the environment; defaults to `process.env`
 * @throws Error when a required variable is missing, when a variable is set to something it
 *   cannot be — a boot failure is much easier to read than a server that came up listening on
 *   `NaN` — when dev login is asked for on a public URL, or when no provider is configured
 *   and dev login is off
 */
export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = readString(env, ENV_VARS.databaseUrl)
  const scheduler = readChoice(env, ENV_VARS.scheduler, ['local', 'postgres'], DEFAULT_SCHEDULER)
  if (scheduler === 'postgres' && databaseUrl === undefined) {
    // Partition leases live in the store, and only the Postgres store has a table to put them
    // in: a server asked to run the multi-instance scheduler without a database is a
    // configuration nobody can mean, so it does not come up.
    throw new Error(
      `${ENV_VARS.scheduler}=postgres requires ${ENV_VARS.databaseUrl} to be set: ` +
        'partition leases are stored in the database',
    )
  }
  const leaseTtlMs = readInteger(env, ENV_VARS.leaseTtlMs, DEFAULT_LEASE_TTL_MS, { min: 1 })
  const heartbeatMs = readInteger(env, ENV_VARS.heartbeatMs, DEFAULT_HEARTBEAT_MS, { min: 1 })
  if (heartbeatMs >= leaseTtlMs) {
    // A heartbeat slower than the lease is a lease that lapses between two renewals.
    throw new Error(
      `${ENV_VARS.heartbeatMs} (${heartbeatMs}) must be smaller than ` +
        `${ENV_VARS.leaseTtlMs} (${leaseTtlMs})`,
    )
  }
  const betterAuthSecret = requireString(env, ENV_VARS.betterAuthSecret)
  const betterAuthUrl = requireString(env, ENV_VARS.betterAuthUrl)
  // The vault's key provider (#150, D6), and the one variable that provider needs. Each is
  // checked here, at boot, with the vault's own validation — so a bad key fails immediately
  // with a message naming the variable (and never echoing a key), instead of at the first
  // credential saved. Constructing the Cloud KMS provider reads no credential and loads no
  // client: that happens on the first wrap or unwrap, which a `local` server never reaches.
  const keyProvider = readChoice(
    env,
    ENV_VARS.keyProvider,
    ['local', 'gcp-kms'] as const,
    DEFAULT_KEY_PROVIDER,
  )
  let secretsKey: string | undefined
  let kmsKey: string | undefined
  if (keyProvider === 'gcp-kms') {
    kmsKey = requireString(env, ENV_VARS.kmsKey)
    gcpKmsKeyProvider({ key: kmsKey })
  } else {
    secretsKey = requireString(env, ENV_VARS.secretsKey)
    envKeyProvider(secretsKey)
  }
  const devLogin = readFlag(env, ENV_VARS.devLogin)
  if (devLogin && !isLocalUrl(betterAuthUrl)) {
    // A7: the dev login is a fixed password on a well-known address. It is for a laptop.
    throw new Error(
      `${ENV_VARS.devLogin} is only allowed when ${ENV_VARS.betterAuthUrl} is a localhost ` +
        `URL (http://localhost… or http://127.0.0.1…), got ${JSON.stringify(betterAuthUrl)}`,
    )
  }
  const google = readProvider(env, ENV_VARS.googleClientId, ENV_VARS.googleClientSecret)
  const github = readProvider(env, ENV_VARS.githubClientId, ENV_VARS.githubClientSecret)
  const microsoft = readMicrosoft(env)
  if (!devLogin && google === undefined && github === undefined && microsoft === undefined) {
    // Every route is behind a session, and a session comes from a sign-in: a server with no
    // provider and no dev login is one nobody can ever sign in to. That is a boot failure,
    // not a server that quietly logs "no social providers configured" and then answers 401
    // to everyone.
    throw new Error(
      'no way to sign in: configure at least one provider (GOOGLE_CLIENT_ID/_SECRET, ' +
        'GITHUB_CLIENT_ID/_SECRET or MICROSOFT_CLIENT_ID/_SECRET), or set ' +
        `${ENV_VARS.devLogin}=1 for local development (localhost only)`,
    )
  }
  return {
    port: readInteger(env, ENV_VARS.port, DEFAULT_PORT, { min: 0, max: 65535 }),
    databaseUrl,
    scheduler,
    betterAuthSecret,
    betterAuthUrl,
    keyProvider,
    secretsKey,
    kmsKey,
    // Zero is meaningful: no cache at all, so every open goes to the key provider.
    keyCacheTtlMs: readInteger(env, ENV_VARS.keyCacheTtlMs, DEFAULT_KEY_CACHE_TTL_MS, { min: 0 }),
    devLogin,
    google,
    github,
    microsoft,
    testModel: readString(env, ENV_VARS.testModel),
    webDir: readString(env, ENV_VARS.webDir),
    // Zero is meaningful — forwarding headers not trusted at all — so the bound is what
    // refuses a negative count, not a falsy check.
    trustedProxyHops: readInteger(env, ENV_VARS.trustedProxyHops, DEFAULT_TRUSTED_PROXY_HOPS, {
      min: 0,
    }),
    corsOrigins: readOrigins(env),
    maxConcurrentSessions: readInteger(
      env,
      ENV_VARS.maxConcurrentSessions,
      DEFAULT_MAX_CONCURRENT_SESSIONS,
      { min: 1 },
    ),
    drainTimeoutMs: readInteger(env, ENV_VARS.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, {
      min: 0,
    }),
    instanceId: readString(env, ENV_VARS.instanceId) ?? defaultInstanceId(),
    partitions: readInteger(env, ENV_VARS.partitions, DEFAULT_PARTITION_COUNT, { min: 1 }),
    leaseTtlMs,
    heartbeatMs,
    sweepMs: readInteger(env, ENV_VARS.sweepMs, DEFAULT_SWEEP_MS, { min: 1 }),
    // Zero is meaningful for both: no retention window at all (delete as soon as the range is
    // superseded), and no compaction job at all.
    deltaRetentionMs: readInteger(env, ENV_VARS.deltaRetentionMs, DEFAULT_DELTA_RETENTION_MS, {
      min: 0,
    }),
    compactIntervalMs: readInteger(env, ENV_VARS.compactIntervalMs, DEFAULT_COMPACT_INTERVAL_MS, {
      min: 0,
    }),
  }
}

/**
 * One line per setting that is not obvious, for the startup log.
 *
 * The mock model is called out here rather than in the model factory, because that is where
 * someone sees it: a server that answers with fixed text is a surprise worth explaining. The
 * sign-in lines say which providers are on and whether the dev login is — the two things a
 * person checking a deployment wants to know.
 */
export function describeConfig(config: ServerConfig): string[] {
  const lines = [`port: ${config.port}`]
  lines.push(
    config.databaseUrl === undefined
      ? 'store: in-memory'
      : 'store: postgres (migrations applied on boot)',
  )
  lines.push(
    config.scheduler === 'postgres'
      ? `scheduler: postgres partitions (instance ${config.instanceId}, ` +
          `${config.partitions} partitions, lease ${config.leaseTtlMs}ms, ` +
          `heartbeat ${config.heartbeatMs}ms, sweep ${config.sweepMs}ms)`
      : 'scheduler: local (this process owns every session)',
  )
  // Which key provider wraps users' credentials (#150): a name, and for Cloud KMS the key's
  // resource name — never the local key's value, which is a secret.
  lines.push(
    config.keyProvider === 'gcp-kms'
      ? `vault keys: Cloud KMS key ${config.kmsKey ?? '(unset)'} (${ENV_VARS.keyProvider}=gcp-kms)`
      : `vault keys: local (${ENV_VARS.secretsKey}; value never printed)`,
  )
  lines.push(`public URL: ${config.betterAuthUrl}`)
  const providers = [
    ...(config.google === undefined ? [] : ['google']),
    ...(config.github === undefined ? [] : ['github']),
    ...(config.microsoft === undefined ? [] : [`microsoft (tenant ${config.microsoft.tenantId})`]),
  ]
  lines.push(
    providers.length === 0
      ? 'sign-in: no social providers configured'
      : `sign-in: ${providers.join(', ')}`,
  )
  lines.push(
    config.devLogin
      ? `dev login: ENABLED (${ENV_VARS.devLogin}=1; localhost only)`
      : 'dev login: off',
  )
  lines.push(
    config.testModel === undefined
      ? 'model: mastra router'
      : `model: TEST MODEL (${ENV_VARS.testModel}=${config.testModel})`,
  )
  lines.push(
    config.compactIntervalMs === 0
      ? 'compaction: disabled'
      : `compaction: every ${config.compactIntervalMs}ms, ` +
          `retaining superseded chunks ${config.deltaRetentionMs}ms`,
  )
  lines.push(config.webDir === undefined ? 'web assets: none' : `web assets: ${config.webDir}`)
  if (config.trustedProxyHops > 0) {
    // Only when it is on: an operating deployment wants to see that the forwarding chain is
    // read, and where in it the client sits (#151).
    lines.push(
      `client IP: x-forwarded-for, entry ${config.trustedProxyHops + 1} from the right ` +
        `(${ENV_VARS.trustedProxyHops}=${config.trustedProxyHops})`,
    )
  }
  if (config.corsOrigins.length > 0) {
    lines.push(`cors: ${config.corsOrigins.join(', ')}`)
  }
  return lines
}

/** A variable's value as a trimmed string, or `undefined` when it is unset or empty. */
function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

/** A variable that has to be set: its value, or a boot failure naming it. */
function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const value = readString(env, name)
  if (value === undefined) {
    throw new Error(`${name} is required: the server cannot start without it. See .env.example.`)
  }
  return value
}

/**
 * A variable's value as an integer, or `fallback` when it is unset.
 */
function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds: { readonly min: number; readonly max?: number },
): number {
  const value = readString(env, name)
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (
    !Number.isInteger(parsed) ||
    parsed < bounds.min ||
    (bounds.max !== undefined && parsed > bounds.max)
  ) {
    const range =
      bounds.max === undefined ? `at least ${bounds.min}` : `${bounds.min}..${bounds.max}`
    throw new Error(`${name} must be an integer ${range}, got ${JSON.stringify(value)}`)
  }
  return parsed
}

/** A variable's value as one of a fixed set, or `fallback` when it is unset or empty. */
function readChoice<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  options: readonly T[],
  fallback: T,
): T {
  const value = readString(env, name)
  if (value === undefined) {
    return fallback
  }
  if (!(options as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${options.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return value as T
}

/** A boolean flag: unset or empty is off, `1`/`true` is on, anything else is a boot failure. */
function readFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = readString(env, name)
  if (value === undefined) {
    return false
  }
  if (value === '1' || value.toLowerCase() === 'true') {
    return true
  }
  throw new Error(`${name} must be 1 or true when it is set, got ${JSON.stringify(value)}`)
}

/**
 * A provider's client id and secret: both, or neither.
 *
 * A provider with only one of the two is a misconfiguration that would otherwise surface as
 * a half-enabled sign-in button, so it fails the boot instead.
 */
function readProvider(
  env: NodeJS.ProcessEnv,
  clientIdVar: string,
  clientSecretVar: string,
): ProviderCredentialsConfig | undefined {
  const clientId = readString(env, clientIdVar)
  const clientSecret = readString(env, clientSecretVar)
  if (clientId === undefined && clientSecret === undefined) {
    return undefined
  }
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      `set both ${clientIdVar} and ${clientSecretVar} to enable the provider, or neither`,
    )
  }
  return { clientId, clientSecret }
}

/** The Microsoft client, which additionally carries the Entra tenant. */
function readMicrosoft(
  env: NodeJS.ProcessEnv,
): (ProviderCredentialsConfig & { readonly tenantId: string }) | undefined {
  const client = readProvider(env, ENV_VARS.microsoftClientId, ENV_VARS.microsoftClientSecret)
  if (client === undefined) {
    return undefined
  }
  return {
    ...client,
    tenantId: readString(env, ENV_VARS.microsoftTenantId) ?? DEFAULT_MICROSOFT_TENANT_ID,
  }
}

/**
 * `OPENHARNESS_CORS_ORIGINS` as a list of origins, comma-separated.
 *
 * Empty entries are dropped, so a trailing comma is not a mistake that turns into an origin
 * nobody can match; a variable that is unset or blank means "no CORS", which is the default.
 */
function readOrigins(env: NodeJS.ProcessEnv): string[] {
  const value = readString(env, ENV_VARS.corsOrigins)
  if (value === undefined) {
    return []
  }
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0)
}

/**
 * Whether a public URL is local — what the dev login is allowed on (A7).
 *
 * `http://localhost…` and `http://127.0.0.1…` are the documented spellings; `https` on the
 * same hosts counts too, because a local reverse proxy is still local, and `[::1]` is the
 * same machine under its IPv6 spelling.
 */
export function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

/** Whether the environment asks for the deterministic test model. */
export function usesTestModel(config: ServerConfig): boolean {
  return config.testModel === MOCK_MODEL_ENV_VALUE
}
