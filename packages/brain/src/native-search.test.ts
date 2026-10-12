import { WEB_SEARCH_TOOL_NAME } from '@openharness/protocol'
import type { ProviderCredentialType } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  MAX_SEARCHES_PER_REQUEST,
  NATIVE_TOOL_DECLARATIONS,
  modelSearches,
  nativeSearchFor,
  searchFamilyOf,
  searchWasRejected,
  webSearchOffered,
} from './native-search'
import type { ToolSettings } from './tools'

/**
 * The provider-native search table and the policy over it (epic #303, X14; issue #335).
 *
 * What a model id means is the whole of it: models.dev records nothing about which models have a
 * native search tool, so this small table is the answer, and a model wrongly inside it is caught
 * by the provider's own refusal (`./turn` drops the tool and asks once more) while one wrongly
 * outside it simply has no search.
 */

/** The tool a request is offered, as the pieces this module decides. */
function offered(modelId: string, credentialType: ProviderCredentialType = 'api_key') {
  const search = nativeSearchFor(modelId, credentialType)
  if (search === null) {
    return null
  }
  // A provider tool carries its own id and no name: the name is the key it is offered under,
  // which is what the model calls it by and what the log records.
  const tools = search.tools as unknown as Record<string, { readonly id: string }>
  return { family: search.family, name: search.name, id: tools[WEB_SEARCH_TOOL_NAME]?.id }
}

describe('the model families that can search (#335)', () => {
  it('offers Anthropic’s newest tool to a Claude, and the basic one on Vertex', () => {
    expect(offered('anthropic/claude-sonnet-4-5')).toEqual({
      family: 'anthropic',
      name: WEB_SEARCH_TOOL_NAME,
      id: 'anthropic.web_search_20260318',
    })
    // Vertex serves Claude through Google's API, which accepts the basic revision and not the
    // later ones — the same model id, a different tool.
    expect(offered('vertex-cred/claude-sonnet-4-5', 'vertex')?.id).toBe(
      'anthropic.web_search_20250305',
    )
  })

  it('offers OpenAI’s and xAI’s own tools on the models that have one', () => {
    expect(offered('openai/gpt-5-mini')?.id).toBe('openai.web_search')
    expect(offered('openai/gpt-4o')?.id).toBe('openai.web_search')
    expect(offered('xai/grok-4')?.id).toBe('xai.web_search')
    // `xSearch` is deliberately not offered: X's posts are a different answer from the web's.
    expect(JSON.stringify(nativeSearchFor('xai/grok-4', 'api_key'))).not.toContain('x_search')
  })

  it('offers none on the models and providers that have no native tool', () => {
    // A generation before the tool existed.
    expect(offered('anthropic/claude-3-opus-20240229')).toBeNull()
    expect(offered('openai/gpt-3.5-turbo')).toBeNull()
    // A provider with no native tool at all, however new the model is.
    expect(offered('deepseek/deepseek-chat')).toBeNull()
    expect(offered('groq/llama-3.3-70b')).toBeNull()
    expect(offered('mistral/mistral-large-latest')).toBeNull()
    expect(offered('openrouter/anthropic/claude-sonnet-4-5')).toBeNull()
    // Google's grounding is left out on purpose: the "search suggestions" element its terms
    // require is an HTML widget, and `oh` is a terminal that cannot render one.
    expect(offered('google/gemini-2.5-pro')).toBeNull()
    // And Azure, whose client this build builds is the chat-completions one.
    expect(offered('azure/gpt-4o', 'azure_openai')).toBeNull()
    // A Bedrock Claude: the family has a tool, the credential route does not carry it.
    expect(offered('bedrock/anthropic.claude-sonnet-4-5-v1:0', 'bedrock')).toBeNull()
    expect(offered('custom/claude-sonnet-4-5', 'openai_compatible')).toBeNull()
  })

  it('bounds what one request may spend on searches', () => {
    const tool = (
      nativeSearchFor('anthropic/claude-sonnet-4-5', 'api_key')?.tools as unknown as Record<
        string,
        { readonly args?: { readonly maxUses?: number } }
      >
    )[WEB_SEARCH_TOOL_NAME]
    expect(tool?.args?.maxUses).toBe(MAX_SEARCHES_PER_REQUEST)
  })

  it('answers whether a model can search when only the id is known', () => {
    expect(modelSearches('anthropic/claude-sonnet-4-5')).toBe(true)
    expect(modelSearches('openai/gpt-5-mini')).toBe(true)
    expect(modelSearches('deepseek/deepseek-chat')).toBe(false)
    // A named credential's id carries the credential's *name*, so the only case a model id alone
    // decides is a Claude model — which is what a Vertex credential's ids look like.
    expect(modelSearches('my-vertex/claude-sonnet-4-5')).toBe(true)
    expect(modelSearches('my-azure/gpt-4o')).toBe(false)
  })

  it('is the family the credential’s type decides for a named credential', () => {
    expect(searchFamilyOf('vertex-cred/claude-sonnet-4-5', 'vertex')).toBe('anthropic')
    expect(searchFamilyOf('vertex-cred/gemini-2.5-pro', 'vertex')).toBeNull()
    // A fixed provider id is read from the id, and the type agrees with it.
    expect(searchFamilyOf('xai/grok-4', 'api_key')).toBe('xai')
  })
})

