import type { Timestamp } from '@openharness/protocol'

/**
 * Time, as a store sees it.
 *
 * A store never reads the wall clock directly: it reads the {@link Clock} it was constructed
 * with. That is what makes the contract testable — the conformance suite hands every store a
 * clock it can advance, so lease expiry, steal-after-expiry and a `processed_at` in the future
 * are tested without timers and without waiting.
 */

/**
 * A source of the current time, in milliseconds since the Unix epoch.
 *
 * Implementations must be monotonically non-decreasing: everything the store dates — session
 * and agent `created_at`/`updated_at`, an event's `processed_at`, a lease's `expires_at` —
 * comes from this function, and a clock that moves backwards would make a stored log look
 * inconsistent.
 */
export type Clock = () => number

/** The clock a store uses when none is injected: the system clock. */
export const systemClock: Clock = () => Date.now()

/**
 * The instant a clock reading is written as: RFC 3339, UTC, millisecond precision.
 *
 * Every timestamp the store writes is `timestampAt(clock())` and nothing else, so a test can
 * predict the exact string a session, an agent, a `processed_at` or a lease carries: the
 * conformance suite asserts on it.
 *
 * @param milliseconds milliseconds since the Unix epoch
 */
export function timestampAt(milliseconds: number): Timestamp {
  return new Date(milliseconds).toISOString()
}
