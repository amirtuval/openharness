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
  createOpenAICompatibleFetch,
  createProviderModelFactory,
  type ModelCredential,
  type SafeFetch,
} from '@openharness/brain'

import { createSessionCredentialResolver } from './credentials'
import { ModelCatalog } from './catalog/catalog'
import type { ModelRegistry, RegistryModel } from './catalog/registry'
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
 * Custom OpenAI-compatible credentials, end to end (epic #245, A3b).
 *
 * What this suite covers is the half the brain's own tests cannot: the route that stores a
 * named credential and the public `details` it publishes, the name and URL rules, the
 * save-time check through the real guard (including the private-address refusal and the
 * self-host flag that lifts it for this type alone), the catalogue that lists the endpoint's
 * own models, and a turn that reaches the endpoint through the guard with an injected
 * transport standing in for it.
 */

const BASE_URL = 'https://api.example.com/v1'
const SECRET = 'sk-custom-do-not-log-me-4242'

const CUSTOM_BODY = {
  type: 'openai_compatible' as const,
  base_url: BASE_URL,
  api_key: SECRET,
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

/** The models one custom endpoint's `/models` answers with: one known id, one unknown. */
const ENDPOINT_MODELS = {
  object: 'list',
  data: [{ id: 'gpt-4o' }, { id: 'llama-3.3-70b-versatile' }, { id: 'text-embedding-3-small' }],
}

/**
 * A registry stub that knows `llama-3.3-70b-versatile` under one provider, and `gpt-4o` under
 * two — the ambiguous case a custom credential must not borrow from (#249).
 */
const exactRegistry: ModelRegistry = {
  models: () => [],
  exact: (id): readonly RegistryModel[] => {
    if (id === 'llama-3.3-70b-versatile') {
      return [
        {
          id,
          name: 'Llama 3.3 70B',
          contextWindow: 131_072,
          maxOutput: 32_768,
          cost: { input: 0.59, output: 0.79, cache_read: null, cache_write: null },
        },
      ]
    }
    if (id === 'gpt-4o') {
      return [
        { id, name: 'GPT-4o' },
        { id, name: 'GPT-4o (azure)' },
      ]
    }
    return []
  },
}

/** A `safeFetch` that answers one endpoint's `/models` and records the calls it saw. */
function modelsFetch(
  calls: { url: string; headers: Record<string, string> }[],
  body: unknown = ENDPOINT_MODELS,
): SafeFetch {
  return (input, init) => {
    calls.push({
      url: String(input),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }
}

/** A catalogue over the given credentials/registry/guard, dialing no fixed provider. */
function catalogue(
  credentials: InMemoryCredentialStore,
  vault: ReturnType<typeof createVault>,
  safeFetch?: SafeFetch,
  registry: ModelRegistry = exactRegistry,
  allowPrivateProviderUrls = false,
): ModelCatalog {
  const fetch: ProviderFetch = () => Promise.reject(new Error('the custom path dials no provider'))
  return new ModelCatalog({
    credentials,
    vault,
    registry,
    fetch,
    allowPrivateProviderUrls,
    ...(safeFetch === undefined ? {} : { safeFetch }),
  })
}

describe('the openai_compatible credential API', () => {
  it('stores a custom credential with its public details, and lists it', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const response = await put(test, 'custom', CUSTOM_BODY)
    expect(response.status, await response.clone().text()).toBe(200)
    const created = (await response.json()) as ProviderCredential
    expect(created.type).toBe('openai_compatible')
    expect(created.name).toBe('custom')
    expect(created.last4).toBe(SECRET.slice(-4))
    // The public field the settings list shows: the host, never the whole URL.
    expect(created.details).toEqual({ base_url_host: 'api.example.com' })
    expect(JSON.stringify(created)).not.toContain(SECRET)
    expect(JSON.stringify(created)).not.toContain('/v1')
    expect(await list(test)).toEqual({ data: [created] })
  })

  it('keeps a keyless custom credential, with an empty last4 and no secret anywhere', async () => {
    // A local server may take no key at all; the credential is stored, and its last4 is empty.
    const test = createTestApp({ validateProviderCredential: acceptAny })
    const response = await put(test, 'custom', {
      type: 'openai_compatible',
      base_url: 'http://127.0.0.1:11434/v1',
    })
    expect(response.status, await response.clone().text()).toBe(200)
    const created = (await response.json()) as ProviderCredential
    expect(created.last4).toBe('')
    expect(created.details).toEqual({ base_url_host: '127.0.0.1:11434' })
    expect(JSON.stringify(created)).not.toContain('11434/v1')
  })

  it('keeps a second credential of the type under its own name', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    await put(test, 'custom', CUSTOM_BODY)
    const second = await put(test, 'my-local', {
      type: 'openai_compatible',
      base_url: 'http://127.0.0.1:11434/v1',
      api_key: 'local-9999',
    })
    expect(second.status).toBe(200)
    expect((await second.json()) as ProviderCredential).toMatchObject({
      name: 'my-local',
      last4: '9999',
    })

    const { data } = await list(test)
    expect(data.map((credential) => credential.name)).toEqual(['custom', 'my-local'])
  })

  it('refuses a name a fixed provider id already owns, and an api_key under a named one', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const reserved = await put(test, 'openai', CUSTOM_BODY)
    expect(reserved.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await reserved.json()).error.type).toBe('invalid_request_error')

    const apiKeyUnderName = await put(test, 'custom', { type: 'api_key', api_key: SECRET })
    expect(apiKeyUnderName.status).toBe(400)
    expect((await list(test)).data).toEqual([])
  })

  it('refuses a name that is not a legal credential name', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    for (const name of ['Custom', 'my_local', 'my-']) {
      const response = await put(test, name, CUSTOM_BODY)
      expect(response.status, name).toBe(400)
    }
  })

  it('refuses a base URL that is not an absolute http(s) URL', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    for (const base_url of ['api.example.com/v1', 'ftp://api.example.com/v1', '']) {
      const response = await put(test, 'custom', { ...CUSTOM_BODY, base_url })
      expect(response.status, base_url).toBe(400)
    }
    expect((await list(test)).data).toEqual([])
  })

  it('answers 422 when the custom check refuses, and stores nothing', async () => {
    const seen: { name: string; type: string }[] = []
    const test = createTestApp({
      validateProviderCredential: (name, body) => {
        seen.push({ name, type: body.type })
        return Promise.reject(new Error('the endpoint api.example.com answered 401'))
      },
    })

    const response = await put(test, 'custom', CUSTOM_BODY)
    expect(response.status).toBe(422)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_provider_credential')
    expect(body.error.message).toContain('custom')
    expect(body.error.message).not.toContain(SECRET)
    expect(seen).toEqual([{ name: 'custom', type: 'openai_compatible' }])
    expect((await list(test)).data).toEqual([])
  })

  it('never puts the key or a full URL in a response or a log line', async () => {
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
    const putResponse = await put(test, 'custom', CUSTOM_BODY)
    const listResponse = await test.request(`${API_VERSION_PREFIX}/provider-credentials`)
    for (const response of [putResponse, listResponse]) {
      const text = await response.clone().text()
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain('api.example.com/v1')
    }
    expect(lines.join('\n')).not.toContain(SECRET)
  })
})

