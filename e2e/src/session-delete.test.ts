import {
  DEFAULT_PARTITION_COUNT,
  EVENT_TYPES,
  partitionOf,
  type StoredEvent,
} from '@openharness/protocol'
import { MOCK_SLOW_MARKER } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import type { Client } from '@openharness/client'

import {
  agentMessages,
  collectStream,
  deltaText,
  e2eHarness,
  errorOf,
  expectedSlowReply,
  personFor,
  previewedEventId,
  textOf,
  waitFor,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * Hard-deleting a session, end to end (epic #116, U5).
 *
 * `DELETE /v1/sessions/{id}` is `204`, owner-scoped (another user's id is the 404 an id nothing
 * has), and it removes **everything** keyed by the session. `apps/server/src/session-delete.test.ts`
 * covers the route in process; a deployment is where the promises that are about *other
 * processes* can be checked:
 *
 * - the cascade leaves no row in any session-keyed table (the store's transaction is the
 *   mechanism, the database is the evidence);
 * - a turn in flight is stopped *before* the rows go, and nothing is written after the call
 *   resolves — a delete races a running brain, and "hard delete" must not mean "a reply lands
 *   in a session that no longer exists";
 * - every open stream gets the final `session.deleted` event and closes, on whichever instance
 *   it runs — which is the second half of the same race;
 * - and it holds when the two halves of the call are in different processes: the delete issued
 *   to one instance, the turn running in another, over the partition scheduler (#11).
 *
 * The `__slow__` prompt is what makes the race observable: it streams for about ten seconds,
 * so a delete sent after the first chunk lands while the turn is genuinely running.
 */

const harness = e2eHarness('session-delete')

/** What the two instances of the cross-instance scenario run with (see `failover.test.ts`). */
const PARTITION_ENV = {
  SCHEDULER: 'postgres',
  OPENHARNESS_LEASE_TTL_MS: '2000',
  OPENHARNESS_HEARTBEAT_MS: '500',
}

/** A session on the mock model — no credential, no provider, no network. */
async function newSession(client: Client): Promise<string> {
  const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
  return session.id
}

/**
 * Every table that keys rows by a session, as Postgres reports them.
 *
 * Discovered rather than listed: the point of the cascade is that a *new* session-keyed table
 * is covered by a delete that already happened, and a test with a hard-coded list would go on
 * passing while the new table kept its rows forever.
 */
async function sessionKeyedTables(): Promise<string[]> {
  const database = await harness.database()
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ table_name: string }>(
        `select table_name from information_schema.columns
          where table_schema = current_schema() and column_name = 'session_id'
          order by table_name`,
      )
      return result.rows.map((row) => row.table_name)
    },
    { database: database.name },
  )
}

/** How many rows one table holds for a session — `0` from a table that was never written. */
async function rowsFor(table: string, sessionId: string): Promise<number> {
  const database = await harness.database()
  return await withDatabaseClient(
    async (client) => {
      // `table` comes from `information_schema`, never from input; the id is a parameter.
      const result = await client.query<{ count: string }>(
        `select count(*)::text as count from "${table}" where session_id = $1`,
        [sessionId],
      )
      return Number(result.rows[0]?.count ?? '0')
    },
    { database: database.name },
  )
}

/** Whether the session's own row is still there. */
async function sessionRowExists(sessionId: string): Promise<boolean> {
  const database = await harness.database()
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query('select 1 from sessions where id = $1', [sessionId])
      return result.rowCount !== null && result.rowCount > 0
    },
    { database: database.name },
  )
}

/** Every session-keyed table, with the rows each still holds for this session. */
async function leftoverRows(sessionId: string): Promise<Record<string, number>> {
  const tables = await sessionKeyedTables()
  const leftovers: Record<string, number> = {}
  for (const table of tables) {
    leftovers[table] = await rowsFor(table, sessionId)
  }
  return leftovers
}

