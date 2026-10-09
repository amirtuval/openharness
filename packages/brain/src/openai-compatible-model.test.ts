import { afterEach, describe, expect, it, vi } from 'vitest'

import { STREAMING_LIMITS, type SafeFetchOptions } from '@openharness/hands'

import {
  createOpenAICompatibleFetch,
  openAICompatibleBaseUrl,
  openAICompatibleFetch,
} from './openai-compatible-fetch'
import type { SafeFetch } from './provider-fetch'
import {
  createProviderModelFactory,
  isUnsupportedProviderError,
  isUsableCredential,
  missingCredentialMessage,
  providerModelFactory,
  streamModelRequest,
  UnsupportedProviderError,
  type OpenAICompatibleModelCredential,
} from './model'
import { TEST_API_KEY } from './testing/mock-model'

/**
 * A custom OpenAI-compatible endpoint as a model client (epic #245, A3b).
 *
 * A `custom` credential is a **named** credential: its name is the first half of the model id
 * (`custom/llama3.3`), and the model is the rest, whatever the endpoint calls it. The factory
 * builds the client from the credential's base URL and key — never from any environment
 * variable — and every request goes through the injected `fetch`, which in production is
 * `safeFetch` under the streaming-safe limits (and, unlike Azure, may allow a private address
 * when the server's self-host setting is on).
 */

const BASE_URL = 'https://api.example.com/v1'

const CREDENTIAL: OpenAICompatibleModelCredential = {
  type: 'openai_compatible',
  apiKey: 'sk-custom-secret',
  baseUrl: BASE_URL,
}