describe('the custom save-time check', () => {
  it('lists the endpoint’s models through safeFetch, with the key as a bearer token', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const validator = createProviderCredentialValidator({
      safeFetch: (url, init) => {
        calls.push({
          url,
          headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        })
        return Promise.resolve(new Response('{"data":[]}', { status: 200 }))
      },
    })

    await validator('custom', CUSTOM_BODY)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE_URL}/models`)
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${SECRET}`)
  })

  it('asks a keyless endpoint with no authorization header', async () => {
    const headers: Record<string, string>[] = []
    const validator = createProviderCredentialValidator({
      safeFetch: (_url, init) => {
        headers.push({ ...((init?.headers ?? {}) as Record<string, string>) })
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
    })

    await validator('custom', { type: 'openai_compatible', base_url: BASE_URL })
    expect(headers[0]?.['authorization']).toBeUndefined()
  })

  it('refuses an endpoint the server answers non-2xx for, naming the host and the status', async () => {
    const validator = createProviderCredentialValidator({
      safeFetch: () => Promise.resolve(new Response('nope', { status: 401 })),
    })

    await expect(validator('custom', CUSTOM_BODY)).rejects.toThrow(/api\.example\.com.*401/s)
    await expect(validator('custom', CUSTOM_BODY)).rejects.not.toThrow(SECRET)
  })

  it('carries the self-host flag to the guard, only for this type', async () => {
    const options: unknown[] = []
    const safeFetch = (_url: string, _init?: RequestInit, opts?: unknown) => {
      options.push(opts)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    await createProviderCredentialValidator({ safeFetch, allowPrivateProviderUrls: true })(
      'custom',
      CUSTOM_BODY,
    )
    // Azure never reads the flag: its call passes the tight preset alone.
    await createProviderCredentialValidator({ safeFetch, allowPrivateProviderUrls: true })(
      'azure',
      {
        type: 'azure_openai',
        endpoint: 'https://x.openai.azure.com',
        api_key: SECRET,
        deployments: ['gpt-4o'],
      },
    )
    expect(options[0]).toMatchObject({ allowPrivate: true })
    expect(options[1]).not.toHaveProperty('allowPrivate')
  })

  it('refuses a private endpoint through the real guard, before any request is made', async () => {
    // The real safeFetch: an endpoint that resolves inside the network is refused here, so it
    // can never be stored and later reached from the model path.
    const validator = createProviderCredentialValidator()
    for (const base_url of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/v1',
      'http://169.254.169.254/v1',
      'http://metadata.google.internal/v1',
    ]) {
      await expect(
        validator('custom', { type: 'openai_compatible', base_url }),
        base_url,
      ).rejects.toThrow(/could not reach custom/)
    }
  })

  it('allows a loopback endpoint when the self-host flag is on', async () => {
    // The flag lifts the address refusal for this type only: with it on, the guard proceeds to
    // the connection — which here fails, since nothing listens — instead of refusing the
    // address, so the error is a reach failure and never "not a public address".
    const validator = createProviderCredentialValidator({ allowPrivateProviderUrls: true })
    const error = await validator('custom', {
      type: 'openai_compatible',
      base_url: 'http://127.0.0.1:1/v1',
    }).catch((thrown: unknown) => thrown as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/could not reach custom/)
    expect((error as Error).message).not.toMatch(/not a public address/)
  })
})

