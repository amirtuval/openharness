import { PROVIDERS } from '@openharness/client'
import { VALIDATABLE_PROVIDERS } from '@openharness/server'
import { describe, expect, it } from 'vitest'

/**
 * The two provider lists agree (#209).
 *
 * The frontends offer a provider and the server decides whether a key for it can be stored, and
 * those are two different packages: `@openharness/client` carries the metadata a tile and a form
 * need (name, "get a key" URL, free-tier hint, credential type), and `apps/server`'s
 * `VALIDATABLE_PROVIDERS` is the set it has a cheap authenticated read for. A provider in one
 * and not the other is a dead end either way — a tile that leads to a key the server refuses, or
 * a key `oh` and the web app cannot offer at all — so they have to be the same set.
 *
 * **This test lives here for a dependency reason, not a subject reason.** The server may not
 * depend on `client` (see the allowed-dependency table in `docs/architecture.md`), so neither
 * package can hold the assertion; `e2e` is the one place that already depends on both, and it
 * needs nothing else — no server process, no database.
 *
 * The invariant it holds is the one `apps/server`'s own `model-catalog.test.ts` holds for the
 * catalogue: a key that can be stored can also be listed, and now, a tile that can be shown can
 * also be saved.
 */
describe('the provider metadata and the server’s validatable providers', () => {
  it('carry exactly the same provider ids', () => {
    expect(PROVIDERS.map((provider) => provider.id).sort()).toEqual(
      [...VALIDATABLE_PROVIDERS].sort(),
    )
  })

  it('gives every provider a credential form the protocol accepts', () => {
    const ids = new Set<string>(VALIDATABLE_PROVIDERS)

    for (const provider of PROVIDERS) {
      expect(ids.has(provider.id), `${provider.id} is offered but not validatable`).toBe(true)
      // The credential type is what selects the form (X6), so a provider whose type the
      // server cannot store is the same dead end as a missing tile.
      expect(provider.credential).toBe('api_key')
      expect(provider.keyUrl.startsWith('https://')).toBe(true)
    }
  })
})
