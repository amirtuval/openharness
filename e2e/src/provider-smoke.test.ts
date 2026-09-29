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
 * It is skipped silently when neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` is set — the
 * usual state of a laptop and of CI — and it is deliberately *coarse*: a provider is not
 * deterministic, so it asserts that a reply arrived and that the request did not fail, never
 * what the reply says.
 */

const harness = e2eHarness('provider-smoke')

/** The provider the environment offers, if any. */
function smokeFromEnvironment(): { readonly model: string } | undefined {
  if ((process.env.ANTHROPIC_API_KEY ?? '') !== '') {
    return { model: 'anthropic/claude-sonnet-5' }
  }
  if ((process.env.OPENAI_API_KEY ?? '') !== '') {
    return { model: 'openai/gpt-5.1' }
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

    const client = harness.client(server)
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
    expect(textOf(reply!).trim().length).toBeGreaterThan(0)
  }, 120_000) // A real provider, over a real network, with its own queueing.
})