describe('hard-deleting a session (U5)', () => {
  it('answers 204, drops the session row, and leaves nothing behind in any session-keyed table', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const sessionId = await newSession(client)
    const sent = await client.sessions.events.send(sessionId, [
      { type: 'user.message', content: [{ type: 'text', text: 'something to leave behind' }] },
    ])
    await waitForTurnEnd(client, sessionId, { afterSeq: sent.data[0]?.seq })

    // The tables the delete has to cover are the ones the session actually wrote to: at least
    // `events`, and whatever else this tree keys by session.
    const tables = await sessionKeyedTables()
    expect(tables).toContain('events')
    const before = await leftoverRows(sessionId)
    expect(before.events ?? 0, 'the turn left events to delete').toBeGreaterThan(0)

    await expect(client.sessions.delete(sessionId)).resolves.toBeUndefined()
    expect(await sessionRowExists(sessionId)).toBe(false)

    const after = await leftoverRows(sessionId)
    // The whole map, not one table: `{ events: 0, event_claims: 0, event_supersessions: 0 }` is
    // the assertion that the cascade is complete.
    expect(after).toEqual(Object.fromEntries(Object.keys(after).map((table) => [table, 0])))

    // And the API agrees with the database: the resource is gone, not tombstoned.
    const gone = await errorOf(() => client.sessions.get(sessionId))
    expect(gone.status).toBe(404)
    expect(gone.type).toBe('not_found_error')
    const eventsGone = await errorOf(() => client.sessions.events.list(sessionId))
    expect(eventsGone.status).toBe(404)
  })

  it('is the owner’s alone: another user gets the 404 an unknown id gets, and deletes nothing', async () => {
    const server = await harness.server()
    const a = personFor(
      server,
      await harness.user(server, { email: 'a@delete.test', password: 'a-password' }),
    )
    const b = personFor(
      server,
      await harness.user(server, { email: 'b@delete.test', password: 'b-password' }),
    )

    const sessionId = await newSession(a.client)
    await a.client.sessions.events.send(sessionId, [
      { type: 'user.message', content: [{ type: 'text', text: 'still mine' }] },
    ])

    // 404, never 403: the answer must not confirm that the id names something (A4).
    const refused = await errorOf(() => b.client.sessions.delete(sessionId))
    expect(refused.status).toBe(404)
    expect(refused.type).toBe('not_found_error')

    // The refusal is not a delete: A's session is still there, whole.
    expect((await a.client.sessions.get(sessionId)).id).toBe(sessionId)
    expect((await leftoverRows(sessionId)).events ?? 0).toBeGreaterThan(0)

    // A's own delete still works afterwards — the refused attempt changed nothing.
    await a.client.sessions.delete(sessionId)
    expect(await sessionRowExists(sessionId)).toBe(false)
  })

  it('stops a turn in flight, and nothing is written after the delete resolves', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const sessionId = await newSession(client)
    const watcher = collectStream(client, sessionId, { deltas: true, afterSeq: 0 })
    await client.sessions.events.send(sessionId, [
      { type: 'user.message', content: [{ type: 'text', text: `${MOCK_SLOW_MARKER} stop me` }] },
    ])

    // The turn is genuinely in flight: a chunk of the reply has arrived.
    await watcher.waitFor(
      (events) => events.some((event) => event.type === EVENT_TYPES.eventDelta),
      'the first chunk of the reply',
    )

    const deletedAt = Date.now()
    await client.sessions.delete(sessionId)
    expect(
      Date.now() - deletedAt,
      'the delete waited out the turn rather than the reply',
    ).toBeLessThan(9_000)

    // The reply was cut short: whatever was streamed is a strict prefix of what the mock would
    // have said, which is what "the turn was stopped" looks like from the stream.
    const full = expectedSlowReply()
    const streamed = watcher.stored.flatMap((event) =>
      event.type === EVENT_TYPES.eventStart ? [event.event.id] : [],
    )
    const partial = streamed[0] === undefined ? '' : deltaText(watcher.events, streamed[0])
    if (partial !== '') {
      expect(full.startsWith(partial), 'a prefix of the reply, not all of it').toBe(true)
      expect(partial, 'the reply did not finish').not.toBe(full)
    }

    // Nothing after: every session-keyed table stays empty. A late brain write — an event
    // appended by a pass that outlived the delete, a claim written by a scheduler — would show
    // up here, and this is the window it would land in.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(await leftoverRows(sessionId)).toEqual(
        Object.fromEntries((await sessionKeyedTables()).map((table) => [table, 0])),
      )
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    await watcher.stop()
  })

  it('gives every open stream the final session.deleted event, and closes them', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const sessionId = await newSession(client)
    // Both halves of the stream opened before the turn, so both are subscribed and both see
    // exactly the same turn: one live-only, one replaying from the start of the log.
    const live = collectStream(client, sessionId, { deltas: true })
    const replaying = collectStream(client, sessionId, { afterSeq: 0 })

    const sent = await client.sessions.events.send(sessionId, [
      { type: 'user.message', content: [{ type: 'text', text: 'goodbye' }] },
    ])
    await waitForTurnEnd(client, sessionId, { afterSeq: sent.data[0]?.seq })
    for (const [name, collector] of [
      ['live', live],
      ['replaying', replaying],
    ] as const) {
      await collector.waitFor(
        (events) => events.some((event) => event.type === EVENT_TYPES.agentMessage),
        `the stored reply on the ${name} stream`,
      )
    }

    await client.sessions.delete(sessionId)

    // The goodbye arrives on both, and it is the *last* thing on each: the stream closes with
    // it rather than reconnecting to a session that no longer exists.
    for (const [name, collector] of [
      ['live', live],
      ['replaying', replaying],
    ] as const) {
      await collector.waitFor(
        (events) => events.some((event) => event.type === EVENT_TYPES.sessionDeleted),
        `the session.deleted event on the ${name} stream`,
      )
      await waitFor(`the ${name} stream to close`, () => (collector.closed ? true : undefined), {
        timeoutMs: 5_000,
      })
      expect(collector.error, `the ${name} stream ended cleanly`).toBeUndefined()

      const last = collector.events.at(-1)
      if (last?.type !== EVENT_TYPES.sessionDeleted) {
        throw new Error(`the ${name} stream ended on ${String(last?.type)}`)
      }
      expect([name, last.session_id]).toEqual([name, sessionId])
      // The goodbye names the session and nothing else — it carries no `seq`, because it is
      // not a position in a log that no longer exists.
      expect(Object.keys(last).sort()).toEqual(['session_id', 'type'])
    }

    // Nothing in the streams but events that were already stored, and both halves agree on
    // that log once the chunks are set aside: the live one carried them as the reply was
    // written, the replaying one skips the superseded ones (D9), and the stored message is
    // what both fold to.
    const withoutChunks = (events: readonly StoredEvent[]): number[] =>
      events
        .filter(
          (event) => event.type !== EVENT_TYPES.eventStart && event.type !== EVENT_TYPES.eventDelta,
        )
        .map((event) => event.seq)
    expect(withoutChunks(live.stored)).toEqual(withoutChunks(replaying.stored))
    expect(live.stored.every((event: StoredEvent) => typeof event.seq === 'number')).toBe(true)
    expect(previewedEventId(live.events), 'the live stream followed the chunks').toBeDefined()
    expect(agentMessages(live.stored)).toHaveLength(1)

    // A stream that opens *after* the delete is a 404, not a farewell.
    const tooLate = await errorOf(() => client.sessions.events.list(sessionId))
    expect(tooLate.status).toBe(404)
  })

  it('stops a turn running on another instance, and closes that instance’s streams', async (context) => {
    // The scheduler capability is detected, not assumed — the delete is issued to an instance
    // that does *not* own the session, so on a server without the partition scheduler this
    // would be testing two independent single-process schedulers (see `failover.test.ts`).
    if (!(await leasesAreHeld())) {
      context.skip(
        'the server ignored SCHEDULER=postgres: no instance holds a partition lease, so the ' +
          'delete would be handled by an instance that owns everything anyway. The scenario ' +
          'below runs unchanged on a server with the multi-instance scheduler (#11).',
      )
      return
    }

    const first = await harness.server({
      env: { ...PARTITION_ENV, OPENHARNESS_INSTANCE_ID: 'delete-first' },
    })
    const second = await harness.server({
      env: { ...PARTITION_ENV, OPENHARNESS_INSTANCE_ID: 'delete-second' },
    })
    const other = await harness.client(second)
    const sessionId = await newSession(other)

    // Watch from *this* instance: whether it owns the session or not, the record of the turn
    // ending and the goodbye both have to reach a stream that is registered here.
    const watcher = collectStream(other, sessionId, { deltas: true, afterSeq: 0 })
    await other.sessions.events.send(sessionId, [
      {
        type: 'user.message',
        content: [{ type: 'text', text: `${MOCK_SLOW_MARKER} cross-instance` }],
      },
    ])
    await watcher.waitFor(
      (events) => events.some((event) => event.type === EVENT_TYPES.eventDelta),
      'the first chunk of the reply',
    )

    // Whichever instance owns the partition is running the turn; delete from the other one.
    const owner = await partitionOwner(sessionId)
    const deleter = owner === 'delete-first' ? second : first
    const deleterClient = await harness.client(deleter)

    const deletedAt = Date.now()
    await deleterClient.sessions.delete(sessionId)
    expect(
      Date.now() - deletedAt,
      'the delete reached the owning instance rather than waiting out a lease',
    ).toBeLessThan(9_000)

    await watcher.waitFor(
      (events) => events.some((event) => event.type === EVENT_TYPES.sessionDeleted),
      'the session.deleted event on the other instance’s stream',
    )
    await waitFor('the stream to close', () => (watcher.closed ? true : undefined), {
      timeoutMs: 5_000,
    })
    expect(watcher.error).toBeUndefined()
    expect(await leftoverRows(sessionId)).toEqual(
      Object.fromEntries((await sessionKeyedTables()).map((table) => [table, 0])),
    )
    expect(await sessionRowExists(sessionId)).toBe(false)

    // The turn was stopped, not finished: no complete reply anywhere.
    const answered = watcher.stored.filter((event) => event.type === EVENT_TYPES.agentMessage)
    expect(agentMessages(watcher.stored).map(textOf)).not.toContain(expectedSlowReply())
    expect(answered.length).toBeLessThanOrEqual(1)

    await watcher.stop()
  }, 60_000)
})

/** Which instance holds the lease on the session's partition, per `partition_leases`. */
async function partitionOwner(sessionId: string): Promise<string | undefined> {
  const database = await harness.database()
  const partition = partitionOf(sessionId, DEFAULT_PARTITION_COUNT)
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ owner: string | null }>(
        'select owner from partition_leases where partition = $1',
        [partition],
      )
      return result.rows[0]?.owner ?? undefined
    },
    { database: database.name },
  )
}

/** Whether any instance holds a lease — the observable a partition scheduler leaves behind. */
async function leasesAreHeld(): Promise<boolean> {
  const database = await harness.database()
  const server = await harness.server({ env: PARTITION_ENV })
  try {
    await waitFor(
      'a partition with an owner',
      async () =>
        await withDatabaseClient(
          async (client) => {
            const result = await client.query<{ owned: string }>(
              'select count(*) as owned from partition_leases where owner is not null',
            )
            return Number(result.rows[0]?.owned ?? '0') > 0 ? true : undefined
          },
          { database: database.name },
        ),
      { timeoutMs: 5_000 },
    )
    return true
  } catch {
    return false
  } finally {
    await server.kill()
  }
}
