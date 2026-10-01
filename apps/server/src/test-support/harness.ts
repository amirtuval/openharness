import type { Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  DEFAULT_PARTITION_COUNT,
  type Agent,
  type AgentId,
  type Session,
  type SessionId,
  type StoredEvent,
  type UserId,
} from '@openharness/protocol'
import {
  InMemoryCredentialStore,
  InMemorySessionStore,
  type CredentialStore,
  type SessionStore,
} from '@openharness/session'
import { createVault, envKeyProvider, type Vault } from '@openharness/vault'

import { createApp } from '../app'
import {
  DEV_LOGIN_EMAIL,
  DEV_LOGIN_PASSWORD,
  createAuth,
  createDevLoginUser,
  type Auth,
  type AuthDatabase,
  type AuthUser,
  type BetterAuthInstance,
} from '../auth'
import { DEFAULT_DELTA_RETENTION_MS } from '../compaction'
import type { SchedulerKind, ServerConfig } from '../config'
import { startServer } from '../main'
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_SWEEP_MS,
} from '../partition-scheduler'
import type { ResolveSessionCredential } from '../credentials'
import type { ProviderCredentialValidator } from '../provider-validation'
import { LocalScheduler, type SessionScheduler } from '../scheduler'
import { type AppEnv, type Logger, silentLogger } from '../types'
import {
  type ScriptedModel,
  type ScriptedReply,
  createScriptedModel,
  resolveTestSessionCredential,
} from './model'

/**
 * Starting a server for a test: a fresh in-memory store, sign-in over Better Auth's memory
 * adapter with the dev user seeded, a scheduler with a scripted model, and either the Hono
 * app called in-process or a real listener on an ephemeral port.
 *
 * The in-memory store is the point — it is the reference implementation of the contract every
 * other package tests against, so a test here says something about a Postgres-backed server
 * as well. A test that needs a socket (SSE, the AI SDK transport) uses
 * {@link startTestServer}; everything else goes through {@link createTestApp}, which is a
 * plain function call.
 *
 * **Every request is authenticated by default** (epic #65, A2): the harness signs in as the
 * seeded dev user on first use and attaches that session's bearer token, exactly as the CLI
 * would. A test that wants to be anonymous uses {@link TestContext.anonymous}; one that wants
 * a second, isolated user calls {@link TestContext.signIn} with another address.
 */

/** The base URL tests pretend the server is deployed at; the CSRF origin that is trusted. */
export const TEST_PUBLIC_URL = 'http://localhost:3000'

/** The fixed vault key tests use. 32 bytes of base64; not a secret anyone should reuse. */
export const TEST_SECRETS_KEY = 'b3Blbmhhcm5lc3MtdGVzdC1zZWNyZXRzLWtleS0zMmI='

/** How a test talks to the server it built. */
export interface TestContext {
  /** The store the app is running against: in-memory unless the test supplied another. */
  readonly store: SessionStore
  /** Where the app's sealed provider credentials live. */
  readonly credentials: CredentialStore
  /** The vault the credential routes seal with. */
  readonly vault: Vault
  /** The Better Auth instance the app was built with. */
  readonly auth: Auth
  /** The scripted model, for tests that script replies or assert on prompts. */
  readonly model: ScriptedModel
  /** The scheduler running the brains. */
  readonly scheduler: SessionScheduler
  /** The Hono app, called in-process. */
  readonly app: Hono<AppEnv>
  /**
   * Fire an authenticated request at the app or the listener: the default caller's bearer
   * token is attached unless `init` carries an `authorization` header of its own.
   */
  request(path: string, init?: RequestInit): Promise<Response>
  /**
   * Fire a request exactly as given, with no default bearer token attached — what the 401
   * tests use, and what a test that presents its own cookie or token uses.
   */
  anonymous(path: string, init?: RequestInit): Promise<Response>
  /**
   * Sign in (creating the user, with a credential account, when needed) and answer the
   * session token. The dev user is the default caller; any address may be used for a second,
   * isolated account.
   */
  signIn(email?: string, password?: string): Promise<SignedIn>
  /** The default caller: the user every {@link TestContext.request} is made as. */
  currentUser(): Promise<AuthUser>
  /** The base URL, when the context is a real listener; `null` in-process. */
  readonly url: string | null
  /** Stop the scheduler and the listener, if there is one. */
  close(): Promise<void>
}

