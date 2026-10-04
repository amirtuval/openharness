import {
  createMastraRegistry,
  isEverydayModel,
  newestModelId,
  RECOMMENDED_DEFAULT_MODELS,
} from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  e2eHarness,
  personFor,
  startProviderStub,
  type Person,
  type ProviderStub,
  type ServerProcess,
} from './harness'

/**
 * The automatic default model, end to end (epic #116, U4): saving the first provider key
 * picks one, and a delete maintains or clears it — so "New chat" can open with no dialog.
 *
 * Saving a key goes through `PUT /v1/provider-credentials/{provider}`, which **validates it
 * against the provider** (A5) and then picks the default against the caller's live catalog
 * (`GET /v1/models`, C1). Both are outbound calls, and CI has no provider key and no business
 * reaching one: the harness's provider stub (`harness/provider-stub.ts`) answers them — the
 * server under test is pointed at a loopback egress proxy (a documented deployment shape)
 * that terminates TLS with a throwaway fixture certificate and answers on the spot. So the
 * whole path is real — the route, the vault, the catalogue, the picker, real Postgres — and
 * the only thing that is not the internet is the internet.
 *
 * The expectations come from the product's own exported rule (`RECOMMENDED_DEFAULT_MODELS`,
 * `isEverydayModel`, `newestModelId`), not from a copy of it: a table update moves the test
 * with it instead of turning it red for the wrong reason.
 */

const harness = e2eHarness('default-model')

/** A key shaped like the real thing; nothing is ever charged to it because nothing real sees it. */
const FAKE_KEY = 'sk-ant-e2e-provider-stub-0001'

/** A signed-in person nobody else in this file shares. */
async function person(server: ServerProcess, name: string): Promise<Person> {
  return personFor(
    server,
    await harness.user(server, {
      email: `${name}@default-model.test`,
      password: `${name}-password`,
    }),
  )
}

/** The model id (without the provider) a provider's list answers with: the table's first pick. */
function recommendedModelFor(provider: string): string {
  const first = RECOMMENDED_DEFAULT_MODELS[provider]?.[0]
  if (first === undefined) {
    throw new Error(`the recommendation table has no entry for ${provider}`)
  }
  return first
}

/** What the registry fallback should pick for a provider, per the exported rule. */
function registryFallbackFor(provider: string): string {
  const everyday = createMastraRegistry()
    .models(provider)
    .filter((model) => isEverydayModel(model.id, model.chat))
    .map((model) => `${provider}/${model.id}`)
  const newest = newestModelId(everyday)
  if (newest === null) {
    throw new Error(`the bundled registry knows no everyday model for ${provider}`)
  }
  return newest
}

/** Answer one provider's list with one model id, the way the provider's own payload does. */
function answerWithModel(stub: ProviderStub, host: string, modelId: string): void {
  stub.answer(host, (request) =>
    request.path.startsWith('/v1/models') || request.path.startsWith('/v1beta/models')
      ? { json: { data: [{ id: modelId, display_name: `stub ${modelId}` }], has_more: false } }
      : undefined,
  )
}

/**
 * Put this test's servers away now rather than at the file's teardown.
 *
 * The e2e suite runs its files side by side on a small runner, and a file that leaves seven
 * idle server processes up until `afterAll` makes every *other* file's turn pay for them.
 * This is the same kill the teardown would do — `kill()` is idempotent — just earlier.
 */
async function killServers(): Promise<void> {
  await Promise.all(harness.servers.map(async (server) => server.kill()))
}

