import { ProviderCredentialSchema, type UserId } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { timestampAt } from '../clock'
import type { CredentialStore, SealedSecret } from '../credentials'
import { type TestClock, createTestClock } from './clock'
import { OWNER_A, OWNER_B } from './conformance'

/**
 * The conformance suite every `CredentialStore` implementation has to pass (epic #65, A5).
 *
 * It is the contract's executable form: `InMemoryCredentialStore` passes it today, and
 * `PostgresCredentialStore` must pass the same suite unchanged. That is why it only asks for
 * what the contract promises — upsert and replace, the metadata a list returns with no sealed
 * field in it, owner scoping, delete, uniqueness per `(user, name)`, and hand-outs that
 * cannot be written to — and never reaches into an implementation.
 *
 * ## Writing the factory
 *
 * ```ts
 * import { InMemoryCredentialStore } from '@openharness/session'
 *
 * runCredentialStoreConformance(
 *   (clock) => new InMemoryCredentialStore({ now: clock.now }),
 *   { name: 'InMemoryCredentialStore' },
 * )
 * ```
 *
 * The factory is called once per test with a fresh {@link TestClock}, and the store it returns
 * must take its time from that clock: `created_at` and `updated_at` are the clock's instants,
 * which is how the suite checks replacement without sleeping. For a store whose schema
 * references Better Auth's `"user"` rows (Postgres), pass an `ensureUsers` that creates the
 * suite's two owners, exactly as the session suite's does.
 *
 * The blob the suite seals is a fixture, not a vault: the fields are distinct strings, so a
 * test can say what came back out. No implementation may depend on their contents.
 */