/** A signed-in test caller. */
export interface SignedIn {
  /** The session token; send it as `Authorization: Bearer`. */
  readonly token: string
  /** The user it belongs to. */
  readonly user: AuthUser
}

/** Options shared by {@link createTestApp} and {@link startTestServer}. */
export interface TestOptions {
  /**
   * Run against this store instead of a fresh in-memory one — a Postgres store, say, for a
   * test that needs the durable half of the same behaviour.
   */
  readonly store?: SessionStore
  /** Store sealed credentials here instead of the in-memory store. */
  readonly credentials?: CredentialStore
  /**
   * Run Better Auth against this database instead of the in-memory one. A test whose store is
   * Postgres passes the same database, so the dev user's `user` row exists where the
   * ownership foreign keys look for it.
   */
  readonly authDatabase?: AuthDatabase
  /** Use this vault instead of one built from {@link TEST_SECRETS_KEY}. */
  readonly vault?: Vault
  /** Serve a built web app from this directory. */
  readonly webDir?: string
  /** The public URL Better Auth is based at; {@link TEST_PUBLIC_URL} by default. */
  readonly betterAuthUrl?: string
  /** The trusted origins a cookie-authenticated write may come from. */
  readonly trustedOrigins?: readonly string[]
  /** Enable the dev login (default true) and seed its user. */
  readonly devLogin?: boolean
  /**
   * Whether the auth endpoints are rate-limited (default **false** in tests).
   *
   * Better Auth's limiter store is process-wide, and a suite signs in far more often than a
   * person; the one test that asserts the limiter works turns this on.
   */
  readonly rateLimit?: boolean
  /** The validator a `PUT /v1/provider-credentials` uses; a fake, by default. */
  readonly validateProviderCredential?: ProviderCredentialValidator
  /**
   * Where the app and Better Auth log. Silent by default; a test that asserts on a log line —
   * or on the absence of one — passes a logger that keeps them.
   */
  readonly logger?: Logger
  /**
   * The credential resolver the scheduler runs with. Defaults to the placeholder a scripted
   * model is happy with; a test that exercises the real lookup passes
   * `createSessionCredentialResolver` over its own store, credentials and vault.
   */
  readonly resolveCredential?: ResolveSessionCredential
  /** Social provider credentials, for tests of `/v1/auth-config`. */
  readonly providers?: {
    readonly google?: { clientId: string; clientSecret: string }
    readonly github?: { clientId: string; clientSecret: string }
    readonly microsoft?: { clientId: string; clientSecret: string; tenantId?: string }
  }
  /** Replies the scripted model answers with, in order; the last one repeats. */
  readonly replies?: readonly ScriptedReply[]
  /** How many sessions may run at once. */
  readonly maxConcurrentSessions?: number
  /** How long a shutdown waits for a turn in flight. */
  readonly drainTimeoutMs?: number
  /** The SSE keepalive interval. */
  readonly sseKeepaliveMs?: number
  /** How often an open stream re-checks its auth session (#76); shortened by tests. */
  readonly sessionRecheckMs?: number
  /** Which scheduler runs the brains; `local` unless the test asks for partitions. */
  readonly scheduler?: SchedulerKind
  /** This instance's id; the lease table's owner when the scheduler is the partitioned one. */
  readonly instanceId?: string
  /** How many partitions the session space has. */
  readonly partitions?: number
  /** How long a partition lease lasts. */
  readonly leaseTtlMs?: number
  /** How often leases are renewed. */
  readonly heartbeatMs?: number
  /** How often owned partitions are re-scanned. */
  readonly sweepMs?: number
  /** How long superseded chunks are kept before compaction deletes them. */
  readonly deltaRetentionMs?: number
  /** How often the compaction job runs; `0` disables it. */
  readonly compactIntervalMs?: number
}

