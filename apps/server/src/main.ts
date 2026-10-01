import { serve } from '@hono/node-server'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import type { ModelFactory, ResolveCredential } from '@openharness/brain'
import type { SessionId } from '@openharness/protocol'
import { InMemorySessionStore, type SessionStore } from '@openharness/session'
import {
  type PostgresSchema,
  createPostgresSessionStore,
  migrate,
} from '@openharness/session/postgres'

import { type AppEnv, type Logger, consoleLogger } from './types'
import { createApp } from './app'
import { DeltaCompactor } from './compaction'
import { ENV_VARS, type ServerConfig, describeConfig, readServerConfig } from './config'
import { resolveModelFactory } from './model'
import { PostgresPartitionScheduler } from './partition-scheduler'
import { ensurePlaceholderUser } from './placeholder-owner'
import { LocalScheduler, type SessionScheduler } from './scheduler'

/**
 * Starting the server: the environment, the store, the scheduler, the app, and the shutdown.
 *
 * `node dist/index.js` runs {@link main}; everything it does is available as
 * {@link startServer} for a test that wants a real listening server on an ephemeral port.
 */

/** What is running once {@link startServer} has resolved. */
export interface StartedServer {
  /** The Hono app, for a caller that wants to keep it (tests use the HTTP interface). */
  readonly app: Hono<AppEnv>
  /** The store the app is running against. */
  readonly store: SessionStore
  /** The scheduler running the brains. */
  readonly scheduler: SessionScheduler
  /** The periodic compaction of superseded chunks; runs in every scheduler mode. */
  readonly compactor: DeltaCompactor
  /** The port the server is listening on; a real one even when `PORT=0`. */
  readonly port: number
  /** Stop the server: no new requests, no new turns, no open store. Idempotent. */
  shutdown(): Promise<void>
}

/** What {@link startServer} takes. Everything is optional; the environment fills the rest. */
export interface StartServerOptions {
  /** The configuration to run with; defaults to the process environment. */
  readonly config?: ServerConfig
  /** Run against this store instead of one built from the config. */
  readonly store?: SessionStore
  /** Use this model factory instead of the one the config resolves. */
  readonly model?: ModelFactory
  /**
   * Use this credential resolver instead of the one the config resolves (epic #65, A5). A
   * test that swaps in a model factory almost always swaps this too: a scripted model ignores
   * credentials, but the brain still asks for one before every request.
   */
  readonly resolveCredential?: ResolveCredential
  /** Where to log; defaults to the console. */
  readonly logger?: Logger
  /** The SSE keepalive interval, for a test that wants to see a `: ping` quickly. */
  readonly sseKeepaliveMs?: number
}

/**
 * Start an HTTP server.
 *
 * The store is built first and, on Postgres, migrated: a server that comes up against a
 * schema it has not applied yet would fail on the first request instead of at boot.
 */
export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const logger = options.logger ?? consoleLogger
  const config = options.config ?? readServerConfig()
  const opened = await openStore(config, options, logger)
  const resolvedModel = resolveModelFactory(config)
  const model = options.model ?? resolvedModel.factory
  const resolveCredential = options.resolveCredential ?? resolvedModel.resolveCredential

  const scheduler = createScheduler(config, opened.store, model, resolveCredential, logger)
  // Compaction is the store's, not a scheduler's: it deletes superseded chunks whoever ran the
  // turn that superseded them, so every instance runs it in either scheduler mode.
  const compactor = new DeltaCompactor({
    store: opened.store,
    retentionMs: config.deltaRetentionMs,
    intervalMs: config.compactIntervalMs,
    logger,
  })

  const app = createApp({
    store: opened.store,
    scheduler,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.webDir === undefined ? {} : { webDir: config.webDir }),
    ...(config.corsOrigins.length === 0 ? {} : { corsOrigins: config.corsOrigins }),
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
    logger,
  })

  const server = serve({ fetch: app.fetch, port: config.port })
  try {
    // The listener first, recovery second. A port somebody else holds must not leave this
    // process running turns nobody can reach — and, once the port is ours, recovering before
    // the first request arrives is what a client's first read depends on.
    await listening(server)
    await scheduler.start()
    compactor.start()
  } catch (error) {
    await compactor.stop()
    await scheduler.stop()
    server.close()
    await opened.close()
    throw error
  }
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  logger.info(`@openharness/server listening on http://localhost:${port}`)

  let stopping: Promise<void> | null = null
  return {
    app,
    store: opened.store,
    scheduler,
    compactor,
    port,
    shutdown: () => {
      stopping ??= stop(server, scheduler, compactor, opened.close, config, logger)
      return stopping
    },
  }
}

/**
 * Read the environment, start the server, and stop it cleanly on `SIGINT` / `SIGTERM`.
 *
 * @param env the environment; defaults to `process.env`
 * @param options.logger where to log; defaults to the console
 */
export async function main(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly logger?: Logger } = {},
): Promise<StartedServer> {
  const logger = options.logger ?? consoleLogger
  const config = readServerConfig(env)
  for (const line of describeConfig(config)) {
    logger.info(`  ${line}`)
  }
  const started = await startServer({ config, logger })
  runningServers.add(started)
  installSignalHandlers(logger)
  return started
}

/** The servers `main` has started in this process; a signal shuts all of them down. */
const runningServers = new Set<StartedServer>()

/** Whether this process already listens for the shutdown signals. */
let signalHandlersInstalled = false

