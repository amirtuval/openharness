import { generateRandomString, hashPassword } from 'better-auth/crypto'

import { withDatabaseClient, type E2eDatabase } from './database'

/**
 * More than one person.
 *
 * The dev login (A7) deliberately seeds exactly one user, and sign-up is disabled, so a test
 * that needs a second account cannot get one over the API — that is the point of A7, not an
 * oversight. What it can do is what the server's own seeding does: create the row the way
 * Better Auth does, with **its own** password hashing (`better-auth/crypto`, the same function
 * `sign-in/email` verifies against) and its own id generator, so the account is
 * indistinguishable from one Better Auth's internals would have made. The path afterwards is
 * the real one: `POST /api/auth/sign-in/email`, a session in the `session` table, a bearer
 * token.
 *
 * The rows go in through the file's own database handle, not the server's, because the server
 * exposes no seam for this over the process boundary — and should not: only the dev login may
 * create a password account (A7). The server has to have booted once, because its migrations
 * are what create the tables.
 */

/** What {@link ensureUser} answers: the row it found or made. */
export interface E2eUser {
  /** The `user.id` the session and every owned resource will reference. */
  readonly id: string
  /** The address the account is stored under — and signs in with. */
  readonly email: string
}

/**
 * Create a password account if it is not there yet, and answer its id.
 *
 * Idempotent, so a test file that runs several scenarios against one database can call it
 * whenever it needs "that user to exist" without caring who made them first.
 *
 * The three writes are Better Auth's own shape: a `user` row with `emailVerified` true (the
 * only kind `refuseUnverifiedUser` lets through), and a `credential` `account` row whose
 * `accountId` is the user's id and whose `password` is a hash `verifyPassword` accepts.
 *
 * @param database the test file's database — the same one the server under test runs against
 * @param email the account's address; a dotted domain, which Better Auth's validation requires
 */
export async function ensureUser(
  database: E2eDatabase,
  email: string,
  password: string,
): Promise<E2eUser> {
  const passwordHash = await hashPassword(password)
  return withDatabaseClient(
    async (client) => {
      const existing = await client.query<{ id: string }>(
        'select "id" from "user" where "email" = $1',
        [email],
      )
      const found = existing.rows[0]
      if (found !== undefined) {
        return { id: found.id, email }
      }

      const id = generateRandomString(32)
      const now = new Date()
      await client.query(
        'insert into "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") ' +
          'values ($1, $2, $3, true, $4, $4)',
        [id, email, email, now],
      )
      await client.query(
        'insert into "account" ("id", "accountId", "providerId", "userId", "password", ' +
          '"createdAt", "updatedAt") values ($1, $2, $3, $4, $5, $6, $6)',
        [generateRandomString(32), id, 'credential', id, passwordHash, now],
      )
      return { id, email }
    },
    { database: database.name },
  )
}
