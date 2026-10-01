import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

import { DEFAULT_PARTITION_COUNT } from '@openharness/protocol'

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
 * | `OPENHARNESS_API_KEY`               | require `x-api-key` on `/v1/*`; unset leaves the API open        |
 * | `PORT`                              | the port to listen on; `3000` by default                         |
 * | `OPENHARNESS_TEST_MODEL`            | `mock` swaps in the deterministic test model (see `mock-model.ts`) |
 * | `OPENHARNESS_WEB_DIR`               | a built web app to serve at `/`                                  |
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
 * Provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are not read here: the
 * default model factory is Mastra's router, which reads whatever the provider it routes to
 * needs from the environment itself.
 */

/** The environment variable names this package reads. */
export const ENV_VARS = {
  databaseUrl: 'DATABASE_URL',
  scheduler: 'SCHEDULER',
  apiKey: 'OPENHARNESS_API_KEY',
  port: 'PORT',
  testModel: 'OPENHARNESS_TEST_MODEL',
  webDir: 'OPENHARNESS_WEB_DIR',
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

/** Everything the server reads from the environment, parsed and checked. */
export interface ServerConfig {
  /** The port to listen on. */
  readonly port: number
  /** The Postgres connection string, or `undefined` for the in-memory store. */
  readonly databaseUrl: string | undefined
  /** Which scheduler runs the brains: this process alone, or partition leases. */
  readonly scheduler: SchedulerKind
  /** The API key `/v1/*` requires, or `undefined` for an open API. */
  readonly apiKey: string | undefined
  /** The value of `OPENHARNESS_TEST_MODEL`, if any. */
  readonly testModel: string | undefined
  /** A directory of built web assets to serve at `/`. */
  readonly webDir: string | undefined
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

/** The port a server listens on when `PORT` does not say. */
export const DEFAULT_PORT = 3000

/** The scheduler a server runs when `SCHEDULER` does not say. */
export const DEFAULT_SCHEDULER: SchedulerKind = 'local'

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
 * @param env the environment; defaults to `process.env`
 * @throws Error when a variable is set to something it cannot be — a boot failure is much
 *   easier to read than a server that came up listening on `NaN`
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
  return {
    port: readInteger(env, ENV_VARS.port, DEFAULT_PORT, { min: 0, max: 65535 }),
    databaseUrl,
    scheduler,
    apiKey: readString(env, ENV_VARS.apiKey),
    testModel: readString(env, ENV_VARS.testModel),
    webDir: readString(env, ENV_VARS.webDir),
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
 * someone sees it: a server that answers with fixed text is a surprise worth explaining.
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
  lines.push(
    config.apiKey === undefined ? 'auth: open (no OPENHARNESS_API_KEY)' : 'auth: x-api-key',
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

/** A variable's value as an integer, or `fallback` when it is unset. */
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

/** Whether the environment asks for the deterministic test model. */
export function usesTestModel(config: ServerConfig): boolean {
  return config.testModel === MOCK_MODEL_ENV_VALUE
}
