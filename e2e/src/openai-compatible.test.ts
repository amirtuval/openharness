import { describe, expect, it } from 'vitest'

import {
  agentMessages,
  e2eHarness,
  errorOf,
  modelRequestEnds,
  personFor,
  readLog,
  seedOpenAICompatibleCredential,
  startOpenAICompatibleStub,
  typesOf,
  waitForTurnEnd,
} from './harness'

/**
 * Custom OpenAI-compatible credentials, end to end (epic #245, A3b).
 *
 * A custom credential's base URL is a URL the reader typed, so the server guards it with
 * `safeFetch` — on the save-time check, on the `/models` listing and on the model call alike.
 * This is the one credential type where a local happy path exists: with the server's self-host
 * flag on, a loopback endpoint is allowed, and the whole flow — save, list, chat — runs against
 * a stub on `127.0.0.1`. With the flag off it is refused, on save and again at request time,
 * which is what these tests pin over the wire.
 */

const harness = e2eHarness('openai-compatible')

/** A person on a server, created the way Better Auth makes them. */
async function person(server: Awaited<ReturnType<typeof harness.server>>, name: string) {
  return personFor(
    server,
    await harness.user(server, { email: `${name}@openai-compatible.test`, password: `${name}-pw` }),
  )
}

/** The loopback host the guard would otherwise refuse, made reachable through NO_PROXY. */
const DIRECT_LOOPBACK = {
  no_proxy: '127.0.0.1,localhost',
  NO_PROXY: '127.0.0.1,localhost',
} as const

describe('a custom OpenAI-compatible credential, on the hosted defaults', () => {
  it('refuses a private, loopback or metadata base URL on save', async () => {
    const server = await harness.server()
    const me = await person(server, 'refusals')

    for (const baseUrl of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/v1',
      'http://169.254.169.254/v1',
      'http://metadata.google.internal/v1',
    ]) {
      const error = await errorOf(() =>
        me.client.providerCredentials.put('custom', {
          type: 'openai_compatible',
          base_url: baseUrl,
        }),
      )
      expect(error.status, baseUrl).toBe(422)
      expect(error.type).toBe('invalid_provider_credential')
      expect(error.message).toContain('custom')
    }

    // Nothing was stored, and no URL ever appeared in the metadata.
    expect((await me.client.providerCredentials.list()).data).toEqual([])
  })

  it('refuses a name a fixed provider id owns, and a base URL that is not http(s)', async () => {
    const server = await harness.server()
    const me = await person(server, 'bads')

    const reserved = await errorOf(() =>
      me.client.providerCredentials.put('openai', {
        type: 'openai_compatible',
        base_url: 'https://api.example.com/v1',
      }),
    )
    expect(reserved.status).toBe(400)
    expect(reserved.type).toBe('invalid_request_error')

    for (const base_url of ['api.example.com/v1', 'ftp://api.example.com/v1']) {
      const error = await errorOf(() =>
        me.client.providerCredentials.put('custom', { type: 'openai_compatible', base_url }),
      )
      expect(error.status, base_url).toBe(400)
    }
  })

  it('refuses a stored private endpoint at request time when the flag is off', async () => {
    // A credential pointing at a loopback endpoint is seeded directly (the save-time check
    // would refuse it), and the model call must refuse it too — the guard runs on every path.
    const database = await harness.database()
    const stub = await startOpenAICompatibleStub()
    // A real router turn, so the custom client is built and its guard is what refuses the URL.
    const server = await harness.server({ mockModel: false })
    const me = await person(server, 'request-time')
    try {
      await seedOpenAICompatibleCredential(database, {
        userId: me.signedIn.user.id,
        name: 'custom',
        baseUrl: stub.baseUrl,
      })

      const agent = await me.client.agents.create({
        name: 'Custom agent',
        model: { id: 'custom/llama3.3' },
      })
      const session = await me.client.sessions.create({ agent: agent.id })
      const sent = await me.client.sendMessage(session.id, 'hello custom')
      await waitForTurnEnd(me.client, session.id, { afterSeq: sent.seq })

      const log = await readLog(me.client, session.id)
      // The turn ends on an error and produces no reply, and the endpoint was never reached: the
      // request span closes as a failure without a single byte having left the process.
      expect(agentMessages(log)).toEqual([])
      expect(typesOf(log)).toContain('session.error')
      const ends = modelRequestEnds(log)
      expect(ends).toHaveLength(1)
      expect(ends[0]?.is_error).toBe(true)
      expect(stub.requests).toEqual([])
    } finally {
      await stub.stop()
    }
  })
})

