/**
 * `@openharness/session` — the append-only session event log, and the store contracts around it.
 *
 * A session is a durable, ordered log of events: user messages, agent replies, session status
 * transitions and the spans that bracket every model request. It is the source of truth for a
 * run — replaying it reconstructs what happened — and the brain is stateless because of it.
 * Every agent and session belongs to one user (epic #65, A4), and a user's sealed
 * model-provider credentials live beside them (A5).
 *
 * This entry point exports:
 *
 * - **{@link SessionStore}** (`./store`) — the storage and signaling contract the brain and the
 *   server code against: agents, sessions, appending and reading events, live subscriptions,
 *   partition signals, the auth-session revocation channel (epic #65, A2), the per-user
 *   preferences and the owner-scoped `deleteSession` (#111), and the leases that fence a
 *   zombie writer out.
 * - **{@link CredentialStore}** (`./credentials`) — the sealed-blob storage contract for
 *   users' provider credentials: metadata in and out, the sealed form only for the one read
 *   the server's model path makes.
 * - **{@link McpServerStore}** (`./mcp-servers`) — the storage contract for users' remote MCP
 *   servers and their pending OAuth states (epic #303, X10): the resource's metadata in and
 *   out, the sealed header map, tokens and registered OAuth client only for the reads the
 *   server's connection check and token refresh make.
 * - **{@link InMemorySessionStore}** and **{@link InMemoryCredentialStore}** (`./memory`) —
 *   the in-memory implementations: the test fakes for every other package, and the reference
 *   behaviour for the contracts. **{@link InMemoryMcpServerStore}** is the third.
 * - **{@link Clock}** and {@link timestampAt} (`./clock`) — the injectable time source every
 *   store takes, so tests can move time instead of waiting for it.
 * - **{@link FencedError}**, {@link SessionNotFoundError}, {@link AgentNotFoundError},
 *   {@link DuplicateEventIdError}, {@link ClaimConflictError}, {@link DuplicateModeNameError},
 *   {@link ModeLimitReachedError}, {@link DuplicateMcpServerNameError},
 *   {@link McpServerLimitReachedError} (`./errors`) — the typed failures a store raises.
 *
 * Since #245 (M6) the contract also carries a user's **modes** — the named presets a chat can
 * follow — in `./store`: `createMode`, `getMode`, `listModes`, `updateMode` and `deleteMode`.
 *
 * `@openharness/session/testing` holds what tests need: the conformance suites every
 * implementation must pass (`runSessionStoreConformance`, `runCredentialStoreConformance`), a
 * controllable `TestClock`, and the in-memory stores again, so a test can import both from one
 * place.
 */

/** This package's name; a cheap way for a dependent to prove the import resolved. */
export const PACKAGE_NAME = '@openharness/session'

export * from './clock'
export * from './credentials'
export * from './errors'
export * from './mcp-servers'
export * from './memory'
export * from './store'
