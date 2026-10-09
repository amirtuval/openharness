import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { API_VERSION_PREFIX, type SessionId } from '@openharness/protocol'
import type { PostgresSchema } from '@openharness/session/postgres'

import {
  ObservablePostgresStore,
  POSTGRES_STARTUP_TIMEOUT_MS,
  openSse,
  postgresSource,
  startPostgres,
  startTestServer,
  waitFor,
  type PostgresFixture,
  type SseReader,
  type TestContext,
} from './test-support'

/**
 * Revocation closes a stream across instances, and on an operator's SQL (epic #65, A2; issue
 * #76), over the store a real deployment runs.
 *
 * Two things only Postgres can prove:
 *
 * - **the notification channel.** One server instance holds the stream, another handles the
 *   sign-out; the revocation travels between them as a `NOTIFY` on the store's revocation
 *   channel (`notifyAuthSessionRevoked` / `onAuthSessionRevoked`), and the stream closes
 *   within about a second even though the instance that published never saw it.
 * - **the trigger.** An operator deletes the session row with SQL — no Better Auth call
 *   anywhere — and the stream still closes promptly: `0014_auth_session_revocation.sql`
 *   announces every row deleted from `"session"`.
 *
 * The multi-instance shape follows `partition-scheduler.test.ts`: one database, one pool, a
 * separate store — its own listening connection — per instance.
 *
 * `DATABASE_URL` when it is set, otherwise Postgres in a container when a Docker daemon is
 * around, otherwise **skipped with a note**.
 */

const SOURCE = postgresSource()

/** A Kysely handle over the fixture's pool, for Better Auth's tables and raw SQL. */
function fixtureDb(fixture: PostgresFixture): Kysely<PostgresSchema> {
  return new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool: fixture.pool }) })
}