/** Build an app, a store and a scheduler in-process; nothing listens. */
export function createTestApp(options: TestOptions = {}): TestContext {
  const logger = options.logger ?? silentLogger
  const store = options.store ?? new InMemorySessionStore()
  const credentials = options.credentials ?? new InMemoryCredentialStore()
  const vault = options.vault ?? createVault(envKeyProvider(TEST_SECRETS_KEY))
  const model = createScriptedModel(...(options.replies ?? []))
  const scheduler = new LocalScheduler({
    store,
    model: model.factory,
    resolveCredential: options.resolveCredential ?? resolveTestSessionCredential,
    ...(options.maxConcurrentSessions === undefined
      ? {}
      : { maxConcurrentSessions: options.maxConcurrentSessions }),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    onError: () => {},
  })
  const auth = buildTestAuth(options, store, logger)
  const app = createApp({
    store,
    scheduler,
    auth: {
      instance: auth.auth,
      enabledProviders: auth.enabledProviders,
      devLogin: auth.config.devLogin,
      trustedOrigins: options.trustedOrigins ?? [
        new URL(options.betterAuthUrl ?? TEST_PUBLIC_URL).origin,
      ],
    },
    credentialRoutes: {
      credentials,
      vault,
      validate: options.validateProviderCredential ?? acceptAnyCredential,
    },
    ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
    ...(options.sessionRecheckMs === undefined
      ? {}
      : { sessionRecheckMs: options.sessionRecheckMs }),
    logger,
  })
  return context({
    store,
    credentials,
    vault,
    auth,
    model,
    scheduler,
    app,
    url: null,
    options,
    send: async (path, init) => app.request(path, init),
  })
}

/** Start a real listening server on an ephemeral port. */
export async function startTestServer(options: TestOptions = {}): Promise<TestContext> {
  const store = options.store ?? new InMemorySessionStore()
  const credentials = options.credentials ?? new InMemoryCredentialStore()
  const vault = options.vault ?? createVault(envKeyProvider(TEST_SECRETS_KEY))
  const model = createScriptedModel(...(options.replies ?? []))
  const started = await startServer({
    config: testConfig(options),
    store,
    model: model.factory,
    resolveCredential: resolveTestSessionCredential,
    credentials,
    vault,
    ...(options.authDatabase === undefined ? {} : { authDatabase: options.authDatabase }),
    validateProviderCredential: options.validateProviderCredential ?? acceptAnyCredential,
    logger: silentLogger,
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
    ...(options.sessionRecheckMs === undefined
      ? {}
      : { sessionRecheckMs: options.sessionRecheckMs }),
  })
  const baseUrl = `http://127.0.0.1:${started.port}`
  return context({
    store,
    credentials,
    vault,
    auth: started.auth,
    model,
    scheduler: started.scheduler,
    app: started.app,
    url: baseUrl,
    options,
    send: (path, init) => fetch(`${baseUrl}${path}`, init),
  })
}

/** The default validator: every key is accepted. Nothing in a test reaches a provider. */
const acceptAnyCredential: ProviderCredentialValidator = () => Promise.resolve()

