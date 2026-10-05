import type { Client } from '@openharness/client'
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
  seedProviderCredential,
  startProviderStub,
  type Person,
  type ProviderStub,
  type ServerProcess,
} from './harness'

/**
 * The automatic default model (epic #116, U4), over the real routes.
 *
 * U4 has two halves, and both are driven end to end here:
 *
 * - **a credential is saved** → the picker chooses a default from the caller's live catalog.
 *   `PUT /v1/provider-credentials/{provider}` validates the key with one cheap call to the
 *   provider (A5) before anything is stored, so reaching this half over HTTP needs a real key
 *   — which CI never has. The harness's provider stub (`harness/provider-stub.ts`) is the one
 *   seam a real process has: the server under test is pointed at a loopback egress proxy (the
 *   documented deployment shape, `catalog/provider-fetch.ts`) that terminates the CONNECT
 *   tunnel with a throwaway fixture certificate and answers — or refuses — the validating
 *   call and the catalogue's list call on the spot. The whole path stays real (the route, the
 *   vault, the picker, the catalogue, real Postgres); the only thing that is not the internet
 *   is the internet. The expectations come from the product's own exported rule
 *   (`RECOMMENDED_DEFAULT_MODELS`, `isEverydayModel`, `newestModelId`), not from a copy of it.
 * - **a credential is deleted** → a default whose provider just lost its last key is
 *   **re-picked** when the server chose it, and **cleared** when the user did. This half needs
 *   no stub: the delete route never calls a provider, so a credential written the way
 *   `seedProviderCredential` writes one (the exact row the PUT route writes, through the
 *   server's own sealing and store — see `harness/credentials.ts`) can be deleted through the
 *   real route. Every credential in those cases belongs to a provider no adapter knows, so the
 *   catalogue answers from the registry and the suite makes no outbound request (C3/C5).
 */

const harness = e2eHarness('default-model')

/** A provider no adapter and no registry entry knows: the catalogue never dials for it. */
const FIRST_PROVIDER = 'acme-first'
const SECOND_PROVIDER = 'acme-second'

/** The explicit default the tests store, naming {@link FIRST_PROVIDER}. */
const EXPLICIT_DEFAULT = `${FIRST_PROVIDER}/everyday-model`

/** Store a key for a provider, the way the `PUT` route stores one once it has validated it. */
async function seedKey(userId: string, provider: string): Promise<void> {
  await seedProviderCredential(await harness.database(), {
    userId,
    provider,
    apiKey: `sk-${provider}-must-not-leak-3f1c`,
  })
}

/** The providers the caller's catalogue lists, sorted — the C5 answer, over the wire. */
async function listedProviders(client: Client): Promise<string[]> {
  const catalog = await client.models.list()
  return catalog.providers.map((status) => status.provider).sort()
}

/**
 * A key shaped like the real thing. Nothing is ever charged to it: it only ever travels to
 * the loopback stub, which answers every key the same way — the tests assert the calls, not
 * the credential.
 */
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
 * The e2e suite runs its files side by side on a small runner, and a file that leaves several
 * idle server processes up until `afterAll` makes every *other* file's turn pay for them.
 * This is the same kill the teardown would do — `kill()` is idempotent — just earlier.
 */
async function killServers(): Promise<void> {
  await Promise.all(harness.servers.map(async (server) => server.kill()))
}

