import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  type ListModelsResponse,
  type ListProviderCredentialsResponse,
  type ProviderCredential,
} from '@openharness/protocol'
import { InMemoryCredentialStore } from '@openharness/session'
import { createVault, envKeyProvider } from '@openharness/vault'
import { isUsableCredential, type ModelCredential } from '@openharness/brain'

import { credentialUpsert, modelCredential, openCredential, sealCredential } from './credentials'
import { ModelCatalog } from './catalog/catalog'
import type { ModelRegistry } from './catalog/registry'
import type { ProviderFetch } from './catalog/provider-fetch'
import { createProviderCredentialValidator } from './provider-validation'
import { TEST_SECRETS_KEY, createTestApp, type TestContext } from './test-support'
import { vertexPublisherModelsUrl } from './vertex'

/**
 * Google Vertex credentials, end to end (epic #245, A3d).
 *
 * What this suite covers is the half the brain's own tests cannot: the schema that refuses a
 * document which is not a service-account key, the route that stores one, the metadata the API
 * answers with (the service-account **email**, the project and the location — and never any
 * part of the private key), the save-time check that lists the project's publisher models, and
 * the catalogue that turns models.dev's Vertex entries into a credential's models.
 */

const PROJECT = 'openharness-vertex'
const LOCATION = 'europe-west4' as const
const EMAIL = 'vertex-runner@openharness-vertex.iam.gserviceaccount.com'
const PRIVATE_KEY_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** A stand-in private key: distinctive, and never a real one. */
const PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\nVERTEX-PRIVATE-KEY-DO-NOT-LOG-4242\n-----END PRIVATE KEY-----\n'

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: PROJECT,
  private_key_id: PRIVATE_KEY_ID,
  private_key: PRIVATE_KEY,
  client_email: EMAIL,
  client_id: '118204773655879341057',
  token_uri: 'https://oauth2.googleapis.com/token',
}

const VERTEX_BODY = {
  type: 'vertex' as const,
  service_account: JSON.stringify(SERVICE_ACCOUNT),
  project: PROJECT,
  location: LOCATION,
}

/** The instant the direct sealing test stamps a credential with. */
const VALIDATED_AT = '2026-03-15T10:00:00.000Z'

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