export function runCredentialStoreConformance(
  makeStore: MakeCredentialStore,
  options: CredentialStoreConformanceOptions = {},
): void {
  const name = options.name ?? 'CredentialStore'

  /** A store for one test, built on a clock that test can move, with the suite's users seeded. */
  async function setup(): Promise<{ store: CredentialStore; clock: TestClock }> {
    const clock = createTestClock(START_MS)
    const store = await makeStore(clock)
    await options.ensureUsers?.([OWNER_A, OWNER_B])
    return { store, clock }
  }

  describe(`${name} conformance`, () => {
    describe('upsert', () => {
      it('stores a credential and answers its metadata under a fresh pcred_ id', async () => {
        const { store, clock } = await setup()
        const metadata = await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('one'),
          last4: 'cdef',
          validatedAt: timestampAt(clock.currentMs),
        })
        expect(metadata.id).toMatch(/^pcred_/)
        expect(metadata).toMatchObject({
          type: 'api_key',
          name: 'anthropic',
          last4: 'cdef',
          created_at: timestampAt(clock.currentMs),
          updated_at: timestampAt(clock.currentMs),
          validated_at: timestampAt(clock.currentMs),
        })
        // The answer is the protocol's metadata, exactly — and never a sealed field.
        expectExact(ProviderCredentialSchema, metadata, 'credential metadata')

        const record = await store.get({ userId: OWNER_A, name: 'anthropic' })
        expect(record).toMatchObject({ id: metadata.id, sealed: sealedSecret('one') })
      })

      it('round-trips a sealed secret whose keyProvider is absent, keeping it absent', async () => {
        // #150: a credential written before the provider field existed is a `local` one (the
        // vault reads it so), and the store writes and reads it down exactly — no invented
        // provider, no field added to what it was given.
        const { store, clock } = await setup()
        await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: legacySealedSecret('legacy'),
          last4: 'cdef',
          validatedAt: timestampAt(clock.currentMs),
        })

        const record = await store.get({ userId: OWNER_A, name: 'anthropic' })
        expect(record?.sealed).toStrictEqual(legacySealedSecret('legacy'))
        expect(record?.sealed).not.toHaveProperty('keyProvider')
      })

      it('round-trips the public details a type publishes, and omits them when there are none', async () => {
        // #249 (A3b): a custom OpenAI-compatible credential publishes its base URL's host so
        // the settings list can show it without opening the sealed payload. A type with no
        // such facts has no `details` key at all — the metadata is unchanged for it.
        const { store, clock } = await setup()
        const detailed = await store.upsert({
          userId: OWNER_A,
          name: 'custom',
          type: 'openai_compatible',
          sealed: sealedSecret('custom'),
          last4: '4242',
          details: { base_url_host: '127.0.0.1:11434' },
          validatedAt: timestampAt(clock.currentMs),
        })
        // `details` is keyed by type: the field exists on the variant that publishes it, and
        // the metadata the type answers with is that type's own shape.
        expect(detailed).toMatchObject({
          type: 'openai_compatible',
          details: { base_url_host: '127.0.0.1:11434' },
        })
        expect((await store.list({ userId: OWNER_A }))[0]).toMatchObject({
          type: 'openai_compatible',
          details: { base_url_host: '127.0.0.1:11434' },
        })

        const plain = await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('plain'),
          last4: '0000',
          validatedAt: timestampAt(clock.currentMs),
        })
        expect(plain).not.toHaveProperty('details')
        expect(await store.get({ userId: OWNER_A, name: 'anthropic' })).not.toHaveProperty(
          'details',
        )
      })

      it('replaces the credential for the same user and name, keeping its id and created_at', async () => {
        const { store, clock } = await setup()
        const first = await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('old'),
          last4: 'old1',
          validatedAt: timestampAt(clock.currentMs),
        })
        clock.advance(5 * SECOND)
        const replaced = await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('new'),
          last4: 'new1',
          validatedAt: timestampAt(clock.currentMs),
        })
        // One credential per `(user, name)`: the replacement is the same credential with
        // a new secret, not a second one.
        expect(replaced.id).toBe(first.id)
        expect(replaced.created_at).toBe(first.created_at)
        expect(replaced.updated_at).toBe(timestampAt(clock.currentMs))
        expect(replaced.last4).toBe('new1')
        expect((await store.list({ userId: OWNER_A })).map((entry) => entry.id)).toEqual([first.id])
        const record = await store.get({ userId: OWNER_A, name: 'anthropic' })
        expect(record?.sealed).toEqual(sealedSecret('new'))
        expect(record?.validated_at).toBe(timestampAt(clock.currentMs))
      })

      it('keeps a user’s credentials apart, and two users’ copies of one name apart', async () => {
        const { store, clock } = await setup()
        const anthropic = await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('a-anthropic'),
          last4: 'aaaa',
          validatedAt: timestampAt(clock.currentMs),
        })
        const openai = await store.upsert({
          userId: OWNER_A,
          name: 'openai',
          type: 'api_key',
          sealed: sealedSecret('a-openai'),
          last4: 'bbbb',
          validatedAt: timestampAt(clock.currentMs),
        })
        await store.upsert({
          userId: OWNER_B,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('b-anthropic'),
          last4: 'cccc',
          validatedAt: timestampAt(clock.currentMs),
        })
        // `list` is ordered by name, byte order.
        expect((await store.list({ userId: OWNER_A })).map((entry) => entry.id)).toEqual([
          anthropic.id,
          openai.id,
        ])
        expect((await store.get({ userId: OWNER_A, name: 'openai' }))?.sealed).toEqual(
          sealedSecret('a-openai'),
        )
        expect((await store.get({ userId: OWNER_B, name: 'anthropic' }))?.sealed).toEqual(
          sealedSecret('b-anthropic'),
        )
      })

      it('keeps two named credentials of one type apart, under the names the user chose', async () => {
        // The point of the name column (epic #245, A3a): a user may hold more than one
        // credential of a type — `azure` and `azure-eu` here — and each is its own row, its
        // own sealed blob and its own name. Under the old `(user, provider)` rule the second
        // save replaced the first; it must not any more.
        const { store, clock } = await setup()
        const azure = await store.upsert({
          userId: OWNER_A,
          name: 'azure',
          type: 'azure_openai',
          sealed: sealedSecret('a-azure'),
          last4: 'az01',
          validatedAt: timestampAt(clock.currentMs),
        })
        const azureEu = await store.upsert({
          userId: OWNER_A,
          name: 'azure-eu',
          type: 'azure_openai',
          sealed: sealedSecret('a-azure-eu'),
          last4: 'az02',
          validatedAt: timestampAt(clock.currentMs),
        })

        expect(azureEu.id).not.toBe(azure.id)
        expect((await store.list({ userId: OWNER_A })).map((entry) => entry.name)).toEqual([
          'azure',
          'azure-eu',
        ])
        expect((await store.get({ userId: OWNER_A, name: 'azure' }))?.sealed).toEqual(
          sealedSecret('a-azure'),
        )
        expect((await store.get({ userId: OWNER_A, name: 'azure-eu' }))?.sealed).toEqual(
          sealedSecret('a-azure-eu'),
        )
        // Deleting one leaves the other: the rows are keyed by name, not by type.
        expect(await store.delete({ userId: OWNER_A, name: 'azure' })).toBe(true)
        expect(await store.get({ userId: OWNER_A, name: 'azure-eu' })).not.toBeNull()
        expect((await store.list({ userId: OWNER_A })).map((entry) => entry.name)).toEqual([
          'azure-eu',
        ])
      })
    })

    describe('get', () => {
      it('answers null for a name the user has no credential for', async () => {
        const { store } = await setup()
        expect(await store.get({ userId: OWNER_A, name: 'anthropic' })).toBeNull()
      })

      it('answers null for another user’s credential', async () => {
        const { store, clock } = await setup()
        await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('theirs'),
          last4: '0000',
          validatedAt: timestampAt(clock.currentMs),
        })
        expect(await store.get({ userId: OWNER_B, name: 'anthropic' })).toBeNull()
      })
    })

    describe('list', () => {
      it('answers an empty list for a user with none', async () => {
        const { store } = await setup()
        expect(await store.list({ userId: OWNER_A })).toEqual([])
      })

      it('returns metadata only, with no sealed field of any shape', async () => {
        const { store, clock } = await setup()
        const sealed = sealedSecret('secret')
        await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed,
          last4: 'zzzz',
          validatedAt: timestampAt(clock.currentMs),
        })
        const [metadata] = await store.list({ userId: OWNER_A })
        expect(metadata).toBeDefined()
        expect(Object.keys(metadata ?? {}).sort()).toEqual(
          ['created_at', 'id', 'last4', 'name', 'type', 'updated_at', 'validated_at'].sort(),
        )
        // Nothing in the answer is any of the sealed values, under any name.
        const serialized = JSON.stringify(metadata)
        for (const value of Object.values(sealed)) {
          expect(serialized).not.toContain(value)
        }
      })

      it('lists only the owner’s credentials', async () => {
        const { store, clock } = await setup()
        await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('a'),
          last4: '1111',
          validatedAt: timestampAt(clock.currentMs),
        })
        expect(await store.list({ userId: OWNER_B })).toEqual([])
      })
    })

    describe('delete', () => {
      it('deletes the credential, and answers false when there is none', async () => {
        const { store, clock } = await setup()
        await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('bye'),
          last4: '2222',
          validatedAt: timestampAt(clock.currentMs),
        })
        expect(await store.delete({ userId: OWNER_A, name: 'anthropic' })).toBe(true)
        expect(await store.get({ userId: OWNER_A, name: 'anthropic' })).toBeNull()
        expect(await store.list({ userId: OWNER_A })).toEqual([])
        // Deleting what is not there is not an error; deleting another user's is a no-op.
        expect(await store.delete({ userId: OWNER_A, name: 'anthropic' })).toBe(false)
        expect(await store.delete({ userId: OWNER_B, name: 'anthropic' })).toBe(false)
      })

      it('leaves another user’s credential alone when the same name is deleted', async () => {
        const { store, clock } = await setup()
        await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('a'),
          last4: '3333',
          validatedAt: timestampAt(clock.currentMs),
        })
        await store.upsert({
          userId: OWNER_B,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('b'),
          last4: '4444',
          validatedAt: timestampAt(clock.currentMs),
        })
        expect(await store.delete({ userId: OWNER_A, name: 'anthropic' })).toBe(true)
        expect((await store.get({ userId: OWNER_B, name: 'anthropic' }))?.sealed).toEqual(
          sealedSecret('b'),
        )
      })
    })

    describe('immutability', () => {
      it('hands out deep-frozen values, so writing to one throws', async () => {
        const { store, clock } = await setup()
        await store.upsert({
          userId: OWNER_A,
          name: 'anthropic',
          type: 'api_key',
          sealed: sealedSecret('frozen'),
          last4: '5555',
          validatedAt: timestampAt(clock.currentMs),
        })
        const [metadata] = await store.list({ userId: OWNER_A })
        const record = await store.get({ userId: OWNER_A, name: 'anthropic' })
        expect(metadata).toBeDefined()
        expect(Object.isFrozen(metadata)).toBe(true)
        expect(record).not.toBeNull()
        expect(Object.isFrozen(record)).toBe(true)
        expect(Object.isFrozen(record?.sealed)).toBe(true)
        expect(() => Object.assign(metadata ?? {}, { last4: '9999' })).toThrow(TypeError)
        expect(() => Object.assign(record ?? {}, { last4: '9999' })).toThrow(TypeError)
        expect(() => Object.assign(record?.sealed ?? {}, { ciphertext: 'no' })).toThrow(TypeError)
        // None of it reached the store.
        expect((await store.get({ userId: OWNER_A, name: 'anthropic' }))?.last4).toBe('5555')
      })
    })
  })
}

