import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import {
  PostgresSessionStore,
  createPostgresSessionStore,
  migrate,
} from '@openharness/session/postgres'
import type { PostgresSchema } from '@openharness/session/postgres'
import type { AppendableEvent, AppendEventsOptions, PartitionFence } from '@openharness/session'
import type { SessionId, StoredEvent } from '@openharness/protocol'

/**
 * A real Postgres for the tests that need one, which is every test of the partitioned
 * scheduler: leases, epochs and the signals between instances are properties of the shared
 * database, not of a process.
 *
 * Same rule as `packages/session`: `DATABASE_URL` when it is set (which is what CI does, with
 * the service container the workflow starts), otherwise Postgres in a container if there is a
 * Docker daemon, otherwise **nothing** — the caller skips its tests with a note, because a
 * skipped scheduler test is not a passing one.
 *
 * Each {@link PostgresFixture.store} is a *separate store* — its own listening connection, its
 * own view of the lease table — on the shared pool. That is what makes several schedulers in
 * one test process behave like several servers: the same tables, reached over independent
 * connections, with `LISTEN`/`NOTIFY` in between.
 */

/** The image the tests bring up when they have to start their own Postgres. */
export const POSTGRES_IMAGE = 'postgres:18-alpine'

/** Where a test's database can come from. */
export type PostgresSource = 'DATABASE_URL' | 'Docker' | null

/** How long starting a container, connecting and migrating may take. */
export const POSTGRES_STARTUP_TIMEOUT_MS = 240_000

/** How many connections the shared pool opens; enough for a handful of instances. */
const POOL_SIZE = 12

/** Whether this machine can reach a real database at all. */
export function postgresSource(env: NodeJS.ProcessEnv = process.env): PostgresSource {
  if ((env.DATABASE_URL ?? '') !== '') {
    return 'DATABASE_URL'
  }
  return dockerIsAvailable() ? 'Docker' : null
}

/** Whether a Docker daemon looks reachable, so testcontainers has something to talk to. */
export function dockerIsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof env.DOCKER_HOST === 'string' && env.DOCKER_HOST.trim() !== '') {
    return true
  }
  const socket =
    typeof env.DOCKER_SOCKET === 'string' && env.DOCKER_SOCKET.trim() !== ''
      ? env.DOCKER_SOCKET
      : '/var/run/docker.sock'
  if (existsSync(socket)) {
    return true
  }
  return existsSync(join(homedir(), '.docker', 'run', 'docker.sock'))
}

/** A database the tests can use: the pool, and the stores built on it. */
export interface PostgresFixture {
  /** The pool every store shares; it holds connections, not state. */
  readonly pool: Pool
  /** The connection string the tests reached Postgres with. */
  readonly connectionString: string
  /** A fresh store — a separate listening connection — over the same tables. */
  store(options?: { partitionCount?: number }): PostgresSessionStore
  /** Register a store the test built itself (a subclass, say) to be closed with the fixture. */
  track<T extends PostgresSessionStore>(store: T): T
  /** Empty every table, so the next test starts from nothing. */
  truncate(): Promise<void>
  /** Close every store the fixture handed out, then the pool. */
  close(): Promise<void>
}

/** Bring up (or connect to) the database the tests run against. */
export async function startPostgres(
  options: { readonly partitions?: number } = {},
): Promise<PostgresFixture> {
  const source = postgresSource()
  if (source === null) {
    throw new Error('no DATABASE_URL and no Docker daemon: there is no database to use')
  }
  let container: StartedPostgreSqlContainer | undefined
  let connectionString = process.env.DATABASE_URL ?? ''
  if (source === 'Docker') {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE).start()
    connectionString = container.getConnectionUri()
  }
  const pool = new Pool({ connectionString, max: POOL_SIZE })
  const db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool }) })
  await migrate(db)
  const stores: PostgresSessionStore[] = []
  const fixture: PostgresFixture = {
    pool,
    connectionString,
    store: (storeOptions = {}) => {
      const store = createPostgresSessionStore(
        { pool },
        { partitionCount: storeOptions.partitionCount ?? options.partitions ?? 64 },
      )
      stores.push(store)
      return store
    },
    track: (store) => {
      stores.push(store)
      return store
    },
    truncate: () => truncateAll(db),
    close: async () => {
      await Promise.all(stores.splice(0).map((store) => store.close()))
      await pool.end()
      await container?.stop()
    },
  }
  return fixture
}

/** Empty the five tables the store uses. */
export async function truncateAll(db: Kysely<PostgresSchema>): Promise<void> {
  await sql`truncate table events, session_previews, sessions, agents, partition_leases`.execute(db)
}

/** What a recorded write carried: the fence, when the writer attached one. */
export interface RecordedWrite {
  /** The lease the write was made under, or `undefined` for an unfenced write. */
  readonly fence?: PartitionFence
}

/**
 * A store that records the options of every write it is asked to make, and behaves like the
 * real one in every other way.
 *
 * A test uses it to see the fence a turn ran under — the difference between "the brain wrote
 * under some lease" and "the brain wrote under *this instance's* lease". It is a subclass
 * rather than a wrapper so that everything it does not override, including the store's own
 * listening connection, is the real implementation's.
 */
export class RecordingStore extends PostgresSessionStore {
  /**
   * Every `appendEvents` this store has been asked to make, in order.
   *
   * One entry per append, because since D9 (issue #46) an append is the only write a turn
   * makes: the claim on a user event rides on the span start, and there is no `markProcessed`
   * call left to record.
   */
  readonly writes: RecordedWrite[] = []

  override async appendEvents(
    sessionId: SessionId,
    events: AppendableEvent[],
    options?: AppendEventsOptions,
  ): Promise<StoredEvent[]> {
    this.writes.push(options ?? {})
    return super.appendEvents(sessionId, events, options)
  }
}

/**
 * A store that counts its subscriptions, like `ObservableStore` does in memory.
 *
 * A test that has to catch what a connection is sent *live* — a preview delta, say, which
 * only goes to the connections attached when it is published — needs that connection's
 * subscription to be in place before the events are, and counting them is the only way to
 * know it is: `subscribe` answers once the `LISTEN` has been issued.
 */
export class ObservablePostgresStore extends PostgresSessionStore {
  /** How many subscriptions this store has established. */
  subscriptions = 0

  /** How many of them have been released again. */
  unsubscribed = 0

  override async subscribe(
    sessionId: SessionId,
    listener: Parameters<PostgresSessionStore['subscribe']>[1],
  ): ReturnType<PostgresSessionStore['subscribe']> {
    const unsubscribe = await super.subscribe(sessionId, listener)
    this.subscriptions += 1
    return () => {
      this.unsubscribed += 1
      unsubscribe()
    }
  }
}