/** A registry stub of models.dev's `google-vertex` entry, trimmed to what these tests need. */
const vertexRegistry: ModelRegistry = {
  models: (provider) =>
    provider === 'google-vertex'
      ? [
          {
            id: 'gemini-2.5-pro',
            name: 'Gemini 2.5 Pro',
            contextWindow: 1_048_576,
            maxOutput: 65_536,
            cost: { input: 1.25, output: 10, cache_read: 0.31, cache_write: null },
          },
          {
            id: 'claude-sonnet-4-5@20250929',
            name: 'Claude Sonnet 4.5',
            contextWindow: 200_000,
            maxOutput: 64_000,
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
          },
          // Not a chat model, and out of the list.
          { id: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image' },
          // A MaaS model Google resells: this build has no client for it.
          { id: 'xai/grok-4.7', name: 'Grok 4.7' },
        ]
      : [],
}

/** A catalogue over the given credentials/registry, dialing nothing. */
function catalogue(
  credentials: InMemoryCredentialStore,
  vault: ReturnType<typeof createVault>,
  registry: ModelRegistry = vertexRegistry,
): ModelCatalog {
  const fetch: ProviderFetch = () => Promise.reject(new Error('the vertex path dials no provider'))
  return new ModelCatalog({ credentials, vault, registry, fetch })
}

/** A credential's published `details`, or `undefined` for a type that carries none. */
function detailsOf(credential: ProviderCredential): unknown {
  return 'details' in credential ? credential.details : undefined
}

describe('the vertex credential API', () => {
  it('stores a service-account key and lists its email, project and location', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    const response = await put(test, 'vertex', VERTEX_BODY)
    expect(response.status, await response.clone().text()).toBe(200)
    const created = (await response.json()) as ProviderCredential
    expect(created.type).toBe('vertex')
    expect(created.name).toBe('vertex')
    // `last4` is the **key id**'s last four, never a piece of the private key: the id is what
    // a reader can match against the console, and the key must not be echoed at all.
    expect(created.last4).toBe(PRIVATE_KEY_ID.slice(-4))
    expect(created).toMatchObject({
      details: { email: EMAIL, project: PROJECT, location: LOCATION },
    })
    expect(Object.keys(created).sort()).toEqual(
      ['created_at', 'details', 'id', 'last4', 'name', 'type', 'updated_at', 'validated_at'].sort(),
    )
    // Nothing of the document but the three facts that are not secret.
    const text = JSON.stringify(created)
    expect(text).not.toContain('VERTEX-PRIVATE-KEY-DO-NOT-LOG')
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).not.toContain(PRIVATE_KEY_ID)
    expect(await list(test)).toEqual({ data: [created] })
  })

  it('keeps a second vertex credential under its own name, with its own facts', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    await put(test, 'vertex', VERTEX_BODY)
    const other = await put(test, 'vertex-eu', {
      ...VERTEX_BODY,
      project: 'openharness-other',
      location: 'europe-west1',
      service_account: JSON.stringify({
        ...SERVICE_ACCOUNT,
        project_id: 'openharness-other',
        client_email: 'other@openharness-other.iam.gserviceaccount.com',
      }),
    })
    expect(other.status).toBe(200)

    const stored = (await list(test)).data
    expect(stored.map((entry) => entry.name)).toEqual(['vertex', 'vertex-eu'])
    expect(stored.map(detailsOf)).toEqual([
      { email: EMAIL, project: PROJECT, location: LOCATION },
      {
        email: 'other@openharness-other.iam.gserviceaccount.com',
        project: 'openharness-other',
        location: 'europe-west1',
      },
    ])
  })

  it('refuses a document that is not a service-account key, before anything is sealed', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    for (const service_account of [
      '{}',
      'not json',
      JSON.stringify({ ...SERVICE_ACCOUNT, type: 'authorized_user' }),
      JSON.stringify({ ...SERVICE_ACCOUNT, private_key: undefined }),
    ]) {
      const response = await put(test, 'vertex', { ...VERTEX_BODY, service_account })
      expect(response.status, service_account).toBe(400)
      const body = ApiErrorBodySchema.parse(await response.json())
      expect(body.error.type).toBe('invalid_request_error')
      expect(body.error.message).toContain('service account')
    }
    // Nothing was stored, and the validator was never asked to prove a document that is not one.
    expect((await list(test)).data).toEqual([])
  })

  it('refuses an unknown location and a project that is not a project id', async () => {
    const test = createTestApp({ validateProviderCredential: acceptAny })

    expect((await put(test, 'vertex', { ...VERTEX_BODY, location: 'mars-north1' })).status).toBe(
      400,
    )
    expect((await put(test, 'vertex', { ...VERTEX_BODY, project: 'Not A Project' })).status).toBe(
      400,
    )
    expect((await put(test, 'vertex', { ...VERTEX_BODY, location: '' })).status).toBe(400)
    expect((await list(test)).data).toEqual([])
  })

  it('answers 422 when the save-time check refuses, and stores nothing', async () => {
    const seen: { name: string; type: string }[] = []
    const test = createTestApp({
      validateProviderCredential: (name, body) => {
        seen.push({ name, type: body.type })
        return Promise.reject(
          new Error(
            'Vertex answered 403 for the project openharness-vertex in europe-west4: the ' +
              'Vertex AI API has not been used in project',
          ),
        )
      },
    })

    const response = await put(test, 'vertex', VERTEX_BODY)
    expect(response.status).toBe(422)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_provider_credential')
    // Google's sentence reaches the reader, and the key never does.
    expect(body.error.message).toContain('Vertex AI API has not been used')
    expect(body.error.message).not.toContain('VERTEX-PRIVATE-KEY')
    expect(seen).toEqual([{ name: 'vertex', type: 'vertex' }])
    expect((await list(test)).data).toEqual([])
  })

  it('never puts the key or any part of it in a response or a log line', async () => {
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
    const putResponse = await put(test, 'vertex', VERTEX_BODY)
    const listResponse = await test.request(`${API_VERSION_PREFIX}/provider-credentials`)
    for (const response of [putResponse, listResponse]) {
      const text = await response.clone().text()
      expect(text).not.toContain('VERTEX-PRIVATE-KEY-DO-NOT-LOG')
      expect(text).not.toContain('BEGIN PRIVATE KEY')
    }
    expect(lines.join('\n')).not.toContain('VERTEX-PRIVATE-KEY-DO-NOT-LOG')
  })
})

