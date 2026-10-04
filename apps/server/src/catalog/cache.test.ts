import { describe, expect, it } from 'vitest'

import {
  CatalogCache,
  DEFAULT_CATALOG_TTL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  RefreshLimiter,
  type CachedProviderCatalog,
} from './cache'

/**
 * The catalogue's memory (C4): the one-hour TTL per (user, provider), the invalidation a
 * credential write performs, and the once-a-minute refresh limit. All of it on an injected
 * clock, so the assertions are about the rules rather than about waiting.
 */

/** A small cached answer, distinguishable from any other by its `fetchedAt`. */
function answer(fetchedAt: string): CachedProviderCatalog {
  return { status: 'ok', fetchedAt, message: null, models: [] }
}

const AT = new Date('2026-10-04T12:00:00.000Z')

/** A moment `ms` after {@link AT}. */
function after(ms: number): Date {
  return new Date(AT.getTime() + ms)
}

describe('CatalogCache', () => {
  it('defaults to one hour, and answers what it was given inside the TTL', () => {
    expect(DEFAULT_CATALOG_TTL_MS).toBe(3_600_000)
    const cache = new CatalogCache()
    const key = { userId: 'user_a', provider: 'openai' }

    cache.set(key, answer('first'), AT)

    expect(cache.get(key, after(DEFAULT_CATALOG_TTL_MS - 1))?.fetchedAt).toBe('first')
    // An hour after the write the answer is stale, to the millisecond.
    expect(cache.get(key, after(DEFAULT_CATALOG_TTL_MS))).toBeNull()
  })

  it('keys by user and provider: one user’s entry is never another’s, nor another provider’s', () => {
    const cache = new CatalogCache()
    cache.set({ userId: 'user_a', provider: 'openai' }, answer('a-openai'), AT)

    expect(cache.get({ userId: 'user_b', provider: 'openai' }, AT)).toBeNull()
    expect(cache.get({ userId: 'user_a', provider: 'anthropic' }, AT)).toBeNull()
    expect(cache.get({ userId: 'user_a', provider: 'openai' }, AT)?.fetchedAt).toBe('a-openai')
  })

  it('invalidate drops exactly one (user, provider) entry', () => {
    const cache = new CatalogCache()
    cache.set({ userId: 'user_a', provider: 'openai' }, answer('a-openai'), AT)
    cache.set({ userId: 'user_a', provider: 'anthropic' }, answer('a-anthropic'), AT)
    cache.set({ userId: 'user_b', provider: 'openai' }, answer('b-openai'), AT)

    cache.invalidate('user_a', 'openai')

    expect(cache.get({ userId: 'user_a', provider: 'openai' }, AT)).toBeNull()
    expect(cache.get({ userId: 'user_a', provider: 'anthropic' }, AT)?.fetchedAt).toBe(
      'a-anthropic',
    )
    expect(cache.get({ userId: 'user_b', provider: 'openai' }, AT)?.fetchedAt).toBe('b-openai')
  })

  it('honors a shorter TTL, which is what a test with a clock uses', () => {
    const cache = new CatalogCache({ ttlMs: 50 })
    const key = { userId: 'user_a', provider: 'openai' }
    cache.set(key, answer('first'), AT)

    expect(cache.get(key, after(49))?.fetchedAt).toBe('first')
    expect(cache.get(key, after(50))).toBeNull()
  })
})

describe('RefreshLimiter', () => {
  it('defaults to once a minute, per user', () => {
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(60_000)
    const limiter = new RefreshLimiter()

    expect(limiter.tryAcquire('user_a', AT)).toBe(true)
    expect(limiter.tryAcquire('user_a', after(59_999))).toBe(false)
    expect(limiter.tryAcquire('user_a', after(DEFAULT_REFRESH_INTERVAL_MS))).toBe(true)
    // Per user, not global: another caller is not held back by the first one's refresh.
    expect(limiter.tryAcquire('user_b', after(1))).toBe(true)
  })

  it('records the attempt even when the caller does not go on to refresh', () => {
    const limiter = new RefreshLimiter({ intervalMs: 100 })
    expect(limiter.tryAcquire('user_a', AT)).toBe(true)
    // The claim is consumed by the call itself: there is no release, so a client that
    // refreshes and then immediately refreshes again is refused.
    expect(limiter.tryAcquire('user_a', after(99))).toBe(false)
    expect(limiter.tryAcquire('user_a', after(100))).toBe(true)
  })
})