describe('the automatic default model (U4)', () => {
  it('leaves an explicit default alone while its provider has a key, and clears it when it does not', async () => {
    const server = await harness.server()
    const person = personFor(
      server,
      await harness.user(server, { email: 'u4@default-model.test', password: 'u4-password' }),
    )
    const { client } = person

    await seedKey(person.signedIn.user.id, FIRST_PROVIDER)
    await seedKey(person.signedIn.user.id, SECOND_PROVIDER)
    expect(await listedProviders(client)).toEqual([FIRST_PROVIDER, SECOND_PROVIDER])

    // The user's own choice, written through the settings route.
    await expect(client.preferences.put({ default_model: EXPLICIT_DEFAULT })).resolves.toEqual({
      default_model: EXPLICIT_DEFAULT,
    })

    // Deleting a *different* provider's key does not touch it: the model can still run, so
    // there is nothing to re-pick or clear.
    await expect(client.providerCredentials.delete(SECOND_PROVIDER)).resolves.toBeUndefined()
    await expect(client.preferences.get()).resolves.toEqual({ default_model: EXPLICIT_DEFAULT })
    // And the deleted provider is gone from the catalogue at once — the cached list was
    // fetched with the key that just went away (C4).
    expect(await listedProviders(client)).toEqual([FIRST_PROVIDER])

    // Deleting the key the default depends on clears it: an explicit choice is never
    // substituted (that is the user's to make), and a default that cannot run is worse than
    // none — the client shows "add a key" instead of failing the first message.
    await expect(client.providerCredentials.delete(FIRST_PROVIDER)).resolves.toBeUndefined()
    await expect(client.preferences.get()).resolves.toEqual({ default_model: null })
    expect(await listedProviders(client)).toEqual([])
  })

  it('is per person: one user’s credential delete leaves another user’s default untouched', async () => {
    const server = await harness.server()
    const a = personFor(
      server,
      await harness.user(server, { email: 'a@default-model.test', password: 'a-password' }),
    )
    const b = personFor(
      server,
      await harness.user(server, { email: 'b@default-model.test', password: 'b-password' }),
    )

    await seedKey(a.signedIn.user.id, FIRST_PROVIDER)
    await seedKey(b.signedIn.user.id, FIRST_PROVIDER)
    await a.client.preferences.put({ default_model: EXPLICIT_DEFAULT })
    await b.client.preferences.put({ default_model: `${SECOND_PROVIDER}/b-model` })

    // The delete is scoped to the caller: B's key and B's default survive A's delete of the
    // same provider, and the catalogue is per person too.
    await a.client.providerCredentials.delete(FIRST_PROVIDER)
    await expect(a.client.preferences.get()).resolves.toEqual({ default_model: null })
    await expect(b.client.preferences.get()).resolves.toEqual({
      default_model: `${SECOND_PROVIDER}/b-model`,
    })
    expect(await listedProviders(b.client)).toEqual([FIRST_PROVIDER])
    expect(await listedProviders(a.client)).toEqual([])
  })

  it('is not an error to delete a credential that was never there', async () => {
    const server = await harness.server()
    const person = personFor(
      server,
      await harness.user(server, { email: 'noop@default-model.test', password: 'n-password' }),
    )
    const { client } = person

    await seedKey(person.signedIn.user.id, FIRST_PROVIDER)
    await client.preferences.put({ default_model: EXPLICIT_DEFAULT })

    // The caller's state is "no credential for this provider" either way, so the delete says
    // so with the same 204 — and it is not a delete of anything else. The default names a
    // provider whose key is still there, so the rule that clears a default that cannot run has
    // nothing to do.
    await expect(client.providerCredentials.delete(SECOND_PROVIDER)).resolves.toBeUndefined()
    await expect(client.preferences.get()).resolves.toEqual({ default_model: EXPLICIT_DEFAULT })
    expect(await listedProviders(client)).toEqual([FIRST_PROVIDER])
  })

  it('leaves a default naming a keyless provider alone when its delete removes nothing (#139)', async () => {
    const server = await harness.server()
    const person = personFor(
      server,
      await harness.user(server, { email: 'ghost@default-model.test', password: 'g-password' }),
    )
    const { client } = person

    // A default naming a provider this account has no key for at all — a hand-written
    // preference, or a default another instance picked before its key went away. The delete
    // removes no row, so it is not "the credential the default depends on was deleted", and
    // the preferences must be exactly as they were: before #139 the re-pick/clear ran
    // unconditionally and this cleared the stored default.
    await client.preferences.put({ default_model: `${SECOND_PROVIDER}/never-saved` })

    await expect(client.providerCredentials.delete(SECOND_PROVIDER)).resolves.toBeUndefined()
    await expect(client.preferences.get()).resolves.toEqual({
      default_model: `${SECOND_PROVIDER}/never-saved`,
    })
    expect(await listedProviders(client)).toEqual([])
  })

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
})
