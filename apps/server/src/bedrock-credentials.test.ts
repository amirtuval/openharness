import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type ListModelsResponse,
  type ListProviderCredentialsResponse,
  type BedrockRegion,
  type ProviderCredential,
} from '@openharness/protocol'
import { InMemoryCredentialStore, InMemorySessionStore } from '@openharness/session'
import { createVault, envKeyProvider } from '@openharness/vault'
import { createProviderModelFactory, type ModelCredential } from '@openharness/brain'

import { createSessionCredentialResolver } from './credentials'
import { ModelCatalog } from './catalog/catalog'
import type { ModelRegistry } from './catalog/registry'
import type { ProviderFetch } from './catalog/provider-fetch'
import { createProviderCredentialValidator } from './provider-validation'
import { bedrockEventStream, bedrockReplyEvents } from './test-support/bedrock-stream'
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
 * Amazon Bedrock credentials, end to end (epic #245, A3c).
 *
 * What this suite covers is the half the brain's tests cannot: the route that stores a named
 * Bedrock credential and the region it reports, the name rules, the save-time `ListFoundationModels`
 * check signed with the user's keys, the catalogue that turns the region's model summaries into
 * models, and a whole turn that reaches `bedrock-runtime.<region>.amazonaws.com` through the
 * real factory and streams the reply an AWS event stream carries.
 *
 * No test reaches AWS: the validator and the catalogue are given a `ProviderFetch` that answers
 * with a recorded payload, and the turn stubs the global `fetch` the provider package uses. The
 * real-account check — that AWS accepts a real key and lists that region's models — is the
 * maintainer's to make, and is the one thing here that is mocked rather than proven.
 */

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const SESSION_TOKEN = 'FwoGZXIvYXdzEBYaDEXAMPLEtoken'
const REGION: BedrockRegion = 'eu-west-1'
const BEDROCK_MODEL = 'anthropic.claude-3-5-haiku-20241022-v1:0'

const BEDROCK_BODY = {
  type: 'bedrock' as const,
  access_key_id: ACCESS_KEY_ID,
  secret_access_key: SECRET_ACCESS_KEY,
  region: REGION,
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

/** A validator that accepts everything: what the route tests use unless they assert on it. */
const acceptAny = (): Promise<void> => Promise.resolve()

/** The `ListFoundationModels` payload one region answers with, as a test reads it back. */
const FOUNDATION_MODELS = {
  modelSummaries: [
    {
      modelId: BEDROCK_MODEL,
      modelName: 'Claude 3.5 Haiku',
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['ON_DEMAND'],
      modelLifecycle: { status: 'ACTIVE' },
    },
    {
      // Only callable through a cross-region inference profile: the bare id would fail, so it
      // is not offered.
      modelId: 'anthropic.claude-opus-4-7',
      modelName: 'Claude Opus 4.7',
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['INFERENCE_PROFILE'],
    },
    {
      // AWS has retired it.
      modelId: 'anthropic.claude-2.1-v1:0',
      modelName: 'Claude 2.1',
      outputModalities: ['TEXT'],
      inferenceTypesSupported: ['ON_DEMAND'],
      modelLifecycle: { status: 'LEGACY' },
    },
    {
      // An embeddings model: AWS's own filter is asked for text output, and the catalogue's
      // name filter would drop it anyway.
      modelId: 'cohere.embed-english-v3',
      modelName: 'Embed English',
      outputModalities: ['EMBEDDING'],
      inferenceTypesSupported: ['ON_DEMAND'],
    },
    {
      // A model AWS names but with no id: skipped rather than guessed at.
      modelName: 'Nameless',
      outputModalities: ['TEXT'],
    },
  ],
}

/** A `ProviderFetch` that answers one recorded payload, and records what it was called with. */
function recordingFetch(payload: unknown, status = 200): ProviderFetch & { calls: string[] } {
  const calls: string[] = []
  const fetch: ProviderFetch = (url) => {
    calls.push(url)
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    })
  }
  return Object.assign(fetch, { calls })
}

