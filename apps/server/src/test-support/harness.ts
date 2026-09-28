import type { Hono } from 'hono'
import {
  API_KEY_HEADER,
  API_VERSION_PREFIX,
  DEFAULT_PARTITION_COUNT,
  type Agent,
  type AgentId,
  type Session,
  type SessionId,
  type StoredEvent,
} from '@openharness/protocol'
import { InMemorySessionStore, type SessionStore } from '@openharness/session'

import { createApp } from '../app'
import type { SchedulerKind, ServerConfig } from '../config'
import { startServer } from '../main'
import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_SWEEP_MS,
} from '../partition-scheduler'
import { LocalScheduler, type SessionScheduler } from '../scheduler'
import { type AppEnv, silentLogger } from '../types'
import { type ScriptedModel, type ScriptedReply, createScriptedModel } from './model'

/**
 * Starting a server for a test: a fresh in-memory store, a scheduler with a scripted model,
 * and either the Hono app called in-process or a real listener on an ephemeral port.
 *
 * The in-memory store is the point — it is the reference implementation of the contract every
 * other package tests against, so a test here says something about a Postgres-backed server
 * as well. A test that needs a socket (SSE, the AI SDK transport) uses
 * {@link startTestServer}; everything else goes through {@link createTestApp}, which is a
 * plain function call.
 */

/** How a test talks to the server it built. */
export interface TestContext {
  /** The store the app is running against. */
  readonly store: InMemorySessionStore
  /** The scripted model, for tests that script replies or assert on prompts. */
  readonly model: ScriptedModel
  /** The scheduler running the brains. */
  readonly scheduler: SessionScheduler
  /** The Hono app, called in-process. */
  readonly app: Hono<AppEnv>
  /** Fire a request at the app or the listener, depending on how it was built. */
  request(path: string, init?: RequestInit): Promise<Response>
  /** The base URL, when the context is a real listener; `null` in-process. */
  readonly url: string | null
  /** Stop the scheduler and the listener, if there is one. */
  close(): Promise<void>
  /** Issue an API key, for a test that configured one. */
  readonly apiKey: string | undefined
}

/** Options shared by {@link createTestApp} and {@link startTestServer}. */
export interface TestOptions {
  /** Run against this store instead of a fresh in-memory one. */
  readonly store?: InMemorySessionStore
  /** Require this key on `/v1/*`. */
  readonly apiKey?: string
  /** Serve a built web app from this directory. */
  readonly webDir?: string
  /** Replies the scripted model answers with, in order; the last one repeats. */
  readonly replies?: readonly ScriptedReply[]
  /** How many sessions may run at once. */
  readonly maxConcurrentSessions?: number
  /** How long a shutdown waits for a turn in flight. */
  readonly drainTimeoutMs?: number
  /** The SSE keepalive interval. */
  readonly sseKeepaliveMs?: number
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
}

/** Build an app, a store and a scheduler in-process; nothing listens. */
export function createTestApp(options: TestOptions = {}): TestContext {
  const store = options.store ?? new InMemorySessionStore()
  const model = createScriptedModel(...(options.replies ?? []))
  const scheduler = new LocalScheduler({
    store,
    model: model.factory,
    ...(options.maxConcurrentSessions === undefined
      ? {}
      : { maxConcurrentSessions: options.maxConcurrentSessions }),
    ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    onError: () => {},
  })
  const app = createApp({
    store,
    scheduler,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.webDir === undefined ? {} : { webDir: options.webDir }),
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
    logger: silentLogger,
  })
  return {
    store,
    model,
    scheduler,
    app,
    url: null,
    apiKey: options.apiKey,
    request: async (path, init) => app.request(path, init),
    close: () => scheduler.stop(),
  }
}

/** Start a real listening server on an ephemeral port. */
export async function startTestServer(options: TestOptions = {}): Promise<TestContext> {
  const store = options.store ?? new InMemorySessionStore()
  const model = createScriptedModel(...(options.replies ?? []))
  const started = await startServer({
    config: testConfig(options),
    store,
    model: model.factory,
    logger: silentLogger,
    ...(options.sseKeepaliveMs === undefined ? {} : { sseKeepaliveMs: options.sseKeepaliveMs }),
  })
  const baseUrl = `http://127.0.0.1:${started.port}`
  return {
    store,
    model,
    scheduler: started.scheduler,
    app: started.app,
    url: baseUrl,
    apiKey: options.apiKey,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    close: () => started.shutdown(),
  }
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
    apiKey: options.apiKey,
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
    headers: { 'content-type': 'application/json', ...headersFor(context, init) },
    body: JSON.stringify(body),
    ...init,
  })
}

/** The `x-api-key` header a context's key requires, when the test did not set one. */
function headersFor(context: TestContext, init: RequestInit): Record<string, string> {
  if (context.apiKey === undefined || headerOf(init.headers, API_KEY_HEADER) !== undefined) {
    return {}
  }
  return { [API_KEY_HEADER]: context.apiKey }
}

function headerOf(headers: HeadersInit | undefined, name: string): string | undefined {
  if (headers === undefined) {
    return undefined
  }
  const record = headers instanceof Headers ? Object.fromEntries(headers) : headers
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase() && typeof value === 'string') {
      return value
    }
  }
  return undefined
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

/** Every event in a session's log, in order, page by page. */
export async function readHistory(
  store: SessionStore,
  sessionId: SessionId,
): Promise<StoredEvent[]> {
  const events: StoredEvent[] = []
  let afterSeq = 0
  for (;;) {
    const page = await store.listEvents(sessionId, { afterSeq, limit: 100, order: 'asc' })
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
