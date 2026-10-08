import { describe, expect, it } from 'vitest'

import { PutProviderCredentialRequestSchema } from './resources/provider-credential'
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from './providers'

/**
 * The one provider list (epic #245, A0).
 *
 * What is worth pinning here is the contract the rest of the repo is typed against: the ids,
 * their order, and the facts every side reads. The rest of the list's invariants — that the
 * server can validate, list and make a request for each provider — are compile errors in those
 * packages now, not assertions here.
 */
describe('PROVIDERS', () => {
  it('carries the eleven provider ids, in the order every side lists them', () => {
    // The order is part of the contract: a frontend draws its tiles in it, and the vendored
    // models.dev snapshot is keyed in it. Reordering this list reorders the snapshot.
    expect(PROVIDER_IDS).toEqual([
      'anthropic',
      'openai',
      'google',
      'openrouter',
      'groq',
      'deepseek',
      'fireworks',
      'mistral',
      'together',
      'xai',
      'cerebras',
    ])
    expect(PROVIDERS.map((provider) => provider.id)).toEqual(PROVIDER_IDS)
  })

  it('describes each provider with what a side needs to name it and get a key', () => {
    for (const provider of PROVIDERS) {
      expect(provider.name).not.toBe('')
      expect(provider.modelsDevKey).not.toBe('')
      // Every key a reader is sent to fetch is over https. The path is not pinned: a provider
      // whose exact keys page could not be confirmed links to its account home instead.
      expect(provider.keyUrl).toMatch(/^https:\/\/[^/]+/)
    }
  })

  it('names a credential type the credentials API accepts', () => {
    for (const provider of PROVIDERS) {
      // The type selects the form a frontend renders (X6), so it has to be one the route
      // parses: the type is checked against the request schema, not against a literal.
      const parsed = PutProviderCredentialRequestSchema.safeParse({
        type: provider.credential,
        api_key: 'sk-test-1234',
      })
      expect(parsed.success, `${provider.id} has no storable credential type`).toBe(true)
    }
  })

  it('files each provider under its own models.dev key', () => {
    const keys = PROVIDERS.map((provider) => provider.modelsDevKey)

    expect(new Set(keys).size).toBe(keys.length)
    // Nine of the eleven are the identity; models.dev spells two by product name.
    expect(PROVIDERS.find((provider) => provider.id === 'fireworks')?.modelsDevKey).toBe(
      'fireworks-ai',
    )
    expect(PROVIDERS.find((provider) => provider.id === 'together')?.modelsDevKey).toBe(
      'togetherai',
    )
  })
})

describe('a table keyed by ProviderId', () => {
  it('is a compile error to leave a provider out of one', () => {
    const complete: Record<ProviderId, string> = {
      anthropic: '',
      openai: '',
      google: '',
      openrouter: '',
      groq: '',
      deepseek: '',
      fireworks: '',
      mistral: '',
      together: '',
      xai: '',
      cerebras: '',
    }
    // @ts-expect-error — `Record<ProviderId, …>` demands every provider; `cerebras` is missing.
    const incomplete: Record<ProviderId, string> = {
      anthropic: '',
      openai: '',
      google: '',
      openrouter: '',
      groq: '',
      deepseek: '',
      fireworks: '',
      mistral: '',
      together: '',
      xai: '',
    }

    expect(Object.keys(complete)).toHaveLength(PROVIDER_IDS.length)
    expect(Object.keys(incomplete)).toHaveLength(PROVIDER_IDS.length - 1)
  })
})
