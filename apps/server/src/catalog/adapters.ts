/**
 * The provider list endpoints, as a fixed table (epic #92, C1; issue #90).
 *
 * One adapter per provider this server can call, each with the endpoint's base URL, the one
 * authenticated `GET` that lists models, and the parser for that provider's payload. The table
 * is the security boundary: **no part of a request ever supplies a URL** — the only URL a
 * provider call uses is one of the constants here — so there is no SSRF surface, and a
 * credential for a provider outside the table is served from the registry (C3) rather than
 * dialing something a caller chose. (The one exception is the custom OpenAI-compatible
 * credential type, #249 A3b, whose base URL **is** the user's: it never goes through this
 * table — the catalogue lists it through `safeFetch`, the guard built for exactly that case.)
 *
 * An adapter answers raw model ids plus whatever capability or limit data the provider's own
 * payload carries: Gemini's `supportedGenerationMethods` and token limits, OpenRouter's
 * `context_length` and its chat-only catalogue, the `display_name` some OpenAI-compatible
 * providers give. The registry join in `registry.ts` fills in what the provider leaves out.
 *
 * The OpenAI-compatible family (Groq, DeepSeek, Fireworks, Mistral, Together, xAI, Cerebras)
 * shares one parser: `GET <base>/models` with `Authorization: Bearer`, answering either an
 * OpenAI-style `{ data: [...] }` or the bare array some of them return.
 */

import { PROVIDER_IDS, type ProviderId } from '@openharness/protocol'

/** One model a provider's own list offered, as the provider spelled it. */
export interface ProviderModel {
  /** The raw model id, without the `provider/` prefix — how the provider names it. */
  readonly id: string
  /** The provider's display name for it, when its payload carries one. */
  readonly name?: string
  /** The context window in tokens, when the provider reports one. */
  readonly contextWindow?: number
  /** The largest output in tokens, when the provider reports one. */
  readonly maxOutput?: number
  /**
   * The provider's own chat verdict, when its payload carries one: Gemini's
   * `supportedGenerationMethods`, OpenRouter's chat-only list. Absent when it says nothing,
   * which is most of them — the filter in `filter.ts` decides those.
   */
  readonly chat?: boolean
}

/** One page of a provider's model list. */
export interface ProviderPage {
  /** The models this page carried. */
  readonly models: readonly ProviderModel[]
  /** The cursor for the next page, or `null` when this was the last one. */
  readonly next: string | null
}

/** How to list one provider's models. */
export interface ProviderAdapter {
  /** The provider id this adapter serves — the `provider` of a `provider/model` id. */
  readonly provider: string
  /**
   * The URL of one page of the list. `cursor` is the previous page's `next`, or `null` for the
   * first page. The base URL is a constant of this module; nothing else ever reaches here.
   */
  url(cursor: string | null): string
  /** The authenticated request headers for this provider. */
  headers(apiKey: string): Record<string, string>
  /**
   * Parse one page of the provider's payload.
   *
   * @throws Error when the body is not the shape this provider serves; the catalog turns that
   *   into the provider's registry fallback, so a provider answering something unexpected is a
   *   visible `fallback`, not a 500.
   */
  parse(body: unknown): ProviderPage
}

/** The Anthropic API version header `GET /v1/models` requires. */
const ANTHROPIC_VERSION = '2023-06-01'

/** How many models one page asks for where the endpoint takes a page size. */
const PAGE_SIZE = 1000

/**
 * The fixed table of providers this server lists from: one adapter per provider of the shared
 * list (`@openharness/protocol`), keyed by its provider id. Every entry is a constant: base
 * URL, page shape and parser. A provider the table leaves out is a compile error, so the
 * catalogue cannot be missing an endpoint for a key the server stores (#245).
 */
