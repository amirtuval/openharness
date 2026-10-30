import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  SessionSchema,
  isStoredEvent,
  newEventId,
  newSessionId,
  newTaskId,
  partitionOf,
  type CreateAgentRequest,
  type EventId,
  type Session,
  type StreamEvent,
  type UserEventInput,
  type UserId,
} from '@openharness/protocol'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { UpsertCredentialInput } from '../credentials'
import type { CreateMcpServerInput } from '../mcp-servers'
import {
  DuplicateEventIdError,
  DuplicateMcpServerNameError,
  FencedError,
  isFencedError,
  SessionNotFoundError,
} from '../errors'
import type { AppendableEvent } from '../store'
import { timestampAt } from '../clock'
import { createTestClock, type TestClock } from '../testing/clock'
import {
  OWNER_A,
  OWNER_B,
  runSessionStoreConformance,
  type MakeSessionStore,
} from '../testing/conformance'
import { runCredentialStoreConformance } from '../testing/credentials-conformance'
import { runMcpServerStoreConformance } from '../testing/mcp-servers-conformance'
import {
  createPostgresCredentialStore,
  createPostgresMcpServerStore,
  createPostgresSessionStore,
  migrate,
  type PostgresSchema,
} from './index'

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
 * connection is killed, a chunk delivered across stores, a session deletion's rows really
 * gone and its `session.deleted` announced across stores (#111), idempotent migrations —
 * `0016` included — the #93 backfill over a row written before the change, and `close()`
 * leaving a borrowed pool alone.
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

/** How long a test waits before asserting that nothing more was delivered. */
const SETTLE_MS = 50

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
  let connectionString = DATABASE_URL
  let pool: Pool
  let db: Kysely<PostgresSchema>

  /** Every store a test made, closed again afterwards so its listening connection goes. */
  const stores: ReturnType<typeof createPostgresSessionStore>[] = []

  /** Every credential store a test made, closed again afterwards. */
  const credentialStores: ReturnType<typeof createPostgresCredentialStore>[] = []

  /** Every MCP server store a test made, closed again afterwards. */
  const mcpStores: ReturnType<typeof createPostgresMcpServerStore>[] = []

  /** How many migration-test schemas this run has made; the name has to be unique per process. */
  let migrationSchemas = 0

  beforeAll(async () => {
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
    await Promise.all(credentialStores.splice(0).map((store) => store.close()))
    await Promise.all(mcpStores.splice(0).map((store) => store.close()))
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

  runSessionStoreConformance(makeStore, {
    name: 'PostgresSessionStore',
    // `agents.owner_id` and `sessions.owner_id` are foreign keys into Better Auth's `"user"`
    // table (0012_ownership.sql), so the suite's owners have to exist as rows before anything
    // is created for them — which is what the server's Better Auth wiring will do in #61.
    ensureUsers,
  })

  /** The credential store's conformance suite, on the same tables and users. */
  runCredentialStoreConformance(
    async (clock) => {
      await truncateAll()
      return trackCredentials(createPostgresCredentialStore({ pool }, { now: clock.now }))
    },
    { name: 'PostgresCredentialStore', ensureUsers },
  )

  /** The MCP server store's conformance suite, on the same tables and users (#303, X10). */
  runMcpServerStoreConformance(
    async (clock) => {
      await truncateAll()
      return trackMcpServers(createPostgresMcpServerStore({ pool }, { now: clock.now }))
    },
    { name: 'PostgresMcpServerStore', ensureUsers },
  )

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

      const events = (await first.listEventsUnscoped(session.id, { limit: MAX_PAGE_LIMIT })).data
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
      const other = await second.createSession(
        (await second.createAgent(agentInput('Other'), OWNER_A)).id,
        { ownerId: OWNER_A },
      )
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
        ...(await first.listEventsUnscoped(session.id)).data,
        ...(await second.listEventsUnscoped(other.id)).data,
      ]
      expect(stored.map((event) => event.id)).toEqual([id])
    })

    it('refuses a child of a session whose delete committed first, and waits for one in flight (#361)', async () => {
      // The one hole the cascade had: `deleteSession` collects the subtree and then locks and
      // deletes exactly those ids, and `parent_session_id` carries no foreign key — so a child
      // inserted between the walk and the delete used to survive a parent that is gone, with no
      // route that would ever list or cascade to it again. `createSession` now **locks the
      // parent row it reads** (`for share`), which the delete's tree lock excludes, so the two
      // serialize instead of interleaving.
      // The seeded store is not used: the child is created through a **second** store, so the
      // pool connection that holds the parent row is not the one the create runs on.
      const { clock, session: parent } = await seeded()
      const other = track(createPostgresSessionStore({ pool }, { now: clock.now }))
      const client = await pool.connect()
      try {
        // A second connection holds the parent's row as the delete's tree lock does, and the
        // create is left waiting for it rather than reading a snapshot and inserting.
        await client.query('begin')
        await client.query('select id from sessions where id = $1 for update', [parent.id])
        const creating = other.createSession(null, {
          ownerId: OWNER_A,
          parentSessionId: parent.id,
          model: { id: 'anthropic/claude-haiku-4-5' },
        })
        const first = await Promise.race([
          creating.then(() => 'settled' as const),
          new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 150)),
        ])
        expect(first).toBe('waiting')

        // The delete commits: the parent is gone, so the create is the parent it looked up —
        // `SessionNotFoundError`, nothing created, and no session left pointing at a session
        // that is not there.
        await client.query('delete from sessions where id = $1', [parent.id])
        await client.query('commit')
        await expect(creating).rejects.toBeInstanceOf(SessionNotFoundError)
      } finally {
        client.release()
      }
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
      expect((await owner.listEventsUnscoped(session.id)).data).toHaveLength(1)

      await zombie.appendEvents(session.id, [userMessage('back')], {
        fence: { partition, epoch: currentEpoch },
      })
      expect((await owner.listEventsUnscoped(session.id)).data).toHaveLength(2)
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

      const stored = (await store.listEventsUnscoped(session.id, { limit: MAX_PAGE_LIMIT })).data
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

    it('delivers a stored chunk of another store, like any other event', async () => {
      const { store, clock, session } = await seeded()
      // A second store on the same pool is a second process as far as the database is
      // concerned: a chunk appended by one is delivered to a subscriber of the other, because
      // since D9 it is a row of the log rather than an ephemeral payload.
      const second = track(createPostgresSessionStore({ pool }, { now: clock.now }))
      const received: string[] = []
      await store.subscribe(session.id, (event) => {
        received.push(event.type)
      })
      const previewed = newEventId()
      await second.appendEvents(session.id, [
        storedEventStart(previewed),
        storedEventDelta(previewed, 'half a '),
        storedEventDelta(previewed, 'reply'),
      ])
      await waitFor(() => received.length === 3, 'the three chunks the other store appended')
      expect(received).toEqual([
        EVENT_TYPES.eventStart,
        EVENT_TYPES.eventDelta,
        EVENT_TYPES.eventDelta,
      ])
    })

    it('never rewrites a stored row, whatever happens to the session', async () => {
      const { store, clock, session } = await seeded()
      const previewed = newEventId()
      const [queued] = await store.appendEvents(session.id, [userMessage('hi')])
      const chunks = await store.appendEvents(session.id, [
        storedEventStart(previewed),
        storedEventDelta(previewed, 'Hel'),
        storedEventDelta(previewed, 'lo'),
      ])
      const before = await eventRows(session.id)

      // Everything a log goes through since D9: a claim by `consumes`, a supersession over the
      // chunk range, and the compaction that deletes the chunks once the window has passed.
      const [span] = await store.appendEvents(session.id, [
        {
          type: EVENT_TYPES.modelRequestStart,
          consumes: [queued?.id ?? ('sevt_00000000000000000000000000' as EventId)],
          model: 'anthropic/claude-sonnet-5',
        },
      ])
      await store.appendEvents(session.id, [
        {
          type: EVENT_TYPES.agentMessage,
          content: [{ type: 'text', text: 'Hello' }],
          supersedes: { from_seq: 2, to_seq: 4 },
        },
      ])
      clock.advance(2 * SECOND)
      expect(await store.compact({ olderThan: clock.currentMs })).toBe(3)

      const after = await eventRows(session.id)
      // A row that is still there is the row it was, field for field: an append may add rows,
      // compaction may remove superseded chunks, and nothing else may touch a stored event.
      for (const [id, row] of after) {
        if (before.has(id)) {
          expect(row).toEqual(before.get(id))
        }
      }
      // The rows that disappeared are exactly the chunks the supersession covered...
      const gone = [...before.keys()].filter((id) => !after.has(id)).sort()
      expect(gone).toEqual(chunks.map((event) => event.id).sort())
      // ...and the claim is a row of its own, not a value written back onto the user event.
      // The column is *never written* for a user event since P4 — the append omits it, and a
      // claim writes `event_claims` — so its raw value stays the null it was inserted with.
      expect(after.get(queued?.id ?? 'sevt_00000000000000000000000000')?.processed_at).toBeNull()
      const claims = await sql<{ event_id: string; claimed_by_event_id: string | null }>`
        select event_id, claimed_by_event_id from event_claims where session_id = ${session.id}
      `.execute(db)
      expect(claims.rows).toEqual([{ event_id: queued?.id, claimed_by_event_id: span?.id }])
    })

    it('never writes the processed_at column for a user event, and derives it from the claim', async () => {
      const { store, clock, session } = await seeded()
      clock.advance(3 * SECOND)
      const [message] = await store.appendEvents(session.id, [userMessage('hi')])
      const id = message?.id ?? ('sevt_00000000000000000000000000' as EventId)

      /** The raw column, straight from the table; `null` is what "not written" leaves. */
      const rawProcessedAt = async (): Promise<unknown> => {
        const row = await sql<{ processed_at: unknown }>`
          select processed_at from events where id = ${id}
        `.execute(db)
        return row.rows[0]?.processed_at
      }
      expect(await rawProcessedAt()).toBeNull()

      clock.advance(5 * SECOND)
      await store.appendEvents(session.id, [
        {
          type: EVENT_TYPES.modelRequestStart,
          consumes: [id],
          model: 'anthropic/claude-sonnet-5',
        },
      ])
      // The claim did not touch the row: the column is still the null it was inserted with,
      // and the read derives `processed_at` from `event_claims` instead.
      expect(await rawProcessedAt()).toBeNull()
      const reread = (await store.listEventsUnscoped(session.id)).data.find(
        (event) => event.id === id,
      )
      expect(reread?.processed_at).toBe(timestampAt(clock.currentMs))
    })

    it('removes every row a deleted session had, and leaves other sessions alone', async () => {
      const { store, session } = await seeded()
      const other = await store.createSession(
        (await store.createAgent(agentInput('Other'), OWNER_A)).id,
        { ownerId: OWNER_A, initial_events: [userMessage('theirs')] },
      )
      // A session with rows in all three tables the delete reaches: `events` (a message and
      // the chunks of a reply), `event_claims` (the span that claims the message) and
      // `event_supersessions` (the range the reply supersedes).
      const previewed = newEventId()
      const [queued] = await store.appendEvents(session.id, [userMessage('hi')])
      const chunks = await store.appendEvents(session.id, [
        storedEventStart(previewed),
        storedEventDelta(previewed, 'Hel'),
      ])
      await store.appendEvents(session.id, [
        {
          type: EVENT_TYPES.modelRequestStart,
          consumes: [queued?.id ?? ('sevt_00000000000000000000000000' as EventId)],
          model: 'anthropic/claude-sonnet-5',
        },
      ])
      await store.appendEvents(session.id, [
        {
          type: EVENT_TYPES.agentMessage,
          content: [{ type: 'text', text: 'the whole reply' }],
          supersedes: { from_seq: chunks[0]?.seq ?? 2, to_seq: chunks[1]?.seq ?? 3 },
        },
      ])

      const before = await rowCounts(session.id)
      const otherBefore = await rowCounts(other.id)
      expect(before.events).toBeGreaterThan(0)
      expect(before.claims).toBeGreaterThan(0)
      expect(before.supersessions).toBeGreaterThan(0)

      expect(await store.deleteSession(session.id, { ownerId: OWNER_A })).toBe(true)

      // The rows are gone — not compacted, not flagged, gone — and the session row with them.
      expect(await rowCounts(session.id)).toEqual({ events: 0, claims: 0, supersessions: 0 })
      expect(await store.getSession(session.id, { ownerId: OWNER_A })).toBeNull()
      // The other session is untouched, row for row, in all three tables.
      expect(await rowCounts(other.id)).toEqual(otherBefore)
      expect((await store.getSession(other.id, { ownerId: OWNER_A }))?.id).toBe(other.id)
    })

    it('announces a session’s deletion to another store’s subscriber', async () => {
      const { store: subscriber, clock, session } = await seeded()
      // A second store on the same pool is a second process as far as the database is
      // concerned: it deletes the session, and the notification reaches this store's
      // listening connection.
      const deleter = track(createPostgresSessionStore({ pool }, { now: clock.now }))
      const received: StreamEvent[] = []
      await subscriber.subscribe(session.id, (event) => {
        received.push(event)
      })
      await deleter.appendEvents(session.id, [userMessage('before')])
      await waitFor(() => received.length === 1, 'the event before the delete')

      expect(await deleter.deleteSession(session.id, { ownerId: OWNER_A })).toBe(true)

      await waitFor(() => received.length === 2, 'the session.deleted the other store announced')
      expect(received[1]).toEqual({ type: EVENT_TYPES.sessionDeleted, session_id: session.id })
      // The deletion ended the subscription: nothing stored follows it, and the session is
      // unreadable from both stores.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      expect(received).toHaveLength(2)
      expect(await subscriber.getSessionUnscoped(session.id)).toBeNull()
    })

    it('applies its migrations idempotently', async () => {
      // The suite's `beforeAll` has already migrated this database, and the ledger says so:
      // a second call is the fast path, applies nothing, and touches no application table —
      // which is what makes every pod boot during a rollout harmless (#378, PR 3/6).
      expect(await migrate(db)).toEqual([])

      // Emptying the ledger makes this an old runner's database: every table exists and the
      // record of what built it is gone. The bootstrap path runs every idempotent file once
      // more, and the checks below prove that re-run leaves the tables, indexes and columns
      // working.
      await sql`delete from schema_migrations`.execute(db)
      const files = await migrate(db)
      expect(files.length).toBeGreaterThan(0)
      // `0016_user_preferences.sql` and `0017_scheduler_instances.sql` are each one
      // `create table if not exists` (#111, #122), `0018_credential_key_provider.sql`,
      // `0019_user_preferences_theme.sql`, `0025_user_preferences_compaction.sql`,
      // `0027_tool_settings.sql`, `0030_mcp_oauth_state_client.sql`,
      // `0031_mcp_tool_policies.sql`, `0032_session_tree.sql` and
      // `0033_mode_subagent_description.sql` one or more
      // `add column if not exists` (#150, #203, #282, #307, #311, #312, #340, #342), and
      // `0021_model_request_end_usage.sql`, `0026_agent_tool_use_usage.sql`,
      // `0027_tool_settings.sql`, `0028_paused_confirmation_work.sql` and
      // `0029_mcp_servers.sql` build an index or a table (#247, #305, #307, #309, #311): a
      // re-run has to leave the tables, the indexes and the columns working, which the store
      // calls below prove.
      expect(files).toContain('0016_user_preferences.sql')
      expect(files).toContain('0017_scheduler_instances.sql')
      expect(files).toContain('0018_credential_key_provider.sql')
      expect(files).toContain('0019_user_preferences_theme.sql')
      expect(files).toContain('0020_rewind_supersessions.sql')
      expect(files).toContain('0021_model_request_end_usage.sql')
      expect(files).toContain('0025_user_preferences_compaction.sql')
      // Both names exist since the tools stack met: #305's index keeps `0026` (it is earlier
      // in the stack) and #307's settings file was renumbered to `0027` — the check that the
      // numbers are unique and ordered is that both files are here, in this order.
      expect(files).toContain('0026_agent_tool_use_usage.sql')
      expect(files).toContain('0027_tool_settings.sql')
      // `0028_paused_confirmation_work.sql` builds the fourth partial index on the log's event
      // types (#309), and must come after the files the tools stack already numbered.
      expect(files).toContain('0028_paused_confirmation_work.sql')
      // #311's two files are numbered after `0028`, since pausing (#309) is beneath them in the
      // stack: `0029_mcp_servers.sql` creates the two tables and `0030` adds the OAuth flow's
      // `client` column, so the number that used to be `0026`/`0027` on the MCP branch moved —
      // and the assertions below are what keeps the pair unique and ordered.
      expect(files).toContain('0029_mcp_servers.sql')
      expect(files).toContain('0030_mcp_oauth_state_client.sql')
      // #312's file adds the remote tool policies to the settings table `0027` created, and is
      // numbered after #311's pair for the same reason they follow `0028`.
      expect(files).toContain('0031_mcp_tool_policies.sql')
      // #340's file adds the session tree to `sessions` (A1, #341), and #342's adds the
      // subagent description to the `modes` table `0024` created — both numbered after the
      // tools stack's tip for the same reason: the numbers have to be unique and ordered.
      expect(files).toContain('0032_session_tree.sql')
      // `0033_mode_subagent_description.sql` adds the subagent description to the `modes`
      // table `0024` created, and `0034_task_notifications.sql` builds the two indexes a
      // background task's notification needs (#343): the partial one the pending read and the
      // work scan use, and the unique one that makes an append idempotent on its `source_key`.
      // Both are exercised below, after the re-run — a unique index that a re-run dropped would
      // let the second append through.
      expect(files).toContain('0033_mode_subagent_description.sql')
      expect(files).toContain('0034_task_notifications.sql')
      // #361's file drops the `root_session_id` index `0032` created for a query that does not
      // exist: every tree read is a recursion over `parent_session_id`. It is written as
      // `if exists`, so the re-run below leaves the schema exactly as it was.
      expect(files).toContain('0035_drop_sessions_root_idx.sql')
      expect(files.indexOf('0026_agent_tool_use_usage.sql')).toBeLessThan(
        files.indexOf('0027_tool_settings.sql'),
      )
      expect(files.indexOf('0027_tool_settings.sql')).toBeLessThan(
        files.indexOf('0028_paused_confirmation_work.sql'),
      )
      expect(files.indexOf('0028_paused_confirmation_work.sql')).toBeLessThan(
        files.indexOf('0029_mcp_servers.sql'),
      )
      expect(files.indexOf('0029_mcp_servers.sql')).toBeLessThan(
        files.indexOf('0030_mcp_oauth_state_client.sql'),
      )
      expect(files.indexOf('0030_mcp_oauth_state_client.sql')).toBeLessThan(
        files.indexOf('0031_mcp_tool_policies.sql'),
      )
      expect(files.indexOf('0031_mcp_tool_policies.sql')).toBeLessThan(
        files.indexOf('0032_session_tree.sql'),
      )
      expect(files.indexOf('0032_session_tree.sql')).toBeLessThan(
        files.indexOf('0033_mode_subagent_description.sql'),
      )
      expect(files.indexOf('0033_mode_subagent_description.sql')).toBeLessThan(
        files.indexOf('0034_task_notifications.sql'),
      )
      expect(files.indexOf('0034_task_notifications.sql')).toBeLessThan(
        files.indexOf('0035_drop_sessions_root_idx.sql'),
      )
      // The bootstrap run recorded every file, so the next boot is the fast path again.
      expect(await migrate(db)).toEqual([])

      const { store, session } = await seeded()
      expect(await store.getSession(session.id, { ownerId: OWNER_A })).toEqual(session)
      expect(
        await store.putPreferences(OWNER_A, {
          default_model: 'openai/gpt-5-mini',
          theme: 'dim',
          compaction_threshold: 0.6,
          summary_model: 'anthropic/claude-haiku-4-5',
          summary_max_passes: 4,
        }),
      ).toEqual({
        default_model: 'openai/gpt-5-mini',
        theme: 'dim',
        compaction_threshold: 0.6,
        summary_model: 'anthropic/claude-haiku-4-5',
        summary_max_passes: 4,
      })
      expect(await store.getPreferences(OWNER_A)).toEqual({
        default_model: 'openai/gpt-5-mini',
        theme: 'dim',
        compaction_threshold: 0.6,
        summary_model: 'anthropic/claude-haiku-4-5',
        summary_max_passes: 4,
      })
      await store.heartbeatInstance('after-a-re-run')
      expect(await store.listLiveInstances(30_000)).toEqual(['after-a-re-run'])
      await store.removeInstance('after-a-re-run')
      expect(await store.listLiveInstances(30_000)).toEqual([])

      // `0033`'s column is exercised after the re-run too: a mode stores the subagent
      // description it was created with, and reads it back (#342).
      const described = await store.createMode(
        {
          name: 'reviewer',
          model: 'anthropic/claude-sonnet-5',
          subagent_description: 'Reviews a diff for correctness bugs.',
        },
        OWNER_A,
      )
      expect(described.subagent_description).toBe('Reviews a diff for correctness bugs.')
      expect((await store.getMode(described.id, { ownerId: OWNER_A }))?.subagent_description).toBe(
        'Reviews a diff for correctness bugs.',
      )

      // `0020`'s column is exercised after the re-run too: a rewind records its range and its
      // kind, and a replay still reads the session the way a rewind means it to (#238).
      const [queued] = await store.appendEvents(session.id, [userMessage('hi')])
      const [rewind, edited] = await store.appendEvents(session.id, [
        { type: EVENT_TYPES.sessionRewind, from_seq: queued?.seq ?? 0 },
        userMessage('hi again'),
      ])
      expect((await store.listEventsUnscoped(session.id)).data).toEqual([rewind, edited])

      // `0034`'s unique index is exercised after the re-run: the second append of one
      // `source_key` is refused by the index and answered as the notification already stored,
      // and `0034`'s partial index is what the pending read seeks (#343).
      const taskId = newTaskId()
      const input = {
        taskId,
        kind: 'result' as const,
        text: 'the child finished',
        sourceKey: `${taskId}:1`,
      }
      const first = await store.appendTaskNotification(session.id, input)
      expect(first.appended).toBe(true)
      expect(await store.appendTaskNotification(session.id, input)).toEqual({
        event: first.event,
        appended: false,
      })
      expect(
        (await store.getPendingTaskNotifications(session.id)).map((event) => event.id),
      ).toEqual([first.event.id])
    })

    it('stores a rewind’s range and its kind, beside the chunk range a reply records (#238)', async () => {
      const { store, session } = await seeded()
      const previewed = newEventId()
      await store.appendEvents(session.id, [userMessage('first')])
      await store.appendEvents(session.id, [{ type: EVENT_TYPES.sessionStatusRunning }])
      // A reply whose chunks its own message supersedes: the range is `chunks` and covers
      // exactly the two chunk rows.
      await store.appendEvents(session.id, [
        storedEventStart(previewed),
        storedEventDelta(previewed, 'hi'),
      ])
      await store.appendEvents(session.id, [
        {
          type: EVENT_TYPES.agentMessage,
          content: [{ type: 'text', text: 'hi' }],
          supersedes: { from_seq: 3, to_seq: 4 },
        },
      ])
      await store.appendEvents(session.id, [
        { type: EVENT_TYPES.sessionStatusIdle, stop_reason: { type: 'end_turn' } },
      ])
      // A rewind over the whole log: the range is `rewind`, and it reaches the event before it.
      await store.appendEvents(session.id, [
        { type: EVENT_TYPES.sessionRewind, from_seq: 1 },
        userMessage('edited'),
      ])

      const rows = await sql<{ from_seq: number; to_seq: number; kind: string; by_seq: number }>`
        select from_seq, to_seq, kind, by_seq
          from event_supersessions
         where session_id = ${session.id}
         order by by_seq asc
      `.execute(db)
      expect(rows.rows).toEqual([
        { from_seq: 3, to_seq: 4, kind: 'chunks', by_seq: 5 },
        { from_seq: 1, to_seq: 6, kind: 'rewind', by_seq: 7 },
      ])
    })

    it('backfills model and system for a session stored before #93, and reads it back', async () => {
      // A real database holds sessions created since the auth epic, whose configuration lives
      // in the agent snapshot columns and nowhere else: `0015_session_model.sql` copies it
      // into the new `model`/`system` columns, and this is that row — written the way the
      // pre-#93 store wrote it, with the new columns left empty.
      await truncateAll()
      await ensureUsers([OWNER_A])
      const store = track(createPostgresSessionStore({ pool }, { now: () => START_MS }))
      const agent = await store.createAgent(agentInput(), OWNER_A)
      const legacyId = newSessionId()

      // `model` is `not null` since 0015. The migration sets that back; dropping it here is
      // what a database that predates the column looks like to the insert. `root_session_id`
      // is written because the column exists by now (`0032`) and is `not null`: this row is a
      // pre-#93 one in a migrated schema, not a pre-#340 row — the migration's own backfill
      // has a test of its own below.
      await sql`alter table sessions alter column model drop not null`.execute(db)
      await sql`
        insert into sessions (
          id, owner_id, status, partition, title,
          agent_id, agent_name, agent_model_id, agent_system,
          model, system, root_session_id, created_at, updated_at
        ) values (
          ${legacyId}, ${OWNER_A}, 'idle', ${partitionOf(legacyId)}, ${'Before #93'},
          ${agent.id}, ${agent.name}, ${agent.model.id}, ${agent.system},
          null, null, ${legacyId}, ${new Date(START_MS)}, ${new Date(START_MS)}
        )
      `.execute(db)

      // Emptying the ledger makes this a database migrated by the old runner: the next
      // `migrate()` runs every file once more, which is what applies the backfill to the row
      // above — exactly what a deploy of #93 does to a real database, and what the one-time
      // bootstrap boot after this change does to every existing one.
      await sql`delete from schema_migrations`.execute(db)
      await migrate(db)

      const session = await store.getSession(legacyId, { ownerId: OWNER_A })
      expect(session).toMatchObject({
        id: legacyId,
        title: 'Before #93',
        model: agent.model,
        system: agent.system,
        agent: {
          id: agent.id,
          name: agent.name,
          model: agent.model,
          system: agent.system,
        },
      })
      // What the store hands out is the protocol's session, exactly — the backfilled row
      // included: no leftover field and nothing missing.
      expect(SessionSchema.parse(session)).toEqual(session)
    })

    it('backfills the tree for a session stored before #340, and reads it as a top-level chat', async () => {
      // Every session in a real database predates the tree: `0032_session_tree.sql` makes it
      // its own root, interactive and at depth 0, which is what a top-level chat is. This is
      // that row, written with the tree columns left empty.
      await truncateAll()
      await ensureUsers([OWNER_A])
      const store = track(createPostgresSessionStore({ pool }, { now: () => START_MS }))
      const agent = await store.createAgent(agentInput(), OWNER_A)
      const legacyId = newSessionId()

      // `root_session_id` is `not null` since 0032, and the migration sets that back after it
      // backfills: dropping it here is what a database that predates the column looks like.
      await sql`alter table sessions alter column root_session_id drop not null`.execute(db)
      await sql`
        insert into sessions (
          id, owner_id, status, partition, title, model, system,
          created_at, updated_at
        ) values (
          ${legacyId}, ${OWNER_A}, 'idle', ${partitionOf(legacyId)}, ${'Before #340'},
          ${{ id: agent.model.id }}::jsonb, ${agent.system},
          ${new Date(START_MS)}, ${new Date(START_MS)}
        )
      `.execute(db)

      const before = await sql<{ root_session_id: string | null; interactive: boolean }>`
        select root_session_id, interactive from sessions where id = ${legacyId}
      `.execute(db)
      expect(before.rows[0]).toEqual({ root_session_id: null, interactive: true })

      // Emptying the ledger makes this a database migrated by the old runner, so `migrate()`
      // runs every file once more and applies 0032's backfill to the row above — what a deploy
      // of #340 does to a real database, and what the bootstrap boot does once.
      await sql`delete from schema_migrations`.execute(db)
      await migrate(db)

      const session = await store.getSession(legacyId, { ownerId: OWNER_A })
      expect(session).toMatchObject({
        id: legacyId,
        interactive: true,
        parent_session_id: null,
        parent_task_id: null,
        root_session_id: legacyId,
        depth: 0,
      })
      expect(SessionSchema.parse(session)).toEqual(session)
    })

    it('leaves a pool it did not open alone, and ends one it did', async () => {
      const borrowed = track(createPostgresSessionStore({ pool }, { now: () => START_MS }))
      await borrowed.createAgent(agentInput(), OWNER_A)
      await borrowed.close()
      // The pool is the caller's: a store that borrowed it must not have ended it, so the
      // rest of the application — and this test — can keep using it.
      await sql`select 1`.execute(db)

      const owned = createPostgresSessionStore(
        { connectionString: DATABASE_URL === '' ? connectionOf(container) : DATABASE_URL },
        { now: () => START_MS },
      )
      const agent = await owned.createAgent(agentInput('Owned'), OWNER_A)
      expect(agent.name).toBe('Owned')
      await owned.close()
      await expect(owned.close()).resolves.toBeUndefined()
    })
  })

  // ----------------------------------------- the credential store's extra tests

  describe('PostgresCredentialStore: more than the contract asks', () => {
    it('keeps one row per (user, provider) when two stores save at once', async () => {
      await truncateAll()
      await ensureUsers([OWNER_A])
      const first = trackCredentials(
        createPostgresCredentialStore({ pool }, { now: () => START_MS }),
      )
      const second = trackCredentials(
        createPostgresCredentialStore({ pool }, { now: () => START_MS }),
      )
      // The upsert is one statement, so two uncoordinated saves of the same provider cannot
      // both create a row: the unique constraint decides, and one of them replaces the other.
      await Promise.all([
        first.upsert({ ...credentialInput(), last4: '1111' }),
        second.upsert({ ...credentialInput(), last4: '2222' }),
      ])
      const listed = await first.list({ userId: OWNER_A })
      expect(listed).toHaveLength(1)
      expect(['1111', '2222']).toContain(listed[0]?.last4)
    })

    it('deletes a user’s credentials, agents and sessions with the user', async () => {
      await truncateAll()
      await ensureUsers([OWNER_A, OWNER_B])
      const store = track(createPostgresSessionStore({ pool }, { now: () => START_MS }))
      const credentials = trackCredentials(
        createPostgresCredentialStore({ pool }, { now: () => START_MS }),
      )
      const agent = await store.createAgent(agentInput(), OWNER_A)
      const theirAgent = await store.createAgent(agentInput('Theirs'), OWNER_B)
      const session = await store.createSession(agent.id, {
        ownerId: OWNER_A,
        initial_events: [userMessage('hi')],
      })
      const theirSession = await store.createSession(theirAgent.id, { ownerId: OWNER_B })
      await credentials.upsert({ ...credentialInput(OWNER_A, 'a'), last4: 'aaaa' })
      await credentials.upsert({ ...credentialInput(OWNER_B, 'b'), last4: 'bbbb' })
      await store.putToolSettings(OWNER_A, {
        builtin: { web_search: { enabled: false, policy: 'deny' } },
        mcp: { notes__search: 'deny' },
      })

      await sql`delete from "user" where id = ${OWNER_A}`.execute(db)

      // Everything the user owned is gone with them — the `on delete cascade` the ownership
      // migration and the credential table declare — and the events went with the session.
      expect(await store.getAgent(agent.id, { ownerId: OWNER_A })).toBeNull()
      expect(await store.getSession(session.id, { ownerId: OWNER_A })).toBeNull()
      expect(await credentials.get({ userId: OWNER_A, name: 'anthropic' })).toBeNull()
      expect(await credentials.list({ userId: OWNER_A })).toEqual([])
      // The tool settings went with the user too (`0027`'s `on delete cascade`), reading back
      // as no choices rather than as a stale row.
      expect(await store.getToolSettings(OWNER_A)).toEqual({ builtin: {}, mcp: {} })
      expect(await eventRows(session.id)).toEqual(new Map())
      // The other user is untouched, down to their own credential for the same provider.
      expect(await store.getAgent(theirAgent.id, { ownerId: OWNER_B })).not.toBeNull()
      expect(await store.getSession(theirSession.id, { ownerId: OWNER_B })).not.toBeNull()
      expect((await credentials.get({ userId: OWNER_B, name: 'anthropic' }))?.last4).toBe('bbbb')
    })
  })

  // ----------------------------------------- the MCP server store's extra tests

  describe('PostgresMcpServerStore: more than the contract asks', () => {
    it('keeps one row per (user, name) when two stores create at once', async () => {
      await truncateAll()
      await ensureUsers([OWNER_A])
      const first = trackMcpServers(createPostgresMcpServerStore({ pool }, { now: () => START_MS }))
      const second = trackMcpServers(
        createPostgresMcpServerStore({ pool }, { now: () => START_MS }),
      )
      // Two uncoordinated creates of the same name: the unique constraint decides, one wins and
      // the other is refused — never two rows.
      const results = await Promise.allSettled([
        first.create(mcpServerInput()),
        second.create(mcpServerInput()),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const refused = results.find((result) => result.status === 'rejected')
      if (refused?.status !== 'rejected') {
        throw new Error('expected one of the two creates to be refused')
      }
      expect(refused.reason).toBeInstanceOf(DuplicateMcpServerNameError)
      expect(await first.list({ ownerId: OWNER_A })).toHaveLength(1)
    })

    it('deletes a server and its pending OAuth states with the user', async () => {
      await truncateAll()
      await ensureUsers([OWNER_A])
      const store = trackMcpServers(createPostgresMcpServerStore({ pool }, { now: () => START_MS }))
      const server = await store.create(mcpServerInput({ auth: 'oauth' }))
      await store.createOAuthState({
        state: 'state-1',
        userId: OWNER_A,
        serverId: server.id,
        codeVerifier: 'v1',
        client: 'web',
        expiresAt: timestampAt(START_MS + 60_000),
      })
      // A server delete cascades to its pending states, so a callback can no longer complete.
      expect(await store.delete(server.id, { ownerId: OWNER_A })).toBe(true)
      expect(await store.consumeOAuthState('state-1')).toBeNull()
    })
  })

  // ------------------------------------------------------ the ledger and its locks

  describe('migrate(): the ledger, bootstrap and bounded locks (#378, PR 3/6)', () => {
    it('applies and records every file on a fresh database, then takes the fast path', async () => {
      const target = await migrationSchema('fresh')
      try {
        const expected = await migrationFiles()
        expect(await migrate(target.db)).toEqual(expected)

        const ledger = await sql<{ file: string }>`
          select file from schema_migrations order by file
        `.execute(target.db)
        expect(ledger.rows.map((row) => row.file)).toEqual(expected)

        // The schema really is there: the newest table, and a column and index from the tip of
        // the stack. A ledger row with no table behind it would be the failure this guards.
        const objects = await sql<{
          modes: string | null
          description: string | null
          notifications: string | null
        }>`
          select
            to_regclass('modes')::text as modes,
            to_regclass('events_task_notification_source_key_idx')::text as notifications,
            (select column_name
               from information_schema.columns
              where table_schema = current_schema()
                and table_name = 'modes'
                and column_name = 'subagent_description') as description
        `.execute(target.db)
        expect(objects.rows[0]).toEqual({
          modes: 'modes',
          description: 'subagent_description',
          notifications: 'events_task_notification_source_key_idx',
        })

        // Every file is recorded, so a boot has nothing to do — and, below, takes no lock.
        expect(await migrate(target.db)).toEqual([])
      } finally {
        await target.dispose()
      }
    })

    it('takes no lock on an application table when the ledger is complete', async () => {
      const target = await migrationSchema('fastpath')
      try {
        await migrate(target.db)

        // Hold the strongest lock on `events` in another connection, as a streaming turn's
        // append and an old runner's `create index if not exists` would contend. If the fast
        // path executed any file, its first statement against `events` would wait here — and
        // the old runner had no `lock_timeout`, so it would wait for as long as the lock is
        // held. A boot must not even ask.
        const holder = await target.pool.connect()
        try {
          await holder.query('begin')
          await holder.query('lock table events in access exclusive mode')

          const startedAt = Date.now()
          const applied = await Promise.race([
            migrate(target.db, { lockTimeoutMs: 2_000 }),
            pause(8_000).then(() => {
              throw new Error('migrate() waited on the events lock the ledger should avoid')
            }),
          ])
          expect(applied).toEqual([])
          expect(Date.now() - startedAt).toBeLessThan(2_000)

          // The fast path held nothing on `events` of its own: the one lock in `pg_locks` for
          // this schema's table is the holder's.
          const locks = await sql<{ held: number }>`
            select count(*)::int as held
              from pg_locks
             where relation = to_regclass('events')
               and mode = 'AccessExclusiveLock'
          `.execute(target.db)
          expect(locks.rows[0]?.held).toBe(1)
        } finally {
          await holder.query('rollback')
          holder.release()
        }
      } finally {
        await target.dispose()
      }
    })

    it('bootstraps a database the old runner migrated: every table, no ledger', async () => {
      const target = await migrationSchema('bootstrap')
      try {
        const expected = await migrationFiles()
        await migrate(target.db)

        // The old runner left no record at all. An empty ledger is exactly that database:
        // every table is in place and nothing says which files built them.
        await sql`delete from schema_migrations`.execute(target.db)
        expect(await migrate(target.db)).toEqual(expected)

        const ledger = await sql<{ file: string }>`
          select file from schema_migrations order by file
        `.execute(target.db)
        expect(ledger.rows.map((row) => row.file)).toEqual(expected)

        // The one boot that still takes the locks left a usable schema behind, and the next
        // boot is the fast path.
        await sql`
          insert into scheduler_instances (instance_id, last_seen)
          values ('bootstrap-check', now())
        `.execute(target.db)
        const instances = await sql<{ instance_id: string }>`
          select instance_id from scheduler_instances
        `.execute(target.db)
        expect(instances.rows).toEqual([{ instance_id: 'bootstrap-check' }])
        expect(await migrate(target.db)).toEqual([])
      } finally {
        await target.dispose()
      }
    })

    it('runs only a file the ledger does not name', async () => {
      const target = await migrationSchema('newfile')
      try {
        await migrate(target.db)

        await withMigrationDir(
          '0036_migration_probe.sql',
          'create table if not exists migration_probe (id integer primary key);',
          async (directory) => {
            expect(await migrate(target.db, { migrationsDir: directory })).toEqual([
              '0036_migration_probe.sql',
            ])
            const probe = await sql<{ table: string | null }>`
              select to_regclass('migration_probe')::text as table
            `.execute(target.db)
            expect(probe.rows[0]?.table).toBe('migration_probe')
            // The old files are still recorded, so a second boot runs none of them.
            expect(await migrate(target.db, { migrationsDir: directory })).toEqual([])
          },
        )
      } finally {
        await target.dispose()
      }
    })

    it('times out, retries, and fails the boot clearly when a lock never clears', async () => {
      const target = await migrationSchema('blocked')
      try {
        await migrate(target.db)

        await withMigrationDir(
          '0036_blocked.sql',
          'alter table events add column if not exists migration_blocked boolean;',
          async (directory) => {
            const holder = await target.pool.connect()
            try {
              await holder.query('begin')
              await holder.query('lock table events in access exclusive mode')

              const error = await thrownBy(() =>
                migrate(target.db, {
                  migrationsDir: directory,
                  lockTimeoutMs: 100,
                  maxAttempts: 2,
                  retryBackoffMs: 10,
                }),
              )
              expect(error).toBeInstanceOf(Error)
              const message = (error as Error).message
              expect(message).toContain('0036_blocked.sql')
              expect(message).toMatch(/lock timeout/u)
              expect(message).toMatch(/2 of 2 attempt/u)
              expect(message).toContain('SQLSTATE 55P03')

              // The failed transaction rolled the schema and the ledger back together: the
              // column is not there, and the file is still pending.
              const column = await sql<{ present: number }>`
                select count(*)::int as present
                  from information_schema.columns
                 where table_schema = current_schema()
                   and table_name = 'events'
                   and column_name = 'migration_blocked'
              `.execute(target.db)
              expect(column.rows[0]?.present).toBe(0)
              const pending = await sql<{ file: string }>`
                select file from schema_migrations where file = '0036_blocked.sql'
              `.execute(target.db)
              expect(pending.rows).toEqual([])
            } finally {
              await holder.query('rollback')
              holder.release()
            }

            // With the lock gone, the same file applies, once.
            expect(
              await migrate(target.db, {
                migrationsDir: directory,
                lockTimeoutMs: 2_000,
                maxAttempts: 1,
              }),
            ).toEqual(['0036_blocked.sql'])
            const column = await sql<{ present: number }>`
              select count(*)::int as present
                from information_schema.columns
               where table_schema = current_schema()
                 and table_name = 'events'
                 and column_name = 'migration_blocked'
            `.execute(target.db)
            expect(column.rows[0]?.present).toBe(1)
          },
        )
      } finally {
        await target.dispose()
      }
    })

    it('succeeds when the lock clears between attempts', async () => {
      const target = await migrationSchema('retry')
      try {
        await migrate(target.db)

        await withMigrationDir(
          '0036_retried.sql',
          'alter table events add column if not exists migration_retried boolean;',
          async (directory) => {
            const holder = await target.pool.connect()
            await holder.query('begin')
            await holder.query('lock table events in access exclusive mode')

            // Attempt one times out at 100 ms; the second attempt is scheduled a backoff later.
            // Release the lock in between, and the whole transaction runs then.
            const pending = migrate(target.db, {
              migrationsDir: directory,
              lockTimeoutMs: 100,
              maxAttempts: 10,
              retryBackoffMs: 100,
            })
            await pause(150)
            await holder.query('rollback')
            holder.release()

            await expect(pending).resolves.toEqual(['0036_retried.sql'])
          },
        )
      } finally {
        await target.dispose()
      }
    })
  })

  /** The SQL files this package ships, in the order `migrate()` applies them. */
  function migrationFiles(): Promise<string[]> {
    return readdir(migrationsDirectory()).then((names) =>
      names.filter((name) => name.endsWith('.sql')).sort(),
    )
  }

  /** The `migrations/` directory beside the package, from either `src/` or `dist/`. */
  function migrationsDirectory(): string {
    return fileURLToPath(new URL('../../migrations/', import.meta.url))
  }

  /**
   * A database of its own for one migration test: a schema on the shared server, reached by a
   * pool whose `search_path` is that schema. Every migration is unqualified SQL, so this is a
   * whole separate database as far as the tables, indexes and the ledger are concerned — and it
   * costs nothing to create or drop, unlike a database per test.
   */
  async function migrationSchema(label: string): Promise<{
    readonly db: Kysely<PostgresSchema>
    readonly pool: Pool
    dispose(): Promise<void>
  }> {
    migrationSchemas += 1
    const name = `migrate_test_${label}_${process.pid}_${migrationSchemas}`.toLowerCase()
    await sql`create schema ${sql.id(name)}`.execute(db)
    const schemaPool = new Pool({
      connectionString,
      max: 2,
      options: `-c search_path=${name}`,
    })
    const schemaDb = new Kysely<PostgresSchema>({
      dialect: new PostgresDialect({ pool: schemaPool }),
    })
    return {
      db: schemaDb,
      pool: schemaPool,
      dispose: async () => {
        await schemaDb.destroy()
        await sql`drop schema ${sql.id(name)} cascade`.execute(db)
      },
    }
  }

  /**
   * A copy of the shipped migrations plus one extra file, for the tests that add a migration
   * the ledger has never seen. `migrate()` takes the directory as an option.
   */
  async function withMigrationDir(
    name: string,
    contents: string,
    work: (directory: string) => Promise<void>,
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'openharness-migrations-'))
    try {
      for (const file of await migrationFiles()) {
        await copyFile(join(migrationsDirectory(), file), join(directory, file))
      }
      await writeFile(join(directory, name), contents, 'utf8')
      await work(directory)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Wait for `ms`; the lock tests need the middle of a retry's backoff, not a condition. */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** The store a test works with: a clock it can move, and one seeded session. */
  async function seeded(clock: TestClock = createTestClock(START_MS)): Promise<{
    store: ReturnType<typeof createPostgresSessionStore>
    clock: TestClock
    session: Session
  }> {
    await truncateAll()
    await ensureUsers([OWNER_A, OWNER_B])
    const store = track(createPostgresSessionStore({ pool }, { now: clock.now }))
    const agent = await store.createAgent(agentInput(), OWNER_A)
    const session = await store.createSession(agent.id, { ownerId: OWNER_A, initial_events: [] })
    return { store, clock, session }
  }

  /** Remember a store so `afterEach` closes it. */
  function track(store: ReturnType<typeof createPostgresSessionStore>) {
    stores.push(store)
    return store
  }

  /** Remember a credential store so `afterEach` closes it. */
  function trackCredentials(store: ReturnType<typeof createPostgresCredentialStore>) {
    credentialStores.push(store)
    return store
  }

  /** Remember an MCP server store so `afterEach` closes it. */
  function trackMcpServers(store: ReturnType<typeof createPostgresMcpServerStore>) {
    mcpStores.push(store)
    return store
  }

  /**
   * The `"user"` rows an owner needs before anything can be created for them.
   *
   * `owner_id` is a foreign key into Better Auth's `"user"` table, so a database that has
   * never seen a user refuses to hold their agents, sessions or credentials. This is what the
   * conformance suite calls between emptying the tables and the first owner-scoped write; the
   * real rows come from Better Auth itself once the server mounts it (#61).
   */
  async function ensureUsers(userIds: readonly UserId[]): Promise<void> {
    for (const userId of userIds) {
      await sql`
        insert into "user" ("id", "name", "email", "emailVerified")
        values (${userId}, ${`Test user ${userId}`}, ${`${userId}@example.test`}, true)
        on conflict ("id") do nothing
      `.execute(db)
    }
  }

  /**
   * Every `events` row of a session, keyed by id and exactly as the table holds it: what "a
   * stored event never changes" is about. Comparing two snapshots is how the immutability of
   * the log is tested against the real SQL, not only against the store's JavaScript.
   */
  async function eventRows(sessionId: string): Promise<Map<string, Record<string, unknown>>> {
    const rows = await sql<Record<string, unknown>>`
      select id, session_id, seq, type, payload, created_at, processed_at
        from events
       where session_id = ${sessionId}
       order by seq asc
    `.execute(db)
    return new Map(rows.rows.map((row) => [row['id'] as string, row]))
  }

  /**
   * How many rows each session-keyed table holds for a session, read straight from the tables
   * — what `deleteSession` has to leave at zero, and what it must not touch for another one.
   */
  async function rowCounts(
    sessionId: string,
  ): Promise<{ events: number; claims: number; supersessions: number }> {
    const counts = await sql<{ events: number; claims: number; supersessions: number }>`
      select
        (select count(*)::int from events where session_id = ${sessionId}) as events,
        (select count(*)::int from event_claims where session_id = ${sessionId}) as claims,
        (select count(*)::int from event_supersessions where session_id = ${sessionId}) as supersessions
    `.execute(db)
    const row = counts.rows[0]
    if (row === undefined) {
      throw new Error('the row-count query returned no row')
    }
    return row
  }

  /** Empty every table of this package's schema, so a test starts where the previous one did. */
  async function truncateAll(): Promise<void> {
    // `event_claims` and `event_supersessions` reference `events`, so they are truncated in the
    // same statement rather than with `cascade`: this is the complete list of the tables the
    // migrations create that this package owns, and a table missing from it should be a
    // failure, not silently cascaded away. `session_previews` was dropped by
    // `0010_drop_session_previews.sql` (P4). Better Auth's own tables (`"user"`, `"session"`,
    // `"account"`, `"verification"`, `"deviceCode"`) are *not* truncated: the only rows in
    // them are the ones `ensureUsers` inserts per test, and a `"user"` row carries the
    // `owner_id`s everything else references. `user_preferences` is here so one test's
    // preferences cannot leak into the next (#111), `user_tool_settings` so one test's tool
    // choices cannot (#307), `mcp_servers` and `mcp_oauth_states` so one test's remote MCP
    // servers and their pending OAuth flows cannot (#303, X10; #311), and `scheduler_instances`
    // so one test's memberships cannot (#122). `schema_migrations` is deliberately *not* here:
    // it records the schema, not data, and truncating it would tell the next `migrate()` that a
    // database with every table is fresh (the bootstrap boot, once per database, is the price
    // of not trusting a heuristic). A test that means to simulate the old runner drops it
    // explicitly, which is also what proves that path (#378, PR 3/6).
    await sql`truncate table
      events, event_claims, event_supersessions, sessions, agents, modes, partition_leases,
      scheduler_instances, provider_credentials, user_preferences, user_tool_settings,
      mcp_oauth_states, mcp_servers`.execute(db)
  }
}

/** A create body for a Postgres MCP server test. */
function mcpServerInput(overrides: Partial<CreateMcpServerInput> = {}): CreateMcpServerInput {
  return {
    ownerId: OWNER_A,
    name: 'notes',
    url: 'https://mcp.example.com/mcp',
    auth: 'none',
    enabled: true,
    status: 'connected',
    lastError: null,
    headerNames: [],
    tools: [],
    definitionTokens: 0,
    lastTestedAt: null,
    ...overrides,
  }
}

/** A `POST /v1/agents` body. */
function agentInput(name = 'Summarizer'): CreateAgentRequest {
  return { name, model: { id: 'anthropic/claude-sonnet-5' }, system: 'You are concise.' }
}

/**
 * One user's sealed `anthropic` key, as `upsert` takes it.
 *
 * The sealed fields are distinct recognizable strings per `tag` — a real blob comes from
 * `@openharness/vault`, and the store treats every field as opaque, so a fixture is as good
 * as a ciphertext for saying what came back out.
 */
function credentialInput(userId: UserId = OWNER_A, tag = 'one'): UpsertCredentialInput {
  return {
    userId,
    name: 'anthropic',
    type: 'api_key',
    sealed: {
      ciphertext: `ciphertext:${tag}`,
      nonce: `nonce:${tag}`,
      wrappedKey: `wrapped-key:${tag}`,
      kekVersion: 'test-v1',
    },
    last4: 'cdef',
    validatedAt: timestampAt(START_MS),
  }
}

/** A `user.message` to append. */
function userMessage(text: string): UserEventInput {
  return { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text }] }
}

/** A stored `event_start` chunk previewing `id`, as a brain appends one since D9. */
function storedEventStart(id: EventId): AppendableEvent {
  return { type: EVENT_TYPES.eventStart, event: { type: EVENT_TYPES.agentMessage, id } }
}

/** A stored `event_delta` chunk carrying `text` for the message `id`, as a brain appends one. */
function storedEventDelta(id: EventId, text: string): AppendableEvent {
  return {
    type: EVENT_TYPES.eventDelta,
    event_id: id,
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
  }
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