describe('the vertex save-time check', () => {
  /** A fetch that records what it was asked for and answers `status`. */
  function recordingFetch(status = 200, body = '{"models":[]}') {
    const requests: { url: string; headers: Record<string, string> }[] = []
    const fetch: ProviderFetch = (url, init) => {
      requests.push({ url, headers: { ...init.headers } })
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(JSON.parse(body) as unknown),
        text: () => Promise.resolve(body),
      })
    }
    return { fetch, requests }
  }

  it('lists the project’s publisher models in the credential’s location, with its token', async () => {
    const { fetch, requests } = recordingFetch()
    const tokens: string[] = []
    const validator = createProviderCredentialValidator({
      providerFetch: fetch,
      vertexToken: (serviceAccount) => {
        tokens.push(serviceAccount)
        return Promise.resolve('access-token-4242')
      },
    })

    await validator('vertex', VERTEX_BODY)

    // The endpoint is Google's, derived from the stored project and location — a user never
    // types a host, which is why this call needs no SSRF guard.
    expect(requests).toEqual([
      {
        url: `https://europe-west4-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models?pageSize=1`,
        headers: { authorization: 'Bearer access-token-4242' },
      },
    ])
    // The token is signed from the stored document and nothing else.
    expect(tokens).toEqual([VERTEX_BODY.service_account])
  })

  it('lists a `global` location from the apex host', async () => {
    const { fetch, requests } = recordingFetch()
    const validator = createProviderCredentialValidator({
      providerFetch: fetch,
      vertexToken: () => Promise.resolve('t'),
    })
    await validator('vertex', { ...VERTEX_BODY, location: 'global' })
    expect(requests[0]?.url).toBe(
      `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models?pageSize=1`,
    )
  })

  it('refuses with Google’s reason and status when the call is not allowed', async () => {
    const { fetch } = recordingFetch(
      403,
      '{"error":{"code":403,"message":"Vertex AI API has not been used in project 123 before or it is disabled."}}',
    )
    const validator = createProviderCredentialValidator({
      providerFetch: fetch,
      vertexToken: () => Promise.resolve('t'),
    })

    await expect(validator('vertex', VERTEX_BODY)).rejects.toThrow(
      /Vertex answered 403 for the project openharness-vertex in europe-west4: .*has not been used/,
    )
  })

  it('refuses with Google’s reason when the key cannot be signed with at all', async () => {
    // A key Google does not know — the failure a reader is likeliest to hit — must reach the
    // reader in Google's own words: `invalid_grant: Invalid grant: account not found`.
    const { fetch, requests } = recordingFetch()
    const validator = createProviderCredentialValidator({
      providerFetch: fetch,
      vertexToken: () =>
        Promise.reject(new Error('invalid_grant: Invalid grant: account not found')),
    })

    await expect(validator('vertex', VERTEX_BODY)).rejects.toThrow(
      /could not authenticate vertex against Google: invalid_grant: Invalid grant: account not found/,
    )
    // Nothing was dialed with a token that does not exist.
    expect(requests).toEqual([])
  })

  it('refuses a location it cannot build a host from, rather than inventing one', () => {
    // The schema refuses an unknown location before this, so the URL builder only ever sees
    // Google's own region names — but the rule it follows is worth pinning: every host is
    // `<location>-aiplatform.googleapis.com`, and `global` is the apex.
    expect(vertexPublisherModelsUrl({ project: 'p', location: 'us-central1' })).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models?pageSize=1',
    )
  })
})

