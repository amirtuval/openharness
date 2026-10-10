/**
 * `@openharness/session/postgres` — the durable stores, on Postgres: the `SessionStore`, the
 * `CredentialStore` and the `McpServerStore`, from the same migrations.
 *
 * This subpath is separate from the main entry point on purpose: `@openharness/session` is
 * imported by code that only ever needs the contracts and the in-memory fakes, and it must not
 * pull `pg` and `kysely` into that process. A package that wants the real stores asks for them.
 *
 * ```ts
 * import { createPostgresSessionStore, migrate } from '@openharness/session/postgres'
 *
 * await migrate(db)
 * const store = createPostgresSessionStore({ connectionString: process.env.DATABASE_URL })
 * const credentials = createPostgresCredentialStore({ pool })
 * ```
 *
 * `migrate` applies this package's migrations — the log's tables, Better Auth's tables (the
 * server sub-issue #61 runs Better Auth against them with its own migrator disabled) and
 * `provider_credentials` — in one locked transaction. See `packages/session/docs/postgres.md`
 * for the schema, the delivery model and how to run the conformance suites against a real
 * database.
 */

export { PostgresSessionStore, createPostgresSessionStore } from './store'
export type { PostgresSessionStoreConfig, PostgresSessionStoreOptions } from './store'
export { PostgresCredentialStore, createPostgresCredentialStore } from './credentials'
export type { PostgresCredentialStoreConfig, PostgresCredentialStoreOptions } from './credentials'
export { PostgresMcpServerStore, createPostgresMcpServerStore } from './mcp-servers'
export type { PostgresMcpServerStoreConfig, PostgresMcpServerStoreOptions } from './mcp-servers'
export { migrate } from './migrate'
export type { MigrateOptions } from './migrate'
export type {
  AgentsTable,
  EventClaimsTable,
  EventsTable,
  EventSupersessionsTable,
  McpOAuthStateRow,
  McpOAuthStatesTable,
  McpServerMetadataRow,
  McpServerRow,
  McpServersTable,
  ModeRow,
  ModesTable,
  PartitionLeasesTable,
  PostgresSchema,
  ProviderCredentialMetadataRow,
  ProviderCredentialRow,
  ProviderCredentialsTable,
  SchedulerInstancesTable,
  SessionsTable,
  UserPreferencesTable,
} from './schema'