/** A registry stub that knows a couple of Bedrock models, filed under models.dev's key. */
const bedrockRegistry: ModelRegistry = {
  models: (provider) =>
    provider === 'amazon-bedrock'
      ? [
          {
            id: BEDROCK_MODEL,
            name: 'Claude 3.5 Haiku',
            contextWindow: 200_000,
            maxOutput: 8_192,
            cost: { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
          },
          {
            // A model the region does not offer on demand, and one AWS did not list.
            id: 'anthropic.claude-opus-4-7',
            name: 'Claude Opus 4.7',
            contextWindow: 500_000,
            maxOutput: 32_000,
          },
        ]
      : [],
}

/** A catalogue over the given credentials/registry/fetch, dialing nothing else. */
function catalogue(
  credentials: InMemoryCredentialStore,
  vault: ReturnType<typeof createVault>,
  fetch: ProviderFetch,
  registry: ModelRegistry = bedrockRegistry,
): ModelCatalog {
  return new ModelCatalog({ credentials, vault, registry, fetch })
}

describe('the bedrock credential API', () => {
  it('stores a named bedrock credential as metadata only, with its region and last4', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const response = await put(test, 'bedrock', BEDROCK_BODY)
    expect(response.status, await response.clone().text()).toBe(200)
    const created = (await response.json()) as ProviderCredential
    expect(created).toMatchObject({
      type: 'bedrock',
      name: 'bedrock',
      // The access key ID is the half a reader recognises, and it is the one last4 is drawn
      // from — never the secret access key or the session token.
      last4: ACCESS_KEY_ID.slice(-4),
      details: { region: REGION },
    })
    // Metadata only: no key, no secret, no token, anywhere in the response.
    const text = JSON.stringify(created)
    for (const secret of [SECRET_ACCESS_KEY, SESSION_TOKEN]) {
      expect(text).not.toContain(secret)
    }
    expect(text).not.toContain(ACCESS_KEY_ID)
    expect(await list(test)).toEqual({ data: [created] })
  })

  it('keeps a second bedrock credential — another region — under its own name', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    await put(test, 'bedrock', BEDROCK_BODY)
    const second = await put(test, 'bedrock-us', {
      ...BEDROCK_BODY,
      region: 'us-east-2',
      access_key_id: 'AKIAIOSFODNN7EXAMPL2',
    })
    expect(second.status).toBe(200)
    expect((await second.json()) as ProviderCredential).toMatchObject({
      name: 'bedrock-us',
      last4: 'MPL2',
      details: { region: 'us-east-2' },
    })

    const { data } = await list(test)
    expect(data.map((credential) => credential.name)).toEqual(['bedrock', 'bedrock-us'])
    expect(
      data.map((credential) =>
        credential.type === 'bedrock' ? credential.details?.region : undefined,
      ),
    ).toEqual(['eu-west-1', 'us-east-2'])
  })

  it('refuses a region AWS does not serve Bedrock in, and a missing key', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    for (const region of ['us-east-3', 'eu-west-4', 'evil.example', 'us-gov-west-1', 'US-EAST-1']) {
      const response = await put(test, 'bedrock', { ...BEDROCK_BODY, region })
      expect(response.status, region).toBe(400)
      expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe(
        'invalid_request_error',
      )
    }
    for (const body of [
      { ...BEDROCK_BODY, access_key_id: '' },
      { ...BEDROCK_BODY, secret_access_key: '' },
      { ...BEDROCK_BODY, session_token: '' },
    ]) {
      expect((await put(test, 'bedrock', body)).status).toBe(400)
    }
    expect((await list(test)).data).toEqual([])
  })

  it('refuses a name a fixed provider id owns, and an api_key under a named one', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const reserved = await put(test, 'openai', BEDROCK_BODY)
    expect(reserved.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await reserved.json()).error.message).toContain(
      'fixed provider id',
    )

    const unnamed = await put(test, 'bedrock', { type: 'api_key', api_key: SECRET_ACCESS_KEY })
    expect(unnamed.status).toBe(400)
    expect((await list(test)).data).toEqual([])
  })

  it('answers 422 when AWS refuses the credentials, and stores nothing', async () => {
    const seen: { name: string; type: string }[] = []
    const test = createTestApp({
      validateProviderCredential: (name, body) => {
        seen.push({ name, type: body.type })
        return Promise.reject(
          new Error(
            'Bedrock in eu-west-1 answered 403 for ListFoundationModels: ' +
              'The security token included in the request is invalid.',
          ),
        )
      },
    })

    const response = await put(test, 'bedrock', BEDROCK_BODY)
    expect(response.status).toBe(422)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_provider_credential')
    expect(body.error.message).toContain('The security token included in the request is invalid')
    expect(body.error.message).not.toContain(SECRET_ACCESS_KEY)
    expect(seen).toEqual([{ name: 'bedrock', type: 'bedrock' }])
    expect((await list(test)).data).toEqual([])
  })

  it('never puts a key, a secret or a token in a response or a log line', async () => {
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
    const withToken = { ...BEDROCK_BODY, session_token: SESSION_TOKEN }
    const putResponse = await put(test, 'bedrock', withToken)
    const listResponse = await test.request(`${API_VERSION_PREFIX}/provider-credentials`)
    for (const response of [putResponse, listResponse]) {
      const text = await response.clone().text()
      for (const secret of [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN]) {
        expect(text).not.toContain(secret)
      }
    }
    const logged = lines.join('\n')
    for (const secret of [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN]) {
      expect(logged).not.toContain(secret)
    }
  })
})

