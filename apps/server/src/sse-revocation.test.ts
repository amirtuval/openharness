import { afterEach, describe, expect, it } from 'vitest'
import { DefaultChatTransport, type UIMessage, type UIMessageChunk } from 'ai'
import { API_VERSION_PREFIX, EVENT_TYPES, type SessionId } from '@openharness/protocol'

import { type Auth } from './auth'
import { SESSION_INVALID_MESSAGE } from './sse'
import {
  ObservableStore,
  TEST_PUBLIC_URL,
  defer,
  openSse,
  signInCookie,
  startTestServer,
  waitFor,
  type SseReader,
  type TestContext,
} from './test-support'

/**
 * A revoked (or expired) session ends the long-lived responses that were opened with it
 * (epic #65, A2; issue #76).
 *
 * The `/v1` guard validates a request once, so an SSE stream — one long request — has to
 * watch its own session. Two mechanisms do, and these tests drive both: the revocation
 * notification published when the session row is deleted (sign-out, `oh logout`, an
 * operator's deletion), and the periodic re-check, which is what catches an expired session.
 * What a client sees either way is the same: a final `event: error` frame carrying the
 * protocol's `authentication_error`, and a closed connection — so `@openharness/client`
 * reconnects once (its own resume loop), gets a 401, and stops.
 *
 * The revocation notification travels through the store's revocation channel. These tests run
 * the in-memory store, where it is in-process; `sse-revocation-postgres.test.ts` runs the
 * same closure across two server instances on one Postgres.
 */

let context: TestContext | undefined
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
  await context?.close()
  context = undefined
})

/** The path of a session's stream. */
function streamPath(sessionId: SessionId): string {
  return `${API_VERSION_PREFIX}/sessions/${sessionId}/events/stream`
}

