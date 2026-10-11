import { serve } from '@hono/node-server'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import type { MemoryDB } from 'better-auth/adapters/memory'
import {
  type ContextCompactionOption,
  type ContextStrategy,
  createContextStrategy,
  type ModeResolver,
  type ModelFactory,
  type ReasoningSupportFor,
} from '@openharness/brain'
import type { SessionId } from '@openharness/protocol'
import {
  InMemoryCredentialStore,
  InMemorySessionStore,
  InMemoryMcpServerStore,
  type CredentialStore,
  type McpServerStore,
  type SessionStore,
} from '@openharness/session'
import {
  type PostgresSchema,
  createPostgresCredentialStore,
  createPostgresMcpServerStore,
  createPostgresSessionStore,
  migrate,
} from '@openharness/session/postgres'
import type { Vault } from '@openharness/vault'

import { type AppEnv, type Logger } from './types'
import { createApp } from './app'
import { loggerFor } from './observability/logging'
import { SessionTraces, withSessionTraces } from './observability/session-traces'
import { initTracing, type Tracer } from './observability/tracing'
import { createAuth, createDevLoginUser, type Auth, type AuthDatabase } from './auth'
import { ModelCatalog } from './catalog/catalog'
import { createMaxOutputResolver, createTokenBudgetResolver } from './catalog/context-budget'
import { createProviderFetch } from './catalog/provider-fetch'
import { createReasoningSupportResolver } from './catalog/reasoning-support'
import { createSearchAllowance } from './searches'
import { createContextCompactionResolver } from './context-compaction'
import { createModeResolver } from './modes'
import { createBundledRegistry, type ModelRegistry } from './catalog/registry'
import { DeltaCompactor } from './compaction'
import { ENV_VARS, type ServerConfig, describeConfig, readServerConfig } from './config'
import { createSessionCredentialResolver, type ResolveSessionCredential } from './credentials'
import { createConfigVault } from './key-provider'
import { resolveMockCredential, resolveModelFactory } from './model'
import { PostgresPartitionScheduler } from './partition-scheduler'
import {
  createProviderCredentialValidator,
  type ProviderCredentialValidator,
} from './provider-validation'
import { LocalScheduler, type SessionScheduler } from './scheduler'
import { createTurnRegistry, createTurnTools, type TurnToolOptions } from './tools'

/**
 * Starting the server: the environment, the store, sign-in, the scheduler, the app, and the
 * shutdown.
 *
 * `node dist/index.js` runs {@link main}; everything it does is available as
 * {@link startServer} for a test that wants a real listening server on an ephemeral port.
 */

/**
 * How long `GET /ready` waits for `select 1` before answering "not ready" (#151).
 *
 * Short on purpose: a readiness probe has to answer before the load balancer's own probe
 * timeout, and a database that cannot answer a one-row query in two seconds is not one this
 * instance should be sent traffic for.
 */
