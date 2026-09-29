import { ApiError, type Client } from '@openharness/client'
import { ApiErrorBodySchema } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { agentMessages, e2eHarness, readLog, textOf, waitForTurnEnd } from './harness'

/**
 * An API that requires a key (`OPENHARNESS_API_KEY`).
 *
 * The key is the whole of v1's authentication story, and it covers exactly `/v1/*`: `/health`
 * stays open, because a load balancer asking whether a process is alive has nothing to
 * authenticate with. Both halves are checked here — the envelope a raw HTTP client sees, and
 * what the SDK makes of it.
 */

const API_KEY = 'oh_e2e_suite_key'

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

/** An agent and a session, behind the key. */
async function newSession(client: Client): Promise<string> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  const session = await client.sessions.create({ agent: agent.id })
  return session.id
}

describe('an API that requires a key', () => {
  it('refuses /v1 without one, and leaves /health open', async () => {
    const server = await harness.server({ apiKey: API_KEY })

    const health = await fetch(`${server.baseUrl}/health`)
    expect(health.status).toBe(200)
    const healthBody: unknown = await health.json()
    expect(healthBody).toEqual({ status: 'ok' })

    // The protocol's envelope, with the request id a support ticket would quote.
    const refusal = await fetch(`${server.baseUrl}/v1/agents`)
    expect(refusal.status).toBe(401)
    const requestId = refusal.headers.get('request-id')
    expect(requestId).toMatch(/^req_/)
    const refusalBody: unknown = await refusal.json()
    // The envelope the protocol defines, down to the request id the header already carried.
    const envelope = ApiErrorBodySchema.parse(refusalBody)
    expect(envelope.error.type).toBe('authentication_error')
    expect(envelope.error.message.length).toBeGreaterThan(0)
    expect(envelope.request_id).toBe(requestId)

    const anonymous = harness.client(server)
    const missing = await errorOf(() => anonymous.agents.list())
    expect(missing.status).toBe(401)
    expect(missing.type).toBe('authentication_error')
    expect(missing.retryable).toBe(false)

    const wrong = harness.client(server, { apiKey: 'oh_not_the_key' })
    const rejected = await errorOf(() => wrong.sessions.list())
    expect(rejected.status).toBe(401)
    expect(rejected.type).toBe('authentication_error')
  })

  it('runs a turn for a client that presents the key, and guards the stream too', async () => {
    const server = await harness.server({ apiKey: API_KEY })
    const client = harness.client(server, { apiKey: API_KEY })
    const sessionId = await newSession(client)

    const sent = await client.sendMessage(sessionId, 'hello from behind a key')
    await waitForTurnEnd(client, sessionId, { afterSeq: sent.seq })

    const log = await readLog(client, sessionId)
    expect(agentMessages(log).map(textOf)).toEqual(['hello from behind a key'])

    // The SSE route is behind the key as well. That is the reason `@openharness/client`
    // streams over `fetch` instead of `EventSource`, which cannot send a header.
    const stream = await fetch(`${server.baseUrl}/v1/sessions/${sessionId}/events/stream`)
    expect(stream.status).toBe(401)
  })
})
