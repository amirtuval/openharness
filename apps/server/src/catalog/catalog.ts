/**
 * The model catalogue (epic #92; issue #90): what `GET /v1/models` answers.
 *
 * For every provider the caller has a stored credential for (C5) — and only those — the
 * catalogue calls that provider's own list endpoint with the caller's key (C1), joins the
 * registry onto what comes back (C2), filters to chat models, and caches the result per
 * (user, provider) for an hour (C4). A provider that fails, times out (5 s) or has no known
 * list endpoint is served from the registry instead, reported as `fallback` (C3) — never
 * silently, and never with any part of a key in the message.
 *
 * The key never leaves this module: it is opened from the vault for the one call (the same
 * `openApiKey` path the brain's credential resolver uses), goes into a request header, and is
 * scrubbed out of anything the provider said before that text becomes a `message` or a log
 * line (`redactSecret`, the brain's redaction).
 *
 * ```ts
 * const catalog = new ModelCatalog({ credentials, vault, registry, fetch })
 * const response = await catalog.list(user.id, { refresh: query.refresh === true })
 * ```
 */

import {
  ListModelsResponseSchema,
  type ListModelsResponse,
  type ModelEntry,
  type ProviderCatalogStatus,
} from '@openharness/protocol'
import type { CredentialStore } from '@openharness/session'
import type { Vault } from '@openharness/vault'
import { redactSecret } from '@openharness/brain'

import { openApiKey } from '../credentials'
import type { Logger } from '../types'
import { adapterFor, type ProviderAdapter, type ProviderModel } from './adapters'
import { CatalogCache, RefreshLimiter, type CachedProviderCatalog } from './cache'
import { isChatModel } from './filter'
import type { ModelRegistry, RegistryModel } from './registry'
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type ProviderFetch,
  type ProviderResponse,
} from './provider-fetch'

/**
 * A `?refresh=true` request inside the once-a-minute window (C4). The route turns this into
 * the protocol's 429 `rate_limit_error`; nothing else in the server throws it.
 */
export class CatalogRefreshLimitedError extends Error {
  constructor() {
    super('the model catalog was refreshed less than a minute ago; try again shortly')
    this.name = 'CatalogRefreshLimitedError'
  }
}

/** What the catalogue needs. Every seam is explicit: nothing here reaches a network by default. */
export interface ModelCatalogOptions {
  /** The caller's sealed credentials; read per request, opened per provider call. */
  readonly credentials: Pick<CredentialStore, 'list' | 'get'>
  /** The vault that opens a sealed credential for one call. */
  readonly vault: Vault
  /** Where metadata and the fallback lists come from — the bundled models.dev snapshot. */
  readonly registry: ModelRegistry
  /** How a provider is reached; the production one is `createProviderFetch()`. */
  readonly fetch: ProviderFetch
  /** The per-(user, provider) cache; a fresh one per process by default. */
  readonly cache?: CatalogCache
  /** The `?refresh=true` rate limit; a fresh limiter per process by default. */
  readonly refreshLimiter?: RefreshLimiter
  /** How long one provider's list may take; {@link DEFAULT_PROVIDER_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number
  /** The clock, for TTLs and `fetched_at`; injectable for tests. */
  readonly now?: () => Date
  /** Where a fallback is explained — provider and reason only, never a key. */
  readonly logger?: Logger
}

/**
 * How many pages one provider's list may span. Every endpoint this server calls returns the
 * whole catalogue in one page (they are asked for a page size of 1000); the cap is only there
 * so a provider that pages forever cannot hold the request open past its deadline.
 */
const MAX_PAGES = 10

/** How much of a provider's error body a fallback message may carry. */
const ERROR_SNIPPET_LENGTH = 200

/** The model catalogue: the same operations `GET /v1/models` serves. */
export class ModelCatalog {
  private readonly credentials: ModelCatalogOptions['credentials']

  private readonly vault: Vault

  private readonly registry: ModelRegistry

  private readonly fetch: ProviderFetch

  private readonly cache: CatalogCache

  private readonly refreshLimiter: RefreshLimiter

  private readonly timeoutMs: number

  private readonly now: () => Date

  private readonly logger: Logger | undefined

  constructor(options: ModelCatalogOptions) {
    this.credentials = options.credentials
    this.vault = options.vault
    this.registry = options.registry
    this.fetch = options.fetch
    this.cache = options.cache ?? new CatalogCache()
    this.refreshLimiter = options.refreshLimiter ?? new RefreshLimiter()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger
  }

