import { afterAll } from 'vitest'

import { createClient, type Client } from '@openharness/client'

import { DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD } from '@openharness/server'

import { createE2eDatabase, type E2eDatabase } from './database'
import {
  startServerProcess,
  stopAllServerProcesses,
  type ServerProcess,
  type ServerProcessOptions,
} from './server'

/**
 * What one e2e test file gets: a database of its own, servers it can kill, and a client.
 *
 * ```ts
 * const harness = e2eHarness('my-scenario')
 *
 * it('does something', async () => {
 *   const server = await harness.server()
 *   const client = harness.client(server)
 *   // ...
 * })
 * ```
 *
 * `e2eHarness` registers the teardown itself (`afterAll`): every server the file started is
 * killed, and the database is dropped. A test that fails half-way through therefore leaks
 * neither a process nor a database — which matters most in CI, where a leaked server would
 * hold its port and its Postgres connections until the job ends.
 */

/** How a test asks for a client: whose session it should carry. */
export interface ClientOptions {
  /** The account to sign in as; the dev user when omitted. */
  readonly email?: string
  /** The account's password; the documented dev password when omitted. */
  readonly password?: string
}

/** A signed-in caller: the session token and who it belongs to. */
export interface SignedIn {
  /** The session token; a bearer request sends it as `Authorization: Bearer <token>`. */
  readonly token: string
  /** The signed-in user, as Better Auth answers it. */
  readonly user: { readonly id: string; readonly email: string }
}

/**
 * Sign in over the dev login (A7), the way `oh login` would end up: a session token.
 *
 * Every server the harness starts is seeded with the same dev user, so a token minted by one
 * of them keeps working after the failover suite kills it and starts another on the same
 * database — the sessions live in Postgres, not in the process.
 */
export async function signIn(
  server: ServerProcess,
  options: ClientOptions = {},
): Promise<SignedIn> {
  const response = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: options.email ?? DEV_LOGIN_EMAIL,
      password: options.password ?? DEV_LOGIN_PASSWORD,
    }),
  })
  const body = (await response.json()) as { token?: string; user?: SignedIn['user'] }
  if (!response.ok || typeof body.token !== 'string' || body.user === undefined) {
    throw new Error(
      `signing in at ${server.baseUrl} failed: ${response.status} ${JSON.stringify(body)}`,
    )
  }
  return { token: body.token, user: body.user }
}

// The documented dev credentials (A7), taken from the server itself so the harness and the
// seed cannot drift apart.
export { DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD, DEV_LOGIN_STORED_EMAIL } from '@openharness/server'

/** A test file's view of the world: one database, its servers, its clients. */
export interface E2eHarness {
  /** The database this file owns: created on first use, dropped by {@link dispose}. */
  database(): Promise<E2eDatabase>
  /** Start a server against this file's database; it is killed by {@link dispose}. */
  server(options?: Omit<ServerProcessOptions, 'databaseUrl'>): Promise<ServerProcess>
  /**
   * A client for a server this harness started, signed in over the dev login.
   *
   * `oh`'s shape: the harness POSTs the documented dev user to `/api/auth/sign-in/email` and
   * builds the client with the session token as its bearer (A2). The token is remembered per
   * server, so several clients for one server share one session.
   */
  client(server: ServerProcess, options?: ClientOptions): Promise<Client>
  /** Every server this harness started and has not killed. */
  readonly servers: readonly ServerProcess[]
  /** Kill the servers and drop the database. Idempotent; also runs in `afterAll`. */
  dispose(): Promise<void>
}

/**
 * Create a harness for one test file.
 *
 * @param label a short name for the file's database, e.g. `'stream-resume'`
 */
export function e2eHarness(label: string): E2eHarness {
  const started: ServerProcess[] = []
  let database: Promise<E2eDatabase> | undefined
  let disposing: Promise<void> | undefined

  const harness: E2eHarness = {
    database: () => {
      database ??= createE2eDatabase(label)
      return database
    },
    server: async (options = {}) => {
      const owned = await harness.database()
      const server = await startServerProcess({ ...options, databaseUrl: owned.url })
      started.push(server)
      return server
    },
    client: async (server, options = {}) => {
      const signedIn = await signIn(server, options)
      return createClient({ baseUrl: server.baseUrl, token: signedIn.token })
    },
    get servers(): readonly ServerProcess[] {
      return started
    },
    dispose: () => {
      disposing ??= (async () => {
        await Promise.all(started.map(async (server) => server.kill()))
        await stopAllServerProcesses()
        if (database !== undefined) {
          const owned = await database
          await owned.dispose()
        }
      })()
      return disposing
    },
  }

  afterAll(async () => {
    await harness.dispose()
  })
  return harness
}

export { createE2eDatabase, withDatabaseClient, type E2eDatabase } from './database'
export {
  agentMessages,
  collectStream,
  deltaText,
  describeEvents,
  hasOpenTurn,
  isPreviewDelta,
  isStoredIdle,
  modelRequestEnds,
  previewedEventId,
  readLog,
  storedSeqs,
  textOf,
  typesOf,
  userMessages,
  waitForTurnEnd,
} from './events'
export type { StreamCollector } from './events'
export { expectedSlowReply } from './mock'
export {
  serverEntryPath,
  startServerProcess,
  stopAllServerProcesses,
  webAppDir,
  type ServerProcess,
  type ServerProcessOptions,
} from './server'
export { DEFAULT_WAIT_MS, sleep, waitFor } from './wait'
