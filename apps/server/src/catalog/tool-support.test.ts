import { describe, expect, it } from 'vitest'

import { createBundledRegistry, type ModelRegistry } from './registry'
import { createToolSupportResolver } from './tool-support'

/**
 * The per-model tool gate (epic #303, X2): whether a model may be offered tools at all, looked
 * up per request from the registry the catalogue already joins for windows, prices and reasoning
 * data.
 *
 * The registry keeps models.dev's `tool_call` only where it is `false` (`catalog/registry.ts`),
 * so the three answers this resolver gives are: `false` for a model the registry knows cannot
 * call tools, and `undefined` — "not known to be unable" — for one that can and for one nobody
 * knows. The brain reads both of the last two as "offer them".
 */

/** A registry over a fixed table, so a test pins the lookup without the snapshot's data. */
function registryOf(
  models: Readonly<Record<string, readonly { id: string; toolCall?: boolean }[]>>,
): ModelRegistry {
  return { models: (provider) => models[provider] ?? [] }
}

describe('createToolSupportResolver', () => {
  it('says no only for the model the registry marks as unable to call tools', () => {
    const supportFor = createToolSupportResolver(
      registryOf({
        openai: [{ id: 'gpt-3.5-turbo', toolCall: false }, { id: 'gpt-4o' }],
      }),
    )

    expect(supportFor('openai/gpt-3.5-turbo', 'api_key')).toBe(false)
    // A chat model the registry knows and does not mark: callable, and `undefined` rather than
    // `true` because nothing here knows it is *unable*.
    expect(supportFor('openai/gpt-4o', 'api_key')).toBeUndefined()
  })

  it('answers nothing for an id it cannot read, or one no provider carries', () => {
    const supportFor = createToolSupportResolver(
      registryOf({ openai: [{ id: 'gpt-4o' }], azure: [{ id: 'gpt-4o' }] }),
    )

    expect(supportFor('no-slash', 'api_key')).toBeUndefined()
    expect(supportFor('openai/', 'api_key')).toBeUndefined()
    expect(supportFor('/gpt-4o', 'api_key')).toBeUndefined()
    expect(supportFor('nobody/nothing', 'api_key')).toBeUndefined()
    // A named credential's deployment: the snapshot files Azure OpenAI under the type's
    // models.dev key, and the credential type is what reaches it from a name the reader typed.
    expect(supportFor('azure-eu/gpt-4o', 'azure_openai')).toBeUndefined()
    // An `api_key` credential under a name no provider carries reads no snapshot entry at all.
    expect(supportFor('azure-eu/gpt-4o', 'api_key')).toBeUndefined()
  })

  it('reads a Bedrock inference profile through the model it wraps', () => {
    // A profile's own id is geography-scoped, so the snapshot may file only the model under it
    // (#274) — and the verdict is that model's, which is why the lookup falls back at all.
    const supportFor = createToolSupportResolver(
      registryOf({
        'amazon-bedrock': [
          { id: 'anthropic.claude-sonnet-4-5-20250929-v1:0', toolCall: false },
          { id: 'amazon.nova-lite-v1:0' },
        ],
      }),
    )

    expect(supportFor('bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'bedrock')).toBe(
      false,
    )
    expect(supportFor('bedrock/amazon.nova-lite-v1:0', 'bedrock')).toBeUndefined()
  })

  it('answers from the bundled snapshot for the models it carries', () => {
    const supportFor = createToolSupportResolver(createBundledRegistry())

    // A chat model models.dev marks tool-less, listed by `GET /v1/models` all the same — it is
    // a chat model, and the flag is what says a chat on it is offered no tools.
    expect(supportFor('openai/gpt-3.5-turbo', 'api_key')).toBe(false)
    // The models a chat normally runs.
    expect(supportFor('anthropic/claude-sonnet-5', 'api_key')).toBeUndefined()
    expect(supportFor('openai/gpt-4.1-mini', 'api_key')).toBeUndefined()
    // A model the snapshot does not carry — a custom endpoint's, a deployment nobody filed —
    // is offered tools: guessing "no" is the mistake the catalogue refuses to make too.
    expect(supportFor('custom/llama3.3', 'openai_compatible')).toBeUndefined()
    expect(supportFor('somebody/unheard-of', 'api_key')).toBeUndefined()
  })
})
