import { afterAll } from 'vitest'

import { createClient, type Client, type FetchLike } from '@openharness/client'

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

/** A test file's view of the world: one database, its servers, its clients. */
export interface E2eHarness {
  /** The database this file owns: created on first use, dropped by {@link dispose}. */
  database(): Promise<E2eDatabase>
  /** Start a server against this file's database; it is killed by {@link dispose}. */
  server(options?: Omit<ServerProcessOptions, 'databaseUrl'>): Promise<ServerProcess>
  /** A client for a server this harness started, with the key it was started with. */
  client(server: ServerProcess, options?: { readonly apiKey?: string }): Client
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
    client: (server, options = {}) => {
      if (options.apiKey === undefined) {
        return createClient({ baseUrl: server.baseUrl })
      }
      // The SDK's static `x-api-key` option is gone (epic #65, A8), but the v1 server still
      // asks for that key — it goes with #61, which rewrites this suite's expectations with
      // #64. Until then the harness presents the key itself, the way the removed option did.
      const apiKey = options.apiKey
      const withApiKey: FetchLike = (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('x-api-key', apiKey)
        return globalThis.fetch(input, { ...init, headers })
      }
      return createClient({ baseUrl: server.baseUrl, fetch: withApiKey })
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
