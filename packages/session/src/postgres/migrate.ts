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
 * assume every earlier one has run.
 *
 * ## The ledger, and why a boot takes no locks
 *
 * A `schema_migrations` table records each file that has been applied (`file` primary key,
 * `applied_at`). A server boots on every rollout, scale-up and crash restart, so the common
 * case has to be *free*: if the ledger names every file, {@link migrate} returns without
 * running a statement against the application's tables — no `alter table`, no
 * `create index`. That matters because **idempotent DDL still takes its locks**:
 * `alter table … add column if not exists` takes `ACCESS EXCLUSIVE` on the table even when
 * the column is already there, and `create index if not exists` takes a `SHARE` lock. Held
 * by every boot while live servers append, those locks stall or deadlock the append (a turn
 * errors, or the boot fails when Postgres aborts its side).
 *
 * Otherwise the run takes the advisory lock, re-reads the ledger (another instance may have
 * applied everything while this one waited), and runs **only** the files it does not name,
 * recording each one in the same transaction as the file's statements. A failure half-way
 * therefore rolls the schema and the ledger back together: the schema is as it was, and the
 * next boot runs the same set again.
 *
 * ## Bootstrapping a database migrated by the old runner
 *
 * A database migrated before the ledger existed has every table and an empty
 * `schema_migrations`. The first new boot cannot tell, from the ledger, that anything ran, so
 * it runs every file once more under the lock and records them. That is correct because the
 * files are idempotent; it is the **one** boot that still takes the application tables' locks,
 * once per database.
 *
 * Recording the files *without* running them, when the schema "looks newest", was deliberately
 * not done. Any such check is a guess: a database can have `agents` and `sessions` yet be
 * missing the newest migration (a rollback to an older image, a schema half-built by hand, a
 * branch of the stack that was not deployed), and a wrong positive writes a ledger that no
 * later boot repairs — the schema stays silently behind. Running the idempotent files once is
 * bounded, observable and cannot be wrong; a false "already applied" is silent and permanent.
 * New files must stay idempotent for this boot (see the rules below).
 *
 * ## Bounded locks: what a real migration may do to a live database
 *
 * A migration that does need a strong lock must not block live appends indefinitely, so every
 * run sets `lock_timeout` and a statement that cannot get its lock aborts the transaction
 * instead of waiting behind a turn's append. The whole transaction is then retried with
 * exponential backoff, a bounded number of times, before failing the boot with an error that
 * names the file and the lock wait.
 *
 * ## Writing a migration (follow these or a rollout will hurt)
 *
 * - **Expand, then contract.** Old and new servers run side by side during a rolling update,
 *   and an old pod must keep working against the new schema. Add columns, tables and indexes
 *   first; stop writing a column before a later release drops it; never rename or rewrite in
 *   the same release that starts (or stops) using a thing. A destructive change waits until no
 *   old pod can still run — normally the release after the one that stopped using it.
 * - **Prefer the non-blocking form.** Adding a nullable column (or one with a constant
 *   default, PostgreSQL 11+) is cheap; `set not null` on a big hot table, a table rewrite, and
 *   a non-concurrent index build are not. Add a `check … not valid` and validate it later
 *   rather than taking `ACCESS EXCLUSIVE` for a full scan.
 * - **`create index concurrently` cannot run inside a transaction**, and this runner applies
 *   each file inside one. A future migration that needs it must not be written as an ordinary
 *   file: it needs either a runner change (e.g. a file-level directive that runs it outside
 *   the transaction, with a duplicate-index-tolerant guard and its own ledger handling) or a
 *   maintenance window. That is deliberately not built yet — no migration so far needs it.
 * - **Never edit a file once it has been applied anywhere.** The ledger records the file name;
 *   editing it changes nothing on a database that already ran it and everything on a fresh
 *   one, so the two drift apart silently. Add a new file.
 * - **Keep the statements idempotent anyway** (`if not exists`, guarded `do` blocks): the
 *   bootstrap boot above re-runs every file once, and the test harnesses that clear the ledger
 *   rely on the same property.
 * - **Keep the file short.** Every statement must acquire its lock within `lock_timeout`.
 *
 * Files are found relative to this module, so the same directory is used from `src/` under
 * Vitest and from `dist/` after a build.
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
 * @returns the files applied by this call, in order — `[]` when the ledger says the database
 *   is already up to date
 */
