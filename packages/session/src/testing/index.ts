/**
 * `@openharness/session/testing` — what a test needs from the session package.
 *
 * What lives here:
 *
 * - {@link InMemorySessionStore}, {@link InMemoryCredentialStore} and
 *   {@link InMemoryMcpServerStore}, re-exported from the main entry so a test can import a
 *   store and the suite that tests it from one place.
 * - {@link createTestClock}, the controllable clock every store takes
 *   (`new InMemorySessionStore({ now: clock.now })`).
 * - {@link runSessionStoreConformance}, {@link runCredentialStoreConformance} and
 *   {@link runMcpServerStoreConformance}, the suites an implementation has to pass — the
 *   in-memory stores today, the Postgres ones next:
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
 * The suites call `describe`/`it` from `vitest`, so this entry point is for test code only: it
 * is a devDependency of every package that uses it, and never a runtime dependency.
 */

export * from '../index'
export { runSessionStoreConformance, OWNER_A, OWNER_B } from './conformance'
export type { MakeSessionStore, SessionStoreConformanceOptions } from './conformance'
export { runCredentialStoreConformance } from './credentials-conformance'
export { runMcpServerStoreConformance } from './mcp-servers-conformance'
export type {
  CredentialStoreConformanceOptions,
  MakeCredentialStore,
} from './credentials-conformance'
export type {
  MakeMcpServerStore,
  McpServerStoreConformanceOptions,
} from './mcp-servers-conformance'
export { createTestClock } from './clock'
export type { TestClock } from './clock'
