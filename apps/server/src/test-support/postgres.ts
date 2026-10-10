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
import type {
  AppendableEvent,
  AppendEventsOptions,
  Clock,
  PartitionFence,
} from '@openharness/session'
import type { SessionId, StoredEvent, UserId } from '@openharness/protocol'

import { TEST_OWNER_ID } from './harness'

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
  /**
   * A fresh store — a separate listening connection — over the same tables.
   *
   * `now` is the clock the store derives every timestamp, lease expiry and membership window
   * from, and it exists for the same reason the contract takes one: a test that is about
   * expiry passes a `TestClock` and moves time by hand instead of waiting for it (#262). Every
   * store a test means to share a clock with must be handed the same one, or their views of a
   * lease and of a membership window disagree.
   */
  store(options?: { partitionCount?: number; now?: Clock }): PostgresSessionStore
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
  // A `pg` pool re-emits an idle client's error as an `error` event on the pool itself, and a
  // pool nobody listens to turns that into an unhandled 'error' event. One of those is the
  // *expected* end of a run against a container: `pool.end()` resolves once every client has
  // been marked released, but each client's socket closes a moment later, and the container
  // stopping first makes Postgres answer the still-attached client with an admin shutdown
  // (SQLSTATE 57P01). That error is only expected while `close()` is tearing the fixture
  // down; anything else is kept here and thrown by `close()`, so a real connection problem is
  // still loud rather than being swallowed for the sake of the teardown race.
  const poolErrors: Error[] = []
  let tearingDown = false
  pool.on('error', (error: Error) => {
    if (tearingDown && isAdminShutdown(error)) {
      return
    }
    poolErrors.push(error)
  })
  await migrate(db)
  // `owner_id` references Better Auth's `"user"` row, so the owner the tests create as has to
  // exist before the first agent does — exactly what Better Auth's sign-in does in production.
  await ensureTestUser(db, TEST_OWNER_ID)
  const stores: PostgresSessionStore[] = []
  const fixture: PostgresFixture = {
    pool,
    connectionString,
    store: (storeOptions = {}) => {
      const store = createPostgresSessionStore(
        { pool },
        {
          partitionCount: storeOptions.partitionCount ?? options.partitions ?? 64,
          ...(storeOptions.now === undefined ? {} : { now: storeOptions.now }),
        },
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
      // Order matters: every store's listening connection goes first, then the pool, and only
      // then the container — so nothing is still attached when Postgres shuts down.
      tearingDown = true
      await Promise.all(stores.splice(0).map((store) => store.close()))
      await pool.end()
      await container?.stop()
      const first = poolErrors[0]
      if (first !== undefined) {
        throw new Error(
          `the Postgres pool reported ${poolErrors.length} unexpected error(s) outside teardown; ` +
            `the first was: ${first.message}`,
          { cause: first },
        )
      }
    },
  }
  return fixture
}

/**
 * Seed a Better Auth `"user"` row — the foreign key `owner_id` needs.
 *
 * Tests that create agents and sessions directly against the store (without going through
 * sign-in) must seed the owner they use; production never does this, because Better Auth's
 * sign-in writes the row itself.
 */
export async function ensureTestUser(db: Kysely<PostgresSchema>, userId: UserId): Promise<void> {
  await sql`
    insert into "user" ("id", "name", "email", "emailVerified")
    values (${userId}, 'Test owner', ${`${userId}@openharness.test`}, true)
    on conflict ("id") do nothing
  `.execute(db)
}

/**
 * Empty every table the store uses; `session_previews` was dropped in P4 (issue #46).
 *
 * `scheduler_instances` is here since #122, so one test's memberships cannot leak into the
 * next: an instance stopped by the test's `afterEach` removes its row itself, and the
 * truncate is the backstop for a test that ever left one behind.
 */
export async function truncateAll(db: Kysely<PostgresSchema>): Promise<void> {
  await sql`truncate table events, sessions, agents, partition_leases, scheduler_instances`.execute(
    db,
  )
}

/**
 * Whether an error is Postgres's admin shutdown — SQLSTATE `57P01`, "terminating connection
 * due to administrator command" — which is what a client that is still attached when the
 * server stops is answered with.
 */
function isAdminShutdown(error: Error): boolean {
  return (error as { code?: unknown }).code === '57P01'
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
   * makes: a claim on a user event rides on the event that answers it — a span start, a span
   * end or a status idle (P4) — and there is no out-of-band claim call left to record.
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
