import { MAX_MCP_SERVERS_PER_USER, McpServerSchema, type UserId } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { timestampAt } from '../clock'
import type { SealedSecret } from '../credentials'
import { DuplicateMcpServerNameError, McpServerLimitReachedError } from '../errors'
import type { CreateMcpServerInput, McpServerStore, UpdateMcpServerInput } from '../mcp-servers'
import { type TestClock, createTestClock } from './clock'
import { OWNER_A, OWNER_B } from './conformance'

/**
 * The conformance suite every `McpServerStore` implementation has to pass (epic #303, X10).
 *
 * It is the contract's executable form: `InMemoryMcpServerStore` passes it today, and
 * `PostgresMcpServerStore` must pass the same suite unchanged. That is why it only asks for
 * what the contract promises — a name unique per user and a cap, owner scoping, a metadata-only
 * list, patched updates that keep what they omit and clear a `null` secret, single-use
 * short-lived OAuth states, and answers that cannot be written to — and never reaches into an
 * implementation.
 *
 * ## Writing the factory
 *
 * ```ts
 * import { InMemoryMcpServerStore } from '@openharness/session'
 *
 * runMcpServerStoreConformance(
 *   (clock) => new InMemoryMcpServerStore({ now: clock.now }),
 *   { name: 'InMemoryMcpServerStore' },
 * )
 * ```
 *
 * The factory is called once per test with a fresh {@link TestClock}, and the store it returns
 * must take its time from that clock: the timestamps, and an OAuth state's expiry, are the
 * clock's, which is how the suite checks both without sleeping. For a store whose schema
 * references Better Auth's `"user"` rows (Postgres), pass an `ensureUsers` that creates the
 * suite's two owners, exactly as the credential suite's does.
 *
 * The blob the suite seals is a fixture, not a vault: the fields are distinct strings, so a
 * test can say what came back out. No implementation may depend on their contents.
 */