/**
 * Shut everything down when the process is asked to stop.
 *
 * `SIGTERM` is what a container runtime sends before it kills a process, and `SIGINT` is
 * Ctrl-C: both mean "stop", and both get the same treatment — stop accepting requests, let
 * the turns in flight finish writing, close the store. A second signal is ignored rather
 * than allowed to interrupt the drain half-way.
 */
function installSignalHandlers(logger: Logger): void {
  if (signalHandlersInstalled) {
    return
  }
  signalHandlersInstalled = true
  let stopping = false
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return
    }
    stopping = true
    logger.info(`${signal} received; shutting down`)
    void Promise.all([...runningServers].map(async (server) => server.shutdown()))
      .then(() => {
        process.exitCode = 0
      })
      .catch((error: unknown) => {
        logger.error('shutdown failed', error)
        process.exitCode = 1
      })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
}

/**
 * The scheduler the configuration asks for.
 *
 * `local` runs every turn in this process; `postgres` shares the sessions with the other
 * instances through partition leases, which is why it needs the store and why the config
 * refuses to boot without a `DATABASE_URL`. Both are handed the same model, credential
 * resolver and concurrency and drain limits — what changes is who owns a session, not how it
 * is run.
 */
function createScheduler(
  config: ServerConfig,
  store: SessionStore,
  model: ModelFactory,
  resolveCredential: ResolveCredential,
  logger: Logger,
): SessionScheduler {
  const onError = (error: unknown, sessionId: SessionId | undefined): void => {
    logger.error(
      sessionId === undefined ? 'the scheduler failed' : `the turn for ${sessionId} failed`,
      error,
    )
  }
  if (config.scheduler === 'postgres') {
    return new PostgresPartitionScheduler({
      store,
      model,
      resolveCredential,
      instanceId: config.instanceId,
      partitions: config.partitions,
      ttlMs: config.leaseTtlMs,
      heartbeatMs: config.heartbeatMs,
      sweepMs: config.sweepMs,
      maxConcurrentSessions: config.maxConcurrentSessions,
      drainTimeoutMs: config.drainTimeoutMs,
      onError,
      onNotice: (message) => {
        logger.info(message)
      },
    })
  }
  return new LocalScheduler({
    store,
    model,
    resolveCredential,
    maxConcurrentSessions: config.maxConcurrentSessions,
    drainTimeoutMs: config.drainTimeoutMs,
    partitionCount: config.partitions,
    onError,
  })
}

/**
 * The store the server runs on, and the way it is released again.
 *
 * `DATABASE_URL` means Postgres: one pool, migrated here, owned by this function. Without it
 * the in-memory store is used — the same one every other package tests against — with a
 * warning that says out loud what it costs: nothing survives a restart.
 */
async function openStore(
  config: ServerConfig,
  options: StartServerOptions,
  logger: Logger,
): Promise<{ store: SessionStore; close: () => Promise<void> }> {
  if (options.store !== undefined) {
    return { store: options.store, close: () => Promise.resolve() }
  }
  const connectionString = config.databaseUrl
  if (connectionString === undefined) {
    logger.warn(
      `${ENV_VARS.databaseUrl} is not set: using the IN-MEMORY store. ` +
        'Nothing is persisted — every session, agent and event is lost when this process exits. ' +
        'Set DATABASE_URL to run against Postgres.',
    )
    return {
      store: new InMemorySessionStore({ partitionCount: config.partitions }),
      close: () => Promise.resolve(),
    }
  }

  const pool = new Pool({ connectionString })
  const db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool }) })
  const applied = await migrate(db)
  logger.info(`applied ${applied.length} migration file(s)`)
  // Transition glue (#58 until #61): the routes own what they create to a placeholder user
  // (A4), and `owner_id` is a foreign key into Better Auth's `"user"` table, so the row has
  // to exist before the first agent is created. Better Auth will insert real users here.
  await ensurePlaceholderUser(db)
  // The store's partition count is what a session's `partition` column holds, and it has to be
  // the scheduler's: `findSessionsNeedingWork` and a signal's channel both name partitions.
  const store = createPostgresSessionStore({ pool }, { partitionCount: config.partitions })
  return {
    store,
    close: async () => {
      // The pool is ours — `{ pool }` means the store does not end it — so both are closed,
      // in that order: the store first, so its listening connection goes before the pool does.
      await store.close()
      await db.destroy()
    },
  }
}

/** Resolve when the server is accepting connections, or reject when it cannot. */
async function listening(server: ReturnType<typeof serve>): Promise<void> {
  if (server.listening) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => {
      resolve()
    })
    server.once('error', (error: Error) => {
      reject(error)
    })
  })
}

/**
 * Shut down: stop accepting requests, let the turns in flight finish writing, drop the rest,
 * and release the store.
 *
 * The order matters. Closing the listener first stops new work arriving; the compaction job is
 * then stopped — it deletes, so it must not outlive the store — and the scheduler drained (its
 * turns are aborted, and given a timeout to write their last events); only then are the
 * remaining connections — the SSE streams, which would otherwise never end — cut off. The
 * store is closed last, because everything above it may still be writing to it.
 */
async function stop(
  server: ReturnType<typeof serve>,
  scheduler: SessionScheduler,
  compactor: DeltaCompactor,
  closeStore: () => Promise<void>,
  config: ServerConfig,
  logger: Logger,
): Promise<void> {
  const closed = new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  await compactor.stop()
  await scheduler.stop({ drainTimeoutMs: config.drainTimeoutMs })
  if ('closeAllConnections' in server) {
    // The SSE streams are connections that never end on their own; without this the listener
    // would stay open for as long as one client holds a stream.
    server.closeAllConnections()
  }
  await closed
  await closeStore()
  logger.info('stopped')
}
