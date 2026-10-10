import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_IDS } from '@openharness/protocol'

import {
  ZERO_MODEL_USAGE,
  isUsableCredential,
  missingCredentialMessage,
  isUnsupportedProviderError,
  providerOf,
  providerModelFactory,
  createProviderModelFactory,
  streamModelRequest,
  UnsupportedProviderError,
  toModelUsage,
} from './model'
import type { ModelRequestResult } from './model'
import {
  TEST_API_KEY,
  TEST_CREDENTIAL,
  apiCallError,
  wrongSpecModel,
  mockModel,
} from './testing/mock-model'
import { anthropicSse, openAiResponsesSse } from './testing/provider-streams'

describe('toModelUsage', () => {
  it('maps the AI SDK report onto the protocol counters', () => {
    // `inputTokens` is the SDK's *total*; the protocol's counter is the uncached half of it
    // (`noCacheTokens`), so the four protocol counters stay disjoint (epic #277, K2).
    expect(
      toModelUsage({
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 16,
        inputTokenDetails: {
          noCacheTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
        },
        outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
      }),
    ).toEqual({
      input_tokens: 6,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    })
  })

  it('reports zero for a counter the provider did not send', () => {
    expect(
      toModelUsage({
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      }),
    ).toEqual(ZERO_MODEL_USAGE)
  })

  it('reads the counts out of the usage object a mis-declared model reports', () => {
    // The shape a report takes when the model's declared provider spec is older than the usage
    // it streams: the model's own usage object, where a number belongs, with the cache
    // breakdown inside it rather than beside it.
    expect(
      toModelUsage({
        inputTokens: { total: 11, noCache: 6, cacheRead: 2, cacheWrite: 3 },
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
        outputTokenDetails: {},
        totalTokens: '0[object Object][object Object]',
      }),
    ).toEqual({
      input_tokens: 6,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    })
  })

  it('reads through the second layer a spec-compatibility layer wraps around it', () => {
    // The breakdown is gone here, so the uncached half is derived: the total minus both cache
    // halves — 7 − 1 − 2.
    expect(
      toModelUsage({
        inputTokens: { total: { total: 7, cacheRead: 1, cacheWrite: 2 }, noCache: undefined },
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: { total: { total: 4 } },
      }),
    ).toEqual({
      input_tokens: 4,
      output_tokens: 4,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
    })
  })

  it('normalises each provider family to the uncached input (epic #277, K2)', () => {
    // Anthropic reports the uncached input itself and the cache halves beside it; the SDK's
    // total is their sum, and the protocol's `input_tokens` is the half the wire carried.
    expect(
      toModelUsage({
        inputTokens: 11,
        outputTokens: 5,
        inputTokenDetails: { noCacheTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2 },
      }),
    ).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    })
    // Bedrock's Claude models and Vertex's Anthropic models are the same shape: their own
    // `input_tokens` leaves cached tokens out, and the SDK's uncached half is that number.
    expect(
      toModelUsage({
        inputTokens: 16,
        outputTokens: 5,
        inputTokenDetails: { noCacheTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2 },
      }).input_tokens,
    ).toBe(11)
    // OpenAI and the OpenAI-compatible family report a cache-inclusive `prompt_tokens`; the
    // uncached half is it minus the cached ones — 11 − 2 — not the raw 11.
    expect(
      toModelUsage({
        inputTokens: 11,
        outputTokens: 5,
        inputTokenDetails: { noCacheTokens: 9, cacheReadTokens: 2, cacheWriteTokens: 0 },
      }),
    ).toEqual({
      input_tokens: 9,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    })
  })

  it('reports zero for a value that carries no count', () => {
    expect(toModelUsage('0[object Object]')).toEqual(ZERO_MODEL_USAGE)
    expect(toModelUsage(undefined)).toEqual(ZERO_MODEL_USAGE)
    expect(toModelUsage({})).toEqual(ZERO_MODEL_USAGE)
    expect(
      toModelUsage({
        inputTokens: 'many',
        outputTokens: {},
        inputTokenDetails: { cacheReadTokens: [] },
      }),
    ).toEqual(ZERO_MODEL_USAGE)
  })

  it('always produces the non-negative integers the protocol demands', () => {
    expect(
      toModelUsage({
        inputTokens: -3.6,
        outputTokens: 4.4,
        inputTokenDetails: {
          cacheReadTokens: Number.NaN,
          cacheWriteTokens: Number.POSITIVE_INFINITY,
        },
      }),
    ).toEqual({
      input_tokens: 0,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  })
})