export function runMcpServerStoreConformance(
  makeStore: MakeMcpServerStore,
  options: McpServerStoreConformanceOptions = {},
): void {
  const name = options.name ?? 'McpServerStore'

  /** A store for one test, built on a clock that test can move, with the suite's users seeded. */
  async function setup(): Promise<{ store: McpServerStore; clock: TestClock }> {
    const clock = createTestClock(START_MS)
    const store = await makeStore(clock)
    await options.ensureUsers?.([OWNER_A, OWNER_B])
    return { store, clock }
  }

  /** A create body with the suite's defaults, overridable field by field. */
  function draft(overrides: Partial<CreateMcpServerInput> = {}): CreateMcpServerInput {
    return {
      ownerId: OWNER_A,
      name: 'notes',
      url: 'https://mcp.example.com/mcp',
      auth: 'none',
      enabled: true,
      status: 'connected',
      lastError: null,
      headerNames: [],
      tools: [],
      definitionTokens: 0,
      lastTestedAt: null,
      ...overrides,
    }
  }

  describe(`${name} conformance`, () => {
    describe('create', () => {
      it('stores a server and answers its metadata under a fresh mcps_ id', async () => {
        const { store, clock } = await setup()
        const server = await store.create(
          draft({
            tools: [{ name: 'search', description: 'Search notes', definition_tokens: 12 }],
            definitionTokens: 12,
            lastTestedAt: timestampAt(clock.currentMs),
          }),
        )
        expect(server.id).toMatch(/^mcps_/)
        expect(server).toMatchObject({
          type: 'mcp_server',
          owner_id: OWNER_A,
          name: 'notes',
          url: 'https://mcp.example.com/mcp',
          auth: 'none',
          enabled: true,
          status: 'connected',
          last_error: null,
          header_names: [],
          definition_tokens: 12,
          created_at: timestampAt(clock.currentMs),
          updated_at: timestampAt(clock.currentMs),
        })
        // The answer is the protocol's resource, exactly, and never a sealed field.
        expectExact(McpServerSchema, server, 'server metadata')
        expect(server).not.toHaveProperty('headers')
        expect(server).not.toHaveProperty('tokens')
      })

      it('hands the sealed blobs back only through get', async () => {
        const { store } = await setup()
        const created = await store.create(
          draft({
            auth: 'headers',
            headerNames: ['Authorization'],
            secrets: { headers: sealedSecret('headers') },
          }),
        )
        const record = await store.get(created.id, { ownerId: OWNER_A })
        expect(record?.headers).toStrictEqual(sealedSecret('headers'))
        // A `none`/`headers` server has no token or client blob, and the record says so by
        // their absence rather than an empty object.
        expect(record).not.toHaveProperty('tokens')
        expect(record).not.toHaveProperty('oauthClient')
      })

      it('refuses a second server with the same name for one user, and allows it for another', async () => {
        const { store } = await setup()
        await store.create(draft())
        // `thrownBy` rather than `.rejects`: the in-memory store runs its whole body before it
        // answers, so a refusal it raises is a synchronous throw, not a rejected promise.
        expect(await thrownBy(() => store.create(draft()))).toBeInstanceOf(
          DuplicateMcpServerNameError,
        )
        // The same name is a different user's to take: uniqueness is per owner.
        expect(await store.create(draft({ ownerId: OWNER_B }))).toMatchObject({
          owner_id: OWNER_B,
        })
      })

      it('refuses the server past the per-user cap', async () => {
        const { store } = await setup()
        for (let i = 0; i < MAX_MCP_SERVERS_PER_USER; i += 1) {
          await store.create(draft({ name: `server-${i}` }))
        }
        expect(await thrownBy(() => store.create(draft({ name: 'one-too-many' })))).toBeInstanceOf(
          McpServerLimitReachedError,
        )
      })

      it('caps a user at MAX_MCP_SERVERS_PER_USER however many creates race for the last slot', async () => {
        // The cap is a count followed by an insert, so the store has to make the two one
        // critical section — a transaction alone does not, and two creates at the limit would
        // each read a count below it and both insert (the Postgres store takes a per-owner
        // advisory lock first, and the in-memory store is serial by construction).
        const { store } = await setup()
        const attempts = MAX_MCP_SERVERS_PER_USER + 5
        const results = await Promise.allSettled(
          // Deferred to a microtask: the in-memory store refuses synchronously, so a bare call
          // would throw while the array is being built rather than settling as a rejection.
          Array.from({ length: attempts }, (_, index) =>
            Promise.resolve().then(() => store.create(draft({ name: `raced-${index}` }))),
          ),
        )
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
          MAX_MCP_SERVERS_PER_USER,
        )
        expect(await store.list({ ownerId: OWNER_A })).toHaveLength(MAX_MCP_SERVERS_PER_USER)
      })
    })

    describe('get, list and ownership', () => {
      it('scopes every read and write to the owner', async () => {
        const { store } = await setup()
        const mine = await store.create(draft())
        expect(await store.get(mine.id, { ownerId: OWNER_B })).toBeNull()
        expect(await store.get(mine.id, { ownerId: OWNER_A })).not.toBeNull()
        expect(await store.list({ ownerId: OWNER_B })).toEqual([])
        expect(await store.update(mine.id, { ownerId: OWNER_B }, { name: 'theirs' })).toBeNull()
        expect(await store.delete(mine.id, { ownerId: OWNER_B })).toBe(false)
      })

      it('lists oldest first and never with a sealed field', async () => {
        const { store, clock } = await setup()
        const first = await store.create(
          draft({ name: 'first', secrets: { headers: sealedSecret('h') } }),
        )
        clock.advance(SECOND)
        const second = await store.create(draft({ name: 'second' }))
        const listed = await store.list({ ownerId: OWNER_A })
        expect(listed.map((server) => server.name)).toEqual(['first', 'second'])
        for (const server of listed) {
          expectExact(McpServerSchema, server, 'listed server')
          expect(server).not.toHaveProperty('headers')
        }
        expect(listed.map((server) => server.id)).toEqual([first.id, second.id])
      })

      it('answers a frozen value a caller cannot write through', async () => {
        const { store } = await setup()
        const server = await store.create(draft())
        expect(() => {
          ;(server as { name: string }).name = 'rewritten'
        }).toThrow()
      })
    })

    describe('update', () => {
      it('keeps what the patch omits and moves updated_at', async () => {
        const { store, clock } = await setup()
        const created = await store.create(draft({ secrets: { headers: sealedSecret('keep') } }))
        clock.advance(SECOND)
        const updated = await store.update(created.id, { ownerId: OWNER_A }, { enabled: false })
        expect(updated).toMatchObject({
          name: 'notes',
          url: 'https://mcp.example.com/mcp',
          enabled: false,
          created_at: created.created_at,
          updated_at: timestampAt(clock.currentMs),
        })
        // The omitted secret is untouched.
        const record = await store.get(created.id, { ownerId: OWNER_A })
        expect(record?.headers).toStrictEqual(sealedSecret('keep'))
      })

      it('replaces a patched secret and clears one set to null', async () => {
        const { store } = await setup()
        const created = await store.create(
          draft({
            auth: 'oauth',
            secrets: { tokens: sealedSecret('t1'), oauthClient: sealedSecret('c1') },
          }),
        )
        await store.update(
          created.id,
          { ownerId: OWNER_A },
          {
            auth: 'headers',
            headerNames: ['Authorization'],
            secrets: { headers: sealedSecret('h1'), tokens: null, oauthClient: null },
          },
        )
        const record = await store.get(created.id, { ownerId: OWNER_A })
        expect(record?.headers).toStrictEqual(sealedSecret('h1'))
        expect(record).not.toHaveProperty('tokens')
        expect(record).not.toHaveProperty('oauthClient')
      })

      it('refuses a rename onto a name the owner already has', async () => {
        const { store } = await setup()
        await store.create(draft({ name: 'first' }))
        const second = await store.create(draft({ name: 'second' }))
        expect(
          await thrownBy(() => store.update(second.id, { ownerId: OWNER_A }, { name: 'first' })),
        ).toBeInstanceOf(DuplicateMcpServerNameError)
      })

      it('clears last_error with an explicit null', async () => {
        const { store } = await setup()
        const created = await store.create(
          draft({ status: 'error', lastError: 'the server refused the connection' }),
        )
        const updated = await store.update(
          created.id,
          { ownerId: OWNER_A },
          { status: 'connected', lastError: null },
        )
        expect(updated).toMatchObject({ status: 'connected', last_error: null })
      })
    })

    describe('delete', () => {
      it('removes the server and answers true, false for an unknown id', async () => {
        const { store } = await setup()
        const created = await store.create(draft())
        expect(await store.delete(created.id, { ownerId: OWNER_A })).toBe(true)
        expect(await store.get(created.id, { ownerId: OWNER_A })).toBeNull()
        expect(await store.delete(created.id, { ownerId: OWNER_A })).toBe(false)
      })
    })

    describe('OAuth states', () => {
      it('consumes a state once, handing back what the callback needs', async () => {
        const { store, clock } = await setup()
        const server = await store.create(draft({ auth: 'oauth' }))
        await store.createOAuthState({
          state: 'state-1',
          userId: OWNER_A,
          serverId: server.id,
          codeVerifier: 'verifier-1',
          client: 'cli',
          expiresAt: timestampAt(clock.currentMs + 10 * SECOND),
        })
        // The client the flow was started from comes back with the rest: the callback is
        // reached without a session and answers the state's user, server and origin (#311).
        expect(await store.consumeOAuthState('state-1')).toEqual({
          userId: OWNER_A,
          serverId: server.id,
          codeVerifier: 'verifier-1',
          client: 'cli',
        })
        // Single use: the row is gone whatever the expiry.
        expect(await store.consumeOAuthState('state-1')).toBeNull()
      })

      it('refuses an expired state and answers nothing for an unknown one', async () => {
        const { store, clock } = await setup()
        const server = await store.create(draft({ auth: 'oauth' }))
        await store.createOAuthState({
          state: 'state-1',
          userId: OWNER_A,
          serverId: server.id,
          codeVerifier: 'verifier-1',
          client: 'web',
          expiresAt: timestampAt(clock.currentMs + SECOND),
        })
        clock.advance(SECOND)
        expect(await store.consumeOAuthState('state-1')).toBeNull()
        expect(await store.consumeOAuthState('never-existed')).toBeNull()
      })

      it('replaces a pending state for the same (user, server)', async () => {
        const { store, clock } = await setup()
        const server = await store.create(draft({ auth: 'oauth' }))
        await store.createOAuthState({
          state: 'first',
          userId: OWNER_A,
          serverId: server.id,
          codeVerifier: 'v1',
          client: 'web',
          expiresAt: timestampAt(clock.currentMs + 10 * SECOND),
        })
        await store.createOAuthState({
          state: 'second',
          userId: OWNER_A,
          serverId: server.id,
          codeVerifier: 'v2',
          client: 'web',
          expiresAt: timestampAt(clock.currentMs + 10 * SECOND),
        })
        expect(await store.consumeOAuthState('first')).toBeNull()
        expect(await store.consumeOAuthState('second')).toMatchObject({ codeVerifier: 'v2' })
      })
    })

    describe('a non-default update shape', () => {
      it('applies every scalar field of a patch', async () => {
        const { store } = await setup()
        const created = await store.create(draft())
        const patch: UpdateMcpServerInput = {
          name: 'renamed',
          url: 'https://other.example.com/mcp',
          auth: 'oauth',
          enabled: false,
          status: 'needs_reconnect',
          headerNames: [],
          tools: [{ name: 'ping', description: null, definition_tokens: 3 }],
          definitionTokens: 3,
          lastTestedAt: null,
        }
        const updated = await store.update(created.id, { ownerId: OWNER_A }, patch)
        expect(updated).toMatchObject({
          name: 'renamed',
          url: 'https://other.example.com/mcp',
          auth: 'oauth',
          enabled: false,
          status: 'needs_reconnect',
          definition_tokens: 3,
          last_tested_at: null,
        })
        expect(updated?.tools).toEqual([{ name: 'ping', description: null, definition_tokens: 3 }])
      })
    })
  })
}

