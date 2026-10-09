#!/usr/bin/env node
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import { migrate } from './migrate'
import type { PostgresSchema } from './schema'

/**
 * `openharness-session-migrate` — apply this package's migrations to a database.
 *
 * Takes the connection string as an argument or from `DATABASE_URL`, which is also what the
 * tests read, so the deployment path and the test path are the same one:
 *
 * ```sh
 * DATABASE_URL=postgres://user:pass@host:5432/openharness yarn migrate
 * ```
 *
 * Exits non-zero when the connection or a migration fails, so a deploy step can gate on it.
 */
async function main(): Promise<number> {
  const connectionString = process.env.DATABASE_URL ?? process.argv[2]
  if (connectionString === undefined || connectionString === '') {
    console.error(
      'usage: openharness-session-migrate [connection-string]\n\n' +
        '  The connection string may also be set in DATABASE_URL.',
    )
    return 2
  }
  const pool = new Pool({ connectionString })
  const db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool }) })
  try {
    const applied = await migrate(db)
    console.log(`applied ${applied.length} migration file(s): ${applied.join(', ')}`)
    return 0
  } finally {
    await db.destroy()
  }
}

process.exitCode = await main()