describe('streamModelRequest', () => {
  const messages = [{ role: 'user' as const, content: 'Hello' }]

  it('streams the text, in chunks, and reports the usage', async () => {
    const { factory, calls } = mockModel({ text: ['Hi ', 'there'], usage: { input_tokens: 9 } })
    const chunks: string[] = []

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
      onTextDelta: (text) => {
        chunks.push(text)
      },
    })

    expect(result).toMatchObject({ text: 'Hi there', aborted: false, error: undefined })
    expect(result.usage).toMatchObject({ input_tokens: 9, output_tokens: 64 })
    expect(chunks).toEqual(['Hi ', 'there'])
    expect(calls).toHaveLength(1)
  })

  it('reports the real counts for a model that declares the wrong provider spec', async () => {
    // A mis-declared report, end to end: `ai` reads the mock's usage through its v2 compatibility
    // layer and accumulates `"0[object Object]"`, and the counts have to come back out of the
    // step report the model made — not out of that sum (issue #39).
    const { factory } = mockModel({
      text: ['Hi'],
      usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2 },
    })

    const result = await streamModelRequest({
      model: wrongSpecModel(factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL)),
      messages,
    })

    expect(result.usage).toEqual({
      // The mock's `input_tokens` scripts an OpenAI-shaped total of 9, 2 of them cached, so the
      // protocol's uncached counter is 7 (epic #277, K2).
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    })
  })

  it('reports a provider failure rather than throwing', async () => {
    // The failure is an `APICallError` with `isRetryable: true` — the shape the SDK's retry
    // classifier recognises — so this also fails if `maxRetries` ever lets the SDK retry: the
    // error would arrive wrapped in an `AI_RetryError` instead of as itself.
    const failure = apiCallError(529, 'Overloaded.')
    const { factory } = mockModel({ failWith: failure })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
    })

    expect(result).toEqual({ text: '', usage: ZERO_MODEL_USAGE, error: failure, aborted: false })
  })

  it('reports a failure that arrives mid-stream', async () => {
    const failure = apiCallError(529, 'Overloaded.')
    const { factory } = mockModel({ text: ['par'], failAfterText: failure })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
    })

    expect(result).toMatchObject({ text: 'par', aborted: false, error: failure })
  })

  it('reports an abort, with the text that had already arrived', async () => {
    const controller = new AbortController()
    const { factory } = mockModel({
      text: ['par', 'tial'],
      onChunk: () => {
        controller.abort()
      },
    })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
      signal: controller.signal,
    })

    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.usage).toEqual(ZERO_MODEL_USAGE)
  })

  it('never retries on its own: the turn loop owns the retries', async () => {
    // The failure is retryable by the SDK's own classifier — an `APICallError` 503 with
    // `isRetryable: true` — which is exactly what `maxRetries` would act on if it were left at
    // its default: `doStream` would be called again underneath the loop, invisibly, and this
    // test would see the calls (issue #117). With `maxRetries: 0` one failure is one call.
    const { factory, calls } = mockModel({ failWith: apiCallError(503, 'Overloaded.') })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
    })

    expect(calls).toHaveLength(1)
    expect(result.error).toMatchObject({ statusCode: 503, isRetryable: true })
  })

  it('passes the abort signal down to the provider', async () => {
    const controller = new AbortController()
    const { factory, calls } = mockModel({ text: ['hi'] })

    await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
      signal: controller.signal,
    })

    expect(calls[0]?.abortSignal).toBe(controller.signal)
  })

  it('does not swallow a fenced write as if it were a model failure', async () => {
    const { factory } = mockModel({ text: ['hi'] })
    const fenced = Object.assign(new Error('fenced'), { name: 'FencedError', code: 'fenced' })
    const onTextDelta = vi.fn(() => {
      throw fenced
    })

    await expect(
      streamModelRequest({
        model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
        messages,
        onTextDelta,
      }),
    ).rejects.toThrow(fenced)
  })
})

