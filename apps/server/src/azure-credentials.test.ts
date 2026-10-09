import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type ListModelsResponse,
  type ListProviderCredentialsResponse,
  type ProviderCredential,
} from '@openharness/protocol'
import { InMemoryCredentialStore, InMemorySessionStore } from '@openharness/session'
import { createVault, envKeyProvider } from '@openharness/vault'
import {
  createAzureFetch,
  createProviderModelFactory,
  type ModelCredential,
  type SafeFetch,
} from '@openharness/brain'

import { createSessionCredentialResolver } from './credentials'
import { ModelCatalog } from './catalog/catalog'
import type { ModelRegistry } from './catalog/registry'
import type { ProviderFetch } from './catalog/provider-fetch'
import { createProviderCredentialValidator } from './provider-validation'
import {
  TEST_SECRETS_KEY,
  createTestApp,
  httpCreateAgent,
  httpCreateSession,
  readHistory,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * Azure OpenAI credentials, end to end (epic #245, A3a).
 *
 * What this suite covers is the half the brain's own tests cannot: the route that stores a
 * named credential, the name rules, the save-time check (including the SSRF refusal), the
 * catalogue that turns the user's deployment names into models, and a turn that reaches the
 * endpoint through the real guard with an injected transport standing in for Azure.
 */

const ENDPOINT = 'https://my-resource.openai.azure.com'
const SECRET = 'az-key-do-not-log-me-4242'

const AZURE_BODY = {
  type: 'azure_openai' as const,
  endpoint: ENDPOINT,
  api_key: SECRET,
  deployments: ['gpt-4o', 'my-private-deployment'],
}

/** `PUT /v1/provider-credentials/{name}` as the default caller. */
async function put(test: TestContext, name: string, body: unknown): Promise<Response> {
  return test.request(`${API_VERSION_PREFIX}/provider-credentials/${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** `GET /v1/provider-credentials` as the default caller. */
async function list(test: TestContext): Promise<ListProviderCredentialsResponse> {
  const response = await test.request(`${API_VERSION_PREFIX}/provider-credentials`)
  expect(response.status).toBe(200)
  return (await response.json()) as ListProviderCredentialsResponse
}

/** A validator that accepts everything: what the route tests below use unless they assert on it. */
const acceptAny = (): Promise<void> => Promise.resolve()

/** A registry stub that knows Azure's `gpt-4o`, and nothing else. */
const azureRegistry: ModelRegistry = {
  models: (provider) =>
    provider === 'azure'
      ? [
          {
            id: 'gpt-4o',
            name: 'GPT-4o',
            contextWindow: 128_000,
            maxOutput: 16_384,
            cost: { input: 2.5, output: 10, cache_read: 1.25, cache_write: null },
          },
        ]
      : [],
}

/** A catalogue over the given credentials/registry, dialing nothing. */
function catalogue(
  credentials: InMemoryCredentialStore,
  vault: ReturnType<typeof createVault>,
  registry: ModelRegistry = azureRegistry,
): ModelCatalog {
  const fetch: ProviderFetch = () => Promise.reject(new Error('the azure path dials no provider'))
  return new ModelCatalog({ credentials, vault, registry, fetch })
}

describe('the azure credential API', () => {
  it('stores a named azure credential as metadata only, and lists it', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const response = await put(test, 'azure', AZURE_BODY)
    expect(response.status, await response.clone().text()).toBe(200)
    const created = (await response.json()) as ProviderCredential
    expect(created.type).toBe('azure_openai')
    expect(created.name).toBe('azure')
    expect(created.last4).toBe(SECRET.slice(-4))
    // The endpoint is not echoed: metadata is the id, the type, the name, last4 and times.
    expect(Object.keys(created).sort()).toEqual(
      ['created_at', 'id', 'last4', 'name', 'type', 'updated_at', 'validated_at'].sort(),
    )
    expect(JSON.stringify(created)).not.toContain(SECRET)
    expect(JSON.stringify(created)).not.toContain(ENDPOINT)
    expect(await list(test)).toEqual({ data: [created] })
  })

  it('keeps a second credential of the same type under its own name', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    await put(test, 'azure', AZURE_BODY)
    const second = await put(test, 'azure-eu', { ...AZURE_BODY, api_key: 'az-eu-key-9999' })
    expect(second.status).toBe(200)
    expect((await second.json()) as ProviderCredential).toMatchObject({
      name: 'azure-eu',
      last4: '9999',
    })

    const { data } = await list(test)
    expect(data.map((credential) => credential.name)).toEqual(['azure', 'azure-eu'])
    // Deleting one leaves the other: the rows are keyed by name, not by type.
    const deleted = await test.request(`${API_VERSION_PREFIX}/provider-credentials/azure-eu`, {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(204)
    expect((await list(test)).data.map((credential) => credential.name)).toEqual(['azure'])
  })

  it('refuses a name a fixed provider id already owns', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const response = await put(test, 'openai', AZURE_BODY)
    expect(response.status).toBe(400)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toContain('fixed provider id')
    expect((await list(test)).data).toEqual([])
  })

  it('refuses an api_key under a name that is not a provider id', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const response = await put(test, 'azure', { type: 'api_key', api_key: SECRET })
    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })

  it('refuses a name that is not a legal credential name', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    for (const name of ['Azure', 'azure_eu', 'azure-']) {
      const response = await put(test, name, AZURE_BODY)
      expect(response.status, name).toBe(400)
    }
    // Deleting is the same: the name is checked before the store is touched.
    const deleted = await test.request(`${API_VERSION_PREFIX}/provider-credentials/Azure`, {
      method: 'DELETE',
    })
    expect(deleted.status).toBe(400)
  })

  it('refuses an endpoint that is not https, and an empty deployment list', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const insecure = await put(test, 'azure', { ...AZURE_BODY, endpoint: 'http://x.azure.com' })
    expect(insecure.status).toBe(400)

    const none = await put(test, 'azure', { ...AZURE_BODY, deployments: [] })
    expect(none.status).toBe(400)
    expect((await list(test)).data).toEqual([])
  })

  it('answers 422 when the azure check refuses, and stores nothing', async () => {
    const seen: { name: string; type: string }[] = []
    const test = createTestApp({
      validateProviderCredential: (name, body) => {
        seen.push({ name, type: body.type })
        return Promise.reject(new Error('the deployment gpt-4o answered 401'))
      },
    })

    const response = await put(test, 'azure', AZURE_BODY)
    expect(response.status).toBe(422)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_provider_credential')
    expect(body.error.message).toContain('azure')
    expect(body.error.message).not.toContain(SECRET)
    expect(seen).toEqual([{ name: 'azure', type: 'azure_openai' }])
    expect((await list(test)).data).toEqual([])
  })

  it('never puts the endpoint or the key in a response or a log line', async () => {
    const lines: string[] = []
    const test = createTestApp({
      validateProviderCredential: acceptAny,
      logger: {
        debug: (m) => lines.push(m),
        info: (m) => lines.push(m),
        warn: (m) => lines.push(m),
        error: (m) => lines.push(m),
      },
    })
    const putResponse = await put(test, 'azure', AZURE_BODY)
    const listResponse = await test.request(`${API_VERSION_PREFIX}/provider-credentials`)
    for (const response of [putResponse, listResponse]) {
      const text = await response.clone().text()
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('my-resource.openai.azure.com')
    }
    expect(lines.join('\n')).not.toContain(SECRET)
  })
})

describe('the azure save-time check', () => {
  it('calls the first deployment through safeFetch, with the key and the endpoint', async () => {
    const requests: { url: string; headers: Record<string, string>; body: unknown }[] = []
    const validator = createProviderCredentialValidator({
      safeFetch: (url, init) => {
        requests.push({
          url,
          headers: { ...((init?.headers ?? {}) as Record<string, string>) },
          body: JSON.parse(init?.body as string),
        })
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    })

    await validator('azure', AZURE_BODY)

    expect(requests).toHaveLength(1)
    const [request] = requests
    expect(request?.url).toBe(`${ENDPOINT}/openai/v1/chat/completions?api-version=v1`)
    expect(request?.headers['api-key']).toBe(SECRET)
    expect(request?.body).toMatchObject({ max_completion_tokens: 1, stream: false })
  })

  it('refuses a credential Azure rejects, naming the deployment and the status', async () => {
    const validator = createProviderCredentialValidator({
      safeFetch: () => Promise.resolve(new Response('unauthorized', { status: 401 })),
    })

    await expect(validator('azure', AZURE_BODY)).rejects.toThrow(/gpt-4o.*401/s)
    await expect(validator('azure', AZURE_BODY)).rejects.not.toThrow(SECRET)
  })

  it('refuses a private endpoint through the real guard, before any request is made', async () => {
    // The real safeFetch: an endpoint that resolves inside the network is refused here, which
    // is what stops such an endpoint from ever being stored and later reached by a model call.
    const validator = createProviderCredentialValidator()
    for (const endpoint of [
      'https://127.0.0.1',
      'https://localhost',
      'https://169.254.169.254',
      'https://metadata.google.internal',
    ]) {
      await expect(validator('azure', { ...AZURE_BODY, endpoint }), endpoint).rejects.toThrow(
        /could not reach azure/,
      )
    }
  })

  it('still validates an api_key with the provider list call', async () => {
    const calls: string[] = []
    const validator = createProviderCredentialValidator({
      providerFetch: (url) => {
        calls.push(url)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({} as unknown),
          text: () => Promise.resolve('{}'),
        })
      },
    })

    await validator('openai', { type: 'api_key', api_key: 'sk-live' })
    expect(calls).toEqual(['https://api.openai.com/v1/models'])
  })
})

describe('the catalogue over azure credentials', () => {
  async function withAzure(): Promise<{ test: TestContext; credentials: InMemoryCredentialStore }> {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      credentials,
      vault,
      catalog: catalogue(credentials, vault),
      validateProviderCredential: acceptAny,
    })
    await put(test, 'azure', AZURE_BODY)
    return { test, credentials }
  }

  it('contributes one model per deployment, with the registry’s metadata where it knows it', async () => {
    const { test } = await withAzure()
    const response = await test.request(`${API_VERSION_PREFIX}/models`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as ListModelsResponse

    expect(body.data.map((entry) => entry.id)).toEqual([
      'azure/gpt-4o',
      'azure/my-private-deployment',
    ])
    expect(body.data[0]).toMatchObject({
      provider: 'azure',
      name: 'GPT-4o',
      context_window: 128_000,
      max_output_tokens: 16_384,
      // The registry prices Azure the way it prices every provider (#247), so a deployment it
      // knows carries a cost and a client can show what a turn spent.
      cost: { input: 2.5, output: 10, cache_read: 1.25 },
    })
    // A deployment models.dev does not know gets no window rather than a guessed one.
    expect(body.data[1]).toMatchObject({
      provider: 'azure',
      name: 'my-private-deployment',
      context_window: null,
      max_output_tokens: null,
      // A deployment models.dev does not know has no rate either: `null` is "not priced",
      // which a client shows as `—` rather than inventing a number.
      cost: null,
    })
    // The status is `ok` — the credential was read — not a fallback.
    const [status] = body.providers
    expect(status).toMatchObject({ provider: 'azure', status: 'ok', message: null })
    expect(typeof status?.fetched_at).toBe('string')
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it('lists a second credential’s models under its own name', async () => {
    const { test } = await withAzure()
    await put(test, 'azure-eu', { ...AZURE_BODY, deployments: ['gpt-4o'] })

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    // Sorted by provider then name, so the `azure` credential's entries come first.
    expect(body.data.map((entry) => entry.id)).toEqual([
      'azure/gpt-4o',
      'azure/my-private-deployment',
      'azure-eu/gpt-4o',
    ])
  })

  it('lists nothing for a credential whose row cannot be opened', async () => {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      credentials,
      vault,
      catalog: catalogue(credentials, vault),
      validateProviderCredential: acceptAny,
    })
    const user = await test.currentUser()
    await credentials.upsert({
      userId: user.id,
      name: 'azure',
      type: 'azure_openai',
      sealed: {
        ciphertext: 'not-a-real-blob',
        nonce: 'n',
        wrappedKey: 'w',
        kekVersion: 'v1',
      },
      last4: '9999',
      validatedAt: new Date().toISOString(),
    })

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data).toEqual([])
    expect(body.providers[0]).toMatchObject({ provider: 'azure', status: 'fallback' })
    expect(body.providers[0]?.message).toContain('could not be opened')
  })
})

describe('a turn through the azure guard', () => {
  it('streams the reply the endpoint sent, over safeFetch', async () => {
    const requests: string[] = []
    const safeFetch: SafeFetch = (input) => {
      requests.push(String(input))
      return Promise.resolve(
        new Response(chatCompletionSse('Hello from Azure'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      )
    }

    const store = new InMemorySessionStore()
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      store,
      credentials,
      vault,
      validateProviderCredential: acceptAny,
      resolveCredential: createSessionCredentialResolver({ store, credentials, vault }),
      model: createProviderModelFactory({ azureFetch: createAzureFetch({ safeFetch }) }),
    })

    await put(test, 'azure', AZURE_BODY)
    const agent = await httpCreateAgent(test, { model: { id: 'azure/gpt-4o' } })
    const session = await httpCreateSession(test, agent.id)
    const sent = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello azure' }] }],
      }),
    })
    expect(sent.status).toBe(200)
    await waitForIdle(store, session.id)

    const history = await readHistory(store, session.id)
    const reply = history.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(reply?.content).toEqual([{ type: 'text', text: 'Hello from Azure' }])
    expect(requests).toEqual([`${ENDPOINT}/openai/v1/chat/completions?api-version=v1`])
  })

  it('refuses a model id whose credential nobody stored', async () => {
    const store = new InMemorySessionStore()
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      store,
      credentials,
      vault,
      validateProviderCredential: acceptAny,
      resolveCredential: createSessionCredentialResolver({ store, credentials, vault }),
    })

    const agent = await httpCreateAgent(test, { model: { id: 'azure/gpt-4o' } })
    const session = await httpCreateSession(test, agent.id)
    await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
      }),
    })
    await waitForIdle(store, session.id)

    const history = await readHistory(store, session.id)
    const error = history.find((event) => event.type === EVENT_TYPES.sessionError)
    expect(error?.error.type).toBe('missing_provider_credential')
    expect(error?.error.message).toContain('Azure')
  })
})

/** A minimal OpenAI chat-completions SSE body: one chunk of text, then the stop. */
function chatCompletionSse(text: string): string {
  const chunk = (delta: unknown, finish: string | null, usage?: unknown): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-4o',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`
  return (
    chunk({ role: 'assistant', content: text }, null) +
    chunk({}, 'stop', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }) +
    'data: [DONE]\n\n'
  )
}

/** A credential the type says is azure: what the resolver must answer for `azure/<deployment>`. */
const AZURE_CREDENTIAL: ModelCredential = {
  type: 'azure_openai',
  apiKey: SECRET,
  endpoint: ENDPOINT,
}

describe('the resolver answers a named credential', () => {
  it('opens the azure row into the credential the factory needs', async () => {
    const store = new InMemorySessionStore()
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      store,
      credentials,
      vault,
      validateProviderCredential: acceptAny,
    })
    const user = await test.currentUser()
    await put(test, 'azure', AZURE_BODY)

    const agent = await store.createAgent({ name: 'A', model: { id: 'azure/gpt-4o' } }, user.id)
    const session = await store.createSession(agent.id, { ownerId: user.id })
    const resolver = createSessionCredentialResolver({ store, credentials, vault })

    await expect(resolver(session.id, 'azure')).resolves.toEqual(AZURE_CREDENTIAL)
    await expect(resolver(session.id, 'azure-eu')).resolves.toBeNull()
  })
})