/** The auth a test app runs with: Better Auth's memory adapter, dev login on by default. */
function buildTestAuth(options: TestOptions, store: SessionStore, logger: Logger): Auth {
  const devLogin = options.devLogin ?? true
  const auth = createAuth(
    {
      secret: 'test-secret-that-is-at-least-32-characters-long',
      baseUrl: options.betterAuthUrl ?? TEST_PUBLIC_URL,
      devLogin,
      rateLimit: options.rateLimit ?? false,
      // The same wiring `startServer` does: a deleted session is announced on the store's
      // revocation channel, which is what closes its open streams (#76).
      onSessionRevoked: (authSessionId) => {
        void store.notifyAuthSessionRevoked(authSessionId).catch(() => undefined)
      },
      providers: {
        ...(options.providers?.google === undefined ? {} : { google: options.providers.google }),
        ...(options.providers?.github === undefined ? {} : { github: options.providers.github }),
        ...(options.providers?.microsoft === undefined
          ? {}
          : {
              microsoft: {
                clientId: options.providers.microsoft.clientId,
                clientSecret: options.providers.microsoft.clientSecret,
                tenantId: options.providers.microsoft.tenantId ?? 'common',
              },
            }),
      },
    },
    {
      kind: 'memory',
      db: { user: [], session: [], account: [], verification: [], deviceCode: [] },
    },
    logger,
  )
  return auth
}

/** The shared {@link TestContext} behaviour, over either transport. */
function context(base: {
  store: SessionStore
  credentials: CredentialStore
  vault: Vault
  auth: Auth
  model: ScriptedModel
  scheduler: SessionScheduler
  app: Hono<AppEnv>
  url: string | null
  options: TestOptions
  send: (path: string, init?: RequestInit) => Promise<Response>
}): TestContext {
  // The dev user is seeded as soon as a context exists — a test that signs anyone in needs
  // it, and one that signed in explicitly would otherwise race the seed.
  const seeded = (base.options.devLogin ?? true) ? createDevLoginUser(base.auth) : Promise.resolve()
  let defaultCaller: Promise<SignedIn> | undefined

  // Every request waits for the dev user to exist: a test that signs in through the app's
  // own route would otherwise race the seed.
  const rawRequest = async (path: string, init?: RequestInit): Promise<Response> => {
    await seeded
    return base.send(path, init)
  }

  const authedRequest = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const token = (await defaultSignIn()).token
    return rawRequest(path, withBearer(init, token))
  }

  const defaultSignIn = (): Promise<SignedIn> => {
    defaultCaller ??= signInThrough(rawRequest, DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD)
    return defaultCaller
  }

  return {
    store: base.store,
    credentials: base.credentials,
    vault: base.vault,
    auth: base.auth,
    model: base.model,
    scheduler: base.scheduler,
    app: base.app,
    url: base.url,
    request: authedRequest,
    anonymous: (path, init) => rawRequest(path, init),
    currentUser: async () => (await defaultSignIn()).user,
    signIn: async (email = DEV_LOGIN_EMAIL, password = DEV_LOGIN_PASSWORD) => {
      if (email !== DEV_LOGIN_EMAIL) {
        await ensureUser(base.auth, email, password)
      }
      return signInThrough(rawRequest, email, password)
    },
    close: () => base.scheduler.stop(),
  }
}