describe('openAICompatibleBaseUrl', () => {
  it('keeps the API root the user pasted, and drops a trailing slash', () => {
    // Unlike Azure, nothing is derived: the family serves `<base>/models` and
    // `<base>/chat/completions`, and the user pasted exactly that `<base>`.
    expect(openAICompatibleBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1')
    expect(openAICompatibleBaseUrl('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1',
    )
    expect(openAICompatibleBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
  })

  it('keeps a base URL with no path, and one with a deeper path', () => {
    // An endpoint at the host root would otherwise become `http://host//models`.
    expect(openAICompatibleBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
    expect(openAICompatibleBaseUrl('https://gw.example.com/openai/v1')).toBe(
      'https://gw.example.com/openai/v1',
    )
  })

  it('drops a query and a fragment, which are not part of a base URL', () => {
    expect(openAICompatibleBaseUrl('https://api.example.com/v1/?a=b#frag')).toBe(
      'https://api.example.com/v1',
    )
  })
})

describe('createProviderModelFactory — the openai_compatible path', () => {
  const PROMPT = [{ role: 'user' as const, content: 'Hello' }]

  /** Build the factory over a capturing `fetch` and stream one request through it. */
  async function capture(
    modelId: string,
    credential: OpenAICompatibleModelCredential = CREDENTIAL,
  ): Promise<{ url: string; headers: Record<string, string> }[]> {
    const requests: { url: string; headers: Record<string, string> }[] = []
    const safeFetch: SafeFetch = (input, init) => {
      requests.push({
        url: String(input),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      })
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'not under test' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const factory = createProviderModelFactory({
      openAICompatibleFetch: createOpenAICompatibleFetch({ safeFetch }),
    })
    const model = factory(modelId, credential)
    await streamModelRequest({ model, messages: PROMPT })
    return requests
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sends the request to the stored base URL, with the model from the model id', async () => {
    const requests = await capture('custom/llama3.3')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${BASE_URL}/chat/completions`)
  })

  it('takes the credential name as the model prefix, whatever it is called', async () => {
    const requests = await capture('my-local/qwen2.5')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${BASE_URL}/chat/completions`)
  })

  it('authenticates with the stored key, never with the environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-decoy-key')
    vi.stubEnv('OPENAI_COMPATIBLE_API_KEY', 'env-decoy-compatible')
    const requests = await capture('custom/llama3.3')
    const [request] = requests
    expect(request?.headers['authorization']).toBe('Bearer sk-custom-secret')
    expect(JSON.stringify(request)).not.toContain('env-decoy')
  })

  it('sends no authorization header for a keyless endpoint', async () => {
    // A local server may take no key at all; the package sends no header for a falsy key and
    // has no environment fallback, so an empty one must not become a real one.
    vi.stubEnv('OPENAI_API_KEY', 'env-decoy-key')
    const requests = await capture('custom/llama3.3', { ...CREDENTIAL, apiKey: '' })
    const [request] = requests
    expect(request?.headers['authorization']).toBeUndefined()
    expect(JSON.stringify(request)).not.toContain('env-decoy')
  })

  it('keeps the whole model id after the first slash as the model', async () => {
    const requests = await capture('custom/org/llama-3')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${BASE_URL}/chat/completions`)
  })

  it('streams a reply the endpoint sent, through the injected fetch', async () => {
    const safeFetch: SafeFetch = () =>
      Promise.resolve(
        new Response(chatCompletionSse('Hello from a custom endpoint'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
    const factory = createProviderModelFactory({
      openAICompatibleFetch: createOpenAICompatibleFetch({ safeFetch }),
    })
    const model = factory('custom/llama3.3', CREDENTIAL)
    const result = await streamModelRequest({ model, messages: PROMPT })
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('Hello from a custom endpoint')
  })

  it('refuses a provider with no client and no matching credential, before any request', () => {
    expect(() =>
      providerModelFactory('nobody/model', { type: 'api_key', apiKey: TEST_API_KEY }),
    ).toThrow(UnsupportedProviderError)
    try {
      providerModelFactory('nobody/model', { type: 'api_key', apiKey: TEST_API_KEY })
    } catch (error) {
      expect(isUnsupportedProviderError(error)).toBe(true)
    }
  })

  it('still builds the eleven fixed providers from an api_key credential', () => {
    expect(() =>
      providerModelFactory('anthropic/claude-haiku-4-5', {
        type: 'api_key',
        apiKey: TEST_API_KEY,
      }),
    ).not.toThrow()
  })
})

describe('the custom fetch is guarded, and honours the self-host option', () => {
  it('refuses a private base URL through the real guard, by default', async () => {
    // The model call goes through safeFetch, not a bare fetch: an endpoint that resolves to a
    // private address is refused here exactly as it is at save time, unless the flag is on.
    await expect(openAICompatibleFetch('http://127.0.0.1:11434/v1/models')).rejects.toMatchObject({
      code: 'blocked_address',
    })
    await expect(openAICompatibleFetch('http://169.254.169.254/')).rejects.toMatchObject({
      code: 'blocked_address',
    })
  })

  it('refuses a scheme that is not http(s), and the metadata hostname', async () => {
    await expect(openAICompatibleFetch('ftp://example.com/x')).rejects.toMatchObject({
      code: 'invalid_protocol',
    })
    await expect(openAICompatibleFetch('https://metadata.google.internal/')).rejects.toMatchObject({
      code: 'metadata_host',
    })
  })

  it('passes allowPrivate through to the guard only when it is on, with the streaming limits', async () => {
    const seen: SafeFetchOptions[] = []
    const safeFetch: SafeFetch = (_input, _init, options = {}) => {
      seen.push(options)
      return Promise.resolve(new Response('{}'))
    }
    await createOpenAICompatibleFetch({ safeFetch, allowPrivate: true })('http://127.0.0.1/x')
    await createOpenAICompatibleFetch({ safeFetch })('https://example.com/x')
    await createOpenAICompatibleFetch({ safeFetch, allowPrivate: false })('https://example.com/x')
    // On: the option is set. Off or absent: it is left off entirely, so the guard's own
    // default (refuse) applies — the flag never weakens anything but this type. All three get
    // the streaming preset, not safeFetch's tighter default.
    expect(seen[0]).toMatchObject({ allowPrivate: true, maxBytes: null, timeoutMs: null })
    expect(seen[1]).toMatchObject({ maxBytes: null, timeoutMs: null })
    expect(seen[1]).not.toHaveProperty('allowPrivate')
    expect(seen[2]).not.toHaveProperty('allowPrivate')
    for (const options of seen) {
      expect(options.idleTimeoutMs).toBe(STREAMING_LIMITS.idleTimeoutMs)
    }
  })

  it('accepts the string and URL shapes the AI SDK hands it', async () => {
    const seen: string[] = []
    const fetch = createOpenAICompatibleFetch({
      safeFetch: (input) => {
        seen.push(String(input))
        return Promise.resolve(new Response('ok'))
      },
    })
    await fetch('https://example.com/a')
    await fetch(new URL('https://example.com/b'))
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b'])
  })
})

describe('isUsableCredential and the message for a custom credential', () => {
  it('needs a base URL, and accepts a blank key', () => {
    // The one type whose key may be absent: the base URL is what the request is built from.
    expect(isUsableCredential({ type: 'openai_compatible', apiKey: '', baseUrl: BASE_URL })).toBe(
      true,
    )
    expect(isUsableCredential({ type: 'openai_compatible', apiKey: '', baseUrl: '  ' })).toBe(false)
    expect(isUsableCredential({ type: 'openai_compatible', apiKey: 'k', baseUrl: '' })).toBe(false)
    expect(isUsableCredential(null)).toBe(false)
  })

  it('names the default credential of the type the way its type is called', () => {
    expect(missingCredentialMessage('custom')).toBe(
      'No Custom (OpenAI-compatible) key is set. Add one in Settings → Model providers.',
    )
    // A second credential's own name falls back to itself, capitalised.
    expect(missingCredentialMessage('my-local')).toBe(
      'No My-local key is set. Add one in Settings → Model providers.',
    )
  })
})

/** A minimal OpenAI chat-completions SSE body: one chunk of text, then the stop. */
function chatCompletionSse(text: string): string {
  const chunk = (delta: unknown, finish: string | null, usage?: unknown): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'llama3.3',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`
  return (
    chunk({ role: 'assistant', content: text }, null) +
    chunk({}, 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }) +
    'data: [DONE]\n\n'
  )
}