if (SOURCE === null) {
  describe.skip('stream revocation on Postgres (skipped: no DATABASE_URL, no Docker)', () => {
    it('would run against a real database', () => {
      expect.unreachable('unreachable: the suite is skipped')
    })
  })
} else {
  let db: PostgresFixture | undefined
  const contexts: TestContext[] = []

  beforeAll(async () => {
    db = await startPostgres()
  }, POSTGRES_STARTUP_TIMEOUT_MS)

  afterEach(async () => {
    for (const context of contexts.splice(0).reverse()) {
      await context.close()
    }
    await db?.truncate()
  })

  afterAll(async () => {
    await db?.close()
    db = undefined
  })

  /** The path of a session's stream. */
  function streamPath(sessionId: SessionId): string {
    return `${API_VERSION_PREFIX}/sessions/${sessionId}/events/stream`
  }

  /** Create an agent and a session as one caller, over HTTP, against one instance. */
  async function createChat(
    instance: TestContext,
    token: string,
  ): Promise<{ sessionId: SessionId }> {
    const post = (path: string, body: unknown): Promise<Response> =>
      instance.anonymous(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
    const agentResponse = await post(`${API_VERSION_PREFIX}/agents`, {
      name: 'Test agent',
      model: { id: 'openharness-test/test-model' },
    })
    const agent = (await agentResponse.json()) as { id: string }
    const sessionResponse = await post(`${API_VERSION_PREFIX}/sessions`, { agent: agent.id })
    const session = (await sessionResponse.json()) as { id: SessionId }
    return { sessionId: session.id }
  }

  /** Open a session's stream and wait until the server has it registered and subscribed. */
  async function openReadyStream(
    store: ObservablePostgresStore,
    instance: TestContext,
    sessionId: SessionId,
    token: string,
  ): Promise<SseReader> {
    const before = store.subscriptions
    const response = await instance.anonymous(streamPath(sessionId), {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const reader = openSse(response)
    await waitFor(() => store.subscriptions > before, {
      message: 'the stream never subscribed to the store',
    })
    return reader
  }

  /**
   * How long the stream took to end after the revocation, in milliseconds.
   *
   * The end is the server's final `event: error` frame (issue #76), not the test dropping the
   * connection — and the bound is what says the *notification* closed it, not the periodic
   * re-check, whose default is fifteen seconds.
   */
  async function waitForEnd(reader: SseReader, timeoutMs = 3000): Promise<number> {
    const started = Date.now()
    await waitFor(() => reader.endError !== null, {
      timeoutMs,
      message: 'the server never sent the final event: error frame',
    })
    return Date.now() - started
  }

  describe('a revocation reaches every instance (A2/#76)', () => {
    it('closes, within about a second, a stream held by the other instance', async () => {
      const fixture = requireFixture(db)
      // The holder: the instance whose stream must close. Observable, so the test knows the
      // connection is established before the session goes.
      const holderStore = fixture.track(new ObservablePostgresStore({ pool: fixture.pool }))
      const holder = await startTestServer({
        store: holderStore,
        authDatabase: { kind: 'postgres', db: fixtureDb(fixture) },
      })
      const signerOut = await startTestServer({
        store: fixture.store(),
        authDatabase: { kind: 'postgres', db: fixtureDb(fixture) },
      })
      contexts.push(holder, signerOut)

      // The session the stream authenticates with is created on the holder...
      const alice = await holder.signIn()
      const { sessionId } = await createChat(holder, alice.token)
      const reader = await openReadyStream(holderStore, holder, sessionId, alice.token)

      // ...and revoked on the other instance, which never saw the stream. The deletion
      // publishes on the shared channel; the holder's listening connection is what closes it.
      const out = await signerOut.anonymous('/api/auth/sign-out', {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(out.status).toBe(200)

      const latency = await waitForEnd(reader)
      expect(latency).toBeLessThan(1000)
      expect(reader.endError).toMatchObject({
        type: 'error',
        error: { type: 'authentication_error' },
      })
    })

    it('closes a stream when an operator deletes the session row with SQL', async () => {
      const fixture = requireFixture(db)
      const store = fixture.track(new ObservablePostgresStore({ pool: fixture.pool }))
      const instance = await startTestServer({
        store,
        authDatabase: { kind: 'postgres', db: fixtureDb(fixture) },
      })
      contexts.push(instance)

      const alice = await instance.signIn()
      const { sessionId } = await createChat(instance, alice.token)
      const reader = await openReadyStream(store, instance, sessionId, alice.token)

      // No sign-out API and no Better Auth: this is the operator's `delete from`, which the
      // trigger on `"session"` is what catches (0014_auth_session_revocation.sql).
      const deleted = await sql`
        delete from "session" where token = ${alice.token}
      `.execute(fixtureDb(fixture))
      expect(deleted.numAffectedRows).toBe(1n)

      const latency = await waitForEnd(reader)
      expect(latency).toBeLessThan(1000)
      expect(reader.endError?.error.type).toBe('authentication_error')
    })

    it('refuses the reconnect a closed client makes, so it stops instead of looping', async () => {
      const fixture = requireFixture(db)
      const store = fixture.track(new ObservablePostgresStore({ pool: fixture.pool }))
      const instance = await startTestServer({
        store,
        authDatabase: { kind: 'postgres', db: fixtureDb(fixture) },
      })
      contexts.push(instance)

      const alice = await instance.signIn()
      const { sessionId } = await createChat(instance, alice.token)
      const reader = await openReadyStream(store, instance, sessionId, alice.token)

      const out = await instance.anonymous('/api/auth/sign-out', {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(out.status).toBe(200)
      await waitForEnd(reader)

      // `@openharness/client` reconnects once after the server closes a stream; the 401 that
      // answers it is an AuthenticationError and is never retried, which is where the loop
      // stops and the caller learns to sign in.
      const reconnect = await instance.anonymous(streamPath(sessionId), {
        headers: { authorization: `Bearer ${alice.token}` },
      })
      expect(reconnect.status).toBe(401)
    })
  })

  /** The fixture `beforeAll` built; a test that runs without one is a bug in the suite. */
  function requireFixture(fixture: PostgresFixture | undefined): PostgresFixture {
    if (fixture === undefined) {
      throw new Error('the Postgres fixture was never started')
    }
    return fixture
  }
}