  /**
   * The caller's chat models and one status per provider they have a credential for (C5).
   *
   * @param userId the signed-in caller; only their credentials are read
   * @param options `refresh: true` bypasses the cache — once a minute per user
   * @throws CatalogRefreshLimitedError when refreshing inside the rate-limit window
   */
  async list(
    userId: string,
    options: { readonly refresh?: boolean } = {},
  ): Promise<ListModelsResponse> {
    const now = this.now()
    const refresh = options.refresh === true
    if (refresh && !this.refreshLimiter.tryAcquire(userId, now)) {
      throw new CatalogRefreshLimitedError()
    }

    const credentials = await this.credentials.list({ userId })
    const providers = [...new Set(credentials.map((credential) => credential.provider))]
    const catalogs = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        catalog: await this.forProvider({ userId, provider, refresh, now }),
      })),
    )

    const data = catalogs.flatMap(({ catalog }) => [...catalog.models]).sort(compareModelEntries)
    const statuses = catalogs
      .map(({ provider, catalog }) => statusOf(provider, catalog))
      .sort((a, b) => compareStrings(a.provider, b.provider))

    // The response is built from typed pieces, so this parse only ever fails on a bug here —
    // and then the caller gets a 500 and the log gets the schema error, not a shape the
    // client's own schema would reject.
    return ListModelsResponseSchema.parse({ data, providers: statuses })
  }

  /**
   * Forget one provider's cached answer for one user — what the credential PUT/DELETE routes
   * call. Only this instance's copy; other instances expire by TTL (C4).
   */
  invalidate(userId: string, provider: string): void {
    this.cache.invalidate(userId, provider)
  }

  /** One provider's answer: from the cache, or a fresh provider call (or its fallback). */
  private async forProvider(input: {
    readonly userId: string
    readonly provider: string
    readonly refresh: boolean
    readonly now: Date
  }): Promise<CachedProviderCatalog> {
    const key = { userId: input.userId, provider: input.provider }
    if (!input.refresh) {
      const cached = this.cache.get(key, input.now)
      if (cached !== null) {
        return cached
      }
    }
    const catalog = await this.fetchProvider(input.userId, input.provider)
    this.cache.set(key, catalog, input.now)
    return catalog
  }

  /**
   * One provider's catalogue, from the provider or the registry.
   *
   * The credential is read and opened here and only here: the plaintext lives for the one
   * call. Anything that goes wrong — no adapter, an unreadable credential, a failed request, a
   * timeout, an unexpected payload — becomes the provider's registry fallback with a message
   * that says which, scrubbed of the key.
   */
  private async fetchProvider(userId: string, provider: string): Promise<CachedProviderCatalog> {
    const adapter = adapterFor(provider)
    if (adapter === null) {
      return this.registryFallback(provider, `no known model-list endpoint for ${provider}`)
    }
    const stored = await this.credentials.get({ userId, provider })
    if (stored === null) {
      return this.registryFallback(provider, `the stored ${provider} credential could not be read`)
    }
    const apiKey = await openApiKey(this.vault, { userId, provider, sealed: stored.sealed })
    if (apiKey === null) {
      return this.registryFallback(
        provider,
        `the stored ${provider} credential could not be opened`,
      )
    }
    try {
      const listed = await this.fetchFromProvider(adapter, apiKey)
      return {
        status: 'ok',
        fetchedAt: this.now().toISOString(),
        message: null,
        models: this.joinProviderList(provider, listed),
      }
    } catch (error) {
      const message = redactSecret(describeFailure(provider, error, this.timeoutMs), apiKey)
      this.logger?.warn(`serving the registry's ${provider} models: ${message}`)
      return this.registryFallback(provider, message)
    }
  }

  /** Fetch the provider's whole list, one page at a time, inside the one deadline. */
  private async fetchFromProvider(
    adapter: ProviderAdapter,
    apiKey: string,
  ): Promise<readonly ProviderModel[]> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    const models: ProviderModel[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.fetch(adapter.url(cursor), {
        headers: adapter.headers(apiKey),
        signal,
      })
      if (!response.ok) {
        throw new CatalogProviderError(
          `the ${adapter.provider} model list answered ${response.status}` +
            (await errorSnippet(response)),
        )
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new CatalogProviderError(`the ${adapter.provider} model list was not JSON`)
      }
      let parsed: { readonly models: readonly ProviderModel[]; readonly next: string | null }
      try {
        parsed = adapter.parse(body)
      } catch (error) {
        throw new CatalogProviderError(
          `the ${adapter.provider} model list was not the expected shape: ` +
            (error instanceof Error ? error.message : 'unreadable'),
        )
      }
      models.push(...parsed.models)
      cursor = parsed.next
      if (cursor === null) {
        break
      }
    }
    return models
  }

  /**
   * The provider's own list, joined with the registry and filtered to chat models (C2).
   *
   * The registry lookup is per provider, once: `RegistryModel` carries what the installed
   * registry knows (in this version, the id), and every field the provider's own entry leaves
   * empty is filled from it where it can be.
   */
  private joinProviderList(provider: string, listed: readonly ProviderModel[]): ModelEntry[] {
    const known = this.registryIndex(provider)
    return dedupe(
      listed.flatMap((raw) => {
        const registry = known.get(raw.id)
        if (!isChatModel({ rawId: raw.id, providerChat: raw.chat, registryChat: registry?.chat })) {
          return []
        }
        return [entryOf(provider, raw, registry, 'provider')]
      }),
    )
  }

  /**
   * A provider's chat models from the registry alone (C3): the provider failed, timed out, or
   * has no list endpoint this server knows. The filter is the same one the provider's own list
   * goes through, with no provider capability data to consult.
   */
  private registryFallback(provider: string, message: string): CachedProviderCatalog {
    const models = dedupe(
      this.registry
        .models(provider)
        .filter((model) => isChatModel({ rawId: model.id, registryChat: model.chat }))
        .map((model) => entryOf(provider, { id: model.id }, model, 'registry')),
    )
    return { status: 'fallback', fetchedAt: null, message, models }
  }

  /** The registry's entries for one provider, by raw id, for the join. */
  private registryIndex(provider: string): ReadonlyMap<string, RegistryModel> {
    return new Map(this.registry.models(provider).map((model) => [model.id, model]))
  }
}

