import type { Clock } from '../clock'

/**
 * A clock a test moves by hand.
 *
 * The store contract takes a {@link Clock}, and this is the one the conformance suite hands
 * every store, so that lease expiry, steal-after-expiry and `processed_at` are tested by
 * moving time rather than by waiting for it: no timers, no sleeping, no flakiness — and the
 * same suite works for a Postgres store, which has to consult the injected clock instead of
 * the database's `now()` for the same reason.
 *
 * ```ts
 * const clock = createTestClock()
 * const store = new InMemorySessionStore({ now: clock.now })
 * const lease = await store.acquirePartition(0, 'owner-1', 30_000)
 * clock.advance(30_000)
 * await store.acquirePartition(0, 'owner-2', 30_000) // steals it; `lease` is now fenced
 * ```
 */
export interface TestClock {
  /**
   * The clock to give the store. A plain function property on purpose, so it can be passed
   * unbound: `new InMemorySessionStore({ now: clock.now })`.
   */
  readonly now: Clock

  /** The instant the clock is at, in milliseconds since the Unix epoch. */
  readonly currentMs: number

  /**
   * Move the clock forward by `ms` milliseconds.
   *
   * @throws RangeError when `ms` is negative or not a finite number: a test clock never runs
   *   backwards, because a store's timestamps and epochs are supposed to be monotonic
   */
  advance(ms: number): void
}

/**
 * A {@link TestClock} starting at `startMs` — a fixed instant by default, so that timestamps
 * in a test are predictable rather than "whenever the suite ran".
 *
 * @param startMs the instant to start at; defaults to the wall clock's
 */
export function createTestClock(startMs: number = Date.now()): TestClock {
  let current = startMs
  return {
    now: () => current,
    get currentMs(): number {
      return current
    },
    advance(ms: number): void {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`a test clock only moves forward, got ${ms}ms`)
      }
      current += ms
    },
  }
}
