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
import type { OpaqueMessagePart, OpaqueTarget } from './opaque'

/**
 * The parts a replay contributes, without the place in the step each goes — which is
 * `OpaqueReplayedPart.textBefore`, and has its own tests below.
 */
function replayed(
  entry: Parameters<typeof opaqueReplayParts>[0],
  target: OpaqueTarget | null,
): readonly OpaqueMessagePart[] {
  return opaqueReplayParts(entry, target).map((placed) => placed.part)
}

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

  it('stores where each part sat in the step, and omits a part that led it', () => {
    const target = opaqueTargetOf('anthropic/claude-sonnet-5', 'api_key')
    const parts = captureOpaque(target!, [
      { ...signed('one'), textBefore: 0 },
      { ...signed('two'), textBefore: 5 },
    ]).parts
    // A part at offset 0 carries no field: absent reads as `0`, which keeps a step that led with
    // its parts — and every entry written before the offsets existed — stored as it always was.
    expect(parts.map((part) => part.text_before)).toEqual([undefined, 5])
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
    expect(replayed(entry, { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' })).toEqual([
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
      replayed(compat, { provider: 'openai-compatible', model: 'custom/deepseek-v4' }),
    ).toEqual([{ type: 'reasoning', text: 'thinking' }])
  })

  it('never replays another provider’s or another model’s entry', () => {
    expect(replayed(entry, null)).toEqual([])
    expect(replayed(entry, { provider: 'bedrock', model: 'anthropic/claude-sonnet-5' })).toEqual([])
    expect(replayed(entry, { provider: 'anthropic', model: 'anthropic/claude-opus-5-5' })).toEqual(
      [],
    )
  })

  it('never replays a family this build has no rule for', () => {
    // The entry's family is a string out of the log — a row another writer, or a later version
    // of this build, put there — so a family the table does not hold is one this build must not
    // guess at, even where the request's own family would name it.
    const foreign = { provider: 'google', model: 'google/gemini-3-pro' } as unknown as OpaqueTarget
    expect(replayed({ ...entry, provider: 'google' }, foreign)).toEqual([])
  })

  it('refuses the whole entry when a keyed family’s part has no payload', () => {
    expect(
      replayed(
        { ...entry, parts: [{ type: 'reasoning', text: 'unsigned' }] },
        { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' },
      ),
    ).toEqual([])
  })

  it('refuses the whole entry when it carries a part type this build does not replay', () => {
    expect(
      replayed(
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
      replayed(
        { ...entry, parts: [] },
        { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' },
      ),
    ).toEqual([])
  })

  it('gives each part the place in the step the log recorded for it', () => {
    // Text → the provider's call → its answer → the text that reads it: the offsets are the
    // characters of the step's text that came before each part, and the strategy splits the text
    // at them to rebuild the turn in this order (epic #303, X14; #335).
    const searched: Parameters<typeof opaqueReplayParts>[0] = {
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      parts: [
        { type: 'reasoning', text: 'thinking', provider_options: { signature: 's' } },
        { type: 'tool-call', text: '', payload: { toolCallId: 'ws_1', toolName: 'web_search' } },
        {
          type: 'tool-result',
          text: 'found it',
          payload: { toolCallId: 'ws_1', toolName: 'web_search', output: {} },
          text_before: 7,
        },
      ],
    }
    const placed = opaqueReplayParts(searched, {
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
    })
    expect(placed.map(({ textBefore }) => textBefore)).toEqual([0, 0, 7])
    expect(placed.map(({ part }) => part.type)).toEqual(['reasoning', 'tool-call', 'tool-result'])
  })

  it('reads a part with no offset as leading the step', () => {
    // Every entry written before the order was recorded carries none, and reads as `0`: the
    // parts go ahead of the text, exactly as they were replayed then (#334).
    expect(
      opaqueReplayParts(entry, { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' })[0]
        ?.textBefore,
    ).toBe(0)
    expect(
      opaqueReplayParts(
        { ...entry, parts: [{ ...entry.parts[0]!, text_before: 12 }] },
        { provider: 'anthropic', model: 'anthropic/claude-sonnet-5' },
      )[0]?.textBefore,
    ).toBe(12)
  })

  it('gives a converted reading the place the entry went before the offsets existed', () => {
    // A switch replays a search's reading as one text block, which stands for the whole entry: it
    // goes ahead of the step's text, as it did before a part carried a place (#335).
    const switched: Parameters<typeof opaqueReplayParts>[0] = {
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-5',
      parts: [
        {
          type: 'tool-result',
          text: 'Web search results for "x":\n1. …',
          payload: { toolCallId: 'ws_1', toolName: 'web_search', output: {} },
          text_before: 9,
        },
      ],
    }
    const placed = opaqueReplayParts(switched, {
      provider: 'openai-compatible',
      model: 'deepseek/deepseek-chat',
    })
    expect(placed).toHaveLength(1)
    expect(placed[0]?.textBefore).toBe(0)
    expect(placed[0]?.part).toEqual({
      type: 'text',
      text: 'Web search results for "x":\n1. …',
    })
  })
})
