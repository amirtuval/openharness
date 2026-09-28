/**
 * `@openharness/session/testing` — what a test needs from the session package.
 *
 * Three things live here:
 *
 * - {@link InMemorySessionStore}, re-exported from the main entry so a test can import the
 *   store and the suite that tests it from one place.
 * - {@link createTestClock}, the controllable clock every store takes
 *   (`new InMemorySessionStore({ now: clock.now })`).
 * - {@link runSessionStoreConformance}, the suite an implementation has to pass — the
 *   in-memory store today, the Postgres store next:
 *
 * ```ts
 * import { InMemorySessionStore } from '@openharness/session'
 * import { runSessionStoreConformance } from '@openharness/session/testing'
 *
 * runSessionStoreConformance((clock) => new InMemorySessionStore({ now: clock.now }), {
 *   name: 'InMemorySessionStore',
 * })
 * ```
 *
 * The suite calls `describe`/`it` from `vitest`, so this entry point is for test code only: it
 * is a devDependency of every package that uses it, and never a runtime dependency.
 */

export * from '../index'
export { runSessionStoreConformance } from './conformance'
export type { MakeSessionStore, SessionStoreConformanceOptions } from './conformance'
export { createTestClock } from './clock'
export type { TestClock } from './clock'
