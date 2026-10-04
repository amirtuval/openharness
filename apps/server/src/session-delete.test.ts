import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  type Session,
  type SessionId,
} from '@openharness/protocol'
import {
  InMemorySessionStore,
  SessionNotFoundError,
  type SessionStore,
} from '@openharness/session'

import { runTurn } from '@openharness/brain'

import { PostgresPartitionScheduler } from './partition-scheduler'
import { SessionRunner } from './runner'
import {
  HELD_REPLY_TEST_TIMEOUT_MS,
  asUser,
  createScriptedModel,
  createTestApp,
  openSse,
  postJson,
  readHistory,
  resolveTestCredential,
  resolveTestSessionCredential,
  startTestServer,
  waitFor,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * `DELETE /v1/sessions/{id}` (epic #116, U5): the hard delete. Owner-scoped (404 otherwise),
 * it stops a running turn before anything is removed, removes the session and its whole log,
 * and ends every open stream with a final `session.deleted` — while the scheduler stays
 * stable for the session that no longer exists.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`

/** `POST /v1/sessions` from a model alone, as the context's default caller. */
async function createSession(
  test: TestContext,
  model = 'openharness-test/model',
): Promise<Session> {
  const response = await postJson(test, SESSIONS, { model: { id: model } })
  if (response.status !== 201) {
    throw new Error(`creating a session failed: ${response.status} ${await response.text()}`)
  }
  return (await response.json()) as Session
}

/** `POST …/events` with one user message. */
async function send(test: TestContext, sessionId: SessionId, text: string): Promise<void> {
  const response = await postJson(test, `${SESSIONS}/${sessionId}/events`, {
    events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
  })
  if (response.status !== 200) {
    throw new Error(`sending a message failed: ${response.status} ${await response.text()}`)
  }
}

/** `DELETE /v1/sessions/{session_id}`. */
function deleteSession(test: TestContext, sessionId: SessionId, token?: string): Promise<Response> {
  return test.request(`${SESSIONS}/${sessionId}`, {
    method: 'DELETE',
    ...(token === undefined ? {} : { headers: asUser(token) }),
  })
}

/** An in-memory store that counts its appends, for the "no writes after" assertion. */
class CountingStore extends InMemorySessionStore {
  appends = 0

  override async appendEvents(
    ...args: Parameters<InMemorySessionStore['appendEvents']>
  ): ReturnType<InMemorySessionStore['appendEvents']> {
    this.appends += 1
    return super.appendEvents(...args)
  }
}

describe('deleting a session', () => {
  it('answers 204, removes the session and its whole log, and 404s every read of it', async () => {
    const test = createTestApp()
    const session = await createSession(test)
    await send(test, session.id, 'hello')
    await waitForIdle(test.store, session.id)
    expect(await readHistory(test.store as InMemorySessionStore, session.id)).not.toEqual([])

    const response = await deleteSession(test, session.id)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')

    expect(await test.store.getSessionUnscoped(session.id)).toBeNull()
    await expect(async () =>
      test.store.listEventsUnscoped(session.id, { limit: 10, order: 'asc' }),
    ).rejects.toThrow(SessionNotFoundError)
    await expect(async () => test.store.getPendingUserEvents(session.id)).rejects.toThrow(
      SessionNotFoundError,
    )
    await expect(async () => test.store.getTurnState(session.id)).rejects.toThrow(
      SessionNotFoundError,
    )

    expect((await test.request(`${SESSIONS}/${session.id}`)).status).toBe(404)
    expect((await test.request(`${SESSIONS}/${session.id}/events`)).status).toBe(404)
  })

  it('is owner-scoped: another user gets a 404 and the session survives', async () => {
    const test = createTestApp()
    const session = await createSession(test)
    const other = await test.signIn('delete-other@example.com')

    const response = await deleteSession(test, session.id, other.token)
    expect(response.status).toBe(404)
    expect(await test.store.getSessionUnscoped(session.id)).not.toBeNull()
  })

  it('answers a malformed id with a 400 and an unknown one with a 404', async () => {
    const test = createTestApp()
    expect((await deleteSession(test, 'not-an-id' as SessionId)).status).toBe(400)
    expect((await deleteSession(test, 'sesn_01ZZZZZZZZZZZZZZZZZZZZZZZZ' as SessionId)).status).toBe(
      404,
    )
  })

  it('stops a running turn before the delete and writes nothing after it', async () => {
    const store = new CountingStore()
    const test = createTestApp({
      store,
      // A reply paced slowly enough that the delete lands mid-stream, deterministically: the
      // abort takes effect at the next chunk, and 16 chunks × 25 ms is far more than the
      // in-process request takes to arrive.
      replies: [{ text: [...'abcdefghijklmnop'], delayMs: 25 }],
    })
    const session = await createSession(test)
    await send(test, session.id, 'something long')
    await test.model.waitForRequests(1)

    // Delete while the turn is streaming: the stop aborts the turn and the delete waits for
    // the pass to write its last events (the partial reply, the closed span, idle) before
    // anything is removed.
    const response = await deleteSession(test, session.id)
    expect(response.status).toBe(204)
    expect(await test.store.getSessionUnscoped(session.id)).toBeNull()

    // Nothing more is written for it — not by the stopped pass, not by a crash loop.
    const appendsWhenDeleted = store.appends
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(store.appends).toBe(appendsWhenDeleted)
    // The turn really ran and was cut short: one request, no retry of a session that is gone.
    expect(test.model.requests).toBe(1)
  })

  it('tolerates a session that vanished before its pass: noop, nothing written, nothing thrown', async () => {
    const store = new InMemorySessionStore()
    const model = createScriptedModel()
    const runner = new SessionRunner({
      store,
      model: model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    const session = await store.createSession(null, {
      ownerId: 'user_delete_tests',
      model: { id: 'openharness-test/model' },
    })
    await store.deleteSession(session.id, { ownerId: 'user_delete_tests' })

    // The runner answers noop instead of rejecting — a deleted session is not a failed pass,
    // so the queue never reports it and nothing retries it.
    await expect(runner.run(session.id)).resolves.toEqual({ outcome: 'noop' })
    expect(model.requests).toBe(0)

    // The brain itself refuses an id nothing has, before writing anything.
    await expect(
      runTurn(session.id, {
        store,
        model: model.factory,
        resolveCredential: resolveTestCredential,
      }),
    ).rejects.toThrow(SessionNotFoundError)
  })

  it('aborts the pass in flight and keeps it from starting another turn', async () => {
    const store = new InMemorySessionStore()
    const model = createScriptedModel({
      text: [...'abcdefghijklmnop'],
      delayMs: 25,
      onChunk: async (_chunk, index) => {
        if (index === 0) {
          // A message queued behind the turn: a plain `abort` would answer it in a second
          // turn, but a `stopSession` must not — the session is on its way out.
          await store.appendEvents(session.id, [
            { type: 'user.message', content: [{ type: 'text', text: 'queued behind' }] },
          ])
        }
      },
    })
    const runner = new SessionRunner({
      store,
      model: model.factory,
      resolveCredential: resolveTestSessionCredential,
    })
    const session = await store.createSession(null, {
      ownerId: 'user_delete_tests',
      model: { id: 'openharness-test/model' },
    })
    await store.appendEvents(session.id, [
      { type: 'user.message', content: [{ type: 'text', text: 'first' }] },
    ])

    const pass = runner.run(session.id)
    await model.waitForRequests(1)
    // Stop while the reply is still streaming: the pass ends on the aborted turn instead of
    // looking for more work, and the queued message stays in the log for nobody.
    await expect(runner.stopSession(session.id)).resolves.toBe(true)
    await expect(pass).resolves.toEqual({ outcome: 'interrupted' })
    expect(model.requests).toBe(1)
  })
})

describe('deleting a session with open streams', () => {
  it('sends a final session.deleted over SSE and closes the stream', async () => {
    const test = await startTestServer()
    const session = await createSession(test)
    await send(test, session.id, 'hello')
    await waitForIdle(test.store, session.id)

    const reader = openSse(await test.request(`${SESSIONS}/${session.id}/events/stream`))
    try {
      const response = await deleteSession(test, session.id)
      expect(response.status).toBe(204)

      const final = await reader.next(5000)
      expect(final?.event.type).toBe(EVENT_TYPES.sessionDeleted)
      expect(final?.event).toEqual({ type: EVENT_TYPES.sessionDeleted, session_id: session.id })
      // The event was never stored, so it carries no resume position; and the stream ends
      // after it, with no goodbye frame — a deletion is not an authentication failure.
      expect(final?.id).toBeNull()
      expect(await reader.next(5000)).toBeNull()
      expect(reader.endError).toBeNull()
    } finally {
      reader.close()
    }
  })

  it(
    'ends the AI SDK adapter stream too',
    async () => {
      const test = await startTestServer({
        replies: [{ text: [...'abcdefghijklmnop'], delayMs: 25 }],
      })
      const session = await createSession(test)
      const caller = await test.signIn()

      const chat = await fetch(`${test.url}${SESSIONS}/${session.id}/ai-sdk/chat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${caller.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'something long' }] }],
        }),
      })
      expect(chat.status).toBe(200)
      await test.model.waitForRequests(1)

      expect((await deleteSession(test, session.id)).status).toBe(204)

      // The response ends on the session.deleted event instead of keeping a subscription to a
      // log that no longer exists open forever. This waits on the stream itself: if the
      // adapter missed the event, the read never resolves and the test times out.
      const body = await chat.text()
      expect(typeof body).toBe('string')
    },
    HELD_REPLY_TEST_TIMEOUT_MS,
  )
})