/** POST `/api/auth/sign-out` with a cookie, as the web app does. */
function signOutWithCookie(test: TestContext, cookie: string): Promise<Response> {
  return test.anonymous('/api/auth/sign-out', {
    method: 'POST',
    headers: { cookie, origin: TEST_PUBLIC_URL, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

/** POST `/api/auth/sign-out` with a bearer token, as `oh logout` does. */
function signOutWithBearer(test: TestContext, token: string): Promise<Response> {
  return test.anonymous('/api/auth/sign-out', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
}

/**
 * Open a session's stream with one caller's bearer token.
 *
 * `anonymous` rather than `request` on purpose: the latter would sign the harness's default
 * caller in to attach *its* token, and a test that signs three callers in by hand would trip
 * Better Auth's sign-in limit (three per ten seconds, per instance).
 */
async function openStream(
  test: TestContext,
  sessionId: SessionId,
  token: string,
): Promise<SseReader> {
  const response = await test.anonymous(streamPath(sessionId), {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  return openSse(response)
}

/**
 * Open a stream and wait until the server has it registered and subscribed.
 *
 * The registration (and the `LISTEN`-like subscription behind it) happens when the response
 * body starts being read, a moment after the headers answer `200`. A test that revokes the
 * session in that window would be testing something else — the re-check, seconds later — so
 * it waits for the subscription count on the {@link ObservableStore} the server runs on.
 */
async function openReadyStream(
  store: ObservableStore,
  test: TestContext,
  sessionId: SessionId,
  token: string,
): Promise<SseReader> {
  const before = store.subscriptions
  const reader = await openStream(test, sessionId, token)
  await waitFor(() => store.subscriptions > before, {
    message: 'the stream never subscribed to the store',
  })
  return reader
}

/** POST as one caller, with their bearer token and nothing of the harness's default caller. */
function postAs(test: TestContext, token: string, path: string, body: unknown): Promise<Response> {
  return test.anonymous(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

/** Create an agent and a session as one caller, over HTTP. */
async function createChat(
  test: TestContext,
  token: string,
): Promise<{ agentId: string; sessionId: SessionId }> {
  const agentResponse = await postAs(test, token, `${API_VERSION_PREFIX}/agents`, {
    name: 'Test agent',
    model: { id: 'openharness-test/test-model' },
  })
  const agent = (await agentResponse.json()) as { id: string }
  const sessionResponse = await postAs(test, token, `${API_VERSION_PREFIX}/sessions`, {
    agent: agent.id,
  })
  const session = (await sessionResponse.json()) as { id: SessionId }
  return { agentId: agent.id, sessionId: session.id }
}

/** Send one message as one caller, so the caller's open streams deliver an event. */
async function sendMessage(
  test: TestContext,
  token: string,
  sessionId: SessionId,
  text: string,
): Promise<void> {
  const response = await postAs(test, token, `${API_VERSION_PREFIX}/sessions/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
  })
  expect(response.status).toBe(200)
}

/**
 * Wait for the stream to end on its own — the server closed it, not the test — and answer how
 * long that took, in milliseconds.
 *
 * What "ended" means here is the reader having seen the server's final `event: error` frame
 * (issue #76): a stream that simply died without one would leave `endError` null and this
 * would time out.
 */
async function waitForEnd(reader: SseReader, timeoutMs = 3000): Promise<number> {
  const started = Date.now()
  await waitFor(() => reader.endError !== null, {
    timeoutMs,
    message: 'the server never sent the final event: error frame',
  })
  return Date.now() - started
}

/** The Better Auth internals these tests reach: the adapter that owns the session rows. */
async function internalAdapterOf(auth: Auth): Promise<{
  deleteSession(token: string): Promise<void>
  updateSession(token: string, session: Record<string, unknown>): Promise<unknown>
}> {
  const context = (await auth.auth.$context) as unknown as {
    internalAdapter: {
      deleteSession(token: string): Promise<void>
      updateSession(token: string, session: Record<string, unknown>): Promise<unknown>
    }
  }
  return context.internalAdapter
}

describe('a revoked session ends its open stream', () => {
  it('when the session signs out with its cookie, within about a second', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store })
    context = test
    const cookie = await signInCookie(test)
    const { sessionId } = await createChat(test, (await test.signIn()).token)

    const response = await test.anonymous(streamPath(sessionId), { headers: { cookie } })
    expect(response.status).toBe(200)
    const reader = openSse(response)
    cleanups.push(() => reader.close())
    await waitFor(() => store.subscriptions > 0, {
      message: 'the stream never subscribed to the store',
    })

    expect((await signOutWithCookie(test, cookie)).status).toBe(200)

    const latency = await waitForEnd(reader)
    expect(latency).toBeLessThan(1000)
    expect(reader.endError).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    })
    // The connection really ended: nothing follows the final frame.
    expect(await reader.next(500)).toBeNull()
  })

  it('when the session signs out with its bearer token (oh logout)', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store })
    context = test
    const alice = await test.signIn()
    const { sessionId } = await createChat(test, alice.token)
    const reader = await openReadyStream(store, test, sessionId, alice.token)
    cleanups.push(() => reader.close())

    expect((await signOutWithBearer(test, alice.token)).status).toBe(200)

    const latency = await waitForEnd(reader)
    expect(latency).toBeLessThan(1000)
    expect(reader.endError?.error.type).toBe('authentication_error')
    // The API agrees the session is gone: a reconnect is refused, which is what stops
    // `@openharness/client`'s resume loop (a 401 is never retryable).
    const reconnect = await test.anonymous(streamPath(sessionId), {
      headers: { authorization: `Bearer ${alice.token}` },
    })
    expect(reconnect.status).toBe(401)
  })

  it('when the user revokes the session’s siblings ("revoke other sessions")', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store })
    context = test
    const stale = await test.signIn()
    const kept = await test.signIn()
    const staleChat = await createChat(test, stale.token)
    const keptChat = await createChat(test, kept.token)
    const staleReader = await openStream(test, staleChat.sessionId, stale.token)
    const keptReader = await openStream(test, keptChat.sessionId, kept.token)
    cleanups.push(() => {
      staleReader.close()
      keptReader.close()
    })
    await waitFor(() => store.subscriptions >= 2, {
      message: 'the streams never subscribed to the store',
    })

    // The bulk path: one request deletes every *other* session of the user — the deletion the
    // per-row hooks have to cover for the closure to be prompt.
    const out = await test.anonymous('/api/auth/revoke-other-sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${kept.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(out.status).toBe(200)

    const latency = await waitForEnd(staleReader)
    expect(latency).toBeLessThan(1000)
    expect(staleReader.endError?.error.type).toBe('authentication_error')

    // The session that asked was not one of the "others": its stream lives on.
    await sendMessage(test, kept.token, keptChat.sessionId, 'still here')
    const message = await keptReader.next(2000)
    expect(message?.event).toMatchObject({ type: EVENT_TYPES.userMessage })
    expect(keptReader.endError).toBeNull()
  })

  it('announces the session id and never the token', async () => {
    const test = await startTestServer()
    context = test
    const alice = await test.signIn()
    const announced: string[] = []
    await test.store.onAuthSessionRevoked((authSessionId) => {
      announced.push(authSessionId)
    })

    expect((await signOutWithBearer(test, alice.token)).status).toBe(200)
    await waitFor(() => announced.length > 0, { message: 'the revocation was never announced' })

    // What travels is the row's id — an identifier every read of the session table shows —
    // and never the token, which is the credential itself.
    expect(announced).toHaveLength(1)
    expect(announced[0]).not.toBe(alice.token)
    expect(JSON.stringify(announced)).not.toContain(alice.token)
  })

  it('when the session row is deleted through Better Auth (operator revocation)', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store })
    context = test
    const alice = await test.signIn()
    const { sessionId } = await createChat(test, alice.token)
    const reader = await openReadyStream(store, test, sessionId, alice.token)
    cleanups.push(() => reader.close())

    // No sign-out API here: the row goes the way an operator tool would remove it.
    await (await internalAdapterOf(test.auth)).deleteSession(alice.token)

    const latency = await waitForEnd(reader)
    expect(latency).toBeLessThan(1000)
    expect(reader.endError?.error.type).toBe('authentication_error')
  })

  it('when the session expires, on the stream’s own re-check', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store, sessionRecheckMs: 25 })
    context = test
    const alice = await test.signIn()
    const { sessionId } = await createChat(test, alice.token)
    const reader = await openReadyStream(store, test, sessionId, alice.token)
    cleanups.push(() => reader.close())

    // Nothing is deleted: the session simply lives too long. Moving its expiry into the past
    // is what a test cannot do to real time, and the re-check asks Better Auth itself, so an
    // expired session is refused exactly as it would be after seven days.
    await (
      await internalAdapterOf(test.auth)
    ).updateSession(alice.token, {
      expiresAt: new Date(Date.now() - 60_000),
    })

    const latency = await waitForEnd(reader)
    expect(latency).toBeLessThan(1000)
    expect(reader.endError).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    })
  })

  it('and leaves other sessions’ and other users’ streams alone', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store })
    context = test
    const alice = await test.signIn()
    const aliceAgain = await test.signIn()
    const bob = await test.signIn('bob@example.com')
    const aliceChat = await createChat(test, alice.token)
    const aliceAgainChat = await createChat(test, aliceAgain.token)
    const bobChat = await createChat(test, bob.token)

    const revoked = await openStream(test, aliceChat.sessionId, alice.token)
    const sameUser = await openStream(test, aliceAgainChat.sessionId, aliceAgain.token)
    const otherUser = await openStream(test, bobChat.sessionId, bob.token)
    cleanups.push(() => {
      revoked.close()
      sameUser.close()
      otherUser.close()
    })
    await waitFor(() => store.subscriptions >= 3, {
      message: 'the three streams never subscribed to the store',
    })

    expect((await signOutWithBearer(test, alice.token)).status).toBe(200)
    await waitForEnd(revoked)

    // Both survivors still deliver: the closure followed the session, not the user or the
    // store.
    await sendMessage(test, aliceAgain.token, aliceAgainChat.sessionId, 'still here')
    await sendMessage(test, bob.token, bobChat.sessionId, 'still here too')
    for (const reader of [sameUser, otherUser]) {
      const message = await reader.next(2000)
      expect(message?.event).toMatchObject({ type: EVENT_TYPES.userMessage })
      expect(reader.endError).toBeNull()
    }
  })
})

describe('the AI SDK adapter ends with its session (A2/#76)', () => {
  it('closes the response with an error chunk when the session is revoked', async () => {
    const held = defer()
    const test = await startTestServer({
      replies: [
        {
          text: ['one ', 'two ', 'three ', 'four '],
          onChunk: (_chunk, index) => (index === 2 ? held.promise : undefined),
        },
      ],
    })
    context = test
    const alice = await test.signIn()
    const { sessionId } = await createChat(test, alice.token)

    const transport = new DefaultChatTransport({
      api: `${test.url}${API_VERSION_PREFIX}/sessions/${sessionId}/ai-sdk/chat`,
      headers: { authorization: `Bearer ${alice.token}` },
    })
    const messages: UIMessage[] = [
      { id: 'message-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    ]
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: sessionId,
      messageId: undefined,
      messages,
      abortSignal: undefined,
    })
    const chunks: UIMessageChunk[] = []
    let ended = false
    void (async () => {
      for await (const chunk of stream) {
        chunks.push(chunk)
      }
      ended = true
    })()
    // If the test fails before the server closes the stream, let the turn go and drop the
    // connection so nothing hangs on a held reply.
    cleanups.push(() => {
      held.release()
      if (!stream.locked) {
        void stream.cancel().catch(() => undefined)
      }
    })

    // Wait until the reply is streaming — the turn is held at its third chunk, so two chunks
    // have arrived and the response is open — before the session goes: signing out first
    // would 401 the chat request itself, which is not the behaviour under test.
    await waitFor(() => chunks.length >= 2, {
      timeoutMs: 3000,
      message: 'the reply never started streaming',
    })
    expect((await signOutWithBearer(test, alice.token)).status).toBe(200)

    const started = Date.now()
    await waitFor(() => ended, { timeoutMs: 3000, message: 'the adapter stream stayed open' })
    expect(Date.now() - started).toBeLessThan(1000)
    expect(chunks).toContainEqual({ type: 'error', errorText: SESSION_INVALID_MESSAGE })
  })
})