/** How a conformance test builds the store under test. */
export type MakeMcpServerStore = (clock: TestClock) => McpServerStore | Promise<McpServerStore>

/** How to title the suite in a report. */
export interface McpServerStoreConformanceOptions {
  /** The implementation's name; the suite's blocks are titled `${name} conformance`. */
  readonly name?: string
  /**
   * Makes sure the given users exist, for a store whose schema references them — the Postgres
   * table's `owner_id` is a foreign key into Better Auth's `"user"` row. Called once per test,
   * after the factory; a store without users leaves it out.
   */
  readonly ensureUsers?: (userIds: readonly UserId[]) => Promise<void>
}

/** The instant every test's clock starts at; fixed, so a timestamp in a failure is readable. */
const START_MS = Date.UTC(2026, 2, 15, 10, 0, 0)

/** One second in milliseconds; the suite moves its clock in these. */
const SECOND = 1000

/**
 * A sealed secret for a test: distinct, recognizable strings per {@link tag}, so a test can
 * say exactly what came back out. A real one comes from `@openharness/vault`; the store treats
 * every field as opaque, so a fixture is as good as a ciphertext here — `keyProvider` included,
 * whose value is a made-up provider name because the store must not know any.
 */
function sealedSecret(tag: string): SealedSecret {
  return {
    ciphertext: `ciphertext:${tag}`,
    nonce: `nonce:${tag}`,
    wrappedKey: `wrapped-key:${tag}`,
    kekVersion: 'test-v1',
    keyProvider: 'test-provider',
  }
}

/**
 * Run `action` and answer whatever it threw.
 *
 * The in-memory store is synchronous — its whole body runs before it answers — so a refusal it
 * raises is a synchronous throw rather than a rejected promise; this is how the suite catches
 * one without caring which implementation it is. It throws when the call does not refuse.
 */
async function thrownBy(action: () => unknown): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to be refused')
}

/** Assert that `value` parses as `schema` and carries nothing the protocol does not define. */
function expectExact<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): void {
  const parsed = schema.parse(value)
  expect(parsed, `${what} is exactly its protocol shape`).toEqual(value)
}