// ------------------------------------------------------------------ building entries

/** One entry: the provider's own facts, the registry's where the provider had none. */
function entryOf(
  provider: string,
  raw: ProviderModel,
  registry: RegistryModel | undefined,
  source: ModelEntry['source'],
): ModelEntry {
  return {
    id: `${provider}/${raw.id}`,
    provider,
    name: firstNonEmpty(raw.name, registry?.name, `${provider}/${raw.id}`),
    context_window: raw.contextWindow ?? registry?.contextWindow ?? null,
    max_output_tokens: raw.maxOutput ?? registry?.maxOutput ?? null,
    // Prices are the registry's alone (epic #245, A2): no provider's list-models payload
    // carries what it charges, and a model models.dev does not price has `null` here rather
    // than a guess — its requests report tokens and no cost.
    cost: registry?.cost ?? null,
    source,
  }
}

/** The first value that carries a name; the model id is the last resort. */
function firstNonEmpty(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) {
      return value
    }
  }
  // firstNonEmpty is only called with the id as its final argument, which is never empty.
  throw new Error('a model entry had no name at all')
}

/** One entry per id, first one wins: a provider that repeats an id gets it listed once. */
function dedupe(entries: readonly ModelEntry[]): ModelEntry[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false
    }
    seen.add(entry.id)
    return true
  })
}

/** The protocol's order: by provider, then by name (case-insensitively), then by id. */
function compareModelEntries(a: ModelEntry, b: ModelEntry): number {
  const byProvider = compareStrings(a.provider, b.provider)
  if (byProvider !== 0) {
    return byProvider
  }
  const byName = compareStrings(a.name.toLowerCase(), b.name.toLowerCase())
  return byName !== 0 ? byName : compareStrings(a.id, b.id)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** One provider's outcome, as the wire reports it. */
function statusOf(provider: string, catalog: CachedProviderCatalog): ProviderCatalogStatus {
  return {
    provider,
    status: catalog.status,
    fetched_at: catalog.fetchedAt,
    message: catalog.message,
  }
}

// ------------------------------------------------------------------ failures

/** A failure this module raised itself; its message is already the story to report. */
class CatalogProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogProviderError'
  }
}

/** What to tell a caller about a provider call that did not produce a list. */
function describeFailure(provider: string, error: unknown, timeoutMs: number): string {
  if (error instanceof CatalogProviderError) {
    return error.message
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `the ${provider} model list did not answer within ${timeoutMs / 1000} seconds`
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null
  const detail = error instanceof Error ? (cause ?? error.message) : String(error)
  return `could not reach ${provider}: ${detail}`
}

/** `: <up to 200 characters of the body>` for an error response, or nothing readable. */
async function errorSnippet(response: ProviderResponse): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return ''
  }
  const snippet = body.trim().replace(/\s+/g, ' ').slice(0, ERROR_SNIPPET_LENGTH)
  return snippet.length === 0 ? '' : `: ${snippet}`
}
