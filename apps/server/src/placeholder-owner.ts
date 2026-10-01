import type { UserId } from '@openharness/protocol'
import type { PostgresSchema } from '@openharness/session/postgres'
import { sql, type Kysely } from 'kysely'

/**
 * The owner everything the server creates belongs to, until real sign-in lands (#61).
 *
 * Every agent and session carries an owner (epic #65, A4), and a route takes it from the
 * authenticated caller. The server does not authenticate anyone yet — that is the third wave
 * of the epic, issue #61, which mounts Better Auth and reads the user off the request — so
 * until then there is one owner, this placeholder, and the routes pass it.
 *
 * `owner_id` is a foreign key into Better Auth's `"user"` table, so a Postgres database has
 * to hold the row: {@link ensurePlaceholderUser} writes it after the migrations, on the
 * server's boot path and in the tests that build their own store. Real sign-ins will insert
 * real users beside it, and #61 removes both this constant and the seeding function.
 *
 * The constant is exported for this package's tests and its module graph only — it is not
 * re-exported from `src/index.ts`, because it is scaffolding, not surface.
 */
export const PLACEHOLDER_OWNER_ID: UserId = 'user_placeholder'

/** The email the placeholder user's row carries; the column is `not null unique`. */
export const PLACEHOLDER_OWNER_EMAIL = 'placeholder@openharness.local'

/**
 * Make sure the placeholder user exists, so this server may own agents and sessions.
 *
 * One idempotent insert into Better Auth's `"user"` table — the schema `@openharness/session`'s
 * migrations created. Called after `migrate()` on the Postgres paths (the server at boot, and
 * the server's Postgres test fixture); the in-memory store has no users to speak of, so the
 * in-memory path never calls it.
 *
 * This is transition glue, not a feature: #61 will have Better Auth create real users, and
 * this function and {@link PLACEHOLDER_OWNER_ID} go with it.
 *
 * @param db a handle to a database whose migrations have already run
 */
export async function ensurePlaceholderUser(db: Kysely<PostgresSchema>): Promise<void> {
  await sql`
    insert into "user" ("id", "name", "email", "emailVerified")
    values (${PLACEHOLDER_OWNER_ID}, 'Placeholder owner', ${PLACEHOLDER_OWNER_EMAIL}, true)
    on conflict ("id") do nothing
  `.execute(db)
}