const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  anthropic: anthropic(),
  openai: openAiCompatible({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  }),
  google: google(),
  openrouter: openRouter(),
  groq: openAiCompatible({ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1' }),
  deepseek: openAiCompatible({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }),
  fireworks: openAiCompatible({
    provider: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
  }),
  mistral: openAiCompatible({ provider: 'mistral', baseUrl: 'https://api.mistral.ai/v1' }),
  together: openAiCompatible({ provider: 'together', baseUrl: 'https://api.together.xyz/v1' }),
  xai: openAiCompatible({ provider: 'xai', baseUrl: 'https://api.x.ai/v1' }),
  cerebras: openAiCompatible({ provider: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1' }),
}

/**
 * The adapter for a provider, or `null` when the table has none — a registry-only provider.
 *
 * The lookup is `Object.hasOwn` rather than a bare index so a provider string that names an
 * inherited property (`toString`, `constructor`) is a miss, not a function call.
 */
export function adapterFor(provider: string): ProviderAdapter | null {
  return Object.hasOwn(ADAPTERS, provider) ? ADAPTERS[provider as ProviderId] : null
}

/** Every provider the table has an adapter for, in the shared list's order. */
export function adaptedProviders(): readonly ProviderId[] {
  return PROVIDER_IDS
}

// ------------------------------------------------------------------ the adapters

/** `GET <base>/models` with a bearer token, for the OpenAI-compatible family. */
function openAiCompatible(input: {
  readonly provider: string
  readonly baseUrl: string
}): ProviderAdapter {
  return {
    provider: input.provider,
    url: () => `${input.baseUrl}/models`,
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    parse: (body) => ({ models: parseOpenAICompatibleModelList(body), next: null }),
  }
}

/**
 * One page of an OpenAI-compatible `GET <base>/models` payload, as raw models.
 *
 * OpenAI returns `{ object: 'list', data: [{ id, … }] }`; a few servers in the family return
 * the array alone, so both are read. Exported because a credential whose base URL the user
 * chose (#249, A3b) lists its models through the same shape without one of the fixed adapters
 * above — the catalogue calls this directly, over a URL `safeFetch` guards.
 */
export function parseOpenAICompatibleModelList(body: unknown): readonly ProviderModel[] {
  return arrayOfModels(body).map(openAiCompatibleModel)
}

/** One entry of an OpenAI-style model list: `id` always, with common extensions read too. */
function openAiCompatibleModel(entry: Record<string, unknown>): ProviderModel {
  const id = requiredString(entry, 'id')
  const name = optionalString(entry, 'display_name') ?? optionalString(entry, 'name')
  const contextWindow = optionalNumber(entry, 'context_length', 'context_window')
  const maxOutput = optionalNumber(entry, 'max_output_tokens', 'max_completion_tokens')
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
  }
}

/** `GET https://api.anthropic.com/v1/models`, one page at a time, with `x-api-key`. */
function anthropic(): ProviderAdapter {
  const baseUrl = 'https://api.anthropic.com/v1'
  return {
    provider: 'anthropic',
    url: (cursor) =>
      `${baseUrl}/models?limit=${PAGE_SIZE}${cursor === null ? '' : `&after_id=${encodeURIComponent(cursor)}`}`,
    headers: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }),
    parse: (body) => {
      const page = record(body)
      const data = page.data
      if (!Array.isArray(data)) {
        throw new Error('the anthropic model list carried no `data` array')
      }
      const models = data.map((entry) => {
        const model = record(entry)
        const name = optionalString(model, 'display_name') ?? optionalString(model, 'name')
        return {
          id: requiredString(model, 'id'),
          ...(name === undefined ? {} : { name }),
        }
      })
      // Anthropic pages with `has_more` plus the id to continue after; `first_id`/`last_id`
      // name the page's ends.
      const lastId = optionalString(page, 'last_id')
      const hasMore = page.has_more === true
      return { models, next: hasMore && lastId !== undefined ? lastId : null }
    },
  }
}

/**
 * `GET https://generativelanguage.googleapis.com/v1beta/models`, with the key in the
 * `x-goog-api-key` header — never in the URL, where it would end up in logs and referrers.
 */
