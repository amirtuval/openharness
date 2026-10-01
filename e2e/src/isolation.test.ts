import { describe, expect, it } from 'vitest'

import { ApiErrorBodySchema } from '@openharness/protocol'

import {
  agentMessages,
  e2eHarness,
  errorOf,
  personFor,
  readLog,
  seedProviderCredential,
  textOf,
  waitForTurnEnd,
  type Person,
  type ServerProcess,
} from './harness'

/**
 * Two people, one server, nothing shared (epic #65, A4).
 *
 * The single-package suites sweep the same routes in-process (`apps/server/src/isolation.test.ts`);
 * this is the deployment's version of it: a real process, a real Postgres, two real sessions,
 * and the answers a second person gets when they ask for the first person's things. The rule
 * is the epic's: **404, never 403** — a 403 would confirm the resource exists — and lists
 * answer only the caller's own rows.
 *
 * The second account cannot be made through the API: sign-up is disabled and the dev login
 * seeds one user (A7). It is created the way Better Auth creates one (`harness/users.ts`), and
 * from then on everything is the real path — a session row, a bearer token, the workspace.
 */

const harness = e2eHarness('isolation')

/** Two signed-in people on one server. */
async function twoPeople(server: ServerProcess): Promise<{ a: Person; b: Person }> {
  return {
    a: personFor(
      server,
      await harness.user(server, { email: 'a@isolation.test', password: 'a-password' }),
    ),
    b: personFor(
      server,
      await harness.user(server, { email: 'b@isolation.test', password: 'b-password' }),
    ),
  }
}

/**
 * The AI SDK adapter route, as the browser calls it.
 *
 * There is no client method for it — it is an extension for `useChat`, not part of the SDK —
 * so the test speaks to it the way the web app does: the session cookie's bearer, the AI SDK
 * request body.
 */
