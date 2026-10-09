import { ApiError, createClient } from '@openharness/client'
import { ApiErrorBodySchema, isStoredEvent } from '@openharness/protocol'
import { DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD, SESSION_INVALID_MESSAGE } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  DEV_LOGIN_STORED_EMAIL,
  agentMessages,
  clientFor,
  collectStream,
  e2eHarness,
  readLog,
  signIn,
  sleep,
  textOf,
  waitFor,
  waitForTurnEnd,
  withDatabaseClient,
  type ServerProcess,
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

/** The payload of the final `event: error` frame a stream ends with (#76). */
interface EndErrorFrame {
  readonly type: 'error'
  readonly error: { readonly type: string; readonly message: string }
}

/** A raw SSE response followed in the background: the frames, and whether the body ended. */
interface FollowedSse {
  /** The raw frames seen so far, in arrival order; comments and keepalives included. */
  readonly frames: readonly string[]
  /** Resolves when the body ends (or the connection is torn down). */
  readonly ended: Promise<void>
  /** Whether the body has ended. */
  readonly done: boolean
  /** The payload of the last `event: error` frame, if one arrived. */
  endError(): EndErrorFrame | null
}

/**
 * Follow an SSE response off the wire.
 *
 * Not through `@openharness/client`: the client skips the `event: error` goodbye — it is not
 * a `StreamEvent` — and learns the same fact from the 401 its reconnect gets. A test about
 * the goodbye itself has to read the frames.
 */
function followSse(response: Response): FollowedSse {
  if (response.body === null) {
    throw new Error('the stream response has no body')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []
  let buffer = ''
  let done = false
  const ended = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) {
          return
        }
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const end = buffer.indexOf('\n\n')
          if (end === -1) {
            break
          }
          frames.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 2)
        }
      }
    } catch {
      // The connection was torn down with the stream still open — the server was killed at
      // teardown, which is what a test that leaves someone's stream open invites. That is an
      // end too, and not a failure of anything the test is about.
    } finally {
      done = true
    }
  })()
  return {
    frames,
    ended,
    get done(): boolean {
      return done
    },
    endError: () => {
      for (let index = frames.length - 1; index >= 0; index -= 1) {
        const frame = frames[index]
        if (frame === undefined || !frame.startsWith('event: error')) {
          continue
        }
        const data = frame.split('\n').find((line) => line.startsWith('data: '))
        return data === undefined
          ? null
          : (JSON.parse(data.slice('data: '.length)) as EndErrorFrame)
      }
      return null
    },
  }
}

/** The `seq` of every message the followed stream delivered, in arrival order. */
function deliveredSeqs(stream: FollowedSse): number[] {
  return stream.frames.flatMap((frame) => {
    const data = frame.split('\n').find((line) => line.startsWith('data: '))
    if (data === undefined) {
      return []
    }
    try {
      const parsed = JSON.parse(data.slice('data: '.length)) as { seq?: unknown }
      return typeof parsed.seq === 'number' ? [parsed.seq] : []
    } catch {
      return []
    }
  })
}

/** Sign in over the dev login and answer the cookie a browser would hold (#76 tests). */
async function signInWithCookie(
  server: ServerProcess,
  email: string,
  password: string,
): Promise<{ token: string; cookie: string }> {
  const response = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    // The Origin a browser sends — required now that the servers run in production mode
    // (#79): without it, Node's `fetch` (which sends `sec-fetch-mode: cors`) is refused.
    headers: { 'content-type': 'application/json', origin: server.baseUrl },
    body: JSON.stringify({ email, password }),
  })
  const body = (await response.json()) as { token?: string }
  const setCookie = response.headers.get('set-cookie')
  if (!response.ok || typeof body.token !== 'string' || setCookie === null) {
    throw new Error(`signing in with a cookie failed: ${response.status}`)
  }
  return { token: body.token, cookie: setCookie.split(';')[0] ?? '' }
}

/** End a session the way the web app does (cookie) or `oh logout` does (bearer). */
function signOut(
  server: ServerProcess,
  credential: { readonly cookie: string } | { readonly token: string },
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if ('cookie' in credential) {
    // A cookie-authenticated write is origin-checked (CSRF); a bearer request cannot be.
    headers.cookie = credential.cookie
    headers.origin = server.baseUrl
  } else {
    headers.authorization = `Bearer ${credential.token}`
  }
  // Better Auth reads a JSON body for the call (an empty object is what the web app sends).
  return fetch(`${server.baseUrl}/api/auth/sign-out`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  })
}

