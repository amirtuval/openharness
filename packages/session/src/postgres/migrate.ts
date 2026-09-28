import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sql, type Kysely } from 'kysely'

import type { PostgresSchema } from './schema'

/**
 * Apply this package's migrations.
 *
 * The migrations are plain SQL files in `migrations/`, applied in file-name order, each
 * followed by the next: `0001_agents.sql` creates the first table, and a later file may
 * assume every earlier one has run. They are **idempotent** — every statement is
 * `if not exists` — so running this twice is a no-op and a database that is already up to
 * date is left alone.
 *
 * The whole run is one transaction under an advisory lock:
 *
 * - a failure half-way leaves the schema as it was, because Postgres DDL is transactional;
 * - two server instances starting at the same time cannot interleave their `create table`s —
 *   the second waits, then finds everything already there.
 *
 * Files are never edited once they have been applied anywhere: the runner has no ledger, so
 * "already applied" is decided by the statements themselves (`if not exists`), and changing
 * what an old file does would not re-run it.
 *
 * ```ts
 * import { Kysely, PostgresDialect } from 'kysely'
 * import { Pool } from 'pg'
 * import { migrate } from '@openharness/session/postgres'
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
 * await migrate(db)
 * ```
 *
 * @returns the migration files that were applied, in order
 */
export async function migrate(
  db: Kysely<PostgresSchema>,
  options: MigrateOptions = {},
): Promise<string[]> {
  const directory = options.migrationsDir ?? defaultMigrationsDir()
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_NAME}))`.execute(trx)
    for (const file of files) {
      const statements = await readFile(join(directory, file), 'utf8')
      await sql.raw(statements).execute(trx)
    }
  })
  return files
}

/** Everything {@link migrate} takes. */
export interface MigrateOptions {
  /**
   * Where the SQL files are. Defaults to the `migrations/` directory shipped with this
   * package, found by walking up from this module — which is the same directory whether the
   * code is running from `src/` under Vitest or from `dist/` after a build.
   */
  readonly migrationsDir?: string
}

/**
 * The advisory lock every migration run takes, so two of them cannot run at once.
 *
 * `hashtext` turns the module name into the lock's key: it is stable for a given string,
 * which is all an advisory lock needs, and it makes the key self-documenting in
 * `pg_locks`.
 */
const MIGRATION_LOCK_NAME = '@openharness/session migrations'

/** How far above the running module the package's `migrations/` directory can be. */
const MAX_SEARCH_DEPTH = 3

/** The `migrations/` directory next to this module, or the one above it. */
function defaultMigrationsDir(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < MAX_SEARCH_DEPTH; depth += 1) {
    const candidate = join(directory, 'migrations')
    if (existsSync(candidate)) {
      return candidate
    }
    directory = dirname(directory)
  }
  throw new Error(
    `could not find a migrations/ directory above ${fileURLToPath(import.meta.url)}; ` +
      'pass { migrationsDir }',
  )
}
