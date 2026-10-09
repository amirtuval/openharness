import { describe, expect, it } from 'vitest'

import { createBundledRegistry, emptyRegistry, SNAPSHOT_DATE } from './registry'
import { VALIDATABLE_PROVIDERS } from '../provider-validation'

/**
 * The registry seam over this package's committed models.dev snapshot (C2; #234): the data is
 * a file in the package, bundled with the code, and nothing here reaches a network. These
 * tests pin what the snapshot carries — a display name, a context window, an output limit and
 * the reasoning data per model, which the ids-only registry it replaced did not — and what it
 * does not, because the rest of the catalogue is written around exactly that: the join fills the
 * limits the provider's own list leaves `null`, and the name filter still classifies.
 */

const registry = createBundledRegistry()

describe('createBundledRegistry', () => {
  it('lists the models the snapshot carries for a provider', () => {
    const openai = registry.models('openai').map((model) => model.id)

    expect(openai.length).toBeGreaterThan(10)
    expect(openai).toContain('gpt-5-mini')
    // The snapshot lists every model a provider serves, chat and non-chat alike — which is why
    // the catalogue filters its fallback lists through the same chat rule.
    expect(openai).toContain('text-embedding-3-small')
  })

  it('carries the name, the context window and the output limit', () => {
    const gpt = registry.models('openai').find((model) => model.id === 'gpt-5-mini')

    expect(gpt).toMatchObject({
      id: 'gpt-5-mini',
      name: 'GPT-5 Mini',
      contextWindow: 400000,
      maxOutput: 128000,
    })
  })

  it('carries no chat verdict, because models.dev has none to carry', () => {
    // The fields models.dev does have are not a chat signal: `modalities.output` is `["text"]`
    // for an embedding model too, and `family` is a name family. So the catalogue's name filter
    // is what classifies, and this is pinned here so a future refresh cannot quietly start
    // answering `chat: true` for `text-embedding-3-small` (C2 step 2 would then keep it).
    const embedding = registry
      .models('openai')
      .find((model) => model.id === 'text-embedding-3-small')

    expect(embedding?.chat).toBeUndefined()
    expect(registry.models('openai').some((model) => model.chat !== undefined)).toBe(false)
  })

  it('serves the context windows for the models the catalogue lists for OpenAI and Anthropic', () => {
    // The acceptance case for #234: the limits the provider's own list does not carry are no
    // longer `null` for these two.
    const haiku = registry.models('anthropic').find((model) => model.id === 'claude-haiku-4-5')
    const gpt = registry.models('openai').find((model) => model.id === 'gpt-5-mini')

    expect(haiku?.contextWindow).toBe(200000)
    expect(gpt?.contextWindow).toBe(400000)
  })

  it('carries the reasoning data: an effort model, and a reasoning model without one', () => {
    const sonnet = registry.models('anthropic').find((model) => model.id === 'claude-sonnet-5')
    // The levels are models.dev's own vocabulary, reaching past our three; the reasoning
    // resolver is what narrows them (`catalog/reasoning-support.ts`).
    expect(sonnet).toMatchObject({
      reasoning: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })

    // A plain chat model carries neither field.
    const gpt4o = registry.models('openai').find((model) => model.id === 'gpt-4o-mini')
    expect(gpt4o?.reasoning).toBeUndefined()
    expect(gpt4o?.efforts).toBeUndefined()

    // And a reasoning model whose knob is a token budget or a toggle is `reasoning: true` with
    // no `efforts` — the shape that keeps it on the provider's default.
    const gemini = registry.models('google').find((model) => model.id === 'gemini-2.5-flash')
    expect(gemini?.reasoning).toBe(true)
    expect(gemini?.efforts).toBeUndefined()
  })

  it('answers an empty list for a provider it does not know', () => {
    expect(registry.models('acme')).toEqual([])
    expect(registry.models('')).toEqual([])
    // The snapshot is keyed by our ids, so models.dev's own spelling of a mapped provider
    // answers nothing: the alias lives in the refresh script, not here.
    expect(registry.models('fireworks-ai')).toEqual([])
  })

  it('knows every provider a key can be stored for', () => {
    for (const provider of VALIDATABLE_PROVIDERS) {
      expect(registry.models(provider).length, provider).toBeGreaterThan(0)
    }
  })

  it('resolves the router spellings the snapshot is keyed by', () => {
    // `fireworks` and `together` are models.dev's `fireworks-ai`/`togetherai`; the refresh
    // script maps them, so a `fireworks/…` credential's fallback is not empty.
    expect(registry.models('fireworks').length).toBeGreaterThan(0)
    expect(registry.models('fireworks').map((model) => model.id)).toContain(
      'accounts/fireworks/models/kimi-k3',
    )
    expect(registry.models('together').length).toBeGreaterThan(0)
    expect(registry.models('together').map((model) => model.id)).toContain(
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    )
  })

  it('records the date its data was taken', () => {
    expect(SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('emptyRegistry', () => {
  it('knows nothing, which is what an inert catalogue (a test’s) gets', () => {
    expect(emptyRegistry.models('openai')).toEqual([])
  })
})