export async function migrate(
  db: Kysely<PostgresSchema>,
  options: MigrateOptions = {},
): Promise<string[]> {
  const directory = options.migrationsDir ?? defaultMigrationsDir()
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS

  // The fast path: no transaction, no advisory lock, and — the point of the ledger — no
  // statement that touches an application table. A database with no ledger is not up to date
  // whichever way it got there (fresh, or migrated by the old runner), so it takes the slow
  // path and the ledger is created there, under the advisory lock, by one writer only.
  const recorded = await recordedFiles(db)
  if (recorded !== null && files.every((file) => recorded.has(file))) {
    return []
  }

  for (let attempt = 1; ; attempt += 1) {
    let failingFile: string | null = null
    try {
      return await db.transaction().execute(async (trx) => {
        // `SET LOCAL` scopes this to the transaction (and the retry's fresh transaction).
        // `set_config` is a function, so the timeout can be a bound parameter.
        await sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`.execute(trx)
        await sql`select pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_NAME}))`.execute(trx)
        await createLedger(trx)
        // Re-read inside the lock: another instance may have applied files while this one
        // waited, and running a file twice is exactly what the ledger is here to avoid.
        const applied = await selectLedger(trx)
        const missing = files.filter((file) => !applied.has(file))
        for (const file of missing) {
          failingFile = file
          const statements = await readFile(join(directory, file), 'utf8')
          await sql.raw(statements).execute(trx)
          await sql`
            insert into schema_migrations (file, applied_at) values (${file}, now())
          `.execute(trx)
        }
        return missing
      })
    } catch (error) {
      // A lock wait that timed out, a deadlock with a live append, or a serialization failure
      // is the contention this retry exists for. Anything else — a bad statement, a missing
      // file — is not going to get better by trying again.
      if (attempt >= maxAttempts || !isRetryableLockError(error)) {
        throw migrationFailure(error, {
          attempt,
          maxAttempts,
          file: failingFile,
          lockTimeoutMs,
          retryable: isRetryableLockError(error),
        })
      }
      await delay(retryBackoffMs * 2 ** (attempt - 1))
    }
  }
}

/** Everything {@link migrate} takes. */
export interface MigrateOptions {
  /**
   * Where the SQL files are. Defaults to the `migrations/` directory shipped with this
   * package, found by walking up from this module — which is the same directory whether the
   * code is running from `src/` under Vitest or from `dist/` after a build.
   */
  readonly migrationsDir?: string
  /**
   * How long one statement may wait for a lock before its transaction is aborted and retried.
   * A few seconds by default: long enough for an ordinary lock to clear, short enough that a
   * boot does not sit behind a streaming turn.
   */
  readonly lockTimeoutMs?: number
  /** How many times the whole migration transaction may be tried. `3` by default. */
  readonly maxAttempts?: number
  /** The first retry's delay; each further retry doubles it. `500` ms by default. */
  readonly retryBackoffMs?: number
}

/** The ledger of applied files: one row per file, the file name as the key. */
const LEDGER_TABLE = 'schema_migrations'

/** How long a statement may wait for a lock before the transaction is retried. */
const DEFAULT_LOCK_TIMEOUT_MS = 3_000

/** How many times a lock-contended migration transaction may be tried. */
const DEFAULT_MAX_ATTEMPTS = 3

/** The first retry's delay; each further retry doubles it. */
const DEFAULT_RETRY_BACKOFF_MS = 500

/** Postgres's SQLSTATEs for the contention this runner retries rather than fails on. */
const RETRYABLE_LOCK_CODES = new Set([
  '55P03', // lock_not_available — a lock_timeout expired
  '40P01', // deadlock_detected
  '40001', // serialization_failure
])

/**
 * The files the ledger names, or `null` when there is no ledger yet.
 *
 * Reading it takes a lock on nothing else. `to_regclass` answers `null` for a name no table
 * has, which is the fresh-database and old-runner case alike — both take the locked path.
 */
async function recordedFiles(db: Kysely<PostgresSchema>): Promise<Set<string> | null> {
  const found = await sql<{ ledger: string | null }>`
    select to_regclass(${LEDGER_TABLE}) as ledger
  `.execute(db)
  if (found.rows[0]?.ledger == null) {
    return null
  }
  return await selectLedger(db)
}

/** The files the ledger names, in whatever order the table returns them. */
async function selectLedger(db: Kysely<PostgresSchema>): Promise<Set<string>> {
  const rows = await sql<{ file: string }>`select file from schema_migrations`.execute(db)
  return new Set(rows.rows.map((row) => row.file))
}

/**
 * Create the ledger if this transaction's database does not have it.
 *
 * This runs under the advisory lock, so two instances booting together cannot race here. The
 * table belongs to the runner, not to a migration file: a file that records itself would have
 * to exist before the thing that records it.
 */
async function createLedger(db: Kysely<PostgresSchema>): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      file text collate "C" primary key,
      applied_at timestamptz not null default now()
    )
  `.execute(db)
}

/** Whether an error is one the next attempt could get past. */
function isRetryableLockError(error: unknown): boolean {
  const code = errorCode(error)
  return code !== null && RETRYABLE_LOCK_CODES.has(code)
}

/** The SQLSTATE a thrown error carries, when it carries one. */
function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/** The error a boot fails with, saying what was being applied and why it gave up. */
function migrationFailure(
  error: unknown,
  context: {
    readonly attempt: number
    readonly maxAttempts: number
    readonly file: string | null
    readonly lockTimeoutMs: number
    readonly retryable: boolean
  },
): Error {
  const reason = error instanceof Error ? error.message : String(error)
  const code = errorCode(error)
  const where = context.file === null ? '' : ` while applying ${context.file}`
  const retry =
    context.retryable && context.maxAttempts > 1
      ? ` after ${context.attempt} of ${context.maxAttempts} attempt(s), ` +
        `retrying a ${context.lockTimeoutMs}ms lock timeout`
      : ''
  return new Error(
    `migrations failed${where}${retry}: ${reason}${code === null ? '' : ` (SQLSTATE ${code})`}`,
    { cause: error },
  )
}

/** Wait before the next attempt. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
