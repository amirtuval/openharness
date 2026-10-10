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

    expect(supportFor('anthropic/claude-sonnet-5', 'api_key')).toEqual(['low', 'medium', 'high'])
  })

  it('answers only the levels the model and we share, so the brain can clamp to them', () => {
    // The model takes `low` and `high` and no `medium`; the answer names exactly those, and the
    // brain clamps a requested `medium` to `high` before anything is sent.
    const supportFor = createReasoningSupportResolver(
      registryOf({ openai: [{ id: 'o4-mini', reasoning: true, efforts: ['low', 'high'] }] }),
    )

    expect(supportFor('openai/o4-mini', 'api_key')).toEqual(['low', 'high'])
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

    expect(supportFor('openai/gpt-4o-mini', 'api_key')).toEqual([])
    expect(supportFor('google/gemini-2.5-flash', 'api_key')).toEqual([])
    expect(supportFor('mistral/odd-model', 'api_key')).toEqual([])
  })

  it('answers nothing for a model the registry does not know', () => {
    const supportFor = createReasoningSupportResolver(
      registryOf({ openai: [{ id: 'o4-mini', reasoning: true, efforts: ['low', 'high'] }] }),
    )

    // A custom URL, an Azure deployment, a model the snapshot predates: unknown, and the brain
    // reads that as "takes none" — the safe default.
    expect(supportFor('openai/gpt-9-does-not-exist', 'api_key')).toBeUndefined()
    expect(supportFor('unknown-provider/model', 'api_key')).toBeUndefined()
    expect(supportFor('not-a-provider-model', 'api_key')).toBeUndefined()
    expect(supportFor('openai/', 'api_key')).toBeUndefined()
    expect(supportFor('/o4-mini', 'api_key')).toBeUndefined()
  })

  it('splits on the first slash, so a model id may carry one of its own', () => {
    const supportFor = createReasoningSupportResolver(
      registryOf({
        together: [
          { id: 'deepseek-ai/DeepSeek-V4-Pro', reasoning: true, efforts: ['low', 'high'] },
        ],
      }),
    )

    expect(supportFor('together/deepseek-ai/DeepSeek-V4-Pro', 'api_key')).toEqual(['low', 'high'])
  })

  it("reads a named credential's deployment under its type's models.dev key", () => {
    // `azure-eu` is a name no snapshot carries; the credential's *type* is what maps it to the
    // registry's `azure` entries (`credentialTypeInfo('azure_openai').modelsDevKey`), the same
    // mapping the catalogue borrows a deployment's window and price with (epic #245 A3a).
    const supportFor = createReasoningSupportResolver(
      registryOf({
        azure: [
          { id: 'gpt-5.4', reasoning: true, efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
        ],
      }),
    )

    expect(supportFor('azure-eu/gpt-5.4', 'azure_openai')).toEqual(['low', 'medium', 'high'])
  })

  it('answers nothing for a deployment models.dev does not know', () => {
    const supportFor = createReasoningSupportResolver(
      registryOf({ azure: [{ id: 'gpt-5.4', reasoning: true, efforts: ['low', 'high'] }] }),
    )

    // The deployment name has to match a models.dev model exactly: a name nobody measured is
    // unknown, and the safe reading of unknown is the provider's default.
    expect(supportFor('azure-eu/gpt-4o-mini', 'azure_openai')).toBeUndefined()
  })

  it('answers nothing for an `api_key` under a name no provider carries', () => {
    const supportFor = createReasoningSupportResolver(
      registryOf({ azure: [{ id: 'gpt-5.4', reasoning: true, efforts: ['low', 'high'] }] }),
    )

    // An `api_key` credential has no models.dev key of its own — only the eleven fixed ids are
    // readable — so a name that is not one of them resolves to nothing.
    expect(supportFor('azure-eu/gpt-5.4', 'api_key')).toBeUndefined()
  })

  it("reads a Bedrock credential's model under models.dev's `amazon-bedrock`", () => {
    // models.dev files Bedrock under the product's full name; the credential type carries that
    // key (`credentialTypeInfo('bedrock').modelsDevKey`), so a Bedrock model id — which is the
    // vendor's own, dots and all — is looked up without the resolver knowing the credential's
    // name or region.
    const supportFor = createReasoningSupportResolver(
      registryOf({
        'amazon-bedrock': [
          {
            id: 'anthropic.claude-sonnet-5-v1:0',
            reasoning: true,
            efforts: ['low', 'medium', 'high'],
          },
        ],
      }),
    )

    expect(supportFor('bedrock/anthropic.claude-sonnet-5-v1:0', 'bedrock')).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(supportFor('bedrock-us/anthropic.claude-sonnet-5-v1:0', 'bedrock')).toEqual([
      'low',
      'medium',
      'high',
    ])
  })

  it('reads the bundled registry, so a real reasoning model gets its real levels', () => {
    // The acceptance case: the snapshot the catalogue joins for its model pickers is what the
    // answer comes from — `o4-mini` takes all three, `gpt-4o-mini` none.
    const supportFor = createReasoningSupportResolver(createBundledRegistry())

    expect(supportFor('openai/o4-mini', 'api_key')).toEqual(['low', 'medium', 'high'])
    expect(supportFor('openai/gpt-4o-mini', 'api_key')).toEqual([])
    expect(supportFor('nobody/nothing', 'api_key')).toBeUndefined()
    // A named credential's deployment too: the snapshot files Azure OpenAI under `azure`, and
    // the credential type is what reaches that entry from a deployment the reader typed.
    expect(supportFor('azure/gpt-5.4', 'azure_openai')).toEqual(['low', 'medium', 'high'])
    expect(supportFor('azure/gpt-4o', 'azure_openai')).toEqual([])
    // And a Bedrock model id — the vendor's own spelling — from the same snapshot.
    expect(supportFor('bedrock/eu.anthropic.claude-fable-5', 'bedrock')).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(supportFor('bedrock/google.gemma-3-12b-it', 'bedrock')).toEqual([])
    // And a Vertex credential's models, both families: models.dev files Google's and
    // Anthropic's under `google-vertex`, so `claude-*` and `gemini-*` are one lookup (#245,
    // A3d). A Gemini whose knob is a token budget carries no efforts and takes none of ours.
    expect(supportFor('vertex/claude-opus-4-8@default', 'vertex')).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(supportFor('vertex/gemini-2.5-pro', 'vertex')).toEqual([])
  })
})
