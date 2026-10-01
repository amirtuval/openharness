import { describe, expect, it, vi } from 'vitest'

import {
  ZERO_MODEL_USAGE,
  isUsableCredential,
  missingCredentialMessage,
  providerOf,
  routerModelFactory,
  streamModelRequest,
  toModelUsage,
} from './model'
import { TEST_CREDENTIAL, misdeclaredSpec, mockModel } from './testing/mock-model'

describe('toModelUsage', () => {
  it('maps the AI SDK report onto the protocol counters', () => {
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
      input_tokens: 11,
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

  it('reads the counts out of the usage object a v2-declared model reports', () => {
    // What `streamText` hands over for Mastra's router: the model's own usage object, where a
    // number belongs, with the cache breakdown inside it rather than beside it.
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
      input_tokens: 11,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    })
  })

  it('reads through the second layer the compatibility layer wraps around it', () => {
    expect(
      toModelUsage({
        inputTokens: { total: { total: 7, cacheRead: 1, cacheWrite: 2 }, noCache: undefined },
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: { total: { total: 4 } },
      }),
    ).toEqual({
      input_tokens: 7,
      output_tokens: 4,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 2,
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
    // The router's report, end to end: `ai` reads the mock's usage through its v2 compatibility
    // layer and accumulates `"0[object Object]"`, and the counts have to come back out of the
    // step report the model made — not out of that sum (issue #39).
    const { factory } = mockModel({
      text: ['Hi'],
      usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2 },
    })

    const result = await streamModelRequest({
      model: misdeclaredSpec(factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL)),
      messages,
    })

    expect(result.usage).toEqual({
      input_tokens: 9,
      output_tokens: 3,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 0,
    })
  })

  it('reports a provider failure rather than throwing', async () => {
    const failure = Object.assign(new Error('Overloaded.'), { statusCode: 529 })
    const { factory } = mockModel({ failWith: failure })

    const result = await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
    })

    expect(result).toEqual({ text: '', usage: ZERO_MODEL_USAGE, error: failure, aborted: false })
  })

  it('reports a failure that arrives mid-stream', async () => {
    const failure = Object.assign(new Error('Overloaded.'), { statusCode: 529 })
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
    const failure = Object.assign(new Error('Overloaded.'), { statusCode: 503 })
    const { factory, calls } = mockModel({ failWith: failure })

    await streamModelRequest({
      model: factory('anthropic/claude-sonnet-5', TEST_CREDENTIAL),
      messages,
    })

    expect(calls).toHaveLength(1)
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
    // A blank key is not merely useless: Mastra's router reads a falsy `apiKey` as "none
    // given" and falls back to the environment, so it must never be treated as a credential.
    expect(isUsableCredential(null)).toBe(false)
    expect(isUsableCredential({ apiKey: '' })).toBe(false)
    expect(isUsableCredential({ apiKey: '   ' })).toBe(false)
  })

  it('answers yes for a key with anything in it', () => {
    expect(isUsableCredential({ apiKey: 'sk-live-abc123' })).toBe(true)
  })
})

describe('missingCredentialMessage', () => {
  it('names the provider the way a person writes it', () => {
    expect(missingCredentialMessage('openai')).toBe(
      'No OpenAI key is set. Add one in Settings → Model providers.',
    )
    expect(missingCredentialMessage('anthropic')).toBe(
      'No Anthropic key is set. Add one in Settings → Model providers.',
    )
  })

  it('falls back to capitalising a provider it does not know', () => {
    expect(missingCredentialMessage('mistral')).toBe(
      'No Mistral key is set. Add one in Settings → Model providers.',
    )
  })
})

describe('routerModelFactory', () => {
  /** The router's auth resolution: private in its type, an ordinary method at runtime. */
  interface RouterInternals {
    resolveAuth(provider: string, model: string): Promise<{ apiKey?: string; source?: string }>
  }

  it('authenticates each request with the explicit key, never the environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-decoy-that-must-not-be-used')
    try {
      const model = routerModelFactory('openai/gpt-4o', {
        apiKey: 'sk-explicit-from-the-owner',
      }) as unknown as RouterInternals

      // Mastra's `resolveAuth` returns a config-supplied key verbatim — `source: 'explicit'`
      // — without asking the gateway that would read `OPENAI_API_KEY`. That is the property
      // epic #65 (A5) rests on, and the one pinned here so a Mastra upgrade cannot silently
      // undo it.
      await expect(model.resolveAuth('openai', 'gpt-4o')).resolves.toMatchObject({
        apiKey: 'sk-explicit-from-the-owner',
        source: 'explicit',
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
