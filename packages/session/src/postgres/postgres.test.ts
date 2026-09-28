import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  isStoredEvent,
  newEventId,
  partitionOf,
  type CreateAgentRequest,
  type Session,
  type StoredEvent,
  type UserEventInput,
} from '@openharness/protocol'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { DuplicateEventIdError, FencedError, isFencedError } from '../errors'
import { createTestClock, type TestClock } from '../testing/clock'
import { runSessionStoreConformance, type MakeSessionStore } from '../testing/conformance'
import { createPostgresSessionStore, migrate, type PostgresSchema } from './index'

/**
 * The Postgres store's tests: the whole conformance suite, plus what only a shared store can
 * be asked about.
 *
 * ## Where the database comes from
 *
 * `DATABASE_URL` when it is set — which is what CI does, with the service container the
 * workflow starts. Otherwise a Postgres brought up by testcontainers, if a Docker daemon is
 * around. If neither is available the suite is **skipped with a note** rather than silently
 * passing: the store is the durable one, and "the tests did not run" must not look like "the
 * tests passed".
 *
 * The extras are the ones a shared store can be asked and a single-process fake cannot: two
 * stores appending at once, a supplied event id two of them try to take, fencing across
 * stores, a burst that must be delivered exactly once, catching up after the listening
 * connection is killed, a dropped oversized ephemeral event, idempotent migrations, and
 * `close()` leaving a borrowed pool alone.
 *
 * ## How each test is isolated
 *
 * The suite's factory is called once per test and must not hand out shared state, so the
 * factory truncates every table and builds a fresh store on the clock it is given. The pool
 * itself is shared — it holds no state, and a store keeps none of its own outside Postgres
 * and its own listening connection — and each store is closed after the test that made it.
 */

/** What the tests bring up when they have to start their own Postgres. */
const POSTGRES_IMAGE = 'postgres:18-alpine'

/** The instant the extra tests' clocks start at, matching the conformance suite's. */
const START_MS = Date.UTC(2026, 2, 15, 10, 0, 0)

/** One second in milliseconds. */
const SECOND = 1000

/** How long a burst test waits for deliveries that may be asynchronous. */
const DELIVERY_TIMEOUT_MS = 5_000

/** How many connections the shared pool opens; enough for the concurrency tests. */
const POOL_SIZE = 8

/** How long starting a container, migrating and connecting may take. */
const STARTUP_TIMEOUT_MS = 240_000

/** The database the tests run against, when the environment names one. */
const DATABASE_URL = process.env.DATABASE_URL ?? ''

/** How the tests reach Postgres, if they can reach one at all. */
const target: 'DATABASE_URL' | 'Docker' | null =
  DATABASE_URL !== '' ? 'DATABASE_URL' : dockerIsAvailable() ? 'Docker' : null

