import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  type ListModelsResponse,
  type ModelEntry,
  type ProviderCatalogStatus,
} from '@openharness/protocol'
import { InMemoryCredentialStore, type CredentialStore } from '@openharness/session'
import { createVault, envKeyProvider } from '@openharness/vault'

import { ModelCatalog } from './catalog/catalog'
import { createBundledRegistry } from './catalog/registry'
import type { ModelRegistry, RegistryModel } from './catalog/registry'
import type { ProviderFetch, ProviderResponse } from './catalog/provider-fetch'
import { credentialUpsert, sealCredential } from './credentials'
import { TEST_SECRETS_KEY, createTestApp, type TestContext } from './test-support'
import type { Logger } from './types'

/**
 * `GET /v1/models` (issue #90): the caller's own keys only, the provider's own list where it
 * answers, the registry's chat models where it does not, one cache per (user, provider) — and
 * a key that never appears in a response, a message or a log line.
 *
 * Nothing here reaches a network: the catalogue runs over a scripted fetch — every provider
 * URL is answered by the test — and a registry stub whose models the test declares. The two
 * provider payloads that matter most are the real shapes: OpenAI's flat model list and
 * Gemini's `models` page with `supportedGenerationMethods`.
 */

/** A distinctive key, so "it is not in the output" is a meaningful assertion. */
const KEY_A = 'sk-catalog-a-do-not-log-me-424242424242'
const KEY_B = 'sk-catalog-b-do-not-log-me-535353535353'

/** The fixed instant the clock starts at, and the moment a cache entry is written. */
const START = new Date('2026-10-04T12:00:00.000Z')

// ------------------------------------------------------------------ test doubles

/** A clock the test moves by hand, so TTLs are asserted rather than waited out. */
function testClock(): { now: () => Date; advance: (ms: number) => void } {
  let current = START
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current = new Date(current.getTime() + ms)
    },
  }
}

/**
 * A registry whose models the test declares, instead of the bundled models.dev snapshot — so a
 * test can give a model a verdict or a limit the real data does not have, and assert what the
 * join does with it. `model-catalog-snapshot.test.ts` runs the same catalogue over the real one.
 */
function fakeRegistry(models: Record<string, readonly RegistryModel[]>): ModelRegistry {
  return { models: (provider) => models[provider] ?? [] }
}

/** A failure response with a text body, as a provider's error would be. */
function failure(status: number, body: string): ProviderResponse {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error(`not JSON: ${body}`)),
    text: () => Promise.resolve(body),
  }
}

/** One request the scripted fetch saw. */
interface RecordedCall {
  readonly url: string
  readonly headers: Record<string, string>
}

/** What the scripted fetch does for a URL — usually `json(...)` or `failure(...)`. */
type Responder = (
  request: RecordedCall & { signal: AbortSignal },
) => ProviderResponse | Promise<ProviderResponse>

interface CatalogueFixture {
  readonly test: TestContext
  readonly catalog: ModelCatalog
  /** Every provider request, in order. */
  readonly calls: RecordedCall[]
  readonly clock: { now: () => Date; advance: (ms: number) => void }
  /** `GET /v1/models`, as the default caller. */
  list(query?: string): Promise<Response>
  /** `PUT /v1/provider-credentials/{provider}` with a key the fake validator accepts. */
  putKey(provider: string, apiKey: string): Promise<void>
  /**
   * Seal and store a credential **without** the route, for a row the route would refuse.
   *
   * The only such row now is a provider string that is not one of the eleven ids — what a
   * database written before named credentials (#245, A3a) can still hold. The catalogue has to
   * degrade on one rather than dialing it, and this is how a test makes one.
   */
  seedKey(name: string, apiKey: string): Promise<void>
}

