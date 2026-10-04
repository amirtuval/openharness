import type { Client } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import { e2eHarness, personFor, seedProviderCredential } from './harness'

/**
 * The automatic default model (epic #116, U4), over the real routes.
 *
 * U4 has two halves, and only one of them can be driven end to end in a suite that may not
 * make a real provider call:
 *
 * - **a credential is saved** → the picker chooses a default from the caller's live catalog.
 *   `PUT /v1/provider-credentials/{provider}` validates the key with one cheap call to the
 *   provider (A5) before anything is stored, so reaching this half over HTTP needs a real key
 *   — which CI never has. The pick itself (the curated table against the live catalog, the
 *   registry fallback behind it, the "never overwrite an existing default" rule) is covered in
 *   process, where `apps/server/src/default-model.test.ts` injects the validator, and the
 *   catalogue it reads is covered over the wire by `model-catalog.test.ts`.
 * - **a credential is deleted** → a default whose provider just lost its last key is
 *   **re-picked** when the server chose it, and **cleared** when the user did. This half is
 *   reachable: the delete route never calls a provider, so a credential written the way
 *   `seedProviderCredential` writes one (the exact row the PUT route writes, through the
 *   server's own sealing and store — see `harness/credentials.ts`) can be deleted through the
 *   real route.
 *
 * What this file proves, then, is the delete's half of the rule the maintainer asked for: an
 * explicit user default is **never** silently replaced while its provider still has a key, and
 * is cleared — not substituted — when it does not. Every credential here belongs to a provider
 * no adapter knows, so the catalogue answers from the registry and the suite makes no outbound
 * request (C3/C5).
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
})
