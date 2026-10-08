import { describe, expect, it } from 'vitest'
import { PROVIDER_IDS } from '@openharness/protocol'

import { adaptedProviders, adapterFor } from './adapters'

/**
 * The fixed endpoint table (C1): one adapter per provider the server may call, its URL a
 * constant of this module — nothing a request carries can reach a provider — and the parsing
 * of each provider's own payload shape.
 */

/** The adapter for a provider, failing the test rather than throwing when it is missing. */
function adapter(provider: string) {
  const found = adapterFor(provider)
  expect(found, `no adapter for ${provider}`).not.toBeNull()
  if (found === null) {
    throw new Error(`no adapter for ${provider}`)
  }
  return found
}

describe('the table', () => {
  it('has an adapter for every provider of the shared list, under that provider id', () => {
    // The table is a `Record<ProviderId, …>` (#245), so a missing provider is a compile error
    // and the ids come from the one list rather than a copy. What is left for a test is the
    // pairing itself: the key an adapter sits under is the id it serves, which the error
    // messages in `catalog.ts` repeat back to a reader.
    expect(adaptedProviders()).toEqual(PROVIDER_IDS)
    for (const provider of PROVIDER_IDS) {
      expect(adapterFor(provider)?.provider, `${provider} has no model-list adapter`).toBe(provider)
    }
  })

  it('knows no adapter for a provider outside it — a registry-only provider', () => {
    expect(adapterFor('acme')).toBeNull()
    expect(adapterFor('')).toBeNull()
    expect(adaptedProviders()).not.toContain('acme')
  })

  it('builds every URL from a constant: the key never appears in one', () => {
    const key = 'sk-do-not-put-me-in-a-url-424242'
    for (const provider of adaptedProviders()) {
      const built = adapter(provider)
      expect(built.url(null)).toMatch(/^https:\/\//)
      expect(built.url(null)).not.toContain(key)
      // And the headers are where the key goes.
      expect(Object.values(built.headers(key)).join(' ')).toContain(key)
    }
  })

  it('sends the key the way each provider expects it', () => {
    expect(adapter('anthropic').headers('k').authorization).toBeUndefined()
    expect(adapter('anthropic').headers('k')['x-api-key']).toBe('k')
    expect(adapter('anthropic').headers('k')['anthropic-version']).toBe('2023-06-01')
    // Gemini's key goes in a header, never the URL (issue #90: "prefer the header so the key
    // isn't in a URL").
    expect(adapter('google').headers('k')['x-goog-api-key']).toBe('k')
    expect(adapter('google').url(null)).not.toContain('key=')
    expect(adapter('openai').headers('k').authorization).toBe('Bearer k')
    expect(adapter('openrouter').headers('k').authorization).toBe('Bearer k')
    expect(adapter('groq').headers('k').authorization).toBe('Bearer k')
  })

  it('points the OpenAI-compatible family at each provider’s own base URL', () => {
    expect(adapter('groq').url(null)).toBe('https://api.groq.com/openai/v1/models')
    expect(adapter('deepseek').url(null)).toBe('https://api.deepseek.com/v1/models')
    expect(adapter('fireworks').url(null)).toBe('https://api.fireworks.ai/inference/v1/models')
    expect(adapter('mistral').url(null)).toBe('https://api.mistral.ai/v1/models')
    expect(adapter('together').url(null)).toBe('https://api.together.xyz/v1/models')
    expect(adapter('xai').url(null)).toBe('https://api.x.ai/v1/models')
    expect(adapter('cerebras').url(null)).toBe('https://api.cerebras.ai/v1/models')
  })
})

describe('OpenAI and the OpenAI-compatible family', () => {
  it('reads the OpenAI list envelope', () => {
    const page = adapter('openai').parse({
      object: 'list',
      data: [{ id: 'gpt-4.1', object: 'model' }, { id: 'gpt-4o-mini' }],
    })

    expect(page.models.map((model) => model.id)).toEqual(['gpt-4.1', 'gpt-4o-mini'])
    expect(page.next).toBeNull()
    // OpenAI gives no capability or limit data; the registry join and the filter decide.
    expect(page.models[0]).toEqual({ id: 'gpt-4.1' })
  })

  it('reads the bare array some OpenAI-compatible providers answer with', () => {
    const page = adapter('together').parse([
      { id: 'Qwen/Qwen3-235B', display_name: 'Qwen3 235B', context_length: 32768 },
    ])

    expect(page.models).toEqual([
      { id: 'Qwen/Qwen3-235B', name: 'Qwen3 235B', contextWindow: 32768 },
    ])
  })

  it('refuses a body that is not a model list', () => {
    expect(() => adapter('openai').parse({ error: 'nope' })).toThrow(/data/)
    expect(() => adapter('openai').parse({ data: [{ notAnId: true }] })).toThrow(/id/)
  })
})

describe('Anthropic', () => {
  it('reads ids and display names, and follows the page cursor', () => {
    const first = adapter('anthropic').parse({
      data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', type: 'model' }],
      has_more: true,
      first_id: 'claude-sonnet-5',
      last_id: 'claude-sonnet-5',
    })

    expect(first.models).toEqual([{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }])
    expect(first.next).toBe('claude-sonnet-5')
    expect(adapter('anthropic').url('claude-sonnet-5')).toContain('after_id=claude-sonnet-5')

    const last = adapter('anthropic').parse({ data: [], has_more: false })
    expect(last.next).toBeNull()
  })
})

describe('Google Gemini', () => {
  it('strips the models/ prefix, reads the limits, and takes the provider’s chat verdict', () => {
    const page = adapter('google').parse({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        {
          name: 'models/text-embedding-004',
          supportedGenerationMethods: ['embedContent'],
        },
      ],
      nextPageToken: 'page-2',
    })

    expect(page.models[0]).toEqual({
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      contextWindow: 1048576,
      maxOutput: 65536,
      chat: true,
    })
    // embedContent without generateContent is the provider saying "not a chat model".
    expect(page.models[1]?.chat).toBe(false)
    expect(page.next).toBe('page-2')
    expect(adapter('google').url('page-2')).toContain('pageToken=page-2')
  })
})

describe('OpenRouter', () => {
  it('reads the catalogue and marks every entry as chat', () => {
    const page = adapter('openrouter').parse({
      data: [
        {
          id: 'anthropic/claude-opus-4.5',
          name: 'Anthropic: Claude Opus 4.5',
          context_length: 200000,
          top_provider: { max_completion_tokens: 32000 },
        },
      ],
    })

    expect(page.models).toEqual([
      {
        id: 'anthropic/claude-opus-4.5',
        chat: true,
        name: 'Anthropic: Claude Opus 4.5',
        contextWindow: 200000,
        maxOutput: 32000,
      },
    ])
  })
})
