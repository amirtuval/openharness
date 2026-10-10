import { describe, expect, it } from 'vitest'

import {
  OPENAI_STUB_REPLY,
  agentMessages,
  e2eHarness,
  openAiResponsesSseBody,
  readLog,
  startProviderStub,
  textOf,
  waitForTurnEnd,
} from './harness'

/**
 * A fixed provider's model request behind an egress proxy (#270).
 *
 * The catalogue and the save-time credential checks reach a provider through
 * `catalog/provider-fetch.ts` (undici's `EnvHttpProxyAgent`, honouring `HTTP_PROXY` /
 * `HTTPS_PROXY` / `NO_PROXY`), but a **model** request used the AI SDK's default `fetch`,
 * which ignores those variables unless the process was started with `NODE_USE_ENV_PROXY=1`.
 * A proxy-only deployment could list models and save keys but not chat.
 *
 * This drives the whole path against `startProviderStub()` — the loopback proxy the server
 * reaches through those documented variables — with `mockModel: false`, so the real provider
 * factory runs. Nothing sets `NODE_USE_ENV_PROXY`: the injected egress fetch is what makes the
 * chat leave the process through the stub, and without it this turn would reach the internet
 * directly (and the response below would never arrive).
 */

const harness = e2eHarness('provider-proxy')

/** A key shaped like a real one. It only ever reaches the loopback stub. */
const FAKE_KEY = 'sk-e2e-proxy-model-3f1c'

/** The model the chat runs: `openai`'s client is the Responses API (see `PROVIDER_CLIENTS`). */
const OPENAI_MODEL = 'openai/gpt-4o-mini'

describe('a fixed provider behind the egress proxy (#270)', () => {
  it('saves a key and chats through HTTPS_PROXY, with no NODE_USE_ENV_PROXY', async () => {
    const stub = await startProviderStub()
    try {
      stub.answer('api.openai.com', (request) => {
        if (request.path.startsWith('/v1/models')) {
          return { json: { object: 'list', data: [{ id: 'gpt-4o-mini', object: 'model' }] } }
        }
        if (request.path === '/v1/responses') {
          return { body: openAiResponsesSseBody(), contentType: 'text/event-stream' }
        }
        return undefined
      })
      // `stub.env` overrides every proxy spelling and `NODE_EXTRA_CA_CERTS`; `mockModel: false`
      // runs the real provider factory. No `NODE_USE_ENV_PROXY` anywhere.
      const server = await harness.server({ mockModel: false, env: stub.env })
      const client = await harness.client(server)

      // The save-time check is one real provider call (A5), so it goes through the proxy too —
      // the half that already worked, and the row the chat's credential comes from.
      const saved = await client.providerCredentials.put('openai', {
        type: 'api_key',
        api_key: FAKE_KEY,
      })
      expect(saved.name).toBe('openai')
      expect(saved.last4).toBe(FAKE_KEY.slice(-4))

      const session = await client.sessions.create({ model: { id: OPENAI_MODEL } })
      const sent = await client.sendMessage(session.id, 'hello through the proxy')
      await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

      const log = await readLog(client, session.id)
      const reply = agentMessages(log)[0]
      expect(reply).toBeDefined()
      expect(textOf(reply!)).toBe(OPENAI_STUB_REPLY)

      // The chat request reached the stub as a real Responses POST — a model request that went
      // out through the egress proxy without the process being told to use one.
      const chat = stub.requests.filter((request) => request.method === 'POST')
      expect(chat.map((request) => `${request.host}${request.path}`)).toEqual([
        'api.openai.com/v1/responses',
      ])
    } finally {
      await stub.stop()
    }
  })
})
