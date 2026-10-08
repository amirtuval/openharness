import { describe, expect, it } from 'vitest'

import { DEFAULT_CONTEXT_TOKEN_BUDGET } from '@openharness/brain'

import {
  OUTPUT_RESERVE_RATIO,
  contextTokenBudget,
  createTokenBudgetResolver,
} from './context-budget'
import { createBundledRegistry, type ModelRegistry } from './registry'

/**
 * The per-model context budget (epic #245's A1; issue #246): `contextWindow − min(maxOutput,
 * 25%)`, looked up per request from the registry the catalogue already joins.
 */

/** A registry over a fixed table, so a test pins the lookup without the snapshot's data. */
function registryOf(
  models: Readonly<
    Record<string, readonly { id: string; contextWindow?: number; maxOutput?: number }[]>
  >,
): ModelRegistry {
  return { models: (provider) => models[provider] ?? [] }
}

describe('contextTokenBudget', () => {
  it('reserves the model’s own output ceiling when it is under a quarter of the window', () => {
    // 30k of a 200k window is less than 25% (50k), so 30k is what the reply may take.
    expect(contextTokenBudget({ contextWindow: 200_000, maxOutput: 30_000 })).toBe(170_000)
  })

  it('reserves a quarter of the window when the model declares no output ceiling', () => {
    expect(contextTokenBudget({ contextWindow: 128_000 })).toBe(96_000)
    expect(OUTPUT_RESERVE_RATIO).toBe(0.25)
  })

  it('never reserves more than a quarter, however large the declared ceiling is', () => {
    // 64k of a 200k window is over a quarter, so the reserve is capped at 25% — a model's own
    // ceiling never takes more room than the default share.
    expect(contextTokenBudget({ contextWindow: 200_000, maxOutput: 64_000 })).toBe(150_000)
    // And a ceiling bigger than the window itself cannot trim past three quarters of it.
    expect(contextTokenBudget({ contextWindow: 8_192, maxOutput: 16_384 })).toBe(6_144)
  })
})

describe('createTokenBudgetResolver', () => {
  it('answers the budget of the model the id names', () => {
    const tokenBudgetFor = createTokenBudgetResolver(
      registryOf({
        openai: [{ id: 'gpt-5-mini', contextWindow: 400_000, maxOutput: 128_000 }],
        anthropic: [{ id: 'claude-haiku-4-5', contextWindow: 200_000 }],
      }),
    )

    expect(tokenBudgetFor('openai/gpt-5-mini')).toBe(300_000)
    expect(tokenBudgetFor('anthropic/claude-haiku-4-5')).toBe(150_000)
  })

  it('splits on the first slash, so a model id may carry one of its own', () => {
    const tokenBudgetFor = createTokenBudgetResolver(
      registryOf({
        together: [{ id: 'meta-llama/Llama-3-70b', contextWindow: 8_192, maxOutput: 2_048 }],
      }),
    )

    expect(tokenBudgetFor('together/meta-llama/Llama-3-70b')).toBe(6_144)
  })

  it('answers nothing for a model the registry does not know', () => {
    const tokenBudgetFor = createTokenBudgetResolver(
      registryOf({ openai: [{ id: 'gpt-5-mini', contextWindow: 400_000 }] }),
    )

    // The caller's own default — the brain's 32,768-token fallback — is what an unknown id
    // gets, so the resolver says "no answer" rather than repeating that number here.
    expect(tokenBudgetFor('openai/gpt-9-does-not-exist')).toBeUndefined()
    expect(tokenBudgetFor('unknown-provider/model')).toBeUndefined()
    expect(tokenBudgetFor('not-a-provider-model')).toBeUndefined()
    expect(tokenBudgetFor('openai/')).toBeUndefined()
    expect(tokenBudgetFor('/gpt-5-mini')).toBeUndefined()
  })

  it('answers nothing for a model the registry knows but has no window for', () => {
    const tokenBudgetFor = createTokenBudgetResolver(registryOf({ openai: [{ id: 'gpt-5-mini' }] }))

    expect(tokenBudgetFor('openai/gpt-5-mini')).toBeUndefined()
  })

  it('reads the bundled registry, so a real model gets a real window', () => {
    // The acceptance case: the snapshot the catalogue joins for its model pickers is what the
    // budget comes from — 400k window, 128k ceiling, so 300k of history.
    const tokenBudgetFor = createTokenBudgetResolver(createBundledRegistry())

    expect(tokenBudgetFor('openai/gpt-5-mini')).toBe(300_000)
    // And a model the snapshot does not carry still falls back to the brain's default.
    expect(tokenBudgetFor('nobody/nothing')).toBeUndefined()
    expect(DEFAULT_CONTEXT_TOKEN_BUDGET).toBe(32_768)
  })
})