export const READINESS_QUERY_TIMEOUT_MS = 2000

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
  /** Where spans go (#158): Cloud Trace when configured, and a no-op otherwise. */
  readonly tracer: Tracer
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
   * How a saved provider key is validated. Defaults to {@link validateProviderCredential}, the
   * real one cheap provider call; tests inject a fake so nothing reaches a provider.
   */
  readonly validateProviderCredential?: ProviderCredentialValidator
  /**
   * Use this model catalogue instead of the one built from the credentials, the vault, the
   * bundled registry and the real provider fetch. A test that exercises `GET /v1/models`
   * injects one whose fetch is a stub, so nothing reaches a provider.
   */
  readonly catalog?: Pick<ModelCatalog, 'list' | 'invalidate'>
  /**
   * The registry the catalogue joins against, and the automatic default's fallback reads
   * (epic #116, U4). Defaults to the bundled models.dev snapshot. A host that supplies
   * its own catalogue supplies this too when the fallback should use its stub.
   */
  readonly registry?: ModelRegistry
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
  const config = options.config ?? readServerConfig()
  // The log format is the configuration's (#158): the readable console format by default, the
  // Cloud Logging JSON one when the deployment asks for it. A caller that passes a logger
  // (a test capturing output) keeps it, whatever the format says.
  const logger = options.logger ?? loggerFor(config.logFormat, config.gcpProjectId)
  const opened = await openStore(config, options, logger)
  // Tracing (#158): off unless `OPENHARNESS_TRACING` says otherwise, and lazy either way — an
  // untraced server never loads the SDK. When it is on, the store is wrapped so every appended
  // session event also becomes a span (the turn and model-request spans of the session log).
  const tracer = await initTracing({
    mode: config.tracing,
    sampleRate: config.traceSampleRate,
    projectId: config.gcpProjectId,
    logger,
  })
  const store = tracer.enabled
    ? withSessionTraces(opened.store, new SessionTraces(tracer, logger))
    : opened.store
  // `/ready` flips to 503 the instant `shutdown()` is called — before the listener closes and
  // before the turns in flight are drained — so a load balancer stops sending new requests
  // while the ones in flight finish (#151). The closure keeps answering this flag for the
  // app's lifetime, which is what makes `started.app.request('/ready')` a probe after the
  // listener is gone.
  let draining = false
  const credentials = options.credentials ?? opened.credentials
  // The vault the configuration asks for (#150): the environment key, or Cloud KMS. Either
  // way it is built here, once, and shared by the credential routes, the per-request resolver
  // and the model catalogue — one cache of unwrapped data keys, not three.
  const vault = options.vault ?? createConfigVault(config)
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
        void store.notifyAuthSessionRevoked(authSessionId).catch((error: unknown) => {
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
          store,
          credentials,
          vault,
          logger,
        }))

  // The context budget (epic #245's A1; #246): every request is trimmed to the window of the
  // model it runs — `contextWindow − min(maxOutput, 25%)` — read from the bundled registry,
  // so a long chat fits a 200k-token model instead of forgetting early and a small model is
  // not handed more than it can take. The lookup is per request (the brain re-reads the
  // session at each request boundary), so a mid-session switch trims to the new model from the
  // next request on. One registry instance serves the resolver, the catalogue and the
  // automatic default's fallback (U4).
  const registry = options.registry ?? createBundledRegistry()
  const tokenBudgetFor = createTokenBudgetResolver(registry)
  const contextStrategy = createContextStrategy({ tokenBudgetFor })

  // Context compaction (epic #277, C2; #279; per-user controls: C3, #282): when the context a
  // request is about to make is over the trigger's share of the chat model's budget, older
  // history is summarized instead of being trimmed away. The trigger and the tail come from the
  // chat model's budget, and the passes from the summary model's — both the same registry-derived
  // resolver the strategy trims with (#246), plus the output ceiling the summary-size cap needs
  // (K5). The threshold, the summary model and the pass limit are the session owner's stored
  // preferences, resolved per request, over `OPENHARNESS_COMPACTION_THRESHOLD` (the default a
  // user who has not chosen one gets).
  const contextCompaction = createContextCompactionResolver({
    store,
    threshold: config.compactionThreshold,
    tokenBudgetFor,
    maxOutputFor: createMaxOutputResolver(registry),
  })

  // The reasoning effort (#252's follow-up): which `low | medium | high` levels a model takes,
  // read from the same registry, and asked per request. Before this the brain carried hand-written
  // model patterns, which rotted with every release; the model's own data is what decides now.
  const reasoningSupportFor = createReasoningSupportResolver(registry)

  // The mode a chat follows (#245, M6): a mode lives in the database and its "my default model"
  // in the user's preferences, so the resolver is the server's and the brain is handed it per
  // request. The store holds the modes and the credentials decide availability; the routes
  // refuse an unusable mode before a chat starts or continues (`modes.ts`), and the brain
  // applies whatever this answers.
  const resolveMode = createModeResolver({ store, credentials })

  // The tools a turn may offer (epic #303, X4; the built-ins are #305, the per-user settings
  // are #307 and the pause is #309): `ask_user`, `web_fetch` and `todo_write` for every
  // deployment, `web_search` where an operator configured a search API, and the test `echo`
  // tool behind `OPENHARNESS_TEST_MODEL=mock`. Which models may call tools at all comes from
  // the same registry, as `models.dev`'s `tool_call`. The registry is built once here and
  // handed to both readers — the turn options and the `/v1/me/tools` routes (`createApp`) — so
  // a tool the settings screen calls available is one a chat can really call.
  // The search request goes out through the server's egress, like every provider call (#270);
  // the fixed endpoint and the operator's key are the only things it carries.
  const searchTransport = createProviderFetch()
  const turnRegistry = createTurnRegistry({ config, kind: resolvedModel.kind, searchTransport })
  const turnTools = createTurnTools({
    config,
    kind: resolvedModel.kind,
    searchTransport,
    registry,
    tools: turnRegistry,
    allowance:
      config.search === null
        ? undefined
        : createSearchAllowance({ store, dailyLimit: config.search.dailyLimit }),
    store,
  })

  const scheduler = createScheduler(
    config,
    store,
    model,
    resolveCredential,
    contextStrategy,
    contextCompaction,
    reasoningSupportFor,
    resolveMode,
    turnTools,
    logger,
  )
  // Compaction is the store's, not a scheduler's: it deletes superseded chunks whoever ran the
  // turn that superseded them, so every instance runs it in either scheduler mode.
  const compactor = new DeltaCompactor({
    store,
    retentionMs: config.deltaRetentionMs,
    intervalMs: config.compactIntervalMs,
    logger,
  })

  // The model catalogue (epic #92): the caller's own keys, the providers' own lists, joined
  // with the bundled models.dev snapshot and cached in memory per (user, provider). It is
  // built from the same credential store and vault the brain's resolver uses, and its one
  // outbound path is `createProviderFetch()`, which honors the egress-proxy variables.
  const catalog =
    options.catalog ??
    new ModelCatalog({
      credentials,
      vault,
      registry,
      fetch: createProviderFetch(),
      // A custom OpenAI-compatible credential's base URL is the user's, so its listing goes
      // through safeFetch — and honours the self-host setting (#249, M4). The other providers
      // use the egress-proxy fetch above, whose URLs are constants.
      allowPrivateProviderUrls: config.allowPrivateProviderUrls,
      // The budget each entry reports (`context_budget`, epic #277 K10; #280) is the one the
      // brain trims to: the catalogue builds the same `createTokenBudgetResolver(registry)` the
      // scheduler was handed above, from the same registry.
      logger,
    })

  const app = createApp({
    store,
    scheduler,
    auth: {
      instance: auth.auth,
      enabledProviders: auth.enabledProviders,
      devLogin: auth.config.devLogin,
      // The public URL is the one origin a cookie-authenticated write may come from (A2).
      trustedOrigins: [config.betterAuthUrl],
    },
    // The remote-MCP-server resource (epic #303, X10): the durable store, and the OAuth
    // callback this deployment's `BETTER_AUTH_URL` makes reachable. Its outbound requests go
    // through the guarded fetch, honouring the same self-host setting a custom endpoint does.
    mcpServers: {
      store: opened.mcpServers,
      callbackUrl: new URL('/v1/me/mcp_servers/oauth/callback', config.betterAuthUrl).href,
      allowPrivateUrls: config.allowPrivateProviderUrls,
    },
    credentialRoutes: {
      credentials,
      vault,
      validate:
        options.validateProviderCredential ??
        createProviderCredentialValidator({
          // The save-time check is the same guard the model call and the listing use, so a
          // private endpoint is refused before it is stored — unless the self-host setting is
          // on, which is read here for a custom credential only (#249, M4).
          allowPrivateProviderUrls: config.allowPrivateProviderUrls,
        }),
    },
    catalog,
    registry,
    // The tools `/v1/me/tools` reports on: the same registry the turn options were built from.
    tools: turnRegistry,
    // The preferences response reports it as the default a user who has not chosen a compaction
    // share follows (C3, #282).
    compactionThreshold: config.compactionThreshold,
    // #151: the client's address behind the deployment's proxies, and the readiness answer
    // the probes see — the store's own `select 1` and this process's drain flag.
    trustedProxyHops: config.trustedProxyHops,
    readiness: { isDraining: () => draining, check: opened.checkReady },
    // #158: one server span per request, and the trace context every JSON log line carries.
    tracer,
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
    await tracer.shutdown()
    throw error
  }
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  logger.info(`@openharness/server listening on http://localhost:${port}`)

  let stopping: Promise<void> | null = null
  return {
    app,
    store,
    scheduler,
    compactor,
    auth,
    vault,
    tracer,
    port,
    shutdown: () => {
      // Draining starts here, not when the listener closes: the load balancer is told "not
      // ready" first and the requests that were already on their way are the ones this drain
      // is for (#151).
      draining = true
      stopping ??= stop(server, scheduler, compactor, opened.close, config, tracer, logger)
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
  const config = readServerConfig(env)
  const logger = options.logger ?? loggerFor(config.logFormat, config.gcpProjectId)
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
 * resolver, context strategy, reasoning resolver and concurrency and drain limits — what changes
 * is who owns a session, not how it is run.
 */
function createScheduler(
  config: ServerConfig,
  store: SessionStore,
  model: ModelFactory,
  resolveCredential: ResolveSessionCredential,
  contextStrategy: ContextStrategy,
  contextCompaction: ContextCompactionOption,
  reasoningSupportFor: ReasoningSupportFor,
  resolveMode: ModeResolver,
  tools: TurnToolOptions | undefined,
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
      contextStrategy,
      compaction: contextCompaction,
      reasoningSupportFor,
      resolveMode,
      ...(tools === undefined ? {} : { tools }),
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
    contextStrategy,
    compaction: contextCompaction,
    reasoningSupportFor,
    resolveMode,
    ...(tools === undefined ? {} : { tools }),
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
 *
 * The `checkReady` it returns is `GET /ready`'s store question (#151): the pool's own
 * `select 1` on Postgres, and "yes" for a store that answers in process. A store the caller
 * supplied is the caller's to know about — this function owns a connection only when it
 * built one — and answers `true`.
 */
async function openStore(
  config: ServerConfig,
  options: StartServerOptions,
  logger: Logger,
): Promise<{
  store: SessionStore
  credentials: CredentialStore
  mcpServers: McpServerStore
  authDatabase: AuthDatabase
  checkReady: () => Promise<boolean>
  close: () => Promise<void>
}> {
  if (options.store !== undefined) {
    return {
      store: options.store,
      credentials: new InMemoryCredentialStore(),
      mcpServers: new InMemoryMcpServerStore(),
      // A caller that supplies its own store is a test: sign-in runs on the memory adapter
      // unless the caller says otherwise (`authDatabase`), which is what a test against a
      // Postgres store has to do — its `user` rows are the foreign keys `owner_id` needs.
      authDatabase: options.authDatabase ?? { kind: 'memory', db: emptyAuthTables() },
      checkReady: () => Promise.resolve(true),
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
      mcpServers: new InMemoryMcpServerStore(),
      authDatabase: { kind: 'memory', db: emptyAuthTables() },
      // Nothing to check: the in-memory store is this process, and it is up whenever the
      // process is (#151).
      checkReady: () => Promise.resolve(true),
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
  const mcpServers = createPostgresMcpServerStore({ pool })
  return {
    store,
    credentials,
    mcpServers,
    authDatabase: { kind: 'postgres', db },
    checkReady: () => checkDatabase(pool),
    close: async () => {
      // The pool is ours — `{ pool }` means the stores do not end it — so everything is
      // closed, in order: the stores first, so their connections go before the pool does.
      await store.close()
      await credentials.close()
      await mcpServers.close()
      await db.destroy()
    },
  }
}

/** The empty tables Better Auth's memory adapter starts from. */
function emptyAuthTables(): MemoryDB {
  return { user: [], session: [], account: [], verification: [], deviceCode: [] }
}

/** The one thing {@link checkDatabase} needs from a pool: somewhere to send `select 1`. */
export interface ReadinessPool {
  query(text: string): Promise<unknown>
}

/**
 * `select 1` against the pool, inside {@link READINESS_QUERY_TIMEOUT_MS} — the one question
 * `GET /ready` asks Postgres (#151).
 *
 * Every answer is a boolean: the query's rows do not matter, a rejected query and a query
 * still unanswered when the deadline passes are both "not ready". A `select 1` the pool is
 * already queueing is left to finish or fail in the background — it is one row against a
 * pool that will reuse the connection — because what a probe must not do is hang.
 *
 * Takes only {@link ReadinessPool} — what a pool can do here — so a test can hand it a stub
 * and ask the timeout question without a database.
 */
export async function checkDatabase(pool: ReadinessPool): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false)
    }, READINESS_QUERY_TIMEOUT_MS)
  })
  try {
    return await Promise.race([
      pool.query('select 1').then(
        () => true,
        () => false,
      ),
      deadline,
    ])
  } finally {
    clearTimeout(timer)
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
 * store is closed last, because everything above it may still be writing to it. The tracer is
 * shut down after everything else, so the spans this process opened are flushed to Cloud Trace
 * before it exits (#158).
 */
async function stop(
  server: ReturnType<typeof serve>,
  scheduler: SessionScheduler,
  compactor: DeltaCompactor,
  closeStore: () => Promise<void>,
  config: ServerConfig,
  tracer: Tracer,
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
  await tracer.shutdown()
  logger.info('stopped')
}