/** Fail when `stream` has not ended `ms` after this is called. */
async function endedWithin(stream: FollowedSse, ms: number, what: string): Promise<void> {
  await Promise.race([
    stream.ended,
    sleep(ms).then(() => {
      throw new Error(`${what} did not end within ${String(ms)}ms`)
    }),
  ])
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

  it('revokes immediately: the old token opens no new stream, and the person is not locked out', async () => {
    // The epic's rule is that revocation is immediate (A2). For the plain routes that is the
    // guard's session lookup — the same refusal an absent or forged token gets, swept route by
    // route in `isolation.test.ts`, which owns each route's plain 401. The stream is the one
    // route whose revocation needs its own test here: it is a long-lived request, and this is
    // the re-open a dropped stream would attempt (the two tests below cover the already-open
    // connection, #76).
    const server = await harness.server()
    const signedIn = await harness.user(server)
    const client = clientFor(server, signedIn)

    const agent = await client.agents.create({
      name: 'Stream revocation agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await client.sessions.create({ agent: agent.id })

    // The token works while the session lives: a stream follows a turn.
    const stream = collectStream(client, session.id)
    const before = await client.sendMessage(session.id, 'before the sign-out')
    await stream.waitFor(
      (events) => events.some((event) => isStoredEvent(event) && event.seq === before.seq),
      'the stream to deliver a turn while the session is valid',
    )
    await stream.stop()

    await client.auth.signOut()

    // The revoked token opens nothing new: a fresh stream request is refused with the
    // protocol's envelope.
    const refused = await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`, {
      headers: { authorization: `Bearer ${signedIn.token}` },
    })
    expect(refused.status).toBe(401)
    expect(ApiErrorBodySchema.parse(await refused.json()).error.type).toBe('authentication_error')

    // And the person is not locked out: a fresh session carries on with the same session.
    const after = clientFor(server, await harness.user(server, { fresh: true }))
    const sent = await after.sendMessage(session.id, 'after the sign-out')
    await waitForTurnEnd(after, session.id, { afterSeq: sent.seq })
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

  it('ends an open stream when the browser session signs out (#76)', async () => {
    // A stream is one long request, so the `/v1` guard validated it once and never again; the
    // fix is that the connection watches its own session, and a revocation closes it with a
    // final `event: error` (the protocol's `authentication_error` envelope) — promptly, not on
    // some timeout. Someone else's stream must not be disturbed by it.
    const server = await harness.server()
    const alice = await signInWithCookie(server, DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD)
    const aliceClient = createClient({ baseUrl: server.baseUrl, token: alice.token })

    const agent = await aliceClient.agents.create({
      name: 'Revocation agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await aliceClient.sessions.create({ agent: agent.id })

    // A second person, whose stream is the control group.
    const bob = await harness.user(server, { email: 'bob@revocation.test', password: 'bob-pw' })
    const bobClient = clientFor(server, bob)
    const bobAgent = await bobClient.agents.create({
      name: 'Bystander agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const bobSession = await bobClient.sessions.create({ agent: bobAgent.id })

    const aliceStream = followSse(
      await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`, {
        headers: { cookie: alice.cookie },
      }),
    )
    const bobStream = followSse(
      await fetch(`${server.baseUrl}/v1/sessions/${bobSession.id}/events/stream`, {
        headers: { authorization: `Bearer ${bob.token}` },
      }),
    )

    // Both streams are established — each has delivered a first turn — before anything is
    // revoked, so the close cannot be blamed on the connection not having been up yet.
    const aSent = await aliceClient.sendMessage(session.id, 'before the sign-out')
    await waitFor(`A's stream to deliver seq ${String(aSent.seq)}`, () =>
      deliveredSeqs(aliceStream).includes(aSent.seq) ? true : undefined,
    )
    const bSent = await bobClient.sendMessage(bobSession.id, 'before the sign-out')
    await waitFor(`B's stream to deliver seq ${String(bSent.seq)}`, () =>
      deliveredSeqs(bobStream).includes(bSent.seq) ? true : undefined,
    )

    const signedOutAt = Date.now()
    const refusal = await signOut(server, { cookie: alice.cookie })
    expect(refusal.status).toBe(200)

    // A's stream gets the goodbye and ends within about two seconds of the sign-out.
    await endedWithin(aliceStream, 2000, "A's stream after the sign-out")
    expect(Date.now() - signedOutAt).toBeLessThan(2000)
    const frame = aliceStream.endError()
    expect(frame?.error.type).toBe('authentication_error')
    expect(frame?.error.message).toBe(SESSION_INVALID_MESSAGE)

    // B's stream is untouched, and still delivers: B sends another turn and sees it arrive.
    expect(bobStream.done).toBe(false)
    const bAfter = await bobClient.sendMessage(bobSession.id, 'after the other sign-out')
    await waitFor(`B's stream to deliver seq ${String(bAfter.seq)}`, () =>
      deliveredSeqs(bobStream).includes(bAfter.seq) ? true : undefined,
    )
    expect(bobStream.done).toBe(false)
  })

  it('ends an open stream when its bearer signs out (oh logout, #76)', async () => {
    const server = await harness.server()
    const alice = await harness.user(server)
    const client = clientFor(server, alice)

    const agent = await client.agents.create({
      name: 'Bearer revocation agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await client.sessions.create({ agent: agent.id })

    const stream = followSse(
      await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`, {
        headers: { authorization: `Bearer ${alice.token}` },
      }),
    )
    const sent = await client.sendMessage(session.id, 'before the bearer sign-out')
    await waitFor(`the stream to deliver seq ${String(sent.seq)}`, () =>
      deliveredSeqs(stream).includes(sent.seq) ? true : undefined,
    )

    // `oh logout`'s path: the same `/api/auth/sign-out`, authenticated with the bearer.
    const refusal = await signOut(server, { token: alice.token })
    expect(refusal.status).toBe(200)

    await endedWithin(stream, 2000, 'the stream after the bearer sign-out')
    const frame = stream.endError()
    expect(frame?.error.type).toBe('authentication_error')
    expect(frame?.error.message).toBe(SESSION_INVALID_MESSAGE)
  })
})
