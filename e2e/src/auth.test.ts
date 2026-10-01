import { ApiError, createClient } from '@openharness/client'
import { ApiErrorBodySchema } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  DEV_LOGIN_STORED_EMAIL,
  agentMessages,
  e2eHarness,
  readLog,
  signIn,
  textOf,
  waitForTurnEnd,
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
    const again = await harness.client(server)
    expect((await again.me()).email).toBe(DEV_LOGIN_STORED_EMAIL)
  })
})