describe('the bedrock save-time check', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reads ListFoundationModels in the region, signed with the stored keys', async () => {
    const fetch = recordingFetch(FOUNDATION_MODELS)
    const validator = createProviderCredentialValidator({ providerFetch: fetch })

    await validator('bedrock', BEDROCK_BODY)

    expect(fetch.calls).toHaveLength(1)
    const url = new URL(fetch.calls[0] as string)
    expect(url.host).toBe('bedrock.eu-west-1.amazonaws.com')
    expect(url.pathname).toBe('/foundation-models')
    expect(url.searchParams.get('byOutputModality')).toBe('TEXT')
    expect(url.searchParams.get('byInferenceType')).toBe('ON_DEMAND')
  })

  it('signs with the stored keys even with every AWS variable set to a decoy', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIADECOYENVIRONMENT')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'decoy-environment-secret')
    vi.stubEnv('AWS_SESSION_TOKEN', 'decoy-environment-session-token')
    vi.stubEnv('AWS_REGION', 'ap-south-1')
    vi.stubEnv('AWS_PROFILE', 'decoy-profile')
    vi.stubEnv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'https://decoy-endpoint.example')

    const seen: { url: string; headers: Record<string, string> }[] = []
    const validator = createProviderCredentialValidator({
      providerFetch: (url, init) => {
        seen.push({ url, headers: { ...init.headers } })
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('{}'),
        })
      },
    })

    await validator('bedrock', { ...BEDROCK_BODY, session_token: SESSION_TOKEN })

    const [request] = seen
    expect(new URL(request?.url as string).host).toBe('bedrock.eu-west-1.amazonaws.com')
    const authorization = request?.headers.authorization ?? ''
    expect(authorization).toContain(`Credential=${ACCESS_KEY_ID}/`)
    expect(authorization).toContain('/eu-west-1/bedrock/aws4_request')
    // The stored session token, not the decoy one, and no decoy anywhere else in the request.
    expect(request?.headers['x-amz-security-token']).toBe(SESSION_TOKEN)
    expect(JSON.stringify(request)).not.toContain('decoy')
  })

  it('answers with AWS’s own reason, scrubbed, when AWS refuses', async () => {
    const validator = createProviderCredentialValidator({
      providerFetch: () =>
        Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({}),
          text: () =>
            Promise.resolve(
              JSON.stringify({
                message: `The security token included in the request is invalid (${SECRET_ACCESS_KEY}).`,
              }),
            ),
        }),
    })

    await expect(validator('bedrock', BEDROCK_BODY)).rejects.toThrow(
      /answered 403 for ListFoundationModels: The security token included in the request is invalid/,
    )
    await expect(validator('bedrock', BEDROCK_BODY)).rejects.not.toThrow(SECRET_ACCESS_KEY)
  })

  it('reports a transport failure without a secret in it', async () => {
    const validator = createProviderCredentialValidator({
      providerFetch: () => Promise.reject(new Error('connection reset')),
    })

    await expect(validator('bedrock', BEDROCK_BODY)).rejects.toThrow(
      /could not reach Bedrock in eu-west-1/,
    )
    await expect(validator('bedrock', BEDROCK_BODY)).rejects.not.toThrow(SECRET_ACCESS_KEY)
  })

  it('still validates an api_key with the provider list call', async () => {
    const fetch = recordingFetch({})
    await createProviderCredentialValidator({ providerFetch: fetch })('openai', {
      type: 'api_key',
      api_key: 'sk-live',
    })
    expect(fetch.calls).toEqual(['https://api.openai.com/v1/models'])
  })
})