if (target === null) {
  // A skip, not a pass: the acceptance test of this store is that it runs against a real
  // Postgres. Set DATABASE_URL, or start Docker, and run `yarn test` again.
  describe.skip('PostgresSessionStore (skipped: no DATABASE_URL and no Docker daemon)', () => {
    it('would run the conformance suite against Postgres', () => {
      expect.unreachable('unreachable: the suite is skipped')
    })
  })
} else {
  let container: StartedPostgreSqlContainer | undefined
  let pool: Pool
  let db: Kysely<PostgresSchema>

  /** Every store a test made, closed again afterwards so its listening connection goes. */
  const stores: ReturnType<typeof createPostgresSessionStore>[] = []

  beforeAll(async () => {
    let connectionString = DATABASE_URL
    if (connectionString === '') {
      container = await new PostgreSqlContainer(POSTGRES_IMAGE).start()
      connectionString = container.getConnectionUri()
    }
    pool = new Pool({ connectionString, max: POOL_SIZE })
    db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool }) })
    await migrate(db)
  }, STARTUP_TIMEOUT_MS)

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()))
  })

  afterAll(async () => {
    await pool.end()
    await container?.stop()
  })

  /**
   * The factory the conformance suite drives: a fresh store per test, on empty tables, with
   * the clock the suite hands it.
   */
  const makeStore: MakeSessionStore = async (clock) => {
    await truncateAll()
    return track(createPostgresSessionStore({ pool }, { now: clock.now }))
  }

  runSessionStoreConformance(makeStore, { name: 'PostgresSessionStore' })

  // -------------------------------------------------------------- extra tests

  describe('PostgresSessionStore: more than the contract asks', () => {
    it('assigns a gap-free seq to concurrent appends from two stores', async () => {
      const { store: first, clock, session } = await seeded()
      // A second store on the same pool is a second process as far as the database is
      // concerned: its own connections, its own listening connection, the same tables.
      const second = track(createPostgresSessionStore({ pool }, { now: clock.now }))

      const batches = await Promise.all([
        ...Array.from({ length: 8 }, (_unused, index) =>
          first.appendEvents(session.id, [userMessage(`first ${index}`)]),
        ),
        ...Array.from({ length: 8 }, (_unused, index) =>
          second.appendEvents(session.id, [userMessage(`second ${index}`)]),
        ),
      ])

      const events = (await first.listEvents(session.id, { limit: MAX_PAGE_LIMIT })).data
      const expected = Array.from({ length: 16 }, (_unused, index) => index + 1)
      // Gap-free and in order: the session row lock serializes the appends, and `seq` is read
      // from the log's own end inside each of those transactions.
      expect(events.map((event) => event.seq)).toEqual(expected)
      // And every append got exactly one distinct seq back — none of them was handed a number
      // another one also got.
      expect(
        batches
          .flat()
          .map((event) => event.seq)
          .sort(ascending),
      ).toEqual(expected)
    })

    it('refuses the same supplied id from two stores, for two sessions at once', async () => {
      const { store: first, session } = await seeded()
      const second = track(createPostgresSessionStore({ pool }, { now: () => START_MS }))
      const other = await second.createSession((await second.createAgent(agentInput('Other'))).id)
      const id = newEventId()

      // Two appends to different sessions do not share the append lock, so nothing serializes
      // them: the unique constraint on `events.id` is what decides. One append stores its
      // event, the other is refused whole.
      const results = await Promise.allSettled([
        first.appendEvents(session.id, [{ ...userMessage('first'), id }]),
        second.appendEvents(other.id, [{ ...userMessage('second'), id }]),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const refused = results.filter((result) => result.status === 'rejected')
      expect(refused).toHaveLength(1)
      expect(refused[0]?.reason).toBeInstanceOf(DuplicateEventIdError)
      expect((refused[0]?.reason as DuplicateEventIdError).eventId).toBe(id)

      // The id landed once, in one of the two logs, and the loser stored nothing.
      const stored = [
        ...(await first.listEvents(session.id)).data,
        ...(await second.listEvents(other.id)).data,
      ]
      expect(stored.map((event) => event.id)).toEqual([id])
    })

    it('fences a stale epoch across stores, and accepts the current one', async () => {
      const { store: owner, session } = await seeded()
      const partition = partitionOf(session.id)
      const stale = await owner.acquirePartition(partition, 'owner-1', 30 * SECOND)
      expect(stale).not.toBeNull()
      const staleEpoch = stale?.epoch ?? 0

      // Another store sees the same lease: leases live in the database, not in the process.
      const zombie = track(createPostgresSessionStore({ pool }, { now: () => START_MS }))
      const accepted = await zombie.appendEvents(session.id, [userMessage('owner')], {
        fence: { partition, epoch: staleEpoch },
      })
      expect(accepted).toHaveLength(1)

      // A new tenure — the same owner asking again is enough — and the old one is fenced.
      const current = await owner.acquirePartition(partition, 'owner-1', 30 * SECOND)
      const currentEpoch = current?.epoch ?? 0
      expect(currentEpoch).toBeGreaterThan(staleEpoch)

      const error = await thrownBy(() =>
        zombie.appendEvents(session.id, [userMessage('zombie')], {
          fence: { partition, epoch: staleEpoch },
        }),
      )
      expect(isFencedError(error)).toBe(true)
      expect(error).toBeInstanceOf(FencedError)
      expect((error as FencedError).currentEpoch).toBe(currentEpoch)
      expect((await owner.listEvents(session.id)).data).toHaveLength(1)

      await zombie.appendEvents(session.id, [userMessage('back')], {
        fence: { partition, epoch: currentEpoch },
      })
      expect((await owner.listEvents(session.id)).data).toHaveLength(2)
    })

    it('delivers a burst of concurrent appends exactly once, in seq order', async () => {
      const { store, session } = await seeded()
      const received: number[] = []
      await store.subscribe(session.id, (event) => {
        if (isStoredEvent(event)) {
          received.push(event.seq)
        }
      })

      const bursts = 10
      await Promise.all(
        Array.from({ length: bursts }, (_unused, index) =>
          store.appendEvents(session.id, [
            userMessage(`burst ${index}`),
            userMessage(`more ${index}`),
          ]),
        ),
      )

      const stored = (await store.listEvents(session.id, { limit: MAX_PAGE_LIMIT })).data
      const expected = stored.map((event) => event.seq)
      expect(expected).toHaveLength(bursts * 2)
      await waitFor(() => received.length >= expected.length, 'the whole burst')
      // No gaps, no duplicates, and in `seq` order: notifications may coalesce or arrive out
      // of step with the commits, which is why a subscriber fetches a range rather than
      // trusting a payload to be the event.
      expect(received).toEqual(expected)
    })

    it('catches up on what was appended while the listening connection was down', async () => {
      const { store, session } = await seeded()
      const received: number[] = []
      await store.subscribe(session.id, (event) => {
        if (isStoredEvent(event)) {
          received.push(event.seq)
        }
      })
      await store.appendEvents(session.id, [userMessage('before')])
      await waitFor(() => received.length === 1, 'the first event')

      // Kill the store's listening backend. Notifications sent while it is gone are gone —
      // Postgres does not queue them — so this is exactly the case the reconnect path has to
      // recover from: re-`LISTEN`, then fetch from the last `seq` that was delivered.
      const terminated = await sql<{ pg_terminate_backend: boolean }>`
        select pg_terminate_backend(pid)
          from pg_stat_activity
         where pid <> pg_backend_pid()
           and query ilike 'listen %'
      `.execute(db)
      expect(terminated.rows.length).toBeGreaterThan(0)

      await store.appendEvents(session.id, [userMessage('while it was down')])
      await waitFor(() => received.length === 2, 'the event from while it was down')
      expect(received).toEqual([1, 2])

      // And the reconnected connection is not just replaying: the next append arrives too.
      await store.appendEvents(session.id, [userMessage('after')])
      await waitFor(() => received.length === 3, 'the event after the reconnect')
      expect(received).toEqual([1, 2, 3])
    })

    it('drops an ephemeral event that cannot fit in a notification', async () => {
      const { store, session } = await seeded()
      const received: string[] = []
      await store.subscribe(session.id, (event) => {
        received.push(event.type)
      })
      const [message] = await store.appendEvents(session.id, [userMessage('hi')])
      const previewed = message?.id ?? ('sevt_00000000000000000000000000' as StoredEvent['id'])

      // Well past the 8000-byte `NOTIFY` payload Postgres accepts. Deltas are a preview, not
      // the record, so the publish succeeds and the delta is simply not delivered.
      await store.publishEphemeral(session.id, {
        type: EVENT_TYPES.eventDelta,
        event_id: previewed,
        delta: {
          type: 'content_delta',
          index: 0,
          content: { type: 'text', text: 'x'.repeat(9_000) },
        },
      })
      await store.publishEphemeral(session.id, {
        type: EVENT_TYPES.eventStart,
        event: { type: EVENT_TYPES.agentMessage, id: previewed },
      })
      await waitFor(() => received.length === 2, 'the stored event and the small preview')
      expect(received).toEqual([EVENT_TYPES.userMessage, EVENT_TYPES.eventStart])
    })

    it('applies its migrations idempotently', async () => {
      // The suite's `beforeAll` has already migrated this database; running again must be a
      // no-op that leaves the schema usable, which is what makes it safe on every deploy.
      const files = await migrate(db)
      expect(files.length).toBeGreaterThan(0)
      expect(await migrate(db)).toEqual(files)

      const { store, session } = await seeded()
      expect(await store.getSession(session.id)).toEqual(session)
    })

    it('leaves a pool it did not open alone, and ends one it did', async () => {
      const borrowed = track(createPostgresSessionStore({ pool }, { now: () => START_MS }))
      await borrowed.createAgent(agentInput())
      await borrowed.close()
      // The pool is the caller's: a store that borrowed it must not have ended it, so the
      // rest of the application — and this test — can keep using it.
      await sql`select 1`.execute(db)

      const owned = createPostgresSessionStore(
        { connectionString: DATABASE_URL === '' ? connectionOf(container) : DATABASE_URL },
        { now: () => START_MS },
      )
      const agent = await owned.createAgent(agentInput('Owned'))
      expect(agent.name).toBe('Owned')
      await owned.close()
      await expect(owned.close()).resolves.toBeUndefined()
    })
  })

  /** The store a test works with: a clock it can move, and one seeded session. */
  async function seeded(clock: TestClock = createTestClock(START_MS)): Promise<{
    store: ReturnType<typeof createPostgresSessionStore>
    clock: TestClock
    session: Session
  }> {
    await truncateAll()
    const store = track(createPostgresSessionStore({ pool }, { now: clock.now }))
    const agent = await store.createAgent(agentInput())
    const session = await store.createSession(agent.id, { initial_events: [] })
    return { store, clock, session }
  }

  /** Remember a store so `afterEach` closes it. */
  function track(store: ReturnType<typeof createPostgresSessionStore>) {
    stores.push(store)
    return store
  }

  /** Empty every table, so a test starts where the previous one started. */
  async function truncateAll(): Promise<void> {
    await sql`truncate table events, sessions, agents, partition_leases`.execute(db)
  }
}

/** A `POST /v1/agents` body. */
function agentInput(name = 'Summarizer'): CreateAgentRequest {
  return { name, model: { id: 'anthropic/claude-sonnet-5' }, system: 'You are concise.' }
}

/** A `user.message` to append. */
function userMessage(text: string): UserEventInput {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** Whether a Docker daemon looks reachable, so testcontainers has something to talk to. */
function dockerIsAvailable(): boolean {
  if ((process.env.DOCKER_HOST ?? '') !== '') {
    return true
  }
  return ['/var/run/docker.sock', join(homedir(), '.docker', 'run', 'docker.sock')].some((socket) =>
    existsSync(socket),
  )
}

/** The connection string of the container the harness started, when it started one. */
function connectionOf(started: StartedPostgreSqlContainer | undefined): string {
  if (started === undefined) {
    throw new Error('no container was started: this test needs DATABASE_URL or Docker')
  }
  return started.getConnectionUri()
}

/** Await `work` and return what it threw; fails the test when it does not throw. */
async function thrownBy(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw, but it resolved')
}

/** Sort numbers the way a test's expectation reads. */
function ascending(left: number, right: number): number {
  return left - right
}

/** Wait for a condition that only becomes true once the store has delivered something. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${DELIVERY_TIMEOUT_MS}ms waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