function google(): ProviderAdapter {
  const baseUrl = 'https://generativelanguage.googleapis.com/v1beta'
  return {
    provider: 'google',
    url: (cursor) =>
      `${baseUrl}/models?pageSize=${PAGE_SIZE}${cursor === null ? '' : `&pageToken=${encodeURIComponent(cursor)}`}`,
    headers: (apiKey) => ({ 'x-goog-api-key': apiKey }),
    parse: (body) => {
      const page = record(body)
      const models = page.models
      if (!Array.isArray(models)) {
        throw new Error('the google model list carried no `models` array')
      }
      const parsed = models.map((entry) => {
        const model = record(entry)
        // The id is the `name` with its `models/` prefix stripped, so the entry's router id
        // is `google/gemini-2.5-flash`.
        const id = requiredString(model, 'name').replace(/^models\//, '')
        const displayName = optionalString(model, 'displayName')
        const contextWindow = optionalNumber(model, 'inputTokenLimit')
        const maxOutput = optionalNumber(model, 'outputTokenLimit')
        // The provider's own chat verdict: only a model that generates content is a chat
        // model; an embeddings model answers `embedContent`.
        const methods = model.supportedGenerationMethods
        const chat = Array.isArray(methods) ? methods.includes('generateContent') : undefined
        return {
          id,
          ...(displayName === undefined ? {} : { name: displayName }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutput === undefined ? {} : { maxOutput }),
          ...(chat === undefined ? {} : { chat }),
        }
      })
      const next = optionalString(page, 'nextPageToken')
      return { models: parsed, next: next ?? null }
    },
  }
}

/**
 * `GET https://openrouter.ai/api/v1/models`: the whole catalogue in one page, chat models
 * only (OpenRouter does not list embeddings), with `context_length` and the top provider's
 * `max_completion_tokens` on every entry.
 */
function openRouter(): ProviderAdapter {
  return {
    provider: 'openrouter',
    url: () => 'https://openrouter.ai/api/v1/models',
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    parse: (body) => {
      const page = record(body)
      const data = page.data
      if (!Array.isArray(data)) {
        throw new Error('the openrouter model list carried no `data` array')
      }
      const models = data.map((entry) => {
        const model = record(entry)
        const name = optionalString(model, 'name')
        const contextWindow = optionalNumber(model, 'context_length')
        const maxOutput = optionalNestedNumber(model, 'top_provider', 'max_completion_tokens')
        return {
          id: requiredString(model, 'id'),
          // Every model OpenRouter lists is a chat model: the catalogue has no non-chat
          // families (C2's "OpenRouter lists only chat models").
          chat: true,
          ...(name === undefined ? {} : { name }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutput === undefined ? {} : { maxOutput }),
        }
      })
      return { models, next: null }
    },
  }
}

// ------------------------------------------------------------------ reading bodies

/** A JSON body as an object; anything else is the wrong shape. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('the model list was not a JSON object')
  }
  return value as Record<string, unknown>
}

/** The entries of an OpenAI-style list: `{ data: [...] }` or the bare `[...]`. */
function arrayOfModels(body: unknown): readonly Record<string, unknown>[] {
  const entries = Array.isArray(body) ? body : record(body).data
  if (!Array.isArray(entries)) {
    throw new Error('the model list carried no `data` array')
  }
  return entries.map((entry) => record(entry))
}

function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`a model list entry had no \`${key}\` string`)
  }
  return value
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The first of `keys` that is a finite, non-negative number. */
function optionalNumber(
  source: Record<string, unknown>,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value)
    }
  }
  return undefined
}

/** A number under a nested object, e.g. OpenRouter's `top_provider.max_completion_tokens`. */
function optionalNestedNumber(
  source: Record<string, unknown>,
  outer: string,
  inner: string,
): number | undefined {
  const nested = source[outer]
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    return undefined
  }
  return optionalNumber(nested as Record<string, unknown>, inner)
}
