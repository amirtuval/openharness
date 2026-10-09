import { PROVIDER_IDS, type ReasoningEffort } from '@openharness/protocol'
import { makeUserInterrupt, makeUserMessage } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { planReasoning, PROVIDER_REASONING, requestedReasoningEffort } from './reasoning'

/**
 * The reasoning-effort mapping, one case per provider.
 *
 * Every provider's row is asserted twice: a model of the family the provider takes an effort
 * for, and a model of one it does not. The second half is the one that matters — an option a
 * provider's API does not know is a failed request, not an ignored one — so each provider is
 * pinned against a model the catalogue really lists and that must keep its default.
 */

const EFFORT: ReasoningEffort = 'high'

/** What {@link planReasoning} sends and applies for `modelId` at {@link EFFORT}. */
function plan(modelId: string): ReturnType<typeof planReasoning> {
  return planReasoning(modelId, EFFORT)
}

describe('PROVIDER_REASONING', () => {
  it('has a row for every provider the server can store a key for', () => {
    expect(Object.keys(PROVIDER_REASONING).sort()).toEqual([...PROVIDER_IDS].sort())
  })

  describe('anthropic', () => {
    it('asks for an effort with `effort`, for the adaptive-thinking models', () => {
      const result = plan('anthropic/claude-opus-4-6')
      expect(result.providerOptions).toEqual({ anthropic: { effort: 'high' } })
      expect(result.applied).toBe('high')
      expect(result.record).toEqual({ requested: 'high', applied: 'high' })
    })

    it('leaves a model with no effort knob on the provider default', () => {
      expect(plan('anthropic/claude-sonnet-4-5').providerOptions).toBeUndefined()
      expect(plan('anthropic/claude-sonnet-4-5').applied).toBeNull()
    })
  })

  describe('openai', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('openai/o4-mini').providerOptions).toEqual({
        openai: { reasoningEffort: 'high' },
      })
    })

    it('leaves a non-reasoning model on the provider default', () => {
      const result = plan('openai/gpt-4o-mini')
      expect(result.providerOptions).toBeUndefined()
      expect(result.record).toEqual({ requested: 'high', applied: null })
    })
  })

  describe('google', () => {
    it('asks for an effort with a Gemini 3 thinking level', () => {
      expect(plan('google/gemini-3.5-flash').providerOptions).toEqual({
        google: { thinkingConfig: { thinkingLevel: 'high' } },
      })
    })

    it('leaves a Gemini 2.5 model alone: its knob is a token budget, not a level', () => {
      expect(plan('google/gemini-2.5-flash').providerOptions).toBeUndefined()
    })
  })

  describe('openrouter', () => {
    it('sends the effort for any model: the router maps or drops it', () => {
      expect(plan('openrouter/anthropic/claude-opus-4.6').providerOptions).toEqual({
        openrouter: { reasoningEffort: 'high' },
      })
      expect(plan('openrouter/sao10k/l3-lunaris-8b').applied).toBe('high')
    })
  })

  describe('groq', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('groq/openai/gpt-oss-120b').providerOptions).toEqual({
        groq: { reasoningEffort: 'high' },
      })
    })

    it('leaves a model Groq rejects the parameter for on the provider default', () => {
      expect(plan('groq/llama-3.3-70b-versatile').providerOptions).toBeUndefined()
    })
  })

  describe('deepseek', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('deepseek/deepseek-v4-pro').providerOptions).toEqual({
        deepseek: { reasoningEffort: 'high' },
      })
    })

    it('runs `medium` at `high`: DeepSeek has no medium', () => {
      const result = planReasoning('deepseek/deepseek-v4-pro', 'medium')
      expect(result.providerOptions).toEqual({ deepseek: { reasoningEffort: 'high' } })
      expect(result.record).toEqual({ requested: 'medium', applied: 'high' })
    })

    it('leaves a non-reasoning model on the provider default', () => {
      expect(plan('deepseek/deepseek-chat').providerOptions).toBeUndefined()
    })
  })

  describe('mistral', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('mistral/magistral-medium-latest').providerOptions).toEqual({
        mistral: { reasoningEffort: 'high' },
      })
    })

    it('runs every level at `high`: Mistral has only `none` and `high`', () => {
      const result = planReasoning('mistral/magistral-medium-latest', 'low')
      expect(result.record).toEqual({ requested: 'low', applied: 'high' })
    })

    it('leaves a model Mistral has no effort for on the provider default', () => {
      expect(plan('mistral/mistral-large-latest').providerOptions).toBeUndefined()
    })
  })

  describe('fireworks', () => {
    it('asks for an effort with `reasoningEffort`, for a slug-shaped id', () => {
      expect(plan('fireworks/accounts/fireworks/models/gpt-oss-120b').providerOptions).toEqual({
        fireworks: { reasoningEffort: 'high' },
      })
    })

    it('leaves a model with no effort knob on the provider default', () => {
      expect(
        plan('fireworks/accounts/fireworks/models/llama-v3p3-70b-instruct').providerOptions,
      ).toBeUndefined()
    })
  })

  describe('together', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('together/deepseek-ai/DeepSeek-V4-Pro-0813').providerOptions).toEqual({
        togetherai: { reasoningEffort: 'high' },
      })
    })

    it('leaves a model with no effort knob on the provider default', () => {
      expect(
        plan('together/meta-llama/Llama-3.3-70B-Instruct-Turbo').providerOptions,
      ).toBeUndefined()
    })
  })

  describe('xai', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('xai/grok-4.7').providerOptions).toEqual({
        xai: { reasoningEffort: 'high' },
      })
    })

    it('leaves a model xAI has no effort for on the provider default', () => {
      expect(plan('xai/grok-4.20-0309-reasoning').providerOptions).toBeUndefined()
    })
  })

  describe('cerebras', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('cerebras/gpt-oss-120b').providerOptions).toEqual({
        cerebras: { reasoningEffort: 'high' },
      })
    })

    it('leaves a model with no effort knob on the provider default', () => {
      expect(plan('cerebras/llama3.1-8b').providerOptions).toBeUndefined()
    })
  })
})

describe('planReasoning', () => {
  it('asks for nothing when the log asked for nothing', () => {
    const result = planReasoning('openai/o4-mini', null)
    expect(result).toEqual({
      requested: null,
      applied: null,
      providerOptions: undefined,
      record: undefined,
    })
  })

  it('sends nothing for a provider this build has no client for', () => {
    const result = planReasoning('someone-else/gpt-5', 'low')
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'low', applied: null })
  })

  it('is unbothered by a model id that names an inherited property', () => {
    expect(planReasoning('toString/x', 'low').record).toEqual({ requested: 'low', applied: null })
  })
})

describe('requestedReasoningEffort', () => {
  const high = makeUserMessage('go', { reasoning_effort: 'high' })
  const low = makeUserMessage('go', { reasoning_effort: 'low' })
  const cleared = makeUserMessage('go', { reasoning_effort: null })
  const silent = makeUserMessage('go')

  it('answers null for a log that never named an effort', () => {
    expect(requestedReasoningEffort([])).toBeNull()
    expect(requestedReasoningEffort([silent, silent])).toBeNull()
  })

  it('answers the newest effort the log carries', () => {
    expect(requestedReasoningEffort([high, silent])).toBe('high')
    expect(requestedReasoningEffort([high, low])).toBe('low')
  })

  it('reads an explicit null as "back to the provider default"', () => {
    expect(requestedReasoningEffort([high, cleared])).toBeNull()
  })

  it('ignores events that are not messages', () => {
    expect(requestedReasoningEffort([high, makeUserInterrupt()])).toBe('high')
  })
})
