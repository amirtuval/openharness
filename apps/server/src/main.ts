import { serve } from '@hono/node-server'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import type { MemoryDB } from 'better-auth/adapters/memory'
import type { ModelFactory } from '@openharness/brain'
import type { SessionId } from '@openharness/protocol'
import {
  InMemoryCredentialStore,
  InMemorySessionStore,
  type CredentialStore,
  type SessionStore,
} from '@openharness/session'
import {
  type PostgresSchema,
  createPostgresCredentialStore,
  createPostgresSessionStore,
  migrate,
} from '@openharness/session/postgres'
import { createVault, envKeyProvider, type Vault } from '@openharness/vault'

import { type AppEnv, type Logger, consoleLogger } from './types'
import { createApp } from './app'
import { createAuth, createDevLoginUser, type Auth, type AuthDatabase } from './auth'
import { DeltaCompactor } from './compaction'
import { ENV_VARS, type ServerConfig, describeConfig, readServerConfig } from './config'
import { createSessionCredentialResolver, type ResolveSessionCredential } from './credentials'
import { resolveMockCredential, resolveModelFactory } from './model'
import { PostgresPartitionScheduler } from './partition-scheduler'
import { validateProviderApiKey, type ProviderCredentialValidator } from './provider-validation'
import { LocalScheduler, type SessionScheduler } from './scheduler'

/**
 * Starting the server: the environment, the store, sign-in, the scheduler, the app, and the
 * shutdown.
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
  /** The Better Auth instance: `/api/auth/*`, and the sessions `/v1` is guarded with. */
  readonly auth: Auth
  /** The vault that seals and opens provider credentials. */
  readonly vault: Vault
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
  readonly resolveCredential?: ResolveSessionCredential
  /** Store sealed credentials here instead of in the store the config built. */
  readonly credentials?: CredentialStore
  /**
   * Run Better Auth against this database instead of the one the config built.
   *
   * A host that supplies its own `store` — a test with a Postgres store, say — points sign-in
   * at the same database, so the `user` rows the ownership foreign keys reference are the
   * ones Better Auth writes.
   */
  readonly authDatabase?: AuthDatabase
  /** Use this vault instead of one built from `OPENHARNESS_SECRETS_KEY`. */
  readonly vault?: Vault
  /**
   * How a saved provider key is validated. Defaults to {@link validateProviderApiKey}, the
   * real one cheap provider call; tests inject a fake so nothing reaches a provider.
   */
  readonly validateProviderCredential?: ProviderCredentialValidator
  /** Where to log; defaults to the console. */
  readonly logger?: Logger
  /** The SSE keepalive interval, for a test that wants to see a `: ping` quickly. */
  readonly sseKeepaliveMs?: number
  /** The session re-check interval (A2/#76), for a test that cannot wait 15 s for it. */
  readonly sessionRecheckMs?: number
}

/**
 * Start an HTTP server.
 *
 * The store is built first and, on Postgres, migrated: a server that comes up against a
 * schema it has not applied yet would fail on the first request instead of at boot. Then
 * sign-in — Better Auth over the same database (the memory adapter when there is no
 * Postgres), the dev user seeded when `OPENHARNESS_DEV_LOGIN=1` — and only then the
 * scheduler, so no turn can run before the credentials it needs can be read.
 */
