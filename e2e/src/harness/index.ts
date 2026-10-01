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
import { ensureUser } from './users'

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
  /**
   * Sign in again even when this file already has a session for that account on that server.
   *
   * Sign-in is **rate-limited** (A2: three per ten seconds per address), a test that asks for
   * the same account twice would otherwise spend its budget on itself, and several clients
   * sharing one session is what the harness documents. A test that needs a *new* session —
   * one that signed out, say — asks for a fresh one explicitly.
   */
  readonly fresh?: boolean
}

/** A signed-in caller: the session token and who it belongs to. */
export interface SignedIn {
  /** The session token; a bearer request sends it as `Authorization: Bearer <token>`. */
  readonly token: string
  /** The signed-in user, as Better Auth answers it. */
  readonly user: { readonly id: string; readonly email: string }
}

/** One signed-in person: the session they hold, and the SDK client carrying it. */
export interface Person {
  /** The session token, for the raw requests the SDK does not wrap. */
  readonly signedIn: SignedIn
  /** The same session, as an `@openharness/client` client. */
  readonly client: Client
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
   * Sign in as an account on a server this harness started.
   *
   * The dev user (A7) is the default. Any other address is first made to exist in the file's
   * database the way Better Auth makes one (`users.ts`), because sign-up is disabled and the
   * dev login seeds exactly one person: several-people tests need a second account, and this
   * is the only honest way to get one.
   */
  user(server: ServerProcess, options?: ClientOptions): Promise<SignedIn>
  /**
   * A client for a server this harness started, signed in over the dev login.
   *
   * `oh`'s shape: the harness POSTs the documented dev user to `/api/auth/sign-in/email` and
   * builds the client with the session token as its bearer (A2). The token is remembered per
   * server, so several clients for one server share one session.
   *
   * With `options.email` set, the client carries **that** account's session instead — the
   * account is created first when it is not the dev user, which is how an isolation test gets
   * a second person.
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
  /** One session per account per server, so a file's sign-ins stay inside the rate limit. */
  const sessionsByServer = new WeakMap<ServerProcess, Map<string, Promise<SignedIn>>>()
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
    user: async (server, options = {}) => {
      const email = options.email ?? DEV_LOGIN_EMAIL
      const password = options.password ?? DEV_LOGIN_PASSWORD
      const sessions = sessionsByServer.get(server) ?? new Map<string, Promise<SignedIn>>()
      sessionsByServer.set(server, sessions)
      const remembered = options.fresh === true ? undefined : sessions.get(email)
      if (remembered !== undefined) {
        return remembered
      }
      const signingIn = (async () => {
        if (email !== DEV_LOGIN_EMAIL) {
          // Not the seeded dev user: the account has to exist before Better Auth can sign it in.
          await ensureUser(await harness.database(), email, password)
        }
        return signIn(server, { email, password })
      })()
      sessions.set(email, signingIn)
      return signingIn
    },
    client: async (server, options = {}) => clientFor(server, await harness.user(server, options)),
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

/**
 * A client carrying one signed-in caller's token.
 *
 * {@link E2eHarness.client} is the usual way; this is for a test that needs both the session
 * token (for a raw `fetch`, say, or the SSE route by hand) and the SDK — one sign-in, both
 * handles.
 */
export function clientFor(server: ServerProcess, signedIn: SignedIn): Client {
  return createClient({ baseUrl: server.baseUrl, token: signedIn.token })
}

/** Both handles for one caller — the token for raw requests, the client for the SDK. */
export function personFor(server: ServerProcess, signedIn: SignedIn): Person {
  return { signedIn, client: clientFor(server, signedIn) }
}

export { seedProviderCredential } from './credentials'
export { createE2eDatabase, withDatabaseClient, type E2eDatabase } from './database'
export { errorOf } from './errors'
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
export { ensureUser, type E2eUser } from './users'
export { DEFAULT_WAIT_MS, sleep, waitFor } from './wait'