describe('the catalogue over bedrock credentials', () => {
  async function withBedrock(
    fetch: ProviderFetch = recordingFetch(FOUNDATION_MODELS),
  ): Promise<{ test: TestContext; credentials: InMemoryCredentialStore }> {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      credentials,
      vault,
      catalog: catalogue(credentials, vault, fetch),
      validateProviderCredential: acceptAny,
    })
    await put(test, 'bedrock', BEDROCK_BODY)
    return { test, credentials }
  }

  it('lists the region’s on-demand text models, joined with the registry', async () => {
    const { test } = await withBedrock()
    const response = await test.request(`${API_VERSION_PREFIX}/models`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as ListModelsResponse

    // One entry: the on-demand text model AWS named. The inference-profile-only model, the
    // retired one, the embeddings model and the id-less summary are all gone.
    expect(body.data.map((entry) => entry.id)).toEqual([`bedrock/${BEDROCK_MODEL}`])
    expect(body.data[0]).toMatchObject({
      provider: 'bedrock',
      name: 'Claude 3.5 Haiku',
      context_window: 200_000,
      max_output_tokens: 8_192,
      // Prices come from models.dev's Amazon Bedrock entry, so a reply can be priced.
      cost: { input: 0.8, output: 4, cache_read: 0.08 },
      source: 'provider',
    })
    const [status] = body.providers
    expect(status).toMatchObject({ provider: 'bedrock', status: 'ok', message: null })
    expect(typeof status?.fetched_at).toBe('string')
    const text = JSON.stringify(body)
    expect(text).not.toContain(SECRET_ACCESS_KEY)
    expect(text).not.toContain(ACCESS_KEY_ID)
  })

  it('lists a second credential’s models under its own name, in its own region', async () => {
    const fetch = recordingFetch(FOUNDATION_MODELS)
    const { test } = await withBedrock(fetch)
    await put(test, 'bedrock-us', { ...BEDROCK_BODY, region: 'us-east-2' })

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data.map((entry) => entry.id)).toEqual([
      `bedrock/${BEDROCK_MODEL}`,
      `bedrock-us/${BEDROCK_MODEL}`,
    ])
    // Each credential dials its own region.
    expect(fetch.calls.map((url) => new URL(url).host).sort()).toEqual([
      'bedrock.eu-west-1.amazonaws.com',
      'bedrock.us-east-2.amazonaws.com',
    ])
  })

  it('serves the registry’s Bedrock models as a visible fallback when AWS fails', async () => {
    const { test } = await withBedrock(recordingFetch({ message: 'InternalServerError' }, 500))

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    // Both models the registry knows stand in, labelled with the credential's name, because
    // nothing read the region to know which of them it serves.
    expect(body.data.map((entry) => entry.id)).toEqual([
      'bedrock/anthropic.claude-3-5-haiku-20241022-v1:0',
      'bedrock/anthropic.claude-opus-4-7',
    ])
    const [status] = body.providers
    expect(status?.status).toBe('fallback')
    expect(status?.message).toContain('answered 500')
    expect(status?.message).not.toContain(SECRET_ACCESS_KEY)
  })

  it('answers a fallback, with nothing listed, for a row that cannot be opened', async () => {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      credentials,
      vault,
      catalog: catalogue(credentials, vault, recordingFetch(FOUNDATION_MODELS)),
      validateProviderCredential: acceptAny,
    })
    const user = await test.currentUser()
    await credentials.upsert({
      userId: user.id,
      name: 'bedrock',
      type: 'bedrock',
      sealed: { ciphertext: 'not-a-real-blob', nonce: 'n', wrappedKey: 'w', kekVersion: 'v1' },
      details: { region: REGION },
      last4: 'MPLE',
      validatedAt: new Date().toISOString(),
    })

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data).toEqual([])
    expect(body.providers[0]).toMatchObject({ provider: 'bedrock', status: 'fallback' })
    expect(body.providers[0]?.message).toContain('could not be opened')
  })
})