describe('a custom OpenAI-compatible credential, with the self-host flag on', () => {
  it('saves, lists its models and chats through a loopback endpoint', async () => {
    const stub = await startOpenAICompatibleStub({
      models: ['llama3.3', 'qwen2.5'],
      reply: 'Hello from the custom endpoint',
    })
    const server = await harness.server({
      mockModel: false,
      env: { OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: '1', ...DIRECT_LOOPBACK },
    })
    const me = await person(server, 'happy')
    try {
      expect(server.output()).toMatch(/PRIVATE ADDRESSES ALLOWED/)

      // The save-time check reaches the stub, so the credential is stored and its public fact —
      // the base URL's host — comes back, never the URL itself.
      const key = 'sk-e2e-custom-4242'
      const saved = await me.client.providerCredentials.put('custom', {
        type: 'openai_compatible',
        base_url: stub.baseUrl,
        api_key: key,
      })
      expect(saved).toMatchObject({
        type: 'openai_compatible',
        name: 'custom',
        last4: '4242',
        details: { base_url_host: stub.baseUrl.replace('http://', '').replace('/v1', '') },
      })
      expect(JSON.stringify(saved)).not.toContain(stub.baseUrl)
      // The validating call was the endpoint's own `/models`, with the key as a bearer token.
      const validation = stub.requests.find((request) => request.path === '/v1/models')
      expect(validation?.authorization).toBe(`Bearer ${key}`)

      // The catalogue contributes the endpoint's own models under the credential's name.
      const catalog = await me.client.models.list()
      expect(catalog.data.map((entry) => entry.id)).toEqual(['custom/llama3.3', 'custom/qwen2.5'])

      // A chat streams the stub's reply through the guard.
      const agent = await me.client.agents.create({
        name: 'Custom agent',
        model: { id: 'custom/llama3.3' },
      })
      const session = await me.client.sessions.create({ agent: agent.id })
      const sent = await me.client.sendMessage(session.id, 'hello custom')
      await waitForTurnEnd(me.client, session.id, { afterSeq: sent.seq })

      const log = await readLog(me.client, session.id)
      expect(agentMessages(log)[0]?.content).toEqual([
        { type: 'text', text: 'Hello from the custom endpoint' },
      ])
      const chat = stub.requests.filter((request) => request.path === '/v1/chat/completions')
      expect(chat).toHaveLength(1)
      expect(chat[0]?.authorization).toBe(`Bearer ${key}`)
      // The key never reached a response, a log line or the server's own output.
      expect(JSON.stringify(log)).not.toContain(key)
      expect(server.output()).not.toContain(key)
    } finally {
      await stub.stop()
    }
  })

  it('saves a keyless endpoint through the route, and chats with no Authorization header', async () => {
    const stub = await startOpenAICompatibleStub({ models: ['llama3.3'] })
    const server = await harness.server({
      mockModel: false,
      env: { OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS: '1', ...DIRECT_LOOPBACK },
    })
    const me = await person(server, 'keyless')
    try {
      const saved = await me.client.providerCredentials.put('custom', {
        type: 'openai_compatible',
        base_url: stub.baseUrl,
      })
      expect(saved.last4).toBe('')

      const agent = await me.client.agents.create({
        name: 'Keyless agent',
        model: { id: 'custom/llama3.3' },
      })
      const session = await me.client.sessions.create({ agent: agent.id })
      const sent = await me.client.sendMessage(session.id, 'hello keyless')
      await waitForTurnEnd(me.client, session.id, { afterSeq: sent.seq })

      const log = await readLog(me.client, session.id)
      expect(agentMessages(log)[0]?.content?.[0]).toMatchObject({ type: 'text' })
      const chat = stub.requests.filter((request) => request.path === '/v1/chat/completions')
      expect(chat).toHaveLength(1)
      // A keyless endpoint is asked with no `Authorization` header at all.
      expect(chat[0]?.authorization).toBeUndefined()
    } finally {
      await stub.stop()
    }
  })
})
