import { CREDENTIAL_TYPES, PROVIDER_IDS, type ReasoningEffort } from '@openharness/protocol'
import { makeUserInterrupt, makeUserMessage } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  CREDENTIAL_TYPE_REASONING,
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
  return planReasoning(modelId, 'api_key', EFFORT, levels)
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
      const result = planReasoning('deepseek/deepseek-v4-pro', 'api_key', 'medium', EVERY_LEVEL)
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
      const result = planReasoning('mistral/magistral-medium-latest', 'api_key', 'low', EVERY_LEVEL)
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
    const result = planReasoning('openai/o4-mini', 'api_key', null, EVERY_LEVEL)
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
    const result = planReasoning('openai/o4-mini', 'api_key', 'low', () => undefined)
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'low', applied: null })
  })

  it('sends nothing for a model the resolver knows takes no effort', () => {
    const result = planReasoning('openai/gpt-4o-mini', 'api_key', 'high', taking([]))
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'high', applied: null })
  })

  it('sends nothing for a provider this build has no client for', () => {
    // The resolver may still describe the model, but there is nothing to send an effort to: the
    // request ends as an unsupported provider before it is made.
    const result = planReasoning('someone-else/gpt-5', 'api_key', 'low', EVERY_LEVEL)
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'low', applied: null })
  })

  it('is unbothered by a model id that names an inherited property', () => {
    expect(planReasoning('toString/x', 'api_key', 'low', EVERY_LEVEL).record).toEqual({
      requested: 'low',
      applied: null,
    })
  })

  it('clamps a level the model does not take to the nearest one it does', () => {
    // A model that takes `low` and `high` has no `medium`: the request runs at `high`, the level
    // its own client would pick, and the level it is actually sent.
    const result = planReasoning('openai/o4-mini', 'api_key', 'medium', taking(['low', 'high']))
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } })
    expect(result.record).toEqual({ requested: 'medium', applied: 'high' })
  })

  it('clamps down as well as up', () => {
    const result = planReasoning('openai/o4-mini', 'api_key', 'high', taking(['low']))
    expect(result.record).toEqual({ requested: 'high', applied: 'low' })
  })

  it('keeps a level the model does take exactly as it is', () => {
    const result = planReasoning(
      'openai/o4-mini',
      'api_key',
      'medium',
      taking(['low', 'medium', 'high']),
    )
    expect(result.record).toEqual({ requested: 'medium', applied: 'medium' })
  })
})

describe('CREDENTIAL_TYPE_REASONING', () => {
  it('has a row for every named credential type', () => {
    expect(Object.keys(CREDENTIAL_TYPE_REASONING).sort()).toEqual(
      CREDENTIAL_TYPES.map((entry) => entry.type).sort(),
    )
  })

  it('asks Azure OpenAI for an effort the way its client reads it: `openai`', () => {
    // `@ai-sdk/azure`'s chat model is an `OpenAIChatLanguageModel` (`azure.chat`) under an Azure
    // URL, and it reads `providerOptions.openai` — never `providerOptions.azure`, which it does
    // not look at. So an Azure deployment gets the OpenAI option.
    expect(CREDENTIAL_TYPE_REASONING.azure_openai.options('high')).toEqual({
      openai: { reasoningEffort: 'high' },
    })
  })

  it('plans a named credential by its type, not by the name in the model id', () => {
    // `azure-eu` is a name, not a provider id: the provider table has no row for it. The
    // credential's type is what says which options key its deployment is asked with.
    const result = planReasoning('azure-eu/gpt-5.4', 'azure_openai', 'medium', EVERY_LEVEL)
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'medium' } })
    expect(result.record).toEqual({ requested: 'medium', applied: 'medium' })
  })

  it('sends nothing for an `api_key` under a name no provider carries', () => {
    // Neither table has a row: the provider id is unknown and the type is the fixed providers'.
    const result = planReasoning('my-gateway/gpt-5', 'api_key', 'high', EVERY_LEVEL)
    expect(result.providerOptions).toBeUndefined()
    expect(result.record).toEqual({ requested: 'high', applied: null })
  })

  it('asks Amazon Bedrock through its own `reasoningConfig`', () => {
    // `@ai-sdk/amazon-bedrock` reads `providerOptions.bedrock` and maps `maxReasoningEffort`
    // onto the model's own vendor field (Anthropic's `output_config.effort`, an OpenAI model's
    // `reasoning_effort`); its levels are `low | medium | high | xhigh | max`.
    expect(CREDENTIAL_TYPE_REASONING.bedrock.options('high')).toEqual({
      bedrock: { reasoningConfig: { maxReasoningEffort: 'high' } },
    })
  })

  it('plans a bedrock credential by its type, like every other named one', () => {
    const result = planReasoning(
      'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
      'bedrock',
      'high',
      EVERY_LEVEL,
    )
    expect(result.providerOptions).toEqual({
      bedrock: { reasoningConfig: { maxReasoningEffort: 'high' } },
    })
    expect(result.record).toEqual({ requested: 'high', applied: 'high' })
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