/** POST an email/password sign-in through the server itself, so the path is the real one. */
async function signInThrough(
  send: (path: string, init?: RequestInit) => Promise<Response>,
  email: string,
  password: string,
): Promise<SignedIn> {
  const response = await send('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) {
    throw new Error(`signing in as ${email} failed: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { token?: string; user?: unknown }
  if (typeof body.token !== 'string' || body.user === undefined) {
    throw new Error('the sign-in response carried no token')
  }
  return { token: body.token, user: body.user as AuthUser }
}

/** Create a password user through Better Auth's internals, for tests that need a second one. */
async function ensureUser(auth: Auth, email: string, password: string): Promise<void> {
  const ctx = (await auth.auth.$context) as unknown as {
    internalAdapter: {
      findUserByEmail(value: string): Promise<{ user: AuthUser } | null>
      createUser(input: Record<string, unknown>): Promise<AuthUser>
      createAccount(input: Record<string, unknown>): Promise<unknown>
    }
    password: { hash(value: string): Promise<string> }
  }
  if ((await ctx.internalAdapter.findUserByEmail(email)) !== null) {
    return
  }
  const now = new Date()
  const user = await ctx.internalAdapter.createUser({
    email,
    name: email,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  })
  await ctx.internalAdapter.createAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await ctx.password.hash(password),
    createdAt: now,
    updatedAt: now,
  })
}

/** A copy of `init` with the bearer token attached, unless it already picks one. */
function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers)
  if (!headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return { ...init, headers }
}

/**
 * An `InMemorySessionStore` that counts its subscriptions, so a test can watch them come and
 * go — the only way to see that a stream released the session it was following.
 */
export class ObservableStore extends InMemorySessionStore {
  subscriptions = 0

  unsubscribed = 0

  override async subscribe(
    sessionId: SessionId,
    listener: Parameters<InMemorySessionStore['subscribe']>[1],
  ): ReturnType<InMemorySessionStore['subscribe']> {
    const unsubscribe = await super.subscribe(sessionId, listener)
    this.subscriptions += 1
    return () => {
      this.unsubscribed += 1
      unsubscribe()
    }
  }
}

/** A full {@link ServerConfig} for a test, listening on an ephemeral port. */
export function testConfig(options: TestOptions = {}): ServerConfig {
  return {
    port: 0,
    databaseUrl: undefined,
    scheduler: options.scheduler ?? 'local',
    betterAuthSecret: 'test-secret-that-is-at-least-32-characters-long',
    betterAuthUrl: options.betterAuthUrl ?? TEST_PUBLIC_URL,
    secretsKey: TEST_SECRETS_KEY,
    devLogin: options.devLogin ?? true,
    google: options.providers?.google,
    github: options.providers?.github,
    microsoft:
      options.providers?.microsoft === undefined
        ? undefined
        : {
            clientId: options.providers.microsoft.clientId,
            clientSecret: options.providers.microsoft.clientSecret,
            tenantId: options.providers.microsoft.tenantId ?? 'common',
          },
    testModel: undefined,
    webDir: options.webDir,
    corsOrigins: [],
    maxConcurrentSessions: options.maxConcurrentSessions ?? 4,
    drainTimeoutMs: options.drainTimeoutMs ?? 5000,
    instanceId: options.instanceId ?? 'test-instance',
    partitions: options.partitions ?? DEFAULT_PARTITION_COUNT,
    leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    sweepMs: options.sweepMs ?? DEFAULT_SWEEP_MS,
    deltaRetentionMs: options.deltaRetentionMs ?? DEFAULT_DELTA_RETENTION_MS,
    // Off unless a test asks: a compaction timer running under every test's feet would make
    // "the chunks are still there" assertions a race. The job's own suite turns it on.
    compactIntervalMs: options.compactIntervalMs ?? 0,
  }
}

// -------------------------------------------------------------------- HTTP helpers

/** POST a JSON body and return the response, without asserting anything about it. */
export function postJson(
  context: TestContext,
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return context.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headersOf(init) },
    body: JSON.stringify(body),
    ...init,
  })
}

/**
 * POST a JSON body with a specific caller's token.
 *
 * Tests that work with two users (isolation, credentials) build each request with this
 * instead of the context's default caller.
 */
export function postJsonAs(
  context: TestContext,
  token: string,
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return context.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headersOf(init),
    },
    body: JSON.stringify(body),
    ...init,
  })
}

/** A request as one specific caller. */
export function asUser(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` }
}

function headersOf(init: RequestInit): Record<string, string> {
  if (init.headers === undefined) {
    return {}
  }
  return init.headers instanceof Headers
    ? Object.fromEntries(init.headers)
    : (init.headers as Record<string, string>)
}

/**
 * Sign in over HTTP against a running server (the dev user by default) and answer the token.
 *
 * The counterpart of {@link TestContext.signIn} for tests that hold a `startServer` result —
 * they talk to the listener directly, so they have to authenticate directly too.
 */
export async function signInAt(
  baseUrl: string,
  email: string = DEV_LOGIN_EMAIL,
  password: string = DEV_LOGIN_PASSWORD,
): Promise<SignedIn> {
  return signInThrough((path, init) => fetch(`${baseUrl}${path}`, init), email, password)
}

/**
 * A `fetch` that carries a bearer token — the shape `/v1` needs now (A2).
 */
export function authedFetch(token: string): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetch(url, { ...init, headers })
  }
}

