import type { ProviderCredentialType } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import type { ModelOpaquePart } from './model'
import {
  captureOpaque,
  OPAQUE_MAX_CHARS,
  OPAQUE_REPLAY,
  opaqueFamilyOf,
  opaqueReplayParts,
  opaqueTargetOf,
} from './opaque'
import type { OpaqueTarget } from './opaque'

/**
 * Provider-opaque content: which family a request belongs to, what a step's parts are stored as,
 * and which of them may go back out (epic #303, X13; issue #334).
 *
 * The three questions are answered in one place, so they are tested in one place: the family
 * table (what each client reads its part options under), the capture (a stream part as the log
 * stores it, with the size cap), and the replay (same family, same model, whole entry or
 * nothing).
 */

/** A captured reasoning part, as the stream left it. */
function reasoning(text: string, providerMetadata?: Record<string, unknown>): ModelOpaquePart {
  return {
    type: 'reasoning',
    text,
    ...(providerMetadata === undefined ? {} : { providerMetadata }),
  }
}

/** An Anthropic-style step: a signed thinking block. */
const signed = (signature = 'sig-1'): ModelOpaquePart =>
  reasoning('weighing the options', { anthropic: { signature } })

describe('opaqueFamilyOf', () => {
  const cases: readonly (readonly [string, ProviderCredentialType, string | null])[] = [
    // A fixed provider id and its `api_key` credential: the client the id names.
    ['anthropic/claude-sonnet-5', 'api_key', 'anthropic'],
    ['openai/gpt-5', 'api_key', 'openai'],
    ['xai/grok-4', 'api_key', 'xai'],
    // The chat families that replay a step's reasoning as plain `reasoning_content`.
    ['deepseek/deepseek-reasoner', 'api_key', 'openai-compatible'],
    ['groq/llama-3.3-70b', 'api_key', 'openai-compatible'],
    ['mistral/mistral-large', 'api_key', 'openai-compatible'],
    // A client that reads no reasoning part back, or one this build has no rule for yet.
    ['google/gemini-3-pro', 'api_key', null],
    ['azure/gpt-4o', 'azure_openai', null],
    ['custom/llama3.3', 'openai_compatible', 'openai-compatible'],
    ['bedrock/anthropic.claude-sonnet-5-v1:0', 'bedrock', 'bedrock'],
    ['vertex/claude-sonnet-4-5@20250929', 'vertex', 'anthropic'],
    ['vertex/gemini-2.5-pro', 'vertex', null],
  ]

  it.each(cases)('reads %s (%s) as %s', (modelId, credentialType, family) => {
    expect(opaqueFamilyOf(modelId, credentialType)).toBe(family)
  })

  it('has a replay rule for every family, and a key for every family it is not plain text in', () => {
    for (const family of ['anthropic', 'bedrock', 'openai', 'xai'] as const) {
      expect(OPAQUE_REPLAY[family].providerOptionsKey).toBe(family)
    }
    expect(OPAQUE_REPLAY['openai-compatible'].providerOptionsKey).toBeNull()
    // Nothing may be replayed across models, and nothing may be replayed truncated: the two
    // rules that make every entry all-or-nothing.
    for (const rule of Object.values(OPAQUE_REPLAY)) {
      expect(rule.sameModel).toBe(true)
      expect(rule.truncatable).toBe(false)
    }
  })

  it('names no family for a model id that carries no slash at all', () => {
    expect(opaqueFamilyOf('claude-sonnet-5', 'api_key')).toBeNull()
  })
})

describe('opaqueTargetOf', () => {
  it('records the family and the model together', () => {
    expect(opaqueTargetOf('anthropic/claude-sonnet-5', 'api_key')).toEqual({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
    })
  })

  it('answers null for a client that reads no parts back', () => {
    expect(opaqueTargetOf('google/gemini-3-pro', 'api_key')).toBeNull()
  })
})

