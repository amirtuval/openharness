import { describe, expect, it } from 'vitest'

import { createReasoningSupportResolver } from './reasoning-support'
import { createBundledRegistry, type ModelRegistry } from './registry'

/**
 * The per-model reasoning resolver (#252's follow-up): which of `low | medium | high` a model
 * takes, looked up per request from the registry the catalogue already joins — the data-driven
 * gate that replaced the brain's hand-written per-provider model patterns.
 */

/** A registry over a fixed table, so a test pins the lookup without the snapshot's data. */
function registryOf(
  models: Readonly<
    Record<string, readonly { id: string; reasoning?: boolean; efforts?: readonly string[] }[]>
  >,
): ModelRegistry {
  return { models: (provider) => models[provider] ?? [] }
}

describe('createReasoningSupportResolver', () => {
  it('answers the levels the model takes, narrowed to our three and in our order', () => {
    // models.dev lists Anthropic's own vocabulary, which reaches past ours (`xhigh`, `max`); the
    // resolver is what keeps the answer to the three levels a request may ask for.
    const supportFor = createReasoningSupportResolver(
      registryOf({
        anthropic: [
          {
            id: 'claude-sonnet-5',
            reasoning: true,
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          },
        ],
      }),
    )

    expect(supportFor('anthropic/claude-sonnet-5')).toEqual(['low', 'medium', 'high'])
  })

  it('answers only the levels the model and we share, so the brain can clamp to them', () => {
    // The model takes `low` and `high` and no `medium`; the answer names exactly those, and the
    // brain clamps a requested `medium` to `high` before anything is sent.
    const supportFor = createReasoningSupportResolver(
      registryOf({ openai: [{ id: 'o4-mini', reasoning: true, efforts: ['low', 'high'] }] }),
    )

    expect(supportFor('openai/o4-mini')).toEqual(['low', 'high'])
  })

  it('answers an empty list for a model that takes no effort', () => {
    const supportFor = createReasoningSupportResolver(
      registryOf({
        // Not a reasoning model at all.
        openai: [{ id: 'gpt-4o-mini' }],
        // Reasoning-capable, but its knob is a token budget rather than an effort — no `efforts`.
        google: [{ id: 'gemini-2.5-flash', reasoning: true }],
        // An effort knob whose levels share nothing with ours.
        mistral: [{ id: 'odd-model', reasoning: true, efforts: ['none', 'minimal'] }],
      }),
    )

    expect(supportFor('openai/gpt-4o-mini')).toEqual([])
    expect(supportFor('google/gemini-2.5-flash')).toEqual([])
    expect(supportFor('mistral/odd-model')).toEqual([])
  })

  it('answers nothing for a model the registry does not know', () => {
    const supportFor = createReasoningSupportResolver(
      registryOf({ openai: [{ id: 'o4-mini', reasoning: true, efforts: ['low', 'high'] }] }),
    )

    // A custom URL, an Azure deployment, a model the snapshot predates: unknown, and the brain
    // reads that as "takes none" — the safe default.
    expect(supportFor('openai/gpt-9-does-not-exist')).toBeUndefined()
    expect(supportFor('unknown-provider/model')).toBeUndefined()
    expect(supportFor('not-a-provider-model')).toBeUndefined()
    expect(supportFor('openai/')).toBeUndefined()
    expect(supportFor('/o4-mini')).toBeUndefined()
  })

  it('splits on the first slash, so a model id may carry one of its own', () => {
    const supportFor = createReasoningSupportResolver(
      registryOf({
        together: [
          { id: 'deepseek-ai/DeepSeek-V4-Pro', reasoning: true, efforts: ['low', 'high'] },
        ],
      }),
    )

    expect(supportFor('together/deepseek-ai/DeepSeek-V4-Pro')).toEqual(['low', 'high'])
  })

  it('reads the bundled registry, so a real reasoning model gets its real levels', () => {
    // The acceptance case: the snapshot the catalogue joins for its model pickers is what the
    // answer comes from — `o4-mini` takes all three, `gpt-4o-mini` none.
    const supportFor = createReasoningSupportResolver(createBundledRegistry())

    expect(supportFor('openai/o4-mini')).toEqual(['low', 'medium', 'high'])
    expect(supportFor('openai/gpt-4o-mini')).toEqual([])
    expect(supportFor('nobody/nothing')).toBeUndefined()
  })
})