describe('the partitioned scheduler and a stop', () => {
  it('routes a stop for a partition this instance does not hold to its owner', async () => {
    const signals: { sessionId: SessionId; kind: string }[] = []
    const store = {
      signalPartition: (_partition: number, signal: { sessionId: SessionId; kind: string }) => {
        signals.push(signal)
        return Promise.resolve()
      },
    } as unknown as SessionStore
    const scheduler = new PostgresPartitionScheduler({
      store,
      model: createScriptedModel().factory,
      resolveCredential: resolveTestSessionCredential,
      instanceId: 'stopping-instance',
    })
    const sessionId = 'sesn_01M43PS28R24R1P4F1FS56RBMS' as SessionId

    // The partition is nobody's yet — certainly not this instance's — so the stop goes out as
    // the one signal that cuts a turn short, and the owner answers it (or refuses a write for
    // a session that is gone, which the runner tolerates).
    await scheduler.stopSession(sessionId)

    expect(signals).toEqual([{ sessionId, kind: 'interrupt' }])
  })
})

describe('the scheduler after a session is deleted', () => {
  it('keeps running other sessions when a signal arrives for the deleted one', async () => {
    const test = createTestApp()
    const gone = await createSession(test)
    await send(test, gone.id, 'hello')
    await waitForIdle(test.store, gone.id)
    expect((await deleteSession(test, gone.id)).status).toBe(204)

    const alive = await createSession(test)
    await send(test, alive.id, 'are you there')
    await waitForIdle(test.store, alive.id)
    expect(await readHistory(test.store as InMemorySessionStore, alive.id)).not.toEqual([])

    // A signal that arrives late for the deleted session is a no-op, not a crash loop: the
    // runner answers noop and the next real session still runs its turn.
    test.scheduler.signal(gone.id, 'work')
    test.scheduler.signal(gone.id, 'interrupt')
    await waitFor(() => test.model.requests >= 2, {
      message: 'the scheduler stopped running after the delete',
    })
    expect(await test.store.getSessionUnscoped(gone.id)).toBeNull()
  })
})