/** An app whose catalogue runs over the given responders (keyed by a substring of the URL). */
function catalogueApp(options: {
  readonly responders: Record<string, Responder>
  readonly models?: Record<string, readonly RegistryModel[]>
  readonly registry?: ModelRegistry
  readonly timeoutMs?: number
  readonly logger?: Logger
  readonly credentials?: CredentialStore
}): CatalogueFixture {
  const credentials = options.credentials ?? new InMemoryCredentialStore()
  const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
  const calls: RecordedCall[] = []
  const fetch: ProviderFetch = async (url, init) => {
    const call = { url, headers: init.headers }
    calls.push(call)
    const match = Object.keys(options.responders).find((fragment) => url.includes(fragment))
    if (match === undefined) {
      throw new Error(`the test has no responder for ${url}`)
    }
    return options.responders[match]?.({
      ...call,
      signal: init.signal,
    }) as Promise<ProviderResponse>
  }
  const clock = testClock()
  const catalog = new ModelCatalog({
    credentials,
    vault,
    registry: options.registry ?? fakeRegistry(options.models ?? {}),
    fetch,
    now: clock.now,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  const test = createTestApp({
    credentials,
    vault,
    catalog,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })
  return {
    test,
    catalog,
    calls,
    clock,
    list: (query = '') => test.request(`${API_VERSION_PREFIX}/models${query}`),
    putKey: async (provider, apiKey) => {
      const response = await test.request(
        `${API_VERSION_PREFIX}/provider-credentials/${provider}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'api_key', api_key: apiKey }),
        },
      )
      expect([provider, response.status]).toEqual([provider, 200])
    },
    seedKey: async (name, apiKey) => {
      const user = await test.currentUser()
      const body = { type: 'api_key' as const, api_key: apiKey }
      const sealed = await sealCredential(vault, { userId: user.id, name, body })
      await credentials.upsert(
        credentialUpsert({ userId: user.id, name, body }, sealed, clock.now().toISOString()),
      )
    },
  }
}

/** `GET /v1/models` as the default caller, parsed. */
async function modelsOf(fixture: CatalogueFixture, query = ''): Promise<ListModelsResponse> {
  const response = await fixture.list(query)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()) as ListModelsResponse
}

/** The ids of a response's entries. */
function idsOf(response: ListModelsResponse): string[] {
  return response.data.map((entry) => entry.id)
}

/** The one status for a provider. */
function statusOf(response: ListModelsResponse, provider: string): ProviderCatalogStatus {
  const found = response.providers.find((status) => status.provider === provider)
  expect(found, `no status for ${provider}`).toBeDefined()
  return found as ProviderCatalogStatus
}

/** A logger that keeps every line, for the "never in the logs" assertions. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = []
  const write = (level: string, message: string, detail?: unknown): void => {
    lines.push(`${level} ${message} ${detail === undefined ? '' : (JSON.stringify(detail) ?? '')}`)
  }
  return {
    lines,
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
  }
}

// ------------------------------------------------------------------ the tests

describe('GET /v1/models', () => {
  it('lists only the providers the caller has a key for (C5), and calls only those', async () => {
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': () => json({ object: 'list', data: [{ id: 'gpt-4.1' }] }),
        'api.anthropic.com': () =>
          json({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }),
      },
      models: {
        openai: [{ id: 'gpt-4.1', chat: true }],
        anthropic: [{ id: 'claude-sonnet-5', chat: true }],
      },
    })

    // No credentials at all: the empty answer, and not one provider call.
    const empty = await modelsOf(fixture)
    expect(empty).toEqual({ data: [], providers: [] })
    expect(fixture.calls).toEqual([])

    await fixture.putKey('openai', KEY_A)
    const openaiOnly = await modelsOf(fixture)
    expect(openaiOnly.providers.map((status) => status.provider)).toEqual(['openai'])
    expect(idsOf(openaiOnly)).toEqual(['openai/gpt-4.1'])
    expect(fixture.calls.map((call) => call.url)).toEqual(['https://api.openai.com/v1/models'])

    await fixture.putKey('anthropic', KEY_A)
    const both = await modelsOf(fixture)
    expect(both.providers.map((status) => status.provider)).toEqual(['anthropic', 'openai'])
    // Sorted by provider, then name.
    expect(idsOf(both)).toEqual(['anthropic/claude-sonnet-5', 'openai/gpt-4.1'])
    expect(statusOf(both, 'anthropic').status).toBe('ok')
    expect(statusOf(both, 'anthropic').fetched_at).toBe(START.toISOString())
    expect(statusOf(both, 'anthropic').message).toBeNull()
  })

  it("filters OpenAI's list: no embeddings, tts, whisper, dall-e or moderation", async () => {
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': () =>
          json({
            object: 'list',
            data: [
              { id: 'gpt-4.1' },
              { id: 'gpt-4o-mini' },
              { id: 'text-embedding-3-small' },
              { id: 'tts-1-hd' },
              { id: 'whisper-1' },
              { id: 'dall-e-3' },
              { id: 'gpt-image-1' },
              { id: 'omni-moderation-latest' },
              { id: 'gpt-realtime-2.1' },
            ],
          }),
      },
    })
    await fixture.putKey('openai', KEY_A)

    const response = await modelsOf(fixture)

    expect(idsOf(response)).toEqual(['openai/gpt-4.1', 'openai/gpt-4o-mini'])
    expect(response.data.every((entry) => entry.source === 'provider')).toBe(true)
    expect(statusOf(response, 'openai').status).toBe('ok')
  })

  it("filters Gemini's list with the provider's own supportedGenerationMethods", async () => {
    const fixture = catalogueApp({
      responders: {
        'generativelanguage.googleapis.com': (request) =>
          request.url.includes('pageToken=')
            ? json({
                models: [
                  {
                    name: 'models/gemini-2.0-flash-lite',
                    supportedGenerationMethods: ['generateContent'],
                  },
                ],
              })
            : json({
                models: [
                  {
                    name: 'models/gemini-2.5-flash',
                    displayName: 'Gemini 2.5 Flash',
                    inputTokenLimit: 1048576,
                    outputTokenLimit: 65536,
                    supportedGenerationMethods: ['generateContent', 'countTokens'],
                  },
                  {
                    name: 'models/text-embedding-004',
                    supportedGenerationMethods: ['embedContent'],
                  },
                ],
                nextPageToken: 'page-2',
              }),
      },
    })
    await fixture.putKey('google', KEY_A)

    const response = await modelsOf(fixture)

    // The embedContent-only model is gone; both pages were read; the display name and the
    // token limits came from the provider's own payload. Sorted by name, so the display name
    // (“Gemini 2.5 Flash”) precedes the entry named after its id.
    expect(idsOf(response)).toEqual(['google/gemini-2.5-flash', 'google/gemini-2.0-flash-lite'])
    const flash = response.data.find((entry) => entry.id === 'google/gemini-2.5-flash')
    expect(flash).toMatchObject({
      provider: 'google',
      name: 'Gemini 2.5 Flash',
      context_window: 1048576,
      max_output_tokens: 65536,
      source: 'provider',
    } satisfies Partial<ModelEntry>)
    expect(fixture.calls).toHaveLength(2)
    // The key travels in the header, never the URL (which is what the page token extends).
    expect(fixture.calls[1]?.url).toContain('pageToken=page-2')
    expect(fixture.calls[1]?.url).not.toContain(KEY_A)
    expect(fixture.calls[1]?.headers['x-goog-api-key']).toBe(KEY_A)
  })

  it('joins the registry onto the provider’s list, and lets its verdicts decide', async () => {
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': () =>
          json({
            object: 'list',
            data: [{ id: 'gpt-4.1' }, { id: 'mystery-model' }, { id: 'custom-model' }],
          }),
      },
      models: {
        openai: [
          {
            id: 'gpt-4.1',
            name: 'GPT-4.1',
            contextWindow: 1047576,
            maxOutput: 32768,
            chat: true,
            // The price is the registry's too (#247): a client prices a reply itself with what
            // the catalog hands it, so the join is where a rate has to arrive.
            cost: { input: 2, output: 8, cache_read: 0.5, cache_write: null },
          },
          // The registry says this one cannot chat, so it is dropped even though its name
          // would pass the heuristic.
          { id: 'mystery-model', chat: false },
        ],
      },
    })
    await fixture.putKey('openai', KEY_A)

    const response = await modelsOf(fixture)

    // Sorted by name: the registry's display name for gpt-4.1 precedes the id-named entry.
    expect(idsOf(response)).toEqual(['openai/gpt-4.1', 'openai/custom-model'])
    // The registry filled in the name and the limits the provider's list did not carry.
    expect(response.data.find((entry) => entry.id === 'openai/gpt-4.1')).toEqual({
      id: 'openai/gpt-4.1',
      provider: 'openai',
      name: 'GPT-4.1',
      context_window: 1047576,
      max_output_tokens: 32768,
      cost: { input: 2, output: 8, cache_read: 0.5, cache_write: null },
      source: 'provider',
    })
    // A model neither side knows is still listed: never hide a usable chat model.
    expect(response.data.find((entry) => entry.id === 'openai/custom-model')).toMatchObject({
      name: 'openai/custom-model',
      context_window: null,
      max_output_tokens: null,
      // A model the registry does not price keeps its tokens and reports no cost — `null`, and
      // never a guessed rate.
      cost: null,
      source: 'provider',
    })
  })

  it('falls back to the registry when the provider times out', async () => {
    const fixture = catalogueApp({
      timeoutMs: 20,
      responders: {
        'api.openai.com': (request) =>
          new Promise((_resolve, reject) => {
            // The catalogue's own deadline is the only way out of this request; the signal's
            // reason is what a real `fetch` rejects with.
            request.signal.addEventListener('abort', () => {
              reject(request.signal.reason as Error)
            })
          }),
      },
      models: {
        openai: [
          { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576, maxOutput: 32768, chat: true },
          { id: 'text-embedding-3-small' },
        ],
      },
    })
    await fixture.putKey('openai', KEY_A)

    const response = await modelsOf(fixture)

    expect(statusOf(response, 'openai').status).toBe('fallback')
    expect(statusOf(response, 'openai').fetched_at).toBeNull()
    expect(statusOf(response, 'openai').message).toMatch(/did not answer within/)
    // The registry's chat models stood in — and its embeddings did not.
    expect(idsOf(response)).toEqual(['openai/gpt-4.1'])
    expect(response.data[0]?.source).toBe('registry')
    expect(response.data[0]?.context_window).toBe(1047576)
  })

  it('falls back on a 5xx, and scrubs the key out of what the provider said', async () => {
    const logger = recordingLogger()
    const fixture = catalogueApp({
      logger,
      responders: {
        'api.openai.com': () =>
          failure(
            500,
            `{"error":{"message":"Incorrect API key provided: ${KEY_A}. Retry later."}}`,
          ),
      },
      models: { openai: [{ id: 'gpt-4.1', chat: true }] },
    })
    await fixture.putKey('openai', KEY_A)

    const response = await modelsOf(fixture)
    const status = statusOf(response, 'openai')

    expect(status.status).toBe('fallback')
    // The reason is kept — it is what tells a user why — with the key replaced.
    expect(status.message).toContain('answered 500')
    expect(status.message).toContain('[REDACTED]')
    expect(status.message).not.toContain(KEY_A)
    // Nowhere in the response, and nowhere in the log lines the fallback wrote.
    expect(JSON.stringify(response)).not.toContain(KEY_A)
    const logged = logger.lines.join('\n')
    expect(logged).not.toContain(KEY_A)
    expect(logged).toContain("serving the registry's openai models")
    expect(logged).toContain('[REDACTED]')
  })

  it('never puts the key in a response, success or failure', async () => {
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': () => json({ object: 'list', data: [{ id: 'gpt-4.1' }] }),
      },
    })
    await fixture.putKey('openai', KEY_A)

    const response = await modelsOf(fixture)

    expect(JSON.stringify(response)).not.toContain(KEY_A)
  })

  it('caches per (user, provider), expires after an hour, and a credential write drops it', async () => {
    let listed = 0
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': () => {
          listed += 1
          return json({ object: 'list', data: [{ id: `gpt-4.1` }, { id: `gpt-v${listed}` }] })
        },
      },
    })
    await fixture.putKey('openai', KEY_A)

    const first = await modelsOf(fixture)
    expect(idsOf(first)).toEqual(['openai/gpt-4.1', 'openai/gpt-v1'])

    // A second read inside the TTL is a cache hit: same answer, no second provider call.
    fixture.clock.advance(3_599_999)
    const cached = await modelsOf(fixture)
    expect(cached).toEqual(first)
    expect(listed).toBe(1)

    // Past the hour, the provider is asked again.
    fixture.clock.advance(1)
    const afterTtl = await modelsOf(fixture)
    expect(idsOf(afterTtl)).toEqual(['openai/gpt-4.1', 'openai/gpt-v2'])
    expect(listed).toBe(2)

    // Saving the credential again drops the entry: the cached list was fetched with the key
    // that just changed (C4).
    await fixture.putKey('openai', KEY_A)
    const afterWrite = await modelsOf(fixture)
    expect(idsOf(afterWrite)).toEqual(['openai/gpt-4.1', 'openai/gpt-v3'])
    expect(listed).toBe(3)

    // Deleting it drops the entry too — and the provider is no longer listed at all.
    const deleted = await fixture.test.request(
      `${API_VERSION_PREFIX}/provider-credentials/openai`,
      { method: 'DELETE' },
    )
    expect(deleted.status).toBe(204)
    const afterDelete = await modelsOf(fixture)
    expect(afterDelete).toEqual({ data: [], providers: [] })
    expect(listed).toBe(3)
  })

  it('refresh bypasses the cache, once a minute per user: the second time is a 429', async () => {
    let listed = 0
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': (request) => {
          listed += 1
          // The first call fails, so refresh has something real to recover from.
          if (listed === 1) {
            return failure(503, 'overloaded')
          }
          expect(request.headers.authorization).toBe(`Bearer ${KEY_A}`)
          return json({ object: 'list', data: [{ id: 'gpt-4.1' }] })
        },
      },
      models: { openai: [{ id: 'gpt-4.1', chat: true }] },
    })
    await fixture.putKey('openai', KEY_A)

    const first = await modelsOf(fixture)
    expect(statusOf(first, 'openai').status).toBe('fallback')

    // `refresh=true` skips the cache and re-fetches — the fallback becomes a live answer.
    const refreshed = await modelsOf(fixture, '?refresh=true')
    expect(statusOf(refreshed, 'openai').status).toBe('ok')
    expect(listed).toBe(2)

    // Inside the minute, the refresh is refused with the protocol's 429 — and nothing was
    // fetched.
    const refused = await fixture.list('?refresh=true')
    expect(refused.status).toBe(429)
    const body = ApiErrorBodySchema.parse(await refused.json())
    expect(body.error.type).toBe('rate_limit_error')
    expect(listed).toBe(2)

    // `refresh=false` is the ordinary cached read, and is not rate-limited.
    const cached = await modelsOf(fixture, '?refresh=false')
    expect(statusOf(cached, 'openai').status).toBe('ok')
    expect(listed).toBe(2)

    // Once the minute has passed, refresh works again.
    fixture.clock.advance(60_000)
    const again = await modelsOf(fixture, '?refresh=true')
    expect(statusOf(again, 'openai').status).toBe('ok')
    expect(listed).toBe(3)
  })

  it('never uses another user’s keys: each caller gets their own providers, with their own key', async () => {
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': (request) =>
          request.headers.authorization === `Bearer ${KEY_A}`
            ? json({ object: 'list', data: [{ id: 'gpt-4.1' }] })
            : failure(401, 'wrong key'),
        'api.x.ai': (request) =>
          request.headers.authorization === `Bearer ${KEY_B}`
            ? json({ object: 'list', data: [{ id: 'grok-4.3' }] })
            : failure(401, 'wrong key'),
      },
    })
    const a = await fixture.test.signIn()
    const b = await fixture.test.signIn('b@example.com', 'b-password')

    // A stores an OpenAI key (the default caller is A in `putKey`).
    await fixture.putKey('openai', KEY_A)

    // B has nothing: B's catalogue is empty, and A's key is never touched.
    const bBefore = await fixture.test.request(`${API_VERSION_PREFIX}/models`, {
      headers: { authorization: `Bearer ${b.token}` },
    })
    expect(await bBefore.json()).toEqual({ data: [], providers: [] })

    // B stores their own key for another provider.
    const bPut = await fixture.test.request(`${API_VERSION_PREFIX}/provider-credentials/xai`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
      body: JSON.stringify({ type: 'api_key', api_key: KEY_B }),
    })
    expect(bPut.status).toBe(200)

    const bAfter = (await (
      await fixture.test.request(`${API_VERSION_PREFIX}/models`, {
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).json()) as ListModelsResponse
    expect(bAfter.providers.map((status) => status.provider)).toEqual(['xai'])
    expect(idsOf(bAfter)).toEqual(['xai/grok-4.3'])

    // A still sees only their own provider, and no call was ever made with the other key.
    const aView = (await (
      await fixture.test.request(`${API_VERSION_PREFIX}/models`, {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).json()) as ListModelsResponse
    expect(aView.providers.map((status) => status.provider)).toEqual(['openai'])
    expect(idsOf(aView)).toEqual(['openai/gpt-4.1'])

    const xaiCall = fixture.calls.find((call) => call.url.includes('api.x.ai'))
    expect(xaiCall?.headers.authorization).toBe(`Bearer ${KEY_B}`)
    const openaiCalls = fixture.calls.filter((call) => call.url.includes('api.openai.com'))
    expect(openaiCalls.every((call) => call.headers.authorization === `Bearer ${KEY_A}`)).toBe(true)
  })

  it('serves a provider with no known list endpoint from the registry, without dialing anything', async () => {
    const fixture = catalogueApp({
      responders: {},
      models: {
        acme: [
          { id: 'acme-chat', name: 'Acme Chat', contextWindow: 8000, chat: true },
          { id: 'acme-embed-2' },
        ],
      },
    })
    // Seeded rather than PUT: no route stores an `api_key` under a name that is not a
    // provider id any more (A3a), but a database written before that rule can still hold one.
    await fixture.seedKey('acme', KEY_A)

    const response = await modelsOf(fixture)

    expect(statusOf(response, 'acme').status).toBe('fallback')
    expect(statusOf(response, 'acme').message).toContain('no known model-list endpoint')
    expect(idsOf(response)).toEqual(['acme/acme-chat'])
    expect(response.data[0]).toMatchObject({
      name: 'Acme Chat',
      context_window: 8000,
      source: 'registry',
    })
    expect(fixture.calls).toEqual([])
  })

  it('falls back when the stored credential cannot be opened, rather than failing the request', async () => {
    const fixture = catalogueApp({
      responders: {
        'api.openai.com': () => json({ object: 'list', data: [{ id: 'gpt-4.1' }] }),
      },
      models: { openai: [{ id: 'gpt-4.1', chat: true }] },
    })
    await fixture.putKey('openai', KEY_A)

    // Tamper with the sealed row the way a corrupted database row would be: the vault cannot
    // open it, and the catalogue must degrade rather than throw.
    const user = await fixture.test.currentUser()
    const stored = await fixture.test.credentials.get({ userId: user.id, name: 'openai' })
    expect(stored).not.toBeNull()
    const tampered = {
      ...stored!.sealed,
      ciphertext: `${stored!.sealed.ciphertext.slice(0, -2)}xx`,
    }
    await fixture.test.credentials.upsert(
      credentialUpsert(
        { userId: user.id, name: 'openai', body: { type: 'api_key', api_key: 'irrelevant' } },
        tampered,
        START.toISOString(),
      ),
    )
    // Saving the key also read the live catalogue — the automatic default model (epic #116,
    // U4) is picked against it — and that read cached a good answer for this (user, provider).
    // Drop it, so this read really has to open the tampered row.
    fixture.catalog.invalidate(user.id, 'openai')
    const callsBeforeRead = fixture.calls.length

    const response = await modelsOf(fixture)

    expect(statusOf(response, 'openai').status).toBe('fallback')
    expect(statusOf(response, 'openai').message).toContain('could not be opened')
    expect(idsOf(response)).toEqual(['openai/gpt-4.1'])
    // The degraded read dials nothing: the registry stands in (the key cannot be opened).
    expect(fixture.calls.length).toBe(callsBeforeRead)
  })

  it('answers an empty catalogue for a caller with no credentials at all', async () => {
    const fixture = catalogueApp({ responders: {} })

    const response = await modelsOf(fixture)

    expect(response).toEqual({ data: [], providers: [] })
  })
})

/**
 * The same catalogue over the **real** registry — the committed models.dev snapshot, not a
 * stub (#234). This is the acceptance case for the registry change: the limits a provider's
 * own list does not carry (`context_window`, `max_output_tokens`) are no longer `null` for
 * OpenAI and Anthropic, because the snapshot has them.
 */
describe('GET /v1/models over the bundled snapshot', () => {
  it('serves the context window and output limit the snapshot carries', async () => {
    const fixture = catalogueApp({
      registry: createBundledRegistry(),
      // The providers' own lists, with no limits on them: exactly the shape OpenAI's and
      // Anthropic's endpoints answer, which is why the join is the only source for these two.
      responders: {
        'api.openai.com': () =>
          json({ object: 'list', data: [{ id: 'gpt-5-mini', object: 'model' }] }),
        'api.anthropic.com': () => json({ data: [{ id: 'claude-haiku-4-5', type: 'model' }] }),
      },
    })

    await fixture.putKey('openai', KEY_A)
    await fixture.putKey('anthropic', KEY_A)
    const response = await modelsOf(fixture)

    expect(entryOf(response, 'openai/gpt-5-mini')).toMatchObject({
      name: 'GPT-5 Mini',
      context_window: 400000,
      max_output_tokens: 128000,
      source: 'provider',
    })
    expect(entryOf(response, 'anthropic/claude-haiku-4-5')).toMatchObject({
      name: 'Claude Haiku 4.5 (latest)',
      context_window: 200000,
      max_output_tokens: 64000,
      source: 'provider',
    })
  })

  it('drops the non-chat models the snapshot lists on a fallback, naming them from it', async () => {
    // The snapshot lists every model a provider serves; on a fallback (here: a provider the
    // adapter cannot dial) the catalogue's filter is what turns that into a picker's list.
    const fixture = catalogueApp({
      registry: createBundledRegistry(),
      responders: { 'api.groq.com': () => failure(500, 'down') },
    })

    await fixture.putKey('groq', KEY_A)
    const response = await modelsOf(fixture)

    expect(statusOf(response, 'groq').status).toBe('fallback')
    expect(idsOf(response).every((id) => id.startsWith('groq/'))).toBe(true)
    expect(idsOf(response).some((id) => /whisper|embed|tts/i.test(id))).toBe(false)
    expect(entryOf(response, 'groq/llama-3.3-70b-versatile').source).toBe('registry')
  })
})

/** One entry of a response, failing the test rather than returning `undefined`. */
function entryOf(response: ListModelsResponse, id: string): ModelEntry {
  const found = response.data.find((entry) => entry.id === id)
  expect(found, `no entry for ${id} in ${idsOf(response).join(', ')}`).toBeDefined()
  return found as ModelEntry
}

/** A 200 response with a JSON body. */
function json(body: unknown): ProviderResponse {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }
}
