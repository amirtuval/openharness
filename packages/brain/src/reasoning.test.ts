import { PROVIDER_IDS, type ReasoningEffort } from '@openharness/protocol'
import { makeUserInterrupt, makeUserMessage } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  planReasoning,
  PROVIDER_REASONING,
  type ReasoningSupportFor,
  requestedReasoningEffort,
} from './reasoning'

/**
 * The reasoning-effort mapping, one case per provider.
 *
 * Which models take an effort is the injected resolver's answer now (#252's follow-up), so these
 * tests hand every model one that takes all three levels and assert only what the table still
 * owns: the spelling of the option each provider's AI SDK client reads and the clamp a knob with
 * fewer levels needs. Which models *get* an effort at all is the resolver's question — the
 * `planReasoning` cases below and, end to end, the server's `reasoning-support.test.ts`.
 */

/** The levels every model takes in the per-provider cases. */
const EVERY_LEVEL: ReasoningSupportFor = () => ['low', 'medium', 'high']

/** The level the per-provider cases ask for. */
const EFFORT: ReasoningEffort = 'high'

/** What {@link planReasoning} sends and applies for `modelId`, for a model that takes `levels`. */
function plan(
  modelId: string,
  levels: ReasoningSupportFor = EVERY_LEVEL,
): ReturnType<typeof planReasoning> {
  return planReasoning(modelId, EFFORT, levels)
}

/** A resolver that says every model takes exactly `levels` — the gate, stated per case. */
function taking(levels: readonly ReasoningEffort[]): ReasoningSupportFor {
  return () => levels
}

describe('PROVIDER_REASONING', () => {
  it('has a row for every provider the server can store a key for', () => {
    expect(Object.keys(PROVIDER_REASONING).sort()).toEqual([...PROVIDER_IDS].sort())
  })

  describe('anthropic', () => {
    it('asks for an effort with `effort`, for a model the resolver grants one', () => {
      const result = plan('anthropic/claude-opus-4-6')
      expect(result.providerOptions).toEqual({ anthropic: { effort: 'high' } })
      expect(result.applied).toBe('high')
      expect(result.record).toEqual({ requested: 'high', applied: 'high' })
    })
  })

  describe('openai', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('openai/o4-mini').providerOptions).toEqual({
        openai: { reasoningEffort: 'high' },
      })
    })
  })

  describe('google', () => {
    it('asks for an effort with a Gemini thinking level', () => {
      expect(plan('google/gemini-3.5-flash').providerOptions).toEqual({
        google: { thinkingConfig: { thinkingLevel: 'high' } },
      })
    })
  })

  describe('openrouter', () => {
    it('asks for an effort with `reasoningEffort` when the resolver grants the model one', () => {
      expect(plan('openrouter/anthropic/claude-opus-4.6').providerOptions).toEqual({
        openrouter: { reasoningEffort: 'high' },
      })
    })
  })

  describe('groq', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('groq/openai/gpt-oss-120b').providerOptions).toEqual({
        groq: { reasoningEffort: 'high' },
      })
    })
  })

  describe('deepseek', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('deepseek/deepseek-v4-pro').providerOptions).toEqual({
        deepseek: { reasoningEffort: 'high' },
      })
    })

    it('runs `medium` at `high`: DeepSeek has no medium', () => {
      const result = planReasoning('deepseek/deepseek-v4-pro', 'medium', EVERY_LEVEL)
      expect(result.providerOptions).toEqual({ deepseek: { reasoningEffort: 'high' } })
      expect(result.record).toEqual({ requested: 'medium', applied: 'high' })
    })
  })

  describe('mistral', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('mistral/magistral-medium-latest').providerOptions).toEqual({
        mistral: { reasoningEffort: 'high' },
      })
    })

    it('runs every level at `high`: Mistral has only `none` and `high`', () => {
      const result = planReasoning('mistral/magistral-medium-latest', 'low', EVERY_LEVEL)
      expect(result.record).toEqual({ requested: 'low', applied: 'high' })
    })
  })

  describe('fireworks', () => {
    it('asks for an effort with `reasoningEffort`, for a slug-shaped id', () => {
      expect(plan('fireworks/accounts/fireworks/models/gpt-oss-120b').providerOptions).toEqual({
        fireworks: { reasoningEffort: 'high' },
      })
    })
  })

  describe('together', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('together/deepseek-ai/DeepSeek-V4-Pro-0813').providerOptions).toEqual({
        togetherai: { reasoningEffort: 'high' },
      })
    })
  })

  describe('xai', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('xai/grok-4.7').providerOptions).toEqual({
        xai: { reasoningEffort: 'high' },
      })
    })
  })

  describe('cerebras', () => {
    it('asks for an effort with `reasoningEffort`', () => {
      expect(plan('cerebras/gpt-oss-120b').providerOptions).toEqual({
        cerebras: { reasoningEffort: 'high' },
      })
    })
  })
})

describe('planReasoning', () => {
  it('asks for nothing when the log asked for nothing', () => {
    const result = planReasoning('openai/o4-mini', null, EVERY_LEVEL)
    expect(result).toEqual({
      requested: null,
      applied: null,
      providerOptions: undefined,
      record: undefined,
    })
  })

  it('sends nothing for a model the resolver does not know', () => {
    // A custom URL, an Azure deployment, a model the snapshot predates: `undefined` is "unknown",
    // and the safe reading of unknown is the provider's default.
    const result = planReasoning('openai/o4-mini', 'low', () => undefined)
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'low', applied: null })
  })

  it('sends nothing for a model the resolver knows takes no effort', () => {
    const result = planReasoning('openai/gpt-4o-mini', 'high', taking([]))
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'high', applied: null })
  })

  it('sends nothing for a provider this build has no client for', () => {
    // The resolver may still describe the model, but there is nothing to send an effort to: the
    // request ends as an unsupported provider before it is made.
    const result = planReasoning('someone-else/gpt-5', 'low', EVERY_LEVEL)
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'low', applied: null })
  })

  it('is unbothered by a model id that names an inherited property', () => {
    expect(planReasoning('toString/x', 'low', EVERY_LEVEL).record).toEqual({
      requested: 'low',
      applied: null,
    })
  })

  it('clamps a level the model does not take to the nearest one it does', () => {
    // A model that takes `low` and `high` has no `medium`: the request runs at `high`, the level
    // its own client would pick, and the level it is actually sent.
    const result = planReasoning('openai/o4-mini', 'medium', taking(['low', 'high']))
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } })
    expect(result.record).toEqual({ requested: 'medium', applied: 'high' })
  })

  it('clamps down as well as up', () => {
    const result = planReasoning('openai/o4-mini', 'high', taking(['low']))
    expect(result.record).toEqual({ requested: 'high', applied: 'low' })
  })

  it('keeps a level the model does take exactly as it is', () => {
    const result = planReasoning('openai/o4-mini', 'medium', taking(['low', 'medium', 'high']))
    expect(result.record).toEqual({ requested: 'medium', applied: 'medium' })
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
