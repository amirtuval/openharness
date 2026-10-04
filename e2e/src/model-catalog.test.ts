import { describe, expect, it } from 'vitest'

import { e2eHarness, personFor, seedProviderCredential } from './harness'

/**
 * The model catalogue, end to end (epic #92, issue #90).
 *
 * `apps/server/src/model-catalog.test.ts` covers C1–C5 exhaustively over a scripted fetch;
 * this file is the deployment's version of the same route, where what can be proven without
 * the network is the part the network cannot change:
 *
 * - an account with no stored keys gets an empty catalogue — no provider is listed and none
 *   is dialled;
 * - a stored key makes its provider appear, and a provider this server has no list endpoint
 *   for is answered from the registry as a visible `fallback` (C3) — which is also why this
 *   test is deterministic offline: no adapter means no outbound request;
 * - one account's keys are not another's: B keeps an empty catalogue while A's provider is
 *   listed, and nothing of A's key reaches any response.
 *
 * The provider-listed paths (filtering, the registry join, cache/refresh) need a provider to
 * answer, which is exactly what the unit suite's scripted fetch exists for; the harness
 * cannot stub a real process's DNS.
 */

const harness = e2eHarness('model-catalog')

/** A provider name no adapter knows and no registry entry carries. */
const UNKNOWN_PROVIDER = 'acme-models'

describe('GET /v1/models over the wire', () => {
  it('lists only the caller’s stored providers, and answers the rest from the registry as fallback', async () => {
    const server = await harness.server()
    const a = personFor(
      server,
      await harness.user(server, { email: 'a@catalogue.test', password: 'a-password' }),
    )
    const b = personFor(
      server,
      await harness.user(server, { email: 'b@catalogue.test', password: 'b-password' }),
    )

    // Nobody has stored anything: empty, and no provider was contacted to say so.
    await expect(b.client.models.list()).resolves.toEqual({ data: [], providers: [] })

    // A key for a provider with no known list endpoint: the catalogue answers from the
    // registry instead of dialling (C3), and says so.
    const apiKey = 'sk-acme-catalogue-must-not-leak-9d2f'
    await seedProviderCredential(await harness.database(), {
      userId: a.signedIn.user.id,
      provider: UNKNOWN_PROVIDER,
      apiKey,
    })

    const mine = await a.client.models.list()
    expect(mine.providers).toHaveLength(1)
    expect(mine.providers[0]).toMatchObject({
      provider: UNKNOWN_PROVIDER,
      status: 'fallback',
      fetched_at: null,
    })
    // The message says why, and never carries any part of the key.
    expect(mine.providers[0]?.message).toContain(UNKNOWN_PROVIDER)
    expect(JSON.stringify(mine)).not.toContain(apiKey)

    // B holds no key of A's: B's catalogue is unchanged, and A's provider is not listed.
    await expect(b.client.models.list()).resolves.toEqual({ data: [], providers: [] })
  })
})
