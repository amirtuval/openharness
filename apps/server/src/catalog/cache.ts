/**
 * The catalogue's memory (epic #92, C4; issue #90): one entry per (user, provider), in this
 * process, with a one-hour TTL, and the refresh rate limit.
 *
 * Nothing here is durable — C4 keeps the cache out of Postgres on purpose: the answer is a
 * convenience over live provider calls, not state, and an instance that restarts can simply
 * ask the providers again. Entries are dropped when the credential they were made with is
 * saved or deleted (the PUT/DELETE routes call {@link CatalogCache.invalidate}), and expire
 * on their own otherwise; on a multi-instance deployment the other instances keep their
 * entries until the TTL passes, which is what C4 says to expect.
 *
 * {@link RefreshLimiter} is the other half of `?refresh=true`: bypassing the cache is a live
 * call to every one of the caller's providers, so it is allowed once a minute per user — and
 * the limiter is per process, like the cache, which bounds a client's foot-gun rather than
 * being an exact quota.
 */

import type { ModelEntry } from '@openharness/protocol'

/** How long a cached provider catalogue stays fresh: one hour (C4). */
export const DEFAULT_CATALOG_TTL_MS = 3_600_000

/** How often one user may bypass the cache with `?refresh=true`: once a minute (C4). */
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000

/**
 * One provider's answer, cached: the same facts a `ProviderCatalogStatus` reports plus the
 * models they came with. `models` are finished entries — the registry join already applied —
 * because the join is deterministic and re-running it per request would buy nothing.
 */
export interface CachedProviderCatalog {
  /** `ok` when the provider's own list answered; `fallback` for the registry's (C3). */
  readonly status: 'ok' | 'fallback'
  /** When the provider's list was fetched, ISO; `null` on a fallback. */
  readonly fetchedAt: string | null
  /** Why it fell back — already scrubbed of any credential; `null` when it did not. */
  readonly message: string | null
  /** The chat models, with their `source`. */
  readonly models: readonly ModelEntry[]
}

/** What one cache entry is keyed by: the caller and one of their providers. */
export interface CatalogCacheKey {
  readonly userId: string
  readonly provider: string
}

/** An entry as it is stored: the answer, and when it must be forgotten. */
interface CacheEntry {
  readonly value: CachedProviderCatalog
  readonly expiresAt: number
}

/** The in-memory, per-(user, provider) cache of provider catalogues. */
export class CatalogCache {
  private readonly entries = new Map<string, CacheEntry>()

  private readonly ttlMs: number

  constructor(options: { readonly ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS
  }

  /** The cached answer for a key, or `null` when there is none or it has expired. */
  get(key: CatalogCacheKey, now: Date = new Date()): CachedProviderCatalog | null {
    const entry = this.entries.get(cacheKey(key))
    if (entry === undefined) {
      return null
    }
    if (entry.expiresAt <= now.getTime()) {
      // Read-through expiry: an entry that is never asked for again is simply replaced by
      // the next write, and the map is bounded by (users × providers) either way.
      this.entries.delete(cacheKey(key))
      return null
    }
    return entry.value
  }

  /** Remember one provider's answer for {@link ttlMs}. */
  set(key: CatalogCacheKey, value: CachedProviderCatalog, now: Date = new Date()): void {
    this.entries.set(cacheKey(key), { value, expiresAt: now.getTime() + this.ttlMs })
  }

  /**
   * Forget one provider's answer for one user — what saving or deleting that credential does.
   *
   * Only this process's copy: another instance's entry expires by TTL (C4).
   */
  invalidate(userId: string, provider: string): void {
    this.entries.delete(cacheKey({ userId, provider }))
  }
}

/**
 * The `?refresh=true` rate limit: one refresh per user per {@link DEFAULT_REFRESH_INTERVAL_MS}.
 *
 * `tryAcquire` answers `true` and records the moment when the caller may refresh, and `false`
 * when the last refresh was too recent — the route turns that into the protocol's 429
 * `rate_limit_error`. Per user, not per provider, because one refresh re-fetches every
 * provider the caller has a key for.
 */
export class RefreshLimiter {
  private readonly lastRefresh = new Map<string, number>()

  private readonly intervalMs: number

  constructor(options: { readonly intervalMs?: number } = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  }

  /** Claim a refresh for this user, or answer `false` when the last one is too recent. */
  tryAcquire(userId: string, now: Date = new Date()): boolean {
    const last = this.lastRefresh.get(userId)
    if (last !== undefined && now.getTime() - last < this.intervalMs) {
      return false
    }
    this.lastRefresh.set(userId, now.getTime())
    return true
  }
}

/** The map key for one (user, provider) pair; a NUL cannot appear in either id. */
function cacheKey(key: CatalogCacheKey): string {
  return `${key.userId}\u0000${key.provider}`
}