describe('the catalogue over custom credentials', () => {
  async function withCustom(
    safeFetch?: SafeFetch,
    options: { allowPrivateProviderUrls?: boolean } = {},
  ): Promise<{ test: TestContext; calls: { url: string; headers: Record<string, string> }[] }> {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const calls: { url: string; headers: Record<string, string> }[] = []
    const guard = safeFetch ?? modelsFetch(calls)
    const test = createTestApp({
      credentials,
      vault,
      catalog: catalogue(
        credentials,
        vault,
        guard,
        exactRegistry,
        options.allowPrivateProviderUrls === true,
      ),
      validateProviderCredential: acceptAny,
    })
    await put(test, 'custom', CUSTOM_BODY)
    return { test, calls }
  }

  it('contributes the endpoint’s own models, borrowing metadata only on an exact match', async () => {
    const { test, calls } = await withCustom()
    const response = await test.request(`${API_VERSION_PREFIX}/models`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as ListModelsResponse

    // `text-embedding-3-small` is filtered out; the other two remain, sorted by name.
    expect(body.data.map((entry) => entry.id)).toEqual([
      'custom/gpt-4o',
      'custom/llama-3.3-70b-versatile',
    ])
    const llama = body.data.find((entry) => entry.id === 'custom/llama-3.3-70b-versatile')
    // `llama-3.3-70b-versatile` matches exactly one registry model, so its metadata is borrowed.
    expect(llama).toMatchObject({
      name: 'Llama 3.3 70B',
      context_window: 131_072,
      max_output_tokens: 32_768,
      cost: { input: 0.59, output: 0.79, cache_read: null },
    })
    // `gpt-4o` is filed under two providers, so nothing is borrowed: no window, no price.
    const gpt = body.data.find((entry) => entry.id === 'custom/gpt-4o')
    expect(gpt).toMatchObject({
      name: 'gpt-4o',
      context_window: null,
      max_output_tokens: null,
      cost: null,
    })

    // The listing went to the endpoint's `/models`, through the guard.
    expect(calls.map((call) => call.url)).toEqual([`${BASE_URL}/models`])
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${SECRET}`)
    expect(JSON.stringify(body)).not.toContain(SECRET)
  })

  it('lists a second credential’s models under its own name', async () => {
    const { test } = await withCustom()
    await put(test, 'my-local', { type: 'openai_compatible', base_url: 'http://127.0.0.1:9/v1' })

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data.map((entry) => entry.id)).toEqual([
      'custom/gpt-4o',
      'custom/llama-3.3-70b-versatile',
      'my-local/gpt-4o',
      'my-local/llama-3.3-70b-versatile',
    ])
  })

  it('falls back to no models when the endpoint cannot be listed, with the reason', async () => {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      credentials,
      vault,
      catalog: catalogue(credentials, vault, () =>
        Promise.reject(new Error('connect ECONNREFUSED')),
      ),
      validateProviderCredential: acceptAny,
    })
    await put(test, 'custom', CUSTOM_BODY)

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data).toEqual([])
    expect(body.providers[0]).toMatchObject({ provider: 'custom', status: 'fallback' })
    expect(body.providers[0]?.message).toContain('custom')
  })

  it('refuses a private endpoint’s listing when the flag is off, and lists it when on', async () => {
    const baseUrl = 'http://127.0.0.1:11434/v1'
    // Off (the default): the real guard refuses before anything is dialed, so the status is
    // `fallback` and the message is the address refusal.
    const offCredentials = new InMemoryCredentialStore()
    const offVault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const off = createTestApp({
      credentials: offCredentials,
      vault: offVault,
      catalog: catalogue(offCredentials, offVault),
      validateProviderCredential: acceptAny,
    })
    await put(off, 'custom', { type: 'openai_compatible', base_url: baseUrl })
    const refused = (await (
      await off.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(refused.data).toEqual([])
    expect(refused.providers[0]?.status).toBe('fallback')
    expect(refused.providers[0]?.message).toMatch(/not a public address/)

    // On: the same catalogue, with the flag, lists the endpoint through the guard's stub.
    const calls: { url: string; headers: Record<string, string> }[] = []
    const onCredentials = new InMemoryCredentialStore()
    const onVault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const on = createTestApp({
      credentials: onCredentials,
      vault: onVault,
      catalog: catalogue(onCredentials, onVault, modelsFetch(calls), exactRegistry, true),
      validateProviderCredential: acceptAny,
    })
    await put(on, 'custom', { type: 'openai_compatible', base_url: baseUrl })
    const listed = (await (
      await on.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(listed.data.map((entry) => entry.id)).toEqual([
      'custom/gpt-4o',
      'custom/llama-3.3-70b-versatile',
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
      name: 'custom',
      type: 'openai_compatible',
      sealed: { ciphertext: 'not-a-real-blob', nonce: 'n', wrappedKey: 'w', kekVersion: 'v1' },
      last4: '9999',
      validatedAt: new Date().toISOString(),
    })

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data).toEqual([])
    expect(body.providers[0]).toMatchObject({ provider: 'custom', status: 'fallback' })
    expect(body.providers[0]?.message).toContain('could not be opened')
  })
})

describe('a turn through the custom guard', () => {
  it('streams the reply the endpoint sent, over safeFetch, with no fixed provider dialed', async () => {
    const requests: string[] = []
    const safeFetch: SafeFetch = (input) => {
      requests.push(String(input))
      return Promise.resolve(
        new Response(chatCompletionSse('Hello from a custom endpoint'), {
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
      model: createProviderModelFactory({
        openAICompatibleFetch: createOpenAICompatibleFetch({ safeFetch }),
      }),
    })

    await put(test, 'custom', CUSTOM_BODY)
    const agent = await httpCreateAgent(test, { model: { id: 'custom/llama3.3' } })
    const session = await httpCreateSession(test, agent.id)
    const sent = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello custom' }] }],
      }),
    })
    expect(sent.status).toBe(200)
    await waitForIdle(store, session.id)

    const history = await readHistory(store, session.id)
    const reply = history.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(reply?.content).toEqual([{ type: 'text', text: 'Hello from a custom endpoint' }])
    expect(requests).toEqual([`${BASE_URL}/chat/completions`])
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

    const agent = await httpCreateAgent(test, { model: { id: 'custom/llama3.3' } })
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
    expect(error?.error.message).toContain('Custom (OpenAI-compatible)')
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

/** A credential the type says is custom: what the resolver must answer for `custom/<model>`. */
const CUSTOM_CREDENTIAL: ModelCredential = {
  type: 'openai_compatible',
  apiKey: SECRET,
  baseUrl: BASE_URL,
}

describe('the resolver answers a custom credential', () => {
  it('opens the custom row into the credential the factory needs', async () => {
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
    await put(test, 'custom', CUSTOM_BODY)

    const agent = await store.createAgent({ name: 'A', model: { id: 'custom/llama3.3' } }, user.id)
    const session = await store.createSession(agent.id, { ownerId: user.id })
    const resolver = createSessionCredentialResolver({ store, credentials, vault })

    await expect(resolver(session.id, 'custom')).resolves.toEqual(CUSTOM_CREDENTIAL)
    await expect(resolver(session.id, 'my-local')).resolves.toBeNull()
  })

  it('answers a keyless credential with an empty key', async () => {
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
    await put(test, 'custom', { type: 'openai_compatible', base_url: 'http://127.0.0.1:11434/v1' })

    const agent = await store.createAgent({ name: 'A', model: { id: 'custom/x' } }, user.id)
    const session = await store.createSession(agent.id, { ownerId: user.id })
    const resolver = createSessionCredentialResolver({ store, credentials, vault })

    await expect(resolver(session.id, 'custom')).resolves.toEqual({
      type: 'openai_compatible',
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })
  })
})
