/**
 * `@openharness/session/testing` — what a test needs from the session package: the in-memory
 * store again, so a test can import the store and everything it is tested with from one place,
 * and {@link createTestClock}, the controllable clock every store takes
 * (`new InMemorySessionStore({ now: clock.now })`).
 */

export * from '../index'
export { createTestClock } from './clock'
export type { TestClock } from './clock'
