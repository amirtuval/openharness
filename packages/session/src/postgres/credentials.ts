import { newProviderCredentialId, type ProviderCredential } from '@openharness/protocol'
import { Kysely, PostgresDialect, type Insertable } from 'kysely'
import { Pool } from 'pg'

import { type Clock, systemClock } from '../clock'
import type {
  CredentialKey,
  CredentialStore,
  ListCredentialsOptions,
  SealedProviderCredential,
  UpsertCredentialInput,
} from '../credentials'
import {
  credentialFromRow,
  credentialMetadataFromRow,
  instant,
  type PostgresSchema,
  type ProviderCredentialsTable,
} from './schema'

/**
 * The Postgres `CredentialStore` (epic #65, A5): the durable implementation of the contract
 * in `credentials.ts`, on the `provider_credentials` table.
 *
 * It moves sealed blobs and nothing else. The plaintext never appears here — the caller seals
 * with `@openharness/vault` before an upsert and opens after a `get`, and this store has no
 * dependency on that package — and the sealed columns are opaque strings to the store. A
 * metadata read (`list`) does not even select them.
 *
 * The table's `unique (user_id, name)` is what makes `upsert` an upsert rather than a
 * read-then-write: one statement, so two concurrent saves of the same name cannot both
 * create a row. The replacement keeps the stored row's `id` and `created_at` — only the
 * secret and the metadata around it move — and `on delete cascade` from `"user"` is the
 * user-delete cascade, in the schema rather than in code.
 *
 * Time comes from the injected clock ({@link PostgresCredentialStoreOptions.now}), like every
 * timestamp in this package: `created_at` and `updated_at` are written from it, never from
 * the database's `now()`. `validated_at` is the caller's — the instant the server's
 * validation call passed.
 */
export class PostgresCredentialStore implements CredentialStore {
  readonly #db: Kysely<PostgresSchema>

  readonly #pool: Pool

  /** Whether this store opened the pool: only then does {@link PostgresCredentialStore.close} end it. */
  readonly #ownsPool: boolean

  readonly #clock: Clock

  #closed = false

  constructor(options: PostgresCredentialStoreOptions = {}) {
    const { pool, connectionString } = options
    if (pool !== undefined && connectionString !== undefined) {
      throw new TypeError('pass either `pool` or `connectionString`, not both')
    }
    if (pool === undefined && connectionString === undefined) {
      throw new TypeError('pass either `pool` or `connectionString`')
    }
    if (pool !== undefined) {
      this.#pool = pool
      this.#ownsPool = false
    } else {
      this.#pool = new Pool({ connectionString })
      this.#ownsPool = true
    }
    this.#db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool: this.#pool }) })
    this.#clock = options.now ?? systemClock
  }

  async upsert(input: UpsertCredentialInput): Promise<ProviderCredential> {
    const now = this.#clock()
    const at = instant(now)
    const row: Insertable<ProviderCredentialsTable> = {
      id: newProviderCredentialId(now),
      user_id: input.userId,
      name: input.name,
      type: input.type,
      ciphertext: input.sealed.ciphertext,
      nonce: input.sealed.nonce,
      wrapped_key: input.sealed.wrappedKey,
      kek_version: input.sealed.kekVersion,
      // The caller's sealed blob is written as given (#150); `undefined` means a caller that
      // predates the field, and `local` is what the vault reads a `null` back as.
      key_provider: input.sealed.keyProvider ?? null,
      // A caller with nothing to report writes `null`, which reads back as an absent
      // `details` rather than an empty object (epic #245, A3c).
      details: input.details ?? null,
      last4: input.last4,
      created_at: at,
      updated_at: at,
      validated_at: instant(Date.parse(input.validatedAt)),
    }
    // One statement: the insert and its `on conflict` are atomic together, so two saves
    // racing for the same provider cannot both create a row. The replacement deliberately
    // does not touch `id` or `created_at` — it is the same credential with a new secret.
    const saved = await this.#db
      .insertInto('provider_credentials')
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(['user_id', 'name']).doUpdateSet({
          type: row.type,
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          wrapped_key: row.wrapped_key,
          kek_version: row.kek_version,
          key_provider: row.key_provider,
          details: row.details,
          last4: row.last4,
          updated_at: row.updated_at,
          validated_at: row.validated_at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow()
    return credentialMetadataFromRow(saved)
  }

  async get(key: CredentialKey): Promise<SealedProviderCredential | null> {
    const row = await this.#db
      .selectFrom('provider_credentials')
      .selectAll()
      .where('user_id', '=', key.userId)
      .where('name', '=', key.name)
      .executeTakeFirst()
    return row === undefined ? null : credentialFromRow(row)
  }

  async list(options: ListCredentialsOptions): Promise<ProviderCredential[]> {
    // The metadata columns only: a list never reads a sealed cell, which is as true of the
    // SQL as of what it returns. `name` is `collate "C"`, so this order is the byte order
    // the in-memory store sorts by.
    const rows = await this.#db
      .selectFrom('provider_credentials')
      .select([
        'id',
        'type',
        'name',
        'last4',
        'details',
        'created_at',
        'updated_at',
        'validated_at',
      ])
      .where('user_id', '=', options.userId)
      .orderBy('name', 'asc')
      .execute()
    return rows.map(credentialMetadataFromRow)
  }

  async delete(key: CredentialKey): Promise<boolean> {
    const deleted = await this.#db
      .deleteFrom('provider_credentials')
      .where('user_id', '=', key.userId)
      .where('name', '=', key.name)
      .executeTakeFirst()
    return Number(deleted.numDeletedRows) > 0
  }

  /**
   * Give up the store's own resources: end the pool when this store opened it.
   *
   * A store built on a pool the caller owns leaves that pool alone. Idempotent, and nothing
   * else may be called afterwards.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    if (this.#ownsPool) {
      await this.#db.destroy()
    }
  }
}

/** Everything {@link PostgresCredentialStore} takes. */
export interface PostgresCredentialStoreOptions {
  /** A connection string this store opens (and, on {@link PostgresCredentialStore.close}, ends) itself. */
  readonly connectionString?: string
  /** A pool to borrow. The store never ends it; the caller owns its lifecycle. */
  readonly pool?: Pool
  /**
   * The store's time source. Defaults to {@link systemClock}; pass a controllable clock in
   * tests, which is what the conformance suite does. Nothing in this store reads the
   * database's `now()`.
   */
  readonly now?: Clock
}

/** How the two ways of reaching Postgres are written: a connection string, or a pool. */
export type PostgresCredentialStoreConfig =
  { readonly connectionString: string } | { readonly pool: Pool }

/**
 * Build a Postgres-backed credential store.
 *
 * ```ts
 * const store = createPostgresCredentialStore({ connectionString: process.env.DATABASE_URL })
 * ```
 *
 * The table has to exist: run {@link migrate} against the same database first — the same
 * migrations the session store applies.
 */
export function createPostgresCredentialStore(
  config: PostgresCredentialStoreConfig,
  options: Omit<PostgresCredentialStoreOptions, 'connectionString' | 'pool'> = {},
): PostgresCredentialStore {
  return new PostgresCredentialStore({ ...config, ...options })
}