describe('providerOf', () => {
  it('reads the provider as everything before the first slash', () => {
    expect(providerOf('anthropic/claude-sonnet-5')).toBe('anthropic')
    expect(providerOf('openai/gpt-4o')).toBe('openai')
    expect(providerOf('openrouter/anthropic/claude-sonnet-5')).toBe('openrouter')
  })

  it('treats an id with no slash as its own provider', () => {
    expect(providerOf('anthropic')).toBe('anthropic')
  })
})

describe('isUsableCredential', () => {
  it('answers no for a missing credential and for a blank key', () => {
    // A blank key is not merely useless: every provider client reads a falsy `apiKey` as "none
    // given" and falls back to its own environment variable, so it must never be treated as
    // a credential.
    expect(isUsableCredential(null)).toBe(false)
    expect(isUsableCredential({ type: 'api_key', apiKey: '' })).toBe(false)
    expect(isUsableCredential({ type: 'api_key', apiKey: '   ' })).toBe(false)
  })

  it('answers yes for a key with anything in it', () => {
    expect(isUsableCredential({ type: 'api_key', apiKey: 'sk-live-abc123' })).toBe(true)
  })
})

describe('missingCredentialMessage', () => {
  it('names the provider the way a person writes it, as the shared list spells it', () => {
    expect(missingCredentialMessage('openai')).toBe(
      'No OpenAI key is set. Add one in Settings → Model providers.',
    )
    // The name is `@openharness/protocol`'s, not a capitalised id: "Fireworks AI", which is
    // also what the frontends put on the provider's tile.
    expect(missingCredentialMessage('fireworks')).toBe(
      'No Fireworks AI key is set. Add one in Settings → Model providers.',
    )
  })

  it('falls back to capitalising a provider it does not know', () => {
    expect(missingCredentialMessage('acme')).toBe(
      'No Acme key is set. Add one in Settings → Model providers.',
    )
  })
})

/**
 * The provider factory, one case per provider a key can be stored for.
 *
 * Every case streams one request through the *real* provider client with `fetch` stubbed, so
 * what it asserts is what the client would really send: the URL, and the header the key
 * travelled in. The environment is set to decoys first — the `*_API_KEY` and `*_BASE_URL`
 * variables the provider packages read when a constructor leaves a setting out — and nothing
 * from it may appear in the request (epic #65, A5).
 */