describe('the generation rules keep working for models nobody has seen (#335 retest)', () => {
  /**
   * The table the issue is about, one row per model id: the three readers must agree about every
   * one of them, because they are what a request (`searchFamilyOf`), the settings listing
   * (`modelSearches`) and the offer (`nativeSearchFor`) are built from.
   *
   * `gpt-6-astra` is the id a reader typed — as `gpt6-astra`, without the hyphen — and was told
   * there is no search; the negatives are the generations that really predate the tool, which a
   * forward-compatible rule must still leave out.
   */
  const cases: readonly { readonly id: string; readonly searches: boolean }[] = [
    // OpenAI: 4o and 4.1, then every gpt-N with N ≥ 5 however it is spelled.
    { id: 'openai/gpt-4o', searches: true },
    { id: 'openai/gpt-4o-mini', searches: true },
    { id: 'openai/gpt-4.1', searches: true },
    { id: 'openai/gpt-4.1-mini', searches: true },
    { id: 'openai/gpt-5', searches: true },
    { id: 'openai/gpt-5.1-codex', searches: true },
    { id: 'openai/gpt-6-astra', searches: true },
    { id: 'openai/gpt6-astra', searches: true },
    { id: 'openai/gpt-10', searches: true },
    { id: 'openai/gpt-12-preview', searches: true },
    // The o-series, from o1 on — a later generation is assumed to have the tool too.
    { id: 'openai/o1', searches: true },
    { id: 'openai/o3-mini', searches: true },
    { id: 'openai/o4-mini', searches: true },
    { id: 'openai/o7', searches: true },
    { id: 'openai/chatgpt-4o-latest', searches: true },
    // Still out: the generations that predate the tool, and ids that are not chat models.
    { id: 'openai/gpt-3.5-turbo', searches: false },
    { id: 'openai/gpt-4', searches: false },
    { id: 'openai/gpt-4-turbo', searches: false },
    { id: 'openai/gpt-4-0613', searches: false },
    { id: 'openai/omni-moderation-latest', searches: false },
    { id: 'openai/text-embedding-3-small', searches: false },
    // Anthropic: 3.5 on, and every claude-<family>-<N ≥ 4> for any family name.
    { id: 'anthropic/claude-3-5-sonnet-20241022', searches: true },
    { id: 'anthropic/claude-3-7-sonnet-latest', searches: true },
    { id: 'anthropic/claude-sonnet-4-5', searches: true },
    { id: 'anthropic/claude-opus-4-1', searches: true },
    { id: 'anthropic/claude-haiku-4-5', searches: true },
    { id: 'anthropic/claude-fable-5-1', searches: true },
    { id: 'anthropic/claude-opus-5-5', searches: true },
    { id: 'anthropic/claude-sonnet-5-5', searches: true },
    { id: 'anthropic/claude-haiku-5-5', searches: true },
    { id: 'anthropic/claude-mythos-10', searches: true },
    { id: 'anthropic/claude-3-opus-20240229', searches: false },
    { id: 'anthropic/claude-3-haiku-20240307', searches: false },
    { id: 'anthropic/claude-2.1', searches: false },
    // xAI: grok-3 on, multi-digit included.
    { id: 'xai/grok-3', searches: true },
    { id: 'xai/grok-3-mini', searches: true },
    { id: 'xai/grok-4', searches: true },
    { id: 'xai/grok-10', searches: true },
    { id: 'xai/grok-2-1212', searches: false },
    { id: 'xai/grok-beta', searches: false },
  ]

  it.each(cases)('$id searches: $searches', ({ id, searches }) => {
    // The offer the loop makes, the family it reads, and the answer the settings listing gives
    // are one decision, so they are asserted together: a table that let them drift is the bug.
    expect(offered(id) !== null).toBe(searches)
    expect(searchFamilyOf(id, 'api_key') !== null).toBe(searches)
    expect(modelSearches(id)).toBe(searches)
  })

  it('reads a Vertex Claude through the same Claude rule', () => {
    // A named credential's id carries the credential's name, so the settings listing cannot
    // resolve one — but the request's own path (which knows the type) reads the model half.
    expect(offered('vertex-cred/claude-fable-5-1', 'vertex')?.id).toBe(
      'anthropic.web_search_20250305',
    )
    expect(offered('vertex-cred/claude-3-opus-20240229', 'vertex')).toBeNull()
  })
})