/** The factory a credential store is tested through: it receives the clock the store must use. */
export type MakeCredentialStore = (clock: TestClock) => CredentialStore | Promise<CredentialStore>

/** How to title the suite in a report. */
export interface CredentialStoreConformanceOptions {
  /** The implementation's name; the suite's blocks are titled `${name} conformance`. */
  readonly name?: string
  /**
   * Makes sure the given users exist, for a store whose schema references them — the Postgres
   * table's `user_id` is a foreign key into Better Auth's `"user"` row. Called once per test,
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
 * say exactly what came back out. A real one comes from `@openharness/vault`; the store
 * treats every field as opaque, so a fixture is as good as a ciphertext here — `keyProvider`
 * included, whose value is a made-up provider name because the store must not know any.
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
 * The same fixture as a credential stored before `keyProvider` existed (#150): the field
 * simply absent. The store has to hand it back absent too — the vault is what reads an
 * absent provider as `local`.
 */
function legacySealedSecret(tag: string): SealedSecret {
  return {
    ciphertext: `ciphertext:${tag}`,
    nonce: `nonce:${tag}`,
    wrappedKey: `wrapped-key:${tag}`,
    kekVersion: 'test-v1',
  }
}

/** Assert that `value` parses as `schema` and carries nothing the protocol does not define. */
function expectExact<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): void {
  const parsed = schema.parse(value)
  expect(parsed, `${what} is exactly its protocol shape`).toEqual(value)
}