/** Create an agent over HTTP and return it. */
export async function httpCreateAgent(
  context: TestContext,
  overrides: Partial<{ name: string; model: { id: string }; system: string | null }> = {},
): Promise<Agent> {
  const response = await postJson(context, `${API_VERSION_PREFIX}/agents`, {
    name: 'Test agent',
    model: { id: 'openharness-test/test-model' },
    ...overrides,
  })
  if (response.status !== 201) {
    throw new Error(`creating an agent failed: ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as Agent
}

/** Create a session over HTTP and return it. */
export async function httpCreateSession(
  context: TestContext,
  agent: AgentId,
  extra: Record<string, unknown> = {},
): Promise<Session> {
  const response = await postJson(context, `${API_VERSION_PREFIX}/sessions`, {
    agent,
    ...extra,
  })
  if (response.status !== 201) {
    throw new Error(`creating a session failed: ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as Session
}

/** Send one `user.message` over HTTP and return the stored events. */
export async function httpSendMessage(
  context: TestContext,
  sessionId: SessionId,
  text: string,
): Promise<StoredEvent[]> {
  const response = await postJson(context, `${API_VERSION_PREFIX}/sessions/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
  })
  if (response.status !== 200) {
    throw new Error(`sending a message failed: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { data: StoredEvent[] }
  return body.data
}

/** Send one `user.interrupt` over HTTP. */
export async function httpInterrupt(
  context: TestContext,
  sessionId: SessionId,
): Promise<StoredEvent[]> {
  const response = await postJson(context, `${API_VERSION_PREFIX}/sessions/${sessionId}/events`, {
    events: [{ type: 'user.interrupt' }],
  })
  const body = (await response.json()) as { data: StoredEvent[] }
  return body.data
}

// -------------------------------------------------------------------- store helpers

/**
 * Every event in a session's log, in order, page by page.
 *
 * The default read is the replay read, which skips superseded chunks — what a client gets and
 * what most assertions are about. `includeSuperseded: true` reads the raw log, which is what a
 * test needs to see a chunk at all, or to see that compaction took it away.
 */
export async function readHistory(
  store: SessionStore,
  sessionId: SessionId,
  options: { readonly includeSuperseded?: boolean } = {},
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = []
  let afterSeq = 0
  for (;;) {
    const page = await store.listEventsUnscoped(sessionId, {
      afterSeq,
      limit: 100,
      order: 'asc',
      ...options,
    })
    events.push(...page.data)
    if (page.next_page === null || page.data.length === 0) {
      return events
    }
    afterSeq = page.data[page.data.length - 1]?.seq ?? afterSeq
  }
}

/** The `type` of every event in a session's log, which is what most assertions want. */
export async function historyTypes(store: SessionStore, sessionId: SessionId): Promise<string[]> {
  return (await readHistory(store, sessionId)).map((event) => event.type)
}

/** Wait until `check` says so, or fail with `message`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  options: { readonly timeoutMs?: number; readonly message?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) {
      return
    }
    if (Date.now() > deadline) {
      throw new Error(options.message ?? `condition not met within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
}

/** Wait until the session is idle with nothing queued. */
export async function waitForIdle(
  store: SessionStore,
  sessionId: SessionId,
  timeoutMs = 5000,
): Promise<void> {
  await waitFor(
    async () => {
      const pending = await store.getPendingUserEvents(sessionId)
      const turn = await store.getTurnState(sessionId)
      return pending.length === 0 && turn.state === 'idle'
    },
    { timeoutMs, message: `session ${sessionId} did not go idle` },
  )
}

/** The user id a test-owned resource belongs to when the test does not sign anyone in. */
export const TEST_OWNER_ID: UserId = 'user_test_owner'

/** The `BetterAuthInstance` type, re-exported for tests that reach for the instance. */
export type { BetterAuthInstance }
