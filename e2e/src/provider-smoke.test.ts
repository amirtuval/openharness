import { EVENT_TYPES } from '@openharness/protocol'
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
 * The provider-credential success path, against a real provider (#120).
 *
 * `PUT /v1/provider-credentials/{provider}` validates the key with one **real provider call**
 * and no test seam crosses the process boundary (`harness/credentials.ts` documents why the
 * rest of the suite seeds the row instead), so this file is the only automatic run that
 * exercises the whole path: validate → seal → store → resolve the key on the next turn. It
 * stores the environment's key as the **dev user's provider credential** — the same route a
 * person uses — lists it back (metadata only), and runs one turn through the real router on
 * the vault-opened copy. The key in the environment is only this *test's* way of having one;
 * the server under test would ignore it (`OPENAI_API_KEY` is not read, tested in
 * `apps/server`).
 *
 * Everything else in this suite runs against the deterministic mock, which is what makes its
 * assertions exact. This file is the counterweight, and it is deliberately *coarse*: a
 * provider is not deterministic, so it asserts that the PUT answered, that the credential is
 * listed, that a reply arrived through the router and that the request did not fail — never
 * what the reply says.
 *
 * Which provider and model run:
 *
 * - with `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) in the environment it runs that provider's
 *   default from {@link SMOKE_PROVIDERS};
 * - `OPENHARNESS_SMOKE_MODEL=provider/model` overrides the model — and with it the provider
 *   whose key is needed, because the credential has to be stored for the provider the model
 *   names. The CI job (`provider-smoke` in `.github/workflows/ci.yml`) runs on the default
 *   below; the override is how pointing CI at another model stays a variable change rather
 *   than a code change.
 *
 * No usable key is a **skip** by default — the usual state of a laptop and of a CI job that
 * passes no key — and a **failure** when `OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1` is set: that
 * is how the CI job runs it, because a job that exists to cover this path must not pass by
 * skipping it.
 */

const harness = e2eHarness('provider-smoke')

/**
 * The providers this file knows: the variable their key lives in, and the model to run by
 * default.
 *
 * The OpenAI default is the first entry of the server's curated everyday-model list
 * (`RECOMMENDED_DEFAULT_MODELS.openai` in `apps/server/src/default-model.ts`, epic #116 U4) —
 * the capable **"mini" tier** the server itself would pick for a new chat on this key — and
 * the bundled registry knows it, so it is cheap enough to run a real turn on every CI run.
 */
const SMOKE_PROVIDERS: Readonly<
  Record<string, { readonly keyVar: string; readonly model: string }>
> = {
  anthropic: { keyVar: 'ANTHROPIC_API_KEY', model: 'anthropic/claude-sonnet-5' },
  openai: { keyVar: 'OPENAI_API_KEY', model: 'openai/gpt-5-mini' },
}

/** What the environment offers: the provider, the key to store, and the model to run. */
interface Smoke {
  readonly provider: string
  readonly model: string
  readonly apiKey: string
}

/** A variable that is set and not blank; a set-but-empty one counts as unset. */
function envValue(name: string): string | undefined {
  const value = (process.env[name] ?? '').trim()
  return value === '' ? undefined : value
}

/**
 * Read the environment: `OPENHARNESS_SMOKE_MODEL` decides the model **and** the provider (the
 * credential is stored for the provider the model names, so the two have to agree); without
 * it, the first of {@link SMOKE_PROVIDERS} whose key is set answers, on its default model.
 * `undefined` when no usable key is present.
 */
function smokeFromEnvironment(): Smoke | undefined {
  const requested = envValue('OPENHARNESS_SMOKE_MODEL')
  if (requested !== undefined) {
    const provider = requested.slice(0, requested.indexOf('/'))
    const keyVar = SMOKE_PROVIDERS[provider]?.keyVar
    const apiKey = keyVar === undefined ? undefined : envValue(keyVar)
    return apiKey === undefined ? undefined : { provider, model: requested, apiKey }
  }
  for (const [provider, known] of Object.entries(SMOKE_PROVIDERS)) {
    const apiKey = envValue(known.keyVar)
    if (apiKey !== undefined) {
      return { provider, model: known.model, apiKey }
    }
  }
  return undefined
}

const smoke = smokeFromEnvironment()

/**
 * The CI contract: with `OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1` a missing key fails the run
 * instead of skipping it, so the job cannot pass by never exercising the path (#120).
 */
const smokeRequired = envValue('OPENHARNESS_REQUIRE_PROVIDER_SMOKE') === '1'

describe.skipIf(smoke === undefined && !smokeRequired)('a real model provider', () => {
  it('stores a key through the PUT route and answers a turn on it', async () => {
    if (smoke === undefined) {
      throw new Error(
        'OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1, but neither OPENAI_API_KEY nor ' +
          'ANTHROPIC_API_KEY is set: there is no provider to run',
      )
    }
    const target = smoke

    // `mockModel: false` is the point: no `OPENHARNESS_TEST_MODEL`, so the process runs the
    // brain's default router and whatever provider the model id resolves to.
    const server = await harness.server({ mockModel: false })
    expect(server.output()).toMatch(/model: mastra router/)

    const client = await harness.client(server)

    // The PUT the CI job exists for: one real provider call validates the key, and only then
    // is it sealed and stored. The metadata that comes back carries the last four characters
    // — and never the key.
    const credential = await client.providerCredentials.put(target.provider, {
      type: 'api_key',
      api_key: target.apiKey,
    })
    expect(credential.provider).toBe(target.provider)
    expect(credential.last4).toBe(target.apiKey.slice(-4))
    expect(JSON.stringify(credential)).not.toContain(target.apiKey)

    // And it is listed, metadata only.
    const listed = await client.providerCredentials.list()
    expect(listed.data.filter((entry) => entry.provider === target.provider)).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain(target.apiKey)

    // The turn runs on the stored key — A5: the server resolves it from the vault, not from
    // the environment it also has — through the real router and a real network.
    const agent = await client.agents.create({
      name: 'Smoke agent',
      model: { id: target.model },
      system: 'Answer in one short sentence.',
    })
    const session = await client.sessions.create({ agent: agent.id })

    const sent = await client.sendMessage(session.id, 'Say hello.')
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq, timeoutMs: 90_000 })

    const log = await readLog(client, session.id)
    // A request that failed — a refused key, a provider outage — writes `is_error: true`.
    expect(modelRequestEnds(log).every((event) => event.is_error === null)).toBe(true)
    // The requests the router made name the model the test asked for.
    const starts = log.filter((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.every((event) => event.model === target.model)).toBe(true)
    // Coarse on purpose: a provider is not deterministic — a non-empty reply arrived.
    const reply = agentMessages(log)[0]
    expect(reply).toBeDefined()
    expect(textOf(reply!).trim().length).toBeGreaterThan(0)
    // Nothing that left the server — a response body, the log, a server log line — echoes
    // the key.
    expect(JSON.stringify(log)).not.toContain(target.apiKey)
    expect(server.output()).not.toContain(target.apiKey)
  }, 120_000) // A real provider, over a real network, with its own queueing.
})
