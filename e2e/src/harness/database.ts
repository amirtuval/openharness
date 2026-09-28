import { randomBytes } from 'node:crypto'

import { Client } from 'pg'

/**
 * The database a test file runs against.
 *
 * An end-to-end test needs a *real* Postgres, and two test files running at the same time
 * must not see each other: the session store's tables, its `LISTEN`/`NOTIFY` channels and the
 * partition leases are all shared state. Each file therefore gets its own **database** —
 * created here, migrated on boot by the server under test, dropped when the file is done.
 *
 * A database rather than a schema on purpose: `migrate()` runs plain SQL, and everything the
 * store does — the advisory lock, the notification channels, the partition leases — is
 * per-database. Isolation is then a property of Postgres, not of a `search_path` somebody has
 * to keep passing around.
 *
 * The connection string comes from `DATABASE_URL`, the variable CI sets from its service
 * container and that `docker run postgres:18-alpine` gives a developer locally. The *server*
 * user has to be allowed to create databases — the official image's `POSTGRES_USER` is a
 * superuser, which both of those are.
 */

/** The database a copy of `DATABASE_URL` is created in, and dropped from. */
const MAINTENANCE_DATABASE = 'postgres'

/** A database name Postgres will accept: lowercase, no dashes, and at most 63 bytes. */
const MAX_NAME_LENGTH = 63

/** A per-file database: where it is, and how to get rid of it. */
export interface E2eDatabase {
  /** The database's name, as Postgres knows it. */
  readonly name: string
  /** The connection string the server under test is started with. */
  readonly url: string
  /** Drop the database, connections and all. Idempotent. */
  dispose(): Promise<void>
}

/**
 * The connection string to build test databases on.
 *
 * @throws Error when `DATABASE_URL` is unset, which is a test-suite-wide problem: naming it
 *   here, once, reads better than every test failing on its own.
 */
export function baseDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim()
  if (url === undefined || url === '') {
    throw new Error(
      'the e2e tests need a Postgres to run against: set DATABASE_URL, e.g.\n' +
        '  docker run --rm -d -p 5432:5432 -e POSTGRES_USER=openharness \\\n' +
        '    -e POSTGRES_PASSWORD=openharness -e POSTGRES_DB=openharness postgres:18-alpine\n' +
        '  DATABASE_URL=postgres://openharness:openharness@localhost:5432/openharness yarn test',
    )
  }
  return url
}

/**
 * Create the database one test file owns.
 *
 * @param label a short name for the file, for the database's name and for debugging
 * @returns the database, with a `dispose()` that drops it
 */
export async function createE2eDatabase(label: string): Promise<E2eDatabase> {
  const base = baseDatabaseUrl()
  const name = databaseName(label)
  await withDatabaseClient(async (client) => {
    await client.query(`create database "${name}"`)
  })
  return {
    name,
    url: withDatabase(base, name),
    dispose: async () => {
      await withDatabaseClient(async (client) => {
        // `with (force)` drops it even if a server under test still has it open — a test that
        // failed mid-teardown must not leave a database nobody can remove.
        await client.query(`drop database if exists "${name}" with (force)`)
      })
    },
  }
}

/**
 * Run `work` against a connection that is opened and closed around it.
 *
 * Tests use this for the few things that are not part of the API — reading
 * `partition_leases`, say — and the harness uses it to create and drop databases.
 *
 * @param work what to do with the connected client
 * @param options.database the database to connect to; the maintenance one by default
 */
export async function withDatabaseClient<T>(
  work: (client: Client) => Promise<T>,
  options: { readonly database?: string } = {},
): Promise<T> {
  const client = new Client({
    connectionString: withDatabase(baseDatabaseUrl(), options.database ?? MAINTENANCE_DATABASE),
  })
  await client.connect()
  try {
    return await work(client)
  } finally {
    await client.end()
  }
}

/** `openharness_e2e_<label>_<random>`, cut to what Postgres allows in an identifier. */
function databaseName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const suffix = randomBytes(4).toString('hex')
  const prefix = `openharness_e2e_${slug}_`
  return `${prefix.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`
}

/** The same connection string, pointed at another database. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}
