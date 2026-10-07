import { PutProviderCredentialRequestSchema } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { PROVIDERS, providerInfo, providerName } from './providers'

/**
 * The provider metadata both frontends offer (#209).
 *
 * The one rule this module has to keep is that it describes providers the server will actually
 * accept a key for — a tile that leads to a key the server refuses is worse than no tile. That
 * rule lives with both lists, in `e2e`'s `provider-metadata.test.ts` (the server may not depend
 * on this package). What is here is everything the list must be on its own.
 */
describe('PROVIDERS', () => {
  it('has one entry per provider id, with the fields a tile needs', () => {
    const ids = PROVIDERS.map((provider) => provider.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThan(0)
    for (const provider of PROVIDERS) {
      expect(provider.id).not.toBe('')
      expect(provider.name).not.toBe('')
      // Every key a reader is sent to fetch is over https. The path is not pinned: a provider
      // whose exact keys page could not be confirmed links to its account home instead, which
      // is a bare host (#209).
      expect(provider.keyUrl).toMatch(/^https:\/\/[^/]+/)
    }
  })

  it('names the credential type the protocol knows, and a form the API accepts', () => {
    for (const provider of PROVIDERS) {
      // The form the web app builds for this type has to produce a body the route parses, so
      // the type is checked against the request schema rather than against a string literal.
      const parsed = PutProviderCredentialRequestSchema.safeParse({
        type: provider.credential,
        api_key: 'sk-test-1234',
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('answers the display name, and the id for a provider it does not carry', () => {
    expect(providerInfo('anthropic')?.name).toBe('Anthropic')
    expect(providerInfo('made-up-provider')).toBeUndefined()
    // An unrecognized provider is not an error — the credentials API takes any router id, so
    // the id is what the reader typed and what they see.
    expect(providerName('made-up-provider')).toBe('made-up-provider')
  })
})