async function aiSdkChat(
  server: ServerProcess,
  token: string,
  sessionId: string,
): Promise<Response> {
  return fetch(`${server.baseUrl}/v1/sessions/${sessionId}/ai-sdk/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    }),
  })
}

describe('two people on one server (A4)', () => {
  it('answers 404 — never 403 — for every one of A’s resources B asks for', async () => {
    const server = await harness.server()
    const { a, b } = await twoPeople(server)

    // A's world: an agent, a session with a finished turn in it.
    const agent = await a.client.agents.create({
      name: 'A’s agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await a.client.sessions.create({ agent: agent.id })
    const sent = await a.client.sendMessage(session.id, 'a private thought')
    await waitForTurnEnd(a.client, session.id, { afterSeq: sent.seq })

    // B's own world is empty, and B is B.
    await expect(b.client.agents.list()).resolves.toEqual({ data: [], next_page: null })
    await expect(b.client.sessions.list()).resolves.toEqual({ data: [], next_page: null })
    expect((await b.client.me()).id).toBe(b.signedIn.user.id)

    // Every by-id route B can reach, with A's ids: the same 404 an id nobody has gets.
    const routes: readonly (readonly [string, () => Promise<unknown>])[] = [
      ['GET /v1/agents/{id}', () => b.client.agents.get(agent.id)],
      ['POST /v1/agents/{id}', () => b.client.agents.update(agent.id, { name: 'renamed by B' })],
      ['GET /v1/sessions/{id}', () => b.client.sessions.get(session.id)],
      ['GET /v1/sessions/{id}/events', () => b.client.sessions.events.list(session.id)],
      ['POST /v1/sessions/{id}/events', () => b.client.sendMessage(session.id, 'B was here')],
    ]

    for (const [what, call] of routes) {
      const refusal = await errorOf(call)
      expect([what, refusal.status]).toEqual([what, 404])
      expect([what, refusal.type]).toEqual([what, 'not_found_error'])
    }

    // The two routes the SDK does not wrap — the AI SDK adapter and the SSE stream — are the
    // ones that would answer with a body (a stream) rather than an error: both refuse instead,
    // and neither refusal carries any of A's data.
    for (const [what, response] of [
      ['POST /v1/sessions/{id}/ai-sdk/chat', await aiSdkChat(server, b.signedIn.token, session.id)],
      [
        'GET /v1/sessions/{id}/events/stream',
        await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`, {
          headers: { authorization: `Bearer ${b.signedIn.token}` },
        }),
      ],
    ] as const) {
      expect([what, response.status]).toEqual([what, 404])
      const envelope = ApiErrorBodySchema.parse(await response.json())
      expect([what, envelope.error.type]).toEqual([what, 'not_found_error'])
      expect(JSON.stringify(envelope)).not.toContain('a private thought')
    }

    // And nothing B tried changed A's world: the agent keeps its name, and the log has exactly
    // one user message in it — A's.
    expect((await a.client.agents.get(agent.id)).name).toBe('A’s agent')
    const log = await readLog(a.client, session.id)
    expect(log.filter((event) => event.type === 'user.message')).toHaveLength(1)
    expect(agentMessages(log).map(textOf)).toEqual(['a private thought'])
  })

  it('keeps provider credentials per user, and lists only your own', async () => {
    const server = await harness.server()
    const { a, b } = await twoPeople(server)

    // Seeded the way the PUT route stores one (see `harness/credentials.ts` for why this is
    // not a PUT here).
    await seedProviderCredential(await harness.database(), {
      userId: a.signedIn.user.id,
      provider: 'anthropic',
      apiKey: 'sk-ant-a-private-key-a1b2',
    })

    const mine = await a.client.providerCredentials.list()
    expect(mine.data.map((credential) => credential.provider)).toEqual(['anthropic'])
    expect(mine.data[0]?.last4).toBe('a1b2')
    expect(JSON.stringify(mine)).not.toContain('sk-ant-a-private-key-a1b2')

    // B's list does not have it, and B's delete is a no-op rather than a way to touch A's row.
    await expect(b.client.providerCredentials.list()).resolves.toEqual({ data: [] })
    await expect(b.client.providerCredentials.delete('anthropic')).resolves.toBeUndefined()

    const stillThere = await a.client.providerCredentials.list()
    expect(stillThere.data.map((credential) => credential.provider)).toEqual(['anthropic'])
    expect(stillThere.data[0]?.last4).toBe('a1b2')
  })

  it('answers 401 for every /v1 route without a session', async () => {
    const server = await harness.server()
    const { a } = await twoPeople(server)

    // The routes are the API's whole surface, so "without a session" is swept rather than
    // sampled: a new route that forgets the guard is the failure this test exists to catch.
    const routes: readonly (readonly [string, string])[] = [
      ['GET', '/v1/me'],
      ['GET', '/v1/agents'],
      ['POST', '/v1/agents'],
      ['GET', '/v1/agents/agent_01JZZZZZZZZZZZZZZZZZZZZZZZ'],
      ['POST', '/v1/agents/agent_01JZZZZZZZZZZZZZZZZZZZZZZZ'],
      ['GET', '/v1/sessions'],
      ['POST', '/v1/sessions'],
      ['GET', '/v1/sessions/sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ'],
      ['GET', '/v1/sessions/sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ/events'],
      ['POST', '/v1/sessions/sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ/events'],
      ['GET', '/v1/sessions/sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ/events/stream'],
      ['POST', '/v1/sessions/sesn_01JZZZZZZZZZZZZZZZZZZZZZZZ/ai-sdk/chat'],
      ['GET', '/v1/provider-credentials'],
      ['PUT', '/v1/provider-credentials/anthropic'],
      ['DELETE', '/v1/provider-credentials/anthropic'],
    ]

    for (const [method, path] of routes) {
      // The guard runs before anything else, so an anonymous request with an *empty* body is
      // still refused for authentication — not for the body it did not carry.
      const response = await fetch(`${server.baseUrl}${path}`, { method })
      const body = ApiErrorBodySchema.parse(await response.json())
      expect([method, path, response.status]).toEqual([method, path, 401])
      expect([method, path, body.error.type]).toEqual([method, path, 'authentication_error'])
    }

    // A bearer token that is not a session is refused the same way — the token is looked up,
    // never trusted.
    const forged = await fetch(`${server.baseUrl}/v1/me`, {
      headers: { authorization: 'Bearer sesn_not-a-real-token' },
    })
    expect(forged.status).toBe(401)

    // A signed-in caller is not affected by any of the above, and the two open routes stay
    // open: /health and /v1/auth-config need no one.
    expect((await a.client.me()).email).toBe('a@isolation.test')
    expect((await fetch(`${server.baseUrl}/health`)).status).toBe(200)
    expect((await fetch(`${server.baseUrl}/v1/auth-config`)).status).toBe(200)
  })
})