describe('the automatic default model (U4)', () => {
  it('picks the recommendation table’s first entry the live catalog lists, on the first key', async () => {
    const stub = await startProviderStub()
    try {
      // The catalog will be the stub's: it lists exactly the model the table recommends first.
      const recommended = recommendedModelFor('anthropic')
      answerWithModel(stub, 'api.anthropic.com', recommended)
      const server = await harness.server({ env: stub.env })
      const me = await person(server, 'first-key')

      // Nobody has a default before a key exists.
      await expect(me.client.preferences.get()).resolves.toEqual({ default_model: null })

      // The save a person makes; the provider call behind it is the stub's.
      const credential = await me.client.providerCredentials.put('anthropic', {
        type: 'api_key',
        api_key: FAKE_KEY,
      })
      expect(credential.provider).toBe('anthropic')
      expect(JSON.stringify(credential)).not.toContain(FAKE_KEY)

      // The pick: `<provider>/<recommended>` — the table's first entry, which the live
      // catalog lists because the stub is the provider.
      await expect(me.client.preferences.get()).resolves.toEqual({
        default_model: `anthropic/${recommended}`,
      })

      // Which calls made that possible: the validating read (A5) and the list the pick was
      // made against (C1) — the default is chosen from `GET /v1/models`, not from a guess.
      const paths = stub.requests
        .filter((request) => request.host === 'api.anthropic.com')
        .map((request) => request.path)
      expect(paths).toContain('/v1/models?limit=1')
      expect(paths.some((path) => path.startsWith('/v1/models?limit=1000'))).toBe(true)
    } finally {
      await killServers()
      await stub.stop()
    }
  })

  it('falls back to the newest everyday registry model when the provider cannot be listed', async () => {
    const stub = await startProviderStub()
    try {
      // The validating call (first) is answered; the catalogue's list call is refused, so the
      // catalogue answers from the bundled registry as a visible fallback (C3) and the pick
      // has nothing listed to match the recommendation table against.
      let calls = 0
      stub.answer('api.together.xyz', () => {
        calls += 1
        return calls === 1
          ? { json: { data: [] } }
          : { status: 503, json: { error: 'the stub refuses to list' } }
      })
      const server = await harness.server({ env: stub.env })
      const me = await person(server, 'fallback')

      await me.client.providerCredentials.put('together', {
        type: 'api_key',
        api_key: FAKE_KEY,
      })

      // `together` has no recommendation-table entry, so the pick is the registry rule: the
      // newest chat model that is neither expensive nor reasoning-only.
      await expect(me.client.preferences.get()).resolves.toEqual({
        default_model: registryFallbackFor('together'),
      })
      // Exactly the two calls: the validation and the list that failed.
      expect(stub.requests.filter((request) => request.host === 'api.together.xyz')).toHaveLength(2)
    } finally {
      await killServers()
      await stub.stop()
    }
  })

  it('never moves a default that exists — an automatic one, or the user’s own choice', async () => {
    const stub = await startProviderStub()
    try {
      answerWithModel(stub, 'api.anthropic.com', recommendedModelFor('anthropic'))
      answerWithModel(stub, 'api.openai.com', recommendedModelFor('openai'))
      const server = await harness.server({ env: stub.env })

      // (a) A second key leaves the first pick alone.
      const twoKeys = await person(server, 'two-keys')
      await twoKeys.client.providerCredentials.put('anthropic', {
        type: 'api_key',
        api_key: FAKE_KEY,
      })
      const picked = `anthropic/${recommendedModelFor('anthropic')}`
      await expect(twoKeys.client.preferences.get()).resolves.toEqual({ default_model: picked })

      await twoKeys.client.providerCredentials.put('openai', {
        type: 'api_key',
        api_key: FAKE_KEY,
      })
      await expect(twoKeys.client.preferences.get()).resolves.toEqual({ default_model: picked })

      // (b) A key saved after an explicit choice is a key, not a re-pick. The choice is free
      // text — not necessarily catalogued — because the router accepts ids the catalog has
      // not caught up with.
      const explicit = await person(server, 'explicit')
      const chosen = 'acme/chosen-by-hand-4f'
      await explicit.client.preferences.put({ default_model: chosen })

      await explicit.client.providerCredentials.put('anthropic', {
        type: 'api_key',
        api_key: FAKE_KEY,
      })
      await expect(explicit.client.preferences.get()).resolves.toEqual({ default_model: chosen })
    } finally {
      await killServers()
      await stub.stop()
    }
  })

  it('maintains an automatic default on a delete: re-picked from the keys that remain, else cleared', async () => {
    const stub = await startProviderStub()
    try {
      answerWithModel(stub, 'api.anthropic.com', recommendedModelFor('anthropic'))
      answerWithModel(stub, 'api.openai.com', recommendedModelFor('openai'))
      const server = await harness.server({ env: stub.env })
      const me = await person(server, 'delete-maintains')

      await me.client.providerCredentials.put('anthropic', { type: 'api_key', api_key: FAKE_KEY })
      await me.client.providerCredentials.put('openai', { type: 'api_key', api_key: FAKE_KEY })
      await expect(me.client.preferences.get()).resolves.toEqual({
        default_model: `anthropic/${recommendedModelFor('anthropic')}`,
      })

      // Deleting a provider the default does not run on changes nothing.
      await me.client.providerCredentials
        .put('google', { type: 'api_key', api_key: FAKE_KEY })
        .catch(() => {
          // The stub does not answer google's list; the save is refused (422) and nothing is
          // stored — the delete below is what this step is about.
        })
      await me.client.providerCredentials.delete('google')

      // The default's own provider loses its key: an automatic default is *maintained* — it
      // re-picks from the providers that remain, because the server owns this value.
      await me.client.providerCredentials.delete('anthropic')
      await expect(me.client.preferences.get()).resolves.toEqual({
        default_model: `openai/${recommendedModelFor('openai')}`,
      })

      // The last key goes: nothing is left to run, and a default that cannot run is worse
      // than none.
      await me.client.providerCredentials.delete('openai')
      await expect(me.client.preferences.get()).resolves.toEqual({ default_model: null })
    } finally {
      await killServers()
      await stub.stop()
    }
  })

  it('clears — but never substitutes — a default the user chose themselves', async () => {
    const stub = await startProviderStub()
    try {
      answerWithModel(stub, 'api.anthropic.com', recommendedModelFor('anthropic'))
      answerWithModel(stub, 'api.openai.com', recommendedModelFor('openai'))
      const server = await harness.server({ env: stub.env })
      const me = await person(server, 'delete-explicit')

      const chosen = `anthropic/${recommendedModelFor('anthropic')}`
      await me.client.preferences.put({ default_model: chosen })
      await me.client.providerCredentials.put('anthropic', { type: 'api_key', api_key: FAKE_KEY })
      await me.client.providerCredentials.put('openai', { type: 'api_key', api_key: FAKE_KEY })
      await expect(me.client.preferences.get()).resolves.toEqual({ default_model: chosen })

      // A delete must not swap the user's model for another one — even a valid one from a
      // provider they still have a key for. Their choice becomes unrunnable, so it is
      // cleared, and the settings screen is where a new one is made.
      await me.client.providerCredentials.delete('anthropic')
      await expect(me.client.preferences.get()).resolves.toEqual({ default_model: null })
    } finally {
      await killServers()
      await stub.stop()
    }
  })
})