export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const logger = options.logger ?? consoleLogger
  const config = options.config ?? readServerConfig()
  const opened = await openStore(config, options, logger)
  const credentials = options.credentials ?? opened.credentials
  const vault = options.vault ?? createVault(envKeyProvider(config.secretsKey))
  const auth = createAuth(
    {
      secret: config.betterAuthSecret,
      baseUrl: config.betterAuthUrl,
      devLogin: config.devLogin,
      providers: {
        ...(config.google === undefined ? {} : { google: config.google }),
        ...(config.github === undefined ? {} : { github: config.github }),
        ...(config.microsoft === undefined ? {} : { microsoft: config.microsoft }),
      },
      // A2/#76: every session Better Auth deletes is announced on the store's revocation
      // channel, which closes that session's open streams — here and on every other
      // instance. Only the id travels; the store never sees the token.
      onSessionRevoked: (authSessionId) => {
        void opened.store.notifyAuthSessionRevoked(authSessionId).catch((error: unknown) => {
          logger.error('announcing a revoked session failed', error)
        })
      },
    },
    opened.authDatabase,
    logger,
  )
  if (config.devLogin) {
    await createDevLoginUser(auth)
    logger.info('dev login is enabled: sign in with the documented dev user (localhost only)')
  }
  const resolvedModel = resolveModelFactory(config)
  const model = options.model ?? resolvedModel.factory
  const resolveCredential =
    options.resolveCredential ??
    (resolvedModel.kind === 'mock'
      ? resolveMockCredential
      : createSessionCredentialResolver({
          store: opened.store,
          credentials,
          vault,
          logger,
        }))

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
    auth: {
      instance: auth.auth,
      enabledProviders: auth.enabledProviders,
      devLogin: auth.config.devLogin,
      // The public URL is the one origin a cookie-authenticated write may come from (A2).
      trustedOrigins: [config.betterAuthUrl],
    },
    credentialRoutes: {
      credentials,
      vault,
      validate: options.validateProviderCredential ?? validateProviderApiKey,
    },
    ...(config.webDir === undefined ? {} : { webDir: config.webDir }),
    ...(config.corsOrigins.length === 0 ? {} : { corsOrigins: config.corsOrigins }),
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
    ...(options.sessionRecheckMs === undefined
      ? {}
      : { sessionRecheckMs: options.sessionRecheckMs }),
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
    auth,
    vault,
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
  resolveCredential: ResolveSessionCredential,
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
 * `DATABASE_URL` means Postgres: one pool, migrated here, owned by this function — the
 * session log, Better Auth's tables and the sealed credentials all live in it, so Better Auth
 * is handed the same Kysely handle. Without it the in-memory stores are used — the same ones
 * every other package tests against, including a memory adapter for Better Auth's tables —
 * with a warning that says out loud what it costs: nothing survives a restart.
 */
async function openStore(
  config: ServerConfig,
  options: StartServerOptions,
  logger: Logger,
): Promise<{
  store: SessionStore
  credentials: CredentialStore
  authDatabase: AuthDatabase
  close: () => Promise<void>
}> {
  if (options.store !== undefined) {
    return {
      store: options.store,
      credentials: new InMemoryCredentialStore(),
      // A caller that supplies its own store is a test: sign-in runs on the memory adapter
      // unless the caller says otherwise (`authDatabase`), which is what a test against a
      // Postgres store has to do — its `user` rows are the foreign keys `owner_id` needs.
      authDatabase: options.authDatabase ?? { kind: 'memory', db: emptyAuthTables() },
      close: () => Promise.resolve(),
    }
  }
  const connectionString = config.databaseUrl
  if (connectionString === undefined) {
    logger.warn(
      `${ENV_VARS.databaseUrl} is not set: using the IN-MEMORY store. ` +
        'Nothing is persisted — every session, agent, event and signed-in user is lost when ' +
        'this process exits. Set DATABASE_URL to run against Postgres.',
    )
    return {
      store: new InMemorySessionStore({ partitionCount: config.partitions }),
      credentials: new InMemoryCredentialStore(),
      authDatabase: { kind: 'memory', db: emptyAuthTables() },
      close: () => Promise.resolve(),
    }
  }

  const pool = new Pool({ connectionString })
  const db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool }) })
  const applied = await migrate(db)
  logger.info(`applied ${applied.length} migration file(s)`)
  // The store's partition count is what a session's `partition` column holds, and it has to be
  // the scheduler's: `findSessionsNeedingWork` and a signal's channel both name partitions.
  const store = createPostgresSessionStore({ pool }, { partitionCount: config.partitions })
  const credentials = createPostgresCredentialStore({ pool })
  return {
    store,
    credentials,
    authDatabase: { kind: 'postgres', db },
    close: async () => {
      // The pool is ours — `{ pool }` means the stores do not end it — so everything is
      // closed, in order: the stores first, so their connections go before the pool does.
      await store.close()
      await credentials.close()
      await db.destroy()
    },
  }
}

/** The empty tables Better Auth's memory adapter starts from. */
function emptyAuthTables(): MemoryDB {
  return { user: [], session: [], account: [], verification: [], deviceCode: [] }
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