describe('a turn through the real bedrock factory', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams the reply AWS sent, to the region’s runtime host, with the stored key', async () => {
    const requests: { url: string; headers: Record<string, string> }[] = []
    // The provider package resolves `globalThis.fetch` when it was given none, which is the
    // only seam a Bedrock model has: the host comes from the region, not from a user-typed URL.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input instanceof Request ? input.url : input),
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      })
      return Promise.resolve(
        new Response(
          bedrockEventStream(
            // Two chunks, so the reply really is assembled from the stream.
            bedrockReplyEvents(['Hello from ', 'Bedrock'], { inputTokens: 11, outputTokens: 4 }),
          ),
          { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } },
        ),
      )
    })

    const store = new InMemorySessionStore()
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      store,
      credentials,
      vault,
      validateProviderCredential: acceptAny,
      resolveCredential: createSessionCredentialResolver({ store, credentials, vault }),
      model: createProviderModelFactory(),
    })

    await put(test, 'bedrock', BEDROCK_BODY)
    const agent = await httpCreateAgent(test, { model: { id: `bedrock/${BEDROCK_MODEL}` } })
    const session = await httpCreateSession(test, agent.id)
    const sent = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello bedrock' }] }],
      }),
    })
    expect(sent.status).toBe(200)
    await waitForIdle(store, session.id)

    const history = await readHistory(store, session.id)
    const reply = history.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(reply?.content).toEqual([{ type: 'text', text: 'Hello from Bedrock' }])
    // The tokens AWS reported reach the log, which is what a reply's cost is computed from.
    const usage = history.find((event) => event.type === EVENT_TYPES.sessionUsage)
    expect(usage?.models[0]?.model).toBe(`bedrock/${BEDROCK_MODEL}`)
    expect(usage?.models[0]?.usage.input_tokens).toBe(11)
    expect(usage?.models[0]?.usage.output_tokens).toBe(4)

    expect(requests).toHaveLength(1)
    const [request] = requests
    const url = new URL(request?.url as string)
    expect(url.host).toBe(`bedrock-runtime.${REGION}.amazonaws.com`)
    expect(decodeURIComponent(url.pathname)).toBe(`/model/${BEDROCK_MODEL}/converse-stream`)
    const authorization = request?.headers.authorization ?? ''
    expect(authorization).toContain(`Credential=${ACCESS_KEY_ID}/`)
    expect(authorization).toContain(`/${REGION}/bedrock/aws4_request`)
    expect(JSON.stringify(request)).not.toContain(SECRET_ACCESS_KEY)
  })

  it('ends the turn with a missing credential when no bedrock credential is stored', async () => {
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

    const agent = await httpCreateAgent(test, { model: { id: `bedrock/${BEDROCK_MODEL}` } })
    const session = await httpCreateSession(test, agent.id)
    await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
      }),
    })
    await waitForIdle(store, session.id)

    const error = (await readHistory(store, session.id)).find(
      (event) => event.type === EVENT_TYPES.sessionError,
    )
    expect(error?.error.type).toBe('missing_provider_credential')
    expect(error?.error.message).toContain('Amazon Bedrock')
  })
})

describe('the resolver answers a bedrock credential', () => {
  it('opens the row into the credential the factory needs', async () => {
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
    await put(test, 'bedrock', { ...BEDROCK_BODY, session_token: SESSION_TOKEN })

    const agent = await store.createAgent(
      { name: 'A', model: { id: `bedrock/${BEDROCK_MODEL}` } },
      user.id,
    )
    const session = await store.createSession(agent.id, { ownerId: user.id })
    const resolver = createSessionCredentialResolver({ store, credentials, vault })

    const expected: ModelCredential = {
      type: 'bedrock',
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      sessionToken: SESSION_TOKEN,
      region: REGION,
    }
    await expect(resolver(session.id, 'bedrock')).resolves.toEqual(expected)
    await expect(resolver(session.id, 'bedrock-us')).resolves.toBeNull()
  })
})