describe('providerModelFactory', () => {
  /**
   * One provider's expected shape: the request that proves the factory built the right client,
   * pointed at the right endpoint, authenticated with the owner's key.
   *
   * The model ids are the providers' own spellings — a fireworks or OpenRouter id carries
   * slashes of its own, and the OpenRouter one is the shape the catalogue's own
   * recommendations use.
   */
  const CASES = [
    {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      url: 'https://api.anthropic.com/v1/messages',
      header: 'x-api-key',
      value: TEST_API_KEY,
    },
    {
      provider: 'openai',
      model: 'gpt-4o-mini',
      url: 'https://api.openai.com/v1/responses',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'google',
      model: 'gemini-2.5-flash',
      url:
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash' +
        ':streamGenerateContent?alt=sse',
      header: 'x-goog-api-key',
      value: TEST_API_KEY,
    },
    {
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'deepseek',
      model: 'deepseek-chat',
      url: 'https://api.deepseek.com/chat/completions',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'fireworks',
      model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'mistral',
      model: 'mistral-small-latest',
      url: 'https://api.mistral.ai/v1/chat/completions',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'together',
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      url: 'https://api.together.xyz/v1/chat/completions',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'xai',
      model: 'grok-4',
      url: 'https://api.x.ai/v1/responses',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
    {
      provider: 'cerebras',
      model: 'llama-3.3-70b',
      url: 'https://api.cerebras.ai/v1/chat/completions',
      header: 'authorization',
      value: `Bearer ${TEST_API_KEY}`,
    },
  ] as const

  /**
   * The decoy environment, one pair per provider: what a deployment might have set, and what a
   * request built from the environment would pick up instead of the owner's key or the pinned
   * URL. No value here may appear in a request this factory builds.
   */
  const DECOYS: Readonly<Record<string, string>> = {
    ANTHROPIC_API_KEY: 'sk-ant-env-decoy',
    ANTHROPIC_BASE_URL: 'https://env-decoy.invalid/anthropic',
    OPENAI_API_KEY: 'sk-openai-env-decoy',
    OPENAI_BASE_URL: 'https://env-decoy.invalid/openai',
    GOOGLE_GENERATIVE_AI_API_KEY: 'google-env-decoy',
    GOOGLE_GENERATIVE_AI_BASE_URL: 'https://env-decoy.invalid/google',
    OPENROUTER_API_KEY: 'openrouter-env-decoy',
    OPENROUTER_BASE_URL: 'https://env-decoy.invalid/openrouter',
    GROQ_API_KEY: 'groq-env-decoy',
    GROQ_BASE_URL: 'https://env-decoy.invalid/groq',
    DEEPSEEK_API_KEY: 'deepseek-env-decoy',
    DEEPSEEK_BASE_URL: 'https://env-decoy.invalid/deepseek',
    FIREWORKS_API_KEY: 'fireworks-env-decoy',
    FIREWORKS_BASE_URL: 'https://env-decoy.invalid/fireworks',
    MISTRAL_API_KEY: 'mistral-env-decoy',
    MISTRAL_BASE_URL: 'https://env-decoy.invalid/mistral',
    TOGETHER_API_KEY: 'together-env-decoy',
    TOGETHER_BASE_URL: 'https://env-decoy.invalid/together',
    XAI_API_KEY: 'xai-env-decoy',
    XAI_BASE_URL: 'https://env-decoy.invalid/xai',
    CEREBRAS_API_KEY: 'cerebras-env-decoy',
    CEREBRAS_BASE_URL: 'https://env-decoy.invalid/cerebras',
  }

  /** One captured outbound request. */
  interface Captured {
    readonly url: string
    readonly headers: Record<string, string>
    readonly body: unknown
  }

  const PROMPT = [{ role: 'user' as const, content: 'Hello' }]

  /** What a provider answers when a test only cares about the request it was sent: a refusal. */
  function refusal(): Response {
    return new Response(JSON.stringify({ error: { message: 'not under test' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  /**
   * Build a model for `modelId` with {@link TEST_CREDENTIAL}, set every decoy variable, stub
   * `fetch` with `respond` so nothing leaves the process, and stream one request through it.
   *
   * The captured requests are what is under test: the URL the provider client built and the
   * headers it authenticated with, read before anything is parsed. What the request's outcome
   * is — a 400 the client rejects, or a stream it parses — is the caller's to assert.
   */
  async function capture(
    modelId: string,
    respond: () => Response,
  ): Promise<{ readonly requests: Captured[]; readonly result: ModelRequestResult }> {
    const requests: Captured[] = []
    for (const [name, value] of Object.entries(DECOYS)) {
      vi.stubEnv(name, value)
    }
    vi.stubGlobal('fetch', (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
      const url = typeof input === 'string' ? input : String((input as { url: string }).url)
      let body: unknown = init?.body
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body)
        } catch {
          // Not JSON: keep the raw text, which is still what the request carried.
        }
      }
      requests.push({
        url,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body,
      })
      return Promise.resolve(respond())
    })
    try {
      const model = providerModelFactory(modelId, TEST_CREDENTIAL)
      const result = await streamModelRequest({ model, messages: PROMPT })
      return { requests, result }
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  }

  it('covers every provider of the shared list, one case each', () => {
    // The table in `model.ts` is typed against `ProviderId` (#245), so a provider with no
    // client is a compile error; this is the other half, and about this test alone: every
    // provider the shared list carries is exercised below, in the list's order.
    expect(CASES.map((entry) => entry.provider)).toEqual(PROVIDER_IDS)
  })

  for (const entry of CASES) {
    it(`sends the ${entry.provider} request to its own host with the explicit key`, async () => {
      const { requests } = await capture(`${entry.provider}/${entry.model}`, refusal)

      expect(requests).toHaveLength(1)
      const [request] = requests
      expect(request?.url).toBe(entry.url)
      // The exact header the provider authenticates with, carrying the owner's key — not the
      // decoy the environment holds, and not the decoy's endpoint either.
      expect(request?.headers[entry.header]).toBe(entry.value)
      expect(JSON.stringify(requests)).not.toContain('env-decoy')
    })
  }

  it('sends the model id the session named, not the whole provider/model string', async () => {
    // A fireworks id carries slashes of its own, so the id is everything after the first one —
    // not `split('/')[1]`, which would ask Fireworks for `accounts`.
    const { requests } = await capture(
      'fireworks/accounts/fireworks/models/llama-v3p1-70b-instruct',
      refusal,
    )

    expect(requests[0]?.body).toMatchObject({
      model: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    })
  })

  it('refuses a provider it has no client for, before any request', () => {
    // The provider a session names is free text (C5), so this is reachable — and a key for such
    // a provider could never be stored. `runTurn` catches this and ends the turn on it.
    expect(() => providerModelFactory('acme/gpt-9', TEST_CREDENTIAL)).toThrow(
      UnsupportedProviderError,
    )
    expect(() => providerModelFactory('no-slash-at-all', TEST_CREDENTIAL)).toThrow(
      'no model client for provider "no-slash-at-all"',
    )
    expect(isUnsupportedProviderError(new UnsupportedProviderError('acme'))).toBe(true)
    expect(isUnsupportedProviderError(new Error('nope'))).toBe(false)
  })

  it('sends a fixed provider through the injected fetch, leaving the platform one alone (#270)', async () => {
    // The eleven fixed providers have no user-typed URL to guard, but they do have an egress
    // path: the host injects the fetch their clients use, so a deployment behind a proxy
    // chats without `NODE_USE_ENV_PROXY` — the same seam Azure, custom and Vertex already
    // have. This drives a real OpenAI Responses stream through it end to end.
    vi.stubEnv('OPENAI_API_KEY', 'env-decoy')
    const calls: string[] = []
    const platformFetch = vi.fn(() => Promise.resolve(refusal()))
    vi.stubGlobal('fetch', platformFetch)
    try {
      const model = createProviderModelFactory({
        fetch: (input) => {
          calls.push(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          )
          return Promise.resolve(openAiResponsesSse())
        },
      })('openai/gpt-4o-mini', TEST_CREDENTIAL)

      const result = await streamModelRequest({ model, messages: PROMPT })

      expect(calls).toEqual(['https://api.openai.com/v1/responses'])
      // Not one request reached the platform's `fetch` — the injected one carried the whole
      // model call, and its reply is the one the loop read.
      expect(platformFetch).not.toHaveBeenCalled()
      expect(result.error).toBeUndefined()
      expect(result.text).toBe('Hi there')
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })

  it('reports the numbers a real OpenAI Responses stream carries', async () => {
    const { result } = await capture('openai/gpt-4o-mini', openAiResponsesSse)

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Hi there')
    // OpenAI's `input_tokens` already includes the cached ones (11 with 2 cached), so the
    // uncached counter is 9 — the real prompt size is 9 + 2 (epic #277, K2).
    expect(result.usage).toEqual({
      input_tokens: 9,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    })
  })

  it('reports the numbers a real Anthropic stream carries', async () => {
    const { result } = await capture('anthropic/claude-haiku-4-5', anthropicSse)

    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Hi there')
    // Anthropic's `input_tokens` is the *uncached* input, so the protocol's counter is the wire's
    // 11 — and the real prompt size is 11 + 2 written + 3 read. The four counters are the ones
    // the wire carried, which is what the old router could not get right (issue #39).
    expect(result.usage).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    })
  })
})
