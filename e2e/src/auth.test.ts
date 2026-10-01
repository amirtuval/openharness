import { ApiError, createClient } from '@openharness/client'
import { ApiErrorBodySchema } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  DEV_LOGIN_STORED_EMAIL,
  agentMessages,
  clientFor,
  collectStream,
  e2eHarness,
  readLog,
  signIn,
  textOf,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * Real authentication, end to end (epic #65, A2/A7): the server a deployment runs — its own
 * process, its own database — is not open any more.
 *
 * The dev login is the handle this suite turns. A real deployment signs users in with Google,
 * GitHub or Microsoft, which an e2e test cannot drive; `OPENHARNESS_DEV_LOGIN=1` is the
 * documented local door (A7), and what it proves is the machinery behind every door: a
 * sign-in creates a session row, the session token authenticates `/v1` as a bearer, and
 * signing out revokes it.
 */

const harness = e2eHarness('auth')

/** Run `work` and answer the {@link ApiError} it threw. */
async function errorOf(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work()
  } catch (error) {
    if (error instanceof ApiError) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to fail, but it resolved')
}

describe('a server that authenticates', () => {
  it('refuses /v1 without a session, and leaves /health open', async () => {
    const server = await harness.server()

    const health = await fetch(`${server.baseUrl}/health`)
    expect(health.status).toBe(200)
    const healthBody: unknown = await health.json()
    expect(healthBody).toEqual({ status: 'ok' })

    // The protocol's envelope, with the request id a support ticket would quote.
    const refusal = await fetch(`${server.baseUrl}/v1/agents`)
    expect(refusal.status).toBe(401)
    const requestId = refusal.headers.get('request-id')
    expect(requestId).toMatch(/^req_/)
    const envelope = ApiErrorBodySchema.parse(await refusal.json())
    expect(envelope.error.type).toBe('authentication_error')
    expect(envelope.error.message.length).toBeGreaterThan(0)
    expect(envelope.request_id).toBe(requestId)

    // The SDK turns it into the typed, never-retryable 401: a client with no token at all.
    const anonymous = createClient({ baseUrl: server.baseUrl })
    const missing = await errorOf(() => anonymous.agents.list())
    expect(missing.status).toBe(401)
    expect(missing.type).toBe('authentication_error')
    expect(missing.retryable).toBe(false)
  })

  it('rejects a bearer token that is not a session', async () => {
    const server = await harness.server()

    const response = await fetch(`${server.baseUrl}/v1/me`, {
      headers: { authorization: 'Bearer not-a-session-token' },
    })

    expect(response.status).toBe(401)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('authentication_error')
  })

  it('reports its sign-in to an unauthenticated reader', async () => {
    const server = await harness.server()

    const response = await fetch(`${server.baseUrl}/v1/auth-config`)
    expect(response.status).toBe(200)
    // No social providers are configured in the e2e environment; the dev login is on.
    await expect(response.json()).resolves.toEqual({ providers: [], dev_login: true })
  })

  it('signs in with the dev user, and the session runs a turn as a bearer', async () => {
    const server = await harness.server()
    const signedIn = await signIn(server)
    // The documented address is what a person types; the row carries the dotted spelling
    // Better Auth's email validation requires (see `auth.ts`).
    expect(signedIn.user.email).toBe(DEV_LOGIN_STORED_EMAIL)

    const client = await harness.client(server)
    const me = await client.me()
    expect(me.id).toBe(signedIn.user.id)

    const agent = await client.agents.create({
      name: 'Echo agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    expect(agent.owner_id).toBe(signedIn.user.id)

    const session = await client.sessions.create({ agent: agent.id })
    const sent = await client.sendMessage(session.id, 'hello from behind a session')
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

    const log = await readLog(client, session.id)
    expect(agentMessages(log).map(textOf)).toEqual(['hello from behind a session'])

    // The SSE route needs the session too — which is why `@openharness/client` streams over
    // `fetch` (it can send the header) instead of `EventSource` (it cannot).
    const stream = await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`)
    expect(stream.status).toBe(401)
  })

  it('revokes the session on sign-out', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    expect((await client.me()).email).toBe(DEV_LOGIN_STORED_EMAIL)

    await client.auth.signOut()

    const refused = await errorOf(() => client.me())
    expect(refused.status).toBe(401)
    expect(refused.type).toBe('authentication_error')

    // A fresh sign-in still works: only the session that signed out is gone.
    const again = await harness.client(server, { fresh: true })
    expect((await again.me()).email).toBe(DEV_LOGIN_STORED_EMAIL)
  })

  it('revokes immediately: every route, the stream included, refuses the old token', async () => {
    const server = await harness.server()
    const signedIn = await harness.user(server)
    const client = clientFor(server, signedIn)

    const agent = await client.agents.create({
      name: 'Revoked agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await client.sessions.create({ agent: agent.id })

    await client.auth.signOut()

    // Revocation is a row deletion (A2), so every request that carries the token is refused
    // from the next one on — including the session the person was just using.
    const refused = await errorOf(() => client.sessions.get(session.id))
    expect(refused.status).toBe(401)

    const stream = await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`, {
      headers: { authorization: `Bearer ${signedIn.token}` },
    })
    expect(stream.status).toBe(401)

    // And the person is not locked out: signing in again works, on a new session.
    const again = await harness.user(server, { fresh: true })
    const returned = clientFor(server, again)
    expect((await returned.sessions.get(session.id)).id).toBe(session.id)
  })

  it('refuses a session that has lapsed', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const signedIn = await harness.user(server)
    const client = clientFor(server, signedIn)
    expect((await client.me()).email).toBe(DEV_LOGIN_STORED_EMAIL)

    // Seven days is not something a test waits out; the row is aged instead, which is the same
    // state a laptop left closed over a week would be in (A2: sessions do not slide unless
    // they are used).
    await withDatabaseClient(
      async (db) => {
        await db.query(`update "session" set "expiresAt" = now() - interval '1 minute'`)
      },
      { database: database.name },
    )

    const refused = await errorOf(() => client.me())
    expect(refused.status).toBe(401)
    expect(refused.type).toBe('authentication_error')
  })

  it('revokes immediately: a stream cannot be opened again with the old token', async () => {
    // The epic's rule is that revocation is immediate (A2), and this is the half of it that
    // holds everywhere: the session row is gone, so nothing new can be started with its token —
    // including a fresh `GET …/events/stream`, which is how a dropped stream would come back.
    //
    // The other half — a stream that is *already open* when the revocation happens — is
    // issue amirtuval/openharness#76: `createSessionEventStream` never asks again whose session
    // it is following, so whether the connection keeps delivering depends on whether it drops
    // first: when it does, the client's reconnect is refused (401) and the stream ends, which
    // is why a CI run does not reproduce it; on a machine where the connection stays up, the
    // events keep arriving after the sign-out. The fix belongs in `apps/server` (re-check the
    // session while a stream is open); a test for it cannot be written here without depending
    // on which of the two happens, so #76 carries the reproduction instead.
    const server = await harness.server()
    const signedIn = await harness.user(server)
    const client = clientFor(server, signedIn)

    const agent = await client.agents.create({
      name: 'Stream revocation agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await client.sessions.create({ agent: agent.id })

    const stream = collectStream(client, session.id)
    const before = await client.sendMessage(session.id, 'before the sign-out')
    await stream.waitFor(
      (events) => events.some((event) => event.seq === before.seq),
      'the stream to deliver a turn while the session is valid',
    )
    await stream.stop()

    await client.auth.signOut()

    // The revoked token opens nothing: not a stream, not a read, not a `me`.
    const refused = await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`, {
      headers: { authorization: `Bearer ${signedIn.token}` },
    })
    expect(refused.status).toBe(401)
    expect(ApiErrorBodySchema.parse(await refused.json()).error.type).toBe('authentication_error')
    expect((await errorOf(() => client.me())).status).toBe(401)

    // And the person is not locked out: a fresh session carries on with the same session.
    const after = clientFor(server, await harness.user(server, { fresh: true }))
    const sent = await after.sendMessage(session.id, 'after the sign-out')
    await waitForTurnEnd(after, session.id, { afterSeq: sent.seq })
  })
})