describe('captureOpaque', () => {
  it('stores a signed reasoning part with its payload', () => {
    const target = opaqueTargetOf('anthropic/claude-sonnet-5', 'api_key')
    expect(target).not.toBeNull()
    expect(captureOpaque(target!, [signed('abc')])).toEqual({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      parts: [
        { type: 'reasoning', text: 'weighing the options', provider_options: { signature: 'abc' } },
      ],
      dropped: 0,
    })
  })

  it('stores a plain-text family’s reasoning without a payload', () => {
    const target = opaqueTargetOf('custom/deepseek-v4', 'openai_compatible')
    expect(captureOpaque(target!, [reasoning('thinking')])).toEqual({
      provider: 'openai-compatible',
      model: 'custom/deepseek-v4',
      parts: [{ type: 'reasoning', text: 'thinking' }],
      dropped: 0,
    })
  })

  it('reads the payload off the family’s own key, and drops metadata that is not JSON', () => {
    const target = opaqueTargetOf('bedrock/anthropic.claude-sonnet-5-v1:0', 'bedrock')
    const [part] = captureOpaque(target!, [
      reasoning('think', {
        // Bedrock sends the same payload under both spellings; the table's key is the one read.
        bedrock: { signature: 'sd', callback: () => undefined, ratio: Number.NaN },
        amazonBedrock: { signature: 'other' },
      }),
    ]).parts
    expect(part?.provider_options).toEqual({ signature: 'sd' })
  })

  it('keeps a step’s parts in the order the provider produced them', () => {
    const target = opaqueTargetOf('anthropic/claude-sonnet-5', 'api_key')
    const parts = captureOpaque(target!, [
      signed('one'),
      reasoning('', { anthropic: { redactedData: 'blob' } }),
      signed('two'),
    ]).parts
    expect(parts.map((part) => part.provider_options)).toEqual([
      { signature: 'one' },
      { redactedData: 'blob' },
      { signature: 'two' },
    ])
  })

  it('drops every part of a step that is over the cap, and counts them', () => {
    const target = opaqueTargetOf('anthropic/claude-sonnet-5', 'api_key')
    const huge = reasoning('x'.repeat(OPAQUE_MAX_CHARS + 1), { anthropic: { signature: 'sig' } })
    // Whole or nothing: dropping the oversized part alone would leave a hole in the step's
    // sequence, which is the shape a provider's own check refuses.
    expect(captureOpaque(target!, [huge, signed('kept')])).toEqual({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      parts: [],
      dropped: 2,
    })
  })

  it('keeps a step whose parts are exactly at the cap', () => {
    const target = opaqueTargetOf('anthropic/claude-sonnet-5', 'api_key')
    const at = reasoning('x'.repeat(OPAQUE_MAX_CHARS), undefined)
    expect(captureOpaque(target!, [at]).dropped).toBe(0)
  })
})

describe('opaqueReplayParts', () => {
  const entry = {
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet-5',
    parts: [
      { type: 'reasoning', text: 'weighing the options', provider_options: { signature: 'abc' } },
    ],
  }

  it('replays the entry to the family and model that produced it, ahead of the text', () => {
    expect(
      opaqueReplayParts(entry, { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' }),
    ).toEqual([
      {
        type: 'reasoning',
        text: 'weighing the options',
        providerOptions: { anthropic: { signature: 'abc' } },
      },
    ])
  })

  it('replays a plain-text family’s reasoning with no options at all', () => {
    const compat = {
      provider: 'openai-compatible',
      model: 'custom/deepseek-v4',
      parts: [{ type: 'reasoning', text: 'thinking' }],
    }
    expect(
      opaqueReplayParts(compat, { provider: 'openai-compatible', model: 'custom/deepseek-v4' }),
    ).toEqual([{ type: 'reasoning', text: 'thinking' }])
  })

  it('never replays another provider’s or another model’s entry', () => {
    expect(opaqueReplayParts(entry, null)).toEqual([])
    expect(
      opaqueReplayParts(entry, { provider: 'bedrock', model: 'anthropic/claude-sonnet-5' }),
    ).toEqual([])
    expect(
      opaqueReplayParts(entry, { provider: 'anthropic', model: 'anthropic/claude-opus-5-5' }),
    ).toEqual([])
  })

  it('never replays a family this build has no rule for', () => {
    // The entry's family is a string out of the log — a row another writer, or a later version
    // of this build, put there — so a family the table does not hold is one this build must not
    // guess at, even where the request's own family would name it.
    const foreign = { provider: 'google', model: 'google/gemini-3-pro' } as unknown as OpaqueTarget
    expect(opaqueReplayParts({ ...entry, provider: 'google' }, foreign)).toEqual([])
  })

  it('refuses the whole entry when a keyed family’s part has no payload', () => {
    expect(
      opaqueReplayParts(
        { ...entry, parts: [{ type: 'reasoning', text: 'unsigned' }] },
        { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' },
      ),
    ).toEqual([])
  })

  it('refuses the whole entry when it carries a part type this build does not replay', () => {
    expect(
      opaqueReplayParts(
        {
          ...entry,
          parts: [entry.parts[0]!, { type: 'tool-result', text: 'from the provider’s own search' }],
        },
        { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' },
      ),
    ).toEqual([])
  })

  it('replays nothing for an entry that kept no parts', () => {
    expect(
      opaqueReplayParts(
        { ...entry, parts: [] },
        { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' },
      ),
    ).toEqual([])
  })
})
