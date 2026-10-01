import { describe, expect, it } from 'vitest'

import {
  agentMessages,
  e2eHarness,
  modelRequestEnds,
  readLog,
  textOf,
  waitForTurnEnd,
} from './harness'

/**
 * A real model provider, when the environment has a key for one.
 *
 * Everything else in this suite runs against the deterministic mock, which is what makes the
 * assertions exact. This file is the counterweight: one turn through the real router, a real
 * provider and a real network, so that "the server works" is not only true of a model that
 * lives in the same process.
 *
 * Since A5 the key is not the server's: the test stores the environment's key as the
 * **dev user's provider credential** — the same `PUT /v1/provider-credentials` a person
 * uses — and the turn runs on the vault-opened copy. That is the whole v2 path: validate,
 * seal, store, resolve per request. The key in the environment is only this *test's* way of
 * having one; the server under test would ignore it (`OPENAI_API_KEY` is not read, tested in
 * `apps/server`).
 *
 * It is skipped silently when neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set — the
 * usual state of a laptop and of CI — and it is deliberately *coarse*: a provider is not
 * deterministic, so it asserts that a reply arrived and that the request did not fail, never
 * what the reply says.
 */

const harness = e2eHarness('provider-smoke')

/** The provider the environment offers, if any. */
function smokeFromEnvironment():
  | { readonly provider: string; readonly model: string; readonly apiKey: string }
  | undefined {
  const anthropic = (process.env.ANTHROPIC_API_KEY ?? '').trim()
  if (anthropic !== '') {
    return { provider: 'anthropic', model: 'anthropic/claude-sonnet-5', apiKey: anthropic }
  }
  const openai = (process.env.OPENAI_API_KEY ?? '').trim()
  if (openai !== '') {
    return { provider: 'openai', model: 'openai/gpt-5.1', apiKey: openai }
  }
  return undefined
}

const smoke = smokeFromEnvironment()

describe.skipIf(smoke === undefined)('a real model provider', () => {
  it('answers a prompt through the router', async () => {
    if (smoke === undefined) {
      throw new Error('this suite does not run without a provider key')
    }

    // `mockModel: false` is the point: no `OPENHARNESS_TEST_MODEL`, so the process runs the
    // brain's default router and whatever provider the model id resolves to.
    const server = await harness.server({ mockModel: false })
    expect(server.output()).toMatch(/model: mastra router/)

    const client = await harness.client(server)
    // Store the key the way a person does: it is validated against the provider, sealed, and
    // stored — and from here on the server reads it from there, never from the environment.
    const credential = await client.providerCredentials.put(smoke.provider, {
      type: 'api_key',
      api_key: smoke.apiKey,
    })
    expect(credential.provider).toBe(smoke.provider)
    expect(JSON.stringify(credential)).not.toContain(smoke.apiKey)

    const agent = await client.agents.create({
      name: 'Smoke agent',
      model: { id: smoke.model },
      system: 'Answer in one short sentence.',
    })
    const session = await client.sessions.create({ agent: agent.id })

    const sent = await client.sendMessage(session.id, 'Say hello.')
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq, timeoutMs: 90_000 })

    const log = await readLog(client, session.id)
    expect(modelRequestEnds(log).every((event) => event.is_error === null)).toBe(true)
    const reply = agentMessages(log)[0]
    expect(reply).toBeDefined()
    expect(textOf(reply!).trim().length).toBeGreaterThan(0)
  }, 120_000) // A real provider, over a real network, with its own queueing.
})
