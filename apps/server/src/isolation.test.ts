import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type Agent,
  type GetMeResponse,
  type ListAgentsResponse,
  type ListProviderCredentialsResponse,
  type ListSessionsResponse,
  type Session,
} from '@openharness/protocol'

import {
  asUser,
  createTestApp,
  httpCreateAgent,
  httpCreateSession,
  httpSendMessage,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * User isolation (epic #65, A4), swept route by route.
 *
 * Two users: A creates an agent, a session with a message in it, and stores a provider
 * credential. Then **every `/v1` route is called as B** with A's ids, and none of them may
 * answer with A's data: a by-id route answers 404 — the same answer an id nobody has gets, so
 * the existence of the resource does not leak — a list answers B's own (empty) list, the
 * stream answers 404 rather than connecting, and `/v1/me` answers B.
 *
 * The sweep is written as a table so a new route has one obvious place to be added to; the
 * compile-time half of the same guarantee is the `SessionStore` contract, where a user-facing
 * read without an owner does not compile (`packages/session`).
 */

interface Fixture {
  readonly test: TestContext
  /** User A: the bearer token, and the resources they made. */
  readonly a: { readonly token: string; readonly agent: Agent; readonly session: Session }
  /** User B: the bearer token. */
  readonly b: { readonly token: string }
}

/** Two signed-in users and A's resources. */
async function twoUsers(): Promise<Fixture> {
  const test = createTestApp()
  const a = await test.signIn()
  const b = await test.signIn('b@example.com', 'b-password')

  const agent = await httpCreateAgent(test, { name: 'A’s agent' })
  const session = await httpCreateSession(test, agent.id)
  await httpSendMessage(test, session.id, 'a private thought')
  await waitForIdle(test.store, session.id)
  // A stored key, so B's credential routes have something of A's to be kept away from.
  const stored = await putCredential(test, a.token, { type: 'api_key', api_key: 'sk-a-secret-key' })
  expect(stored.status).toBe(200)

  return { test, a: { token: a.token, agent, session }, b: { token: b.token } }
}

/** A request as one user, with a JSON body where there is one. */
function call(
  test: TestContext,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return test.request(path, {
    method,
    headers: {
      ...asUser(token),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** `PUT /v1/provider-credentials/{provider}` as one user. */
function putCredential(
  test: TestContext,
  token: string,
  body: unknown,
  provider = 'anthropic',
): Promise<Response> {
  return call(test, token, 'PUT', `${API_VERSION_PREFIX}/provider-credentials/${provider}`, body)
}

describe('user isolation (A4)', () => {
  it('answers 404 — never 403 — for every by-id route of another user’s resources', async () => {
    const { test, a, b } = await twoUsers()

    const routes: readonly (readonly [string, string, unknown?])[] = [
      ['GET', `${API_VERSION_PREFIX}/agents/${a.agent.id}`],
      ['POST', `${API_VERSION_PREFIX}/agents/${a.agent.id}`, { name: 'renamed by B' }],
      ['GET', `${API_VERSION_PREFIX}/sessions/${a.session.id}`],
      [
        'POST',
        `${API_VERSION_PREFIX}/sessions/${a.session.id}/events`,
        {
          events: [{ type: 'user.message', content: [{ type: 'text', text: 'B was here' }] }],
        },
      ],
      ['GET', `${API_VERSION_PREFIX}/sessions/${a.session.id}/events`],
      ['GET', `${API_VERSION_PREFIX}/sessions/${a.session.id}/events/stream`],
      [
        'POST',
        `${API_VERSION_PREFIX}/sessions/${a.session.id}/ai-sdk/chat`,
        {
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
        },
      ],
    ]

    for (const [method, path, request] of routes) {
      const response = await call(test, b.token, method, path, request)
      expect([method, path, response.status]).toEqual([method, path, 404])
      // The answer is the protocol's not_found_error and carries none of A's data — only the
      // id B asked for, which B already had. A 403 would have confirmed the resource exists.
      const refusal = ApiErrorBodySchema.parse(await response.json())
      expect(refusal.error.type).toBe('not_found_error')
      expect(JSON.stringify(refusal)).not.toContain('A’s agent')
      expect(JSON.stringify(refusal)).not.toContain('a private thought')
    }

    // A's agent is untouched by the attempted update, and its log has nothing new: the one
    // user message in it is A's, and B's was never stored.
    const reread = await test.store.getAgent(a.agent.id, { ownerId: (await test.currentUser()).id })
    expect(reread?.name).toBe('A’s agent')
    const history = await test.store.listEventsUnscoped(a.session.id)
    const userMessages = history.data.filter((event) => event.type === EVENT_TYPES.userMessage)
    expect(userMessages).toHaveLength(1)
    expect(JSON.stringify(userMessages)).toContain('a private thought')
    expect(JSON.stringify(history.data)).not.toContain('B was here')
  })

  it('lists nothing of another user’s, and everything of one’s own', async () => {
    const { test, a, b } = await twoUsers()
    // B makes their own agent and session, as B.
    const created = await call(test, b.token, 'POST', `${API_VERSION_PREFIX}/agents`, {
      name: 'B’s agent',
      model: { id: 'openharness-test/test-model' },
    })
    expect(created.status).toBe(201)
    const bAgent = (await created.json()) as Agent
    const createdSession = await call(test, b.token, 'POST', `${API_VERSION_PREFIX}/sessions`, {
      agent: bAgent.id,
    })
    expect(createdSession.status).toBe(201)
    const bSession = (await createdSession.json()) as Session

    // B's own resources carry B's owner, not A's.
    expect(bAgent.owner_id).not.toBe(a.agent.owner_id)
    expect(bSession.owner_id).toBe(bAgent.owner_id)

    const agentsForB = (await (
      await call(test, b.token, 'GET', `${API_VERSION_PREFIX}/agents`)
    ).json()) as ListAgentsResponse
    const sessionsForB = (await (
      await call(test, b.token, 'GET', `${API_VERSION_PREFIX}/sessions`)
    ).json()) as ListSessionsResponse

    expect(agentsForB.data.map((agent) => agent.id)).toEqual([bAgent.id])
    expect(sessionsForB.data.map((session) => session.id)).toEqual([bSession.id])

    // And A still sees exactly their own.
    const agentsForA = (await (
      await call(test, a.token, 'GET', `${API_VERSION_PREFIX}/agents`)
    ).json()) as ListAgentsResponse
    expect(agentsForA.data.map((agent) => agent.id)).toEqual([a.agent.id])
  })

  it('keeps provider credentials apart, both the list and the writes', async () => {
    const { test, a, b } = await twoUsers()

    const forB = (await (
      await call(test, b.token, 'GET', `${API_VERSION_PREFIX}/provider-credentials`)
    ).json()) as ListProviderCredentialsResponse
    expect(forB.data).toEqual([])

    // B replacing “anthropic” writes B's own row, never A's.
    const bPut = await putCredential(test, b.token, {
      type: 'api_key',
      api_key: 'sk-b-own-key',
    })
    expect(bPut.status).toBe(200)

    const forA = (await (
      await call(test, a.token, 'GET', `${API_VERSION_PREFIX}/provider-credentials`)
    ).json()) as ListProviderCredentialsResponse
    const forBAfter = (await (
      await call(test, b.token, 'GET', `${API_VERSION_PREFIX}/provider-credentials`)
    ).json()) as ListProviderCredentialsResponse

    expect(forA.data).toHaveLength(1)
    // The last four characters of `sk-a-secret-key`; B's was `sk-b-own-key` — the metadata
    // differs, and the rows are different rows.
    expect(forA.data[0]?.last4).toBe('-key')
    expect(forA.data[0]?.id).not.toBe(forBAfter.data[0]?.id)

    // B deleting “anthropic” deletes only B's row.
    const deleted = await call(
      test,
      b.token,
      'DELETE',
      `${API_VERSION_PREFIX}/provider-credentials/anthropic`,
    )
    expect(deleted.status).toBe(204)
    const forAAfter = (await (
      await call(test, a.token, 'GET', `${API_VERSION_PREFIX}/provider-credentials`)
    ).json()) as ListProviderCredentialsResponse
    expect(forAAfter.data).toHaveLength(1)
  })

  it('answers /v1/me with the caller, and nothing of the other user', async () => {
    const { test, b } = await twoUsers()

    const response = await call(test, b.token, 'GET', `${API_VERSION_PREFIX}/me`)
    const me = (await response.json()) as GetMeResponse

    expect(me.email).toBe('b@example.com')
  })
})
