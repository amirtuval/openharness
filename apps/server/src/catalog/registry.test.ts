import { describe, expect, it } from 'vitest'

import { createMastraRegistry, emptyRegistry } from './registry'

/**
 * The registry seam over the installed `@mastra/core` (C2): the bundled data, read through
 * the API that version exports, with no network anywhere. These tests pin what the *installed*
 * version carries — ids, and provider configuration — because the rest of the catalogue is
 * written around exactly that: the join fills from the provider's own list, and the filter's
 * name heuristic is what classifies, since the registry has no chat flag to consult.
 */

const registry = createMastraRegistry()

describe('createMastraRegistry', () => {
  it('lists the models the bundled registry knows for a provider', () => {
    const openai = registry.models('openai').map((model) => model.id)

    expect(openai.length).toBeGreaterThan(10)
    expect(openai).toContain('gpt-4.1-mini')
    // The registry lists every model a provider serves, chat and non-chat alike — which is
    // why the catalogue filters its fallback lists through the same name filter.
    expect(openai).toContain('text-embedding-3-small')
  })

  it('carries an id only: this version attaches no name, limits or chat flag', () => {
    const gpt = registry.models('openai').find((model) => model.id === 'gpt-4.1-mini')

    expect(gpt).toEqual({ id: 'gpt-4.1-mini' })
  })

  it('answers an empty list for a provider it does not know', () => {
    expect(registry.models('acme')).toEqual([])
    expect(registry.models('')).toEqual([])
  })

  it('resolves the router spellings whose registry entries are named differently', () => {
    // models.dev keys these by product name; the router (and VALIDATABLE_PROVIDERS) use the
    // short ones. Without the alias the fallback for such a provider would be empty.
    expect(registry.models('fireworks').length).toBeGreaterThan(0)
    expect(registry.models('fireworks').map((model) => model.id)).toEqual(
      registry.models('fireworks-ai').map((model) => model.id),
    )
    expect(registry.models('together').length).toBeGreaterThan(0)
    expect(registry.models('together').map((model) => model.id)).toEqual(
      registry.models('togetherai').map((model) => model.id),
    )
  })

  it('knows the providers this server lists from', () => {
    for (const provider of ['anthropic', 'google', 'openrouter', 'groq', 'deepseek', 'mistral']) {
      expect(registry.models(provider).length, provider).toBeGreaterThan(0)
    }
  })
})

describe('emptyRegistry', () => {
  it('knows nothing, which is what an inert catalogue (a test’s) gets', () => {
    expect(emptyRegistry.models('openai')).toEqual([])
  })
})