describe('the catalogue over vertex credentials', () => {
  async function withVertex(): Promise<{
    test: TestContext
    credentials: InMemoryCredentialStore
  }> {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const test = createTestApp({
      credentials,
      vault,
      catalog: catalogue(credentials, vault),
      validateProviderCredential: acceptAny,
    })
    await put(test, 'vertex', VERTEX_BODY)
    return { test, credentials }
  }

  it('lists the Vertex models a request can run, with their prices', async () => {
    const { test } = await withVertex()
    const response = await test.request(`${API_VERSION_PREFIX}/models`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as ListModelsResponse

    expect(body.data.map((entry) => entry.id)).toEqual([
      'vertex/claude-sonnet-4-5@20250929',
      'vertex/gemini-2.5-pro',
    ])
    expect(body.data[1]).toMatchObject({
      provider: 'vertex',
      name: 'Gemini 2.5 Pro',
      context_window: 1_048_576,
      max_output_tokens: 65_536,
      cost: { input: 1.25, output: 10, cache_read: 0.31 },
      source: 'registry',
    })
    // The status is `ok` — the credential was read, and its models come from the publisher
    // catalogue models.dev files — rather than a fallback.
    expect(body.providers[0]).toMatchObject({ provider: 'vertex', status: 'ok', message: null })
    expect(typeof body.providers[0]?.fetched_at).toBe('string')
    // The key, and any part of it, stays out of the catalogue too.
    expect(JSON.stringify(body)).not.toContain('VERTEX-PRIVATE-KEY')
    expect(JSON.stringify(body)).not.toContain(PRIVATE_KEY_ID)
  })

  it('lists a second credential’s models under its own name', async () => {
    const { test } = await withVertex()
    await put(test, 'vertex-eu', { ...VERTEX_BODY, location: 'europe-west1' })

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data.map((entry) => entry.id)).toEqual([
      'vertex/claude-sonnet-4-5@20250929',
      'vertex/gemini-2.5-pro',
      'vertex-eu/claude-sonnet-4-5@20250929',
      'vertex-eu/gemini-2.5-pro',
    ])
    expect(body.providers.map((entry) => entry.provider)).toEqual(['vertex', 'vertex-eu'])
  })

  it('answers a fallback with no models for a row that cannot be opened', async () => {
    const { test, credentials } = await withVertex()
    // A row whose sealed blob a different key sealed: it cannot be opened, so the credential
    // contributes its status and no models rather than a guessed list.
    const vault = createVault(envKeyProvider(Buffer.alloc(32, 7).toString('base64')))
    const sealed = await vault.seal('{}', `x|vertex`)
    const userId = (await test.currentUser()).id
    await credentials.upsert({
      userId,
      name: 'vertex',
      type: 'vertex',
      sealed,
      last4: '0000',
      validatedAt: new Date().toISOString(),
    })
    // The save that stored the working credential filled the catalogue's cache, and this row
    // was written behind its back: drop the cached answer, as another instance's TTL would.
    test.catalog.invalidate(userId, 'vertex')

    const body = (await (
      await test.request(`${API_VERSION_PREFIX}/models`)
    ).json()) as ListModelsResponse
    expect(body.data).toEqual([])
    expect(body.providers[0]).toMatchObject({ provider: 'vertex', status: 'fallback' })
    expect(body.providers[0]?.message).toContain('could not be opened')
  })
})

describe('the vertex resolver', () => {
  it('opens a sealed row into exactly the credential the factory needs', async () => {
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const userId = 'user_vertex_test'

    // Sealed and stored as the route does it, then opened as the brain's resolver does.
    const sealed = await sealCredential(vault, { userId, name: 'vertex', body: VERTEX_BODY })
    await credentials.upsert(
      credentialUpsert({ userId, name: 'vertex', body: VERTEX_BODY }, sealed, VALIDATED_AT),
    )
    const body = await openCredential(vault, { userId, name: 'vertex', sealed })
    expect(body).toEqual(VERTEX_BODY)

    // What the brain is handed: the project, the location and the whole key document — the
    // three things `createVertex` is built from, and nothing else.
    const credential: ModelCredential = modelCredential(VERTEX_BODY)
    expect(credential).toEqual({
      type: 'vertex',
      project: PROJECT,
      location: LOCATION,
      serviceAccount: VERTEX_BODY.service_account,
    })
    expect(isUsableCredential(credential)).toBe(true)
  })

  it('answers the metadata the list shows: the key id’s tail, and the facts that are not secret', () => {
    const userId = 'user_vertex_test'
    const metadata = credentialUpsert(
      { userId, name: 'vertex', body: VERTEX_BODY },
      { ciphertext: 'c', nonce: 'n', wrappedKey: 'w', kekVersion: 'v1' },
      VALIDATED_AT,
    )
    expect(metadata.last4).toBe(PRIVATE_KEY_ID.slice(-4))
    expect(metadata.details).toEqual({ email: EMAIL, project: PROJECT, location: LOCATION })
    expect(JSON.stringify(metadata)).not.toContain('VERTEX-PRIVATE-KEY-DO-NOT-LOG')
  })
})
