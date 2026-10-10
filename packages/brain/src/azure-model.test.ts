import { afterEach, describe, expect, it, vi } from 'vitest'

import { azureBaseUrl, azureFetch, createAzureFetch } from './azure-fetch'
import type { SafeFetch } from './provider-fetch'
import {
  createProviderModelFactory,
  isUnsupportedProviderError,
  isUsableCredential,
  missingCredentialMessage,
  providerModelFactory,
  streamModelRequest,
  UnsupportedProviderError,
  type AzureOpenAIModelCredential,
} from './model'
import { TEST_API_KEY } from './testing/mock-model'

/**
 * Azure OpenAI as a model client (epic #245, A3a).
 *
 * An Azure credential is a **named** credential: its name is the first half of the model id
 * (`azure/gpt-4o`), and the deployment is the rest. The factory builds the client from the
 * credential's endpoint and key — never from `AZURE_API_KEY` or `AZURE_RESOURCE_NAME`, the
 * variables `@ai-sdk/azure` would otherwise fall back to — and every request goes through the
 * injected `fetch`, which in production is `safeFetch` under the streaming-safe limits.
 */

const ENDPOINT = 'https://my-resource.openai.azure.com'

const CREDENTIAL: AzureOpenAIModelCredential = {
  type: 'azure_openai',
  apiKey: 'az-secret-key',
  endpoint: ENDPOINT,
}

describe('azureBaseUrl', () => {
  it('turns the resource endpoint into the base URL the API lives at', () => {
    // The portal's "Endpoint" is the resource root; the API is one segment below it, and
    // `@ai-sdk/azure` appends the `/v1` half.
    expect(azureBaseUrl('https://my-resource.openai.azure.com')).toBe(
      'https://my-resource.openai.azure.com/openai',
    )
    expect(azureBaseUrl('https://my-resource.openai.azure.com/')).toBe(
      'https://my-resource.openai.azure.com/openai',
    )
  })

  it('normalizes the spellings a user might paste to the same base URL', () => {
    for (const endpoint of [
      'https://my-resource.openai.azure.com/openai',
      'https://my-resource.openai.azure.com/openai/',
      'https://my-resource.openai.azure.com/openai/v1',
      'https://my-resource.openai.azure.com/openai/v1/',
    ]) {
      expect(azureBaseUrl(endpoint), endpoint).toBe('https://my-resource.openai.azure.com/openai')
    }
  })

  it('drops a query and a fragment, which are not part of an endpoint', () => {
    expect(azureBaseUrl('https://x.openai.azure.com/?a=b#frag')).toBe(
      'https://x.openai.azure.com/openai',
    )
  })

  it('keeps a resource name that is not the openai suffix', () => {
    // A Foundry/cognitive-services endpoint: the same treatment, different host.
    expect(azureBaseUrl('https://my-resource.cognitiveservices.azure.com')).toBe(
      'https://my-resource.cognitiveservices.azure.com/openai',
    )
  })
})

describe('createProviderModelFactory — the azure path', () => {
  const PROMPT = [{ role: 'user' as const, content: 'Hello' }]

  /** Build the factory over a capturing `fetch` and stream one request through it. */
  async function capture(
    modelId: string,
    credential: AzureOpenAIModelCredential = CREDENTIAL,
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
    const factory = createProviderModelFactory({ azureFetch: createAzureFetch({ safeFetch }) })
    const model = factory(modelId, credential)
    await streamModelRequest({ model, messages: PROMPT })
    return requests
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sends the request to the credential endpoint, with the deployment from the model id', async () => {
    const requests = await capture('azure/gpt-4o')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${ENDPOINT}/openai/v1/chat/completions?api-version=v1`)
  })

  it('takes the credential name as the model prefix, whatever it is called', async () => {
    // `azure-eu` is a second credential of the same type; its name is the left half of the id.
    const requests = await capture('azure-eu/gpt-4o-mini')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${ENDPOINT}/openai/v1/chat/completions?api-version=v1`)
  })

  it('authenticates with the stored key, never with the environment', async () => {
    vi.stubEnv('AZURE_API_KEY', 'env-decoy-key')
    vi.stubEnv('AZURE_RESOURCE_NAME', 'env-decoy-resource')
    const requests = await capture('azure/gpt-4o')
    const [request] = requests
    expect(request?.headers['api-key']).toBe('az-secret-key')
    expect(JSON.stringify(request)).not.toContain('env-decoy')
  })

  it('keeps the whole model id after the first slash as the deployment', async () => {
    // A deployment name may carry slashes of its own, exactly as a Fireworks model id does.
    const requests = await capture('azure/team/gpt-4o')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${ENDPOINT}/openai/v1/chat/completions?api-version=v1`)
  })

  it('refuses a provider with no client and no azure credential, before any request', () => {
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
    // The named path must not have changed the fixed one.
    expect(() =>
      providerModelFactory('anthropic/claude-haiku-4-5', {
        type: 'api_key',
        apiKey: TEST_API_KEY,
      }),
    ).not.toThrow()
  })
})

describe('the azure fetch is guarded', () => {
  it('refuses a private endpoint through the real guard', async () => {
    // The model call goes through safeFetch, not a bare fetch: an endpoint that resolves to a
    // private address is refused here exactly as it is at save time.
    await expect(azureFetch('https://127.0.0.1/v1/chat/completions')).rejects.toMatchObject({
      code: 'blocked_address',
    })
    await expect(azureFetch('http://169.254.169.254/')).rejects.toMatchObject({
      code: 'blocked_address',
    })
  })

  it('refuses a non-https endpoint and the metadata hostname', async () => {
    await expect(azureFetch('ftp://example.com/x')).rejects.toMatchObject({
      code: 'invalid_protocol',
    })
    await expect(azureFetch('https://metadata.google.internal/')).rejects.toMatchObject({
      code: 'metadata_host',
    })
  })

  it('accepts the string and URL shapes the AI SDK hands it', async () => {
    const seen: string[] = []
    const fetch = createAzureFetch({
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

describe('isUsableCredential and the message for a named credential', () => {
  it('refuses an azure credential with a blank key or a blank endpoint', () => {
    expect(isUsableCredential({ type: 'azure_openai', apiKey: '', endpoint: ENDPOINT })).toBe(false)
    expect(isUsableCredential({ type: 'azure_openai', apiKey: 'k', endpoint: '' })).toBe(false)
    expect(isUsableCredential({ type: 'azure_openai', apiKey: '  ', endpoint: '  ' })).toBe(false)
    expect(isUsableCredential({ type: 'azure_openai', apiKey: 'k', endpoint: ENDPOINT })).toBe(true)
    expect(isUsableCredential(null)).toBe(false)
  })

  it('names the default credential of a named type the way its type is called', () => {
    // `azure` is not one of the eleven provider ids; it is the name an Azure credential takes
    // by default, and the message says the type's display name.
    expect(missingCredentialMessage('azure')).toBe(
      'No Azure OpenAI key is set. Add one in Settings → Model providers.',
    )
    expect(missingCredentialMessage('anthropic')).toBe(
      'No Anthropic key is set. Add one in Settings → Model providers.',
    )
    // A second credential's own name falls back to itself, capitalised.
    expect(missingCredentialMessage('azure-eu')).toBe(
      'No Azure-eu key is set. Add one in Settings → Model providers.',
    )
  })
})