describe('the settings decide whether it is offered (#335)', () => {
  const CLAUDE = 'anthropic/claude-sonnet-4-5'

  it('offers it by default, and not on a model without a provider tool', () => {
    expect(webSearchOffered(CLAUDE, 'api_key', undefined)).toBe(true)
    expect(webSearchOffered(CLAUDE, 'api_key', {})).toBe(true)
    expect(webSearchOffered('deepseek/deepseek-chat', 'api_key', undefined)).toBe(false)
  })

  it('does not attach it when the user turned it off, or denied it', () => {
    const off: ToolSettings = {
      [WEB_SEARCH_TOOL_NAME]: { enabled: false, permission: 'allow' },
    }
    const denied: ToolSettings = {
      [WEB_SEARCH_TOOL_NAME]: { enabled: true, permission: 'deny' },
    }
    expect(webSearchOffered(CLAUDE, 'api_key', off)).toBe(false)
    // A `deny` cannot be honoured mid-flight, so it means "do not attach it" — which is what
    // the user asked for either way.
    expect(webSearchOffered(CLAUDE, 'api_key', denied)).toBe(false)
  })

  it('reads a stored `ask` as allow, because a provider-executed search cannot pause', () => {
    const asking: ToolSettings = {
      [WEB_SEARCH_TOOL_NAME]: { enabled: true, permission: 'ask' },
    }
    expect(webSearchOffered(CLAUDE, 'api_key', asking)).toBe(true)
  })

  it('declares the tool the settings are keyed by', () => {
    // `modelGated`, because whether this tool can be offered at all is the **chat model's**
    // question (#335): the search is the model's own provider's, so a model whose provider has
    // none cannot be offered it. A tool this build's own turn builds — the two that read a
    // user's skills (#352) — declares nothing of the kind.
    expect(NATIVE_TOOL_DECLARATIONS).toEqual([
      { name: WEB_SEARCH_TOOL_NAME, permission: 'allow', modelGated: true },
    ])
  })
})

describe('a provider refusing the search tool (#335)', () => {
  it('recognises a 4xx that names it, and nothing else', () => {
    const failure = (statusCode: number, message: string) =>
      Object.assign(new Error(message), { statusCode })
    expect(
      searchWasRejected(
        failure(400, 'tools.0.web_search_20260318: Extra inputs are not permitted'),
      ),
    ).toBe(true)
    expect(searchWasRejected(failure(400, 'Unknown tool name: web_search'))).toBe(true)
    // A server error is the ordinary retry path's, not this one's.
    expect(searchWasRejected(failure(503, 'web_search is unavailable'))).toBe(false)
    // Any other 400 — an unknown model, a bad request — must not cost a second request.
    expect(searchWasRejected(failure(400, 'the model does not exist'))).toBe(false)
    expect(searchWasRejected(new Error('web_search blew up'))).toBe(false)
    expect(searchWasRejected(undefined)).toBe(false)
  })
})
