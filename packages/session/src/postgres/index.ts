/**
 * `@openharness/session/postgres` — the durable `SessionStore`, on Postgres.
 *
 * This subpath is separate from the main entry point on purpose: `@openharness/session` is
 * imported by code that only ever needs the contract and the in-memory fake, and it must not
 * pull `pg` and `kysely` into that process. A package that wants the real store asks for it.
 *
 * ```ts
 * import { createPostgresSessionStore, migrate } from '@openharness/session/postgres'
 *
 * await migrate(db)
 * const store = createPostgresSessionStore({ connectionString: process.env.DATABASE_URL })
 * ```
 *
 * See `packages/session/docs/postgres.md` for the schema, the delivery model and how to run
 * the conformance suite against a real database.
 */

export { PostgresSessionStore, createPostgresSessionStore } from './store'
export type { PostgresSessionStoreConfig, PostgresSessionStoreOptions } from './store'
export { migrate } from './migrate'
export type { MigrateOptions } from './migrate'
export type {
  AgentsTable,
  EventsTable,
  PartitionLeasesTable,
  PostgresSchema,
  SessionsTable,
} from './schema'
