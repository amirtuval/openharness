import {
  DEFAULT_PARTITION_COUNT,
  EVENT_TYPES,
  partitionOf,
  type Session,
} from '@openharness/protocol'
import { MOCK_SLOW_MARKER } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  clientFor,
  collectStream,
  e2eHarness,
  errorOf,
  isPreviewDelta,
  personFor,
  sleep,
  waitFor,
  waitForTurnEnd,
  withDatabaseClient,
  type Person,
} from './harness'

/**
 * Deleting a session, end to end (epic #116, U5): a hard delete that takes the whole log.
 *
 * The server package tests the route in-process (`session-delete.test.ts`); what a deployment
 * adds is the parts only real infrastructure can show — the **cascade** over real Postgres
 * rows, streams that actually close, a turn stopped across a process, and two instances
 * sharing a database because the session's partition belongs to one of them.
 *
 * The cascade is asserted against the schema, not a list of table names: every table with a
 * `session_id` column is swept, so a future table keyed by a session is covered the day it
 * exists rather than the day somebody remembers this test.
 */

const harness = e2eHarness('session-delete')

/** Every table that has a `session_id` column, as Postgres reports them. */
async function sessionKeyedTables(databaseName: string): Promise<string[]> {
  const rows = await withDatabaseClient(
    async (client) =>
      client.query<{ table_name: string }>(
        `select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'session_id'
          order by table_name`,
      ),
    { database: databaseName },
  )
  return rows.rows.map((row) => row.table_name)
}

/** How many rows in each session-keyed table (plus `sessions` itself) name this session. */
async function rowsForSession(
  databaseName: string,
  sessionId: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  await withDatabaseClient(
    async (client) => {
      const sessions = await client.query<{ count: string }>(
        'select count(*) as count from sessions where id = $1',
        [sessionId],
      )
      counts.sessions = Number(sessions.rows[0]?.count ?? '0')
      for (const table of await sessionKeyedTables(databaseName)) {
        const result = await client.query<{ count: string }>(
          `select count(*) as count from "${table}" where session_id = $1`,
          [sessionId],
        )
        counts[table] = Number(result.rows[0]?.count ?? '0')
      }
    },
    { database: databaseName },
  )
  return counts
}

/** Every count zero: the session and its whole log are gone, everywhere. */
function expectNothingLeft(counts: Record<string, number>): void {
  for (const [table, count] of Object.entries(counts)) {
    expect([table, count]).toEqual([table, 0])
  }
}

/** A session with one finished turn in it — the log the cascade has to remove. */
async function sessionWithATurn(client: Person['client'], prompt: string): Promise<Session> {
  const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
  const sent = await client.sendMessage(session.id, prompt)
  await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })
  return session
}

/**
 * Put this file's servers away as each scenario ends rather than at the teardown.
 *
 * The e2e suite runs its files side by side on a small runner; a file that leaves six idle
 * server processes up until `afterAll` — two of them partitioned — makes every other file's
 * turn pay for them. `kill()` is idempotent, so this is the teardown's own work, earlier.
 */
async function killServers(): Promise<void> {
  await Promise.all(harness.servers.map(async (server) => server.kill()))
}

describe('deleting a session (U5)', () => {
  it('answers 204, removes every session-keyed row, and 404s every read', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const me = personFor(server, await harness.user(server, {}))
    const session = await sessionWithATurn(me.client, 'a turn worth deleting')

    // The premise: a real log is there to be removed — events, the requests' claims and the
    // reply's supersessions — and every one of those tables is swept below.
    const before = await rowsForSession(database.name, session.id)
    expect(before.sessions).toBe(1)
    expect(before.events ?? 0).toBeGreaterThan(0)
    expect(before.event_claims ?? 0).toBeGreaterThan(0)
    expect(before.event_supersessions ?? 0).toBeGreaterThan(0)

    // The delete itself: 204, so the client resolves `void`.
    await expect(me.client.sessions.delete(session.id)).resolves.toBeUndefined()

    // Every read of it is the 404 an unknown id gets — the resource, the list, the events
    // list, an append, and the delete again.
    const missing = await errorOf(() => me.client.sessions.get(session.id))
    expect(missing.status).toBe(404)
    expect(missing.type).toBe('not_found_error')
    const listed = await me.client.sessions.list({ limit: 100 })
    expect(listed.data.some((candidate) => candidate.id === session.id)).toBe(false)
    for (const read of [
      () => me.client.sessions.events.list(session.id),
      () => me.client.sendMessage(session.id, 'into the void'),
      () => me.client.sessions.delete(session.id),
    ]) {
      const refused = await errorOf(read)
      expect(refused.status).toBe(404)
      expect(refused.type).toBe('not_found_error')
    }

    // And the cascade, in every table that holds a `session_id`.
    const after = await rowsForSession(database.name, session.id)
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
    expectNothingLeft(after)
    await killServers()
  })

  it('is owner-scoped: another user gets a 404 and the session survives for its owner', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const owner = personFor(
      server,
      await harness.user(server, { email: 'owner@session-delete.test', password: 'owner-pw' }),
    )
    const other = personFor(
      server,
      await harness.user(server, { email: 'other@session-delete.test', password: 'other-pw' }),
    )
    const session = await sessionWithATurn(owner.client, 'mine to delete')

    // The other person's delete is the 404 an unknown id gets — never a 403, so the
    // session's existence never leaks — and nothing was removed.
    const refused = await errorOf(() => other.client.sessions.delete(session.id))
    expect(refused.status).toBe(404)
    expect(refused.type).toBe('not_found_error')
    expect(
      await other.client.sessions.get(session.id).catch((error: unknown) => error),
    ).toBeTruthy()
    await expect(owner.client.sessions.get(session.id)).resolves.toMatchObject({ id: session.id })
    expect((await rowsForSession(database.name, session.id)).sessions).toBe(1)

    // The owner's delete is the one that works.
    await owner.client.sessions.delete(session.id)
    expectNothingLeft(await rowsForSession(database.name, session.id))
    await killServers()
  })

  it('stops a turn in flight: nothing is written after the delete resolves', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const me = personFor(server, await harness.user(server, {}))
    const session = await me.client.sessions.create({
      model: { id: 'anthropic/claude-sonnet-5' },
    })

    // A reply that takes about ten seconds — long enough that the delete lands mid-turn.
    const watching = collectStream(me.client, session.id, { deltas: true, afterSeq: 0 })
    await me.client.sendMessage(session.id, `${MOCK_SLOW_MARKER} delete me mid-sentence`)
    await watching.waitFor((events) => events.some(isPreviewDelta), 'the turn to be mid-flight')

    await me.client.sessions.delete(session.id)
    // The open stream was told, not hung up on: the goodbye is `session.deleted`, which the
    // client folds and stops reconnecting on.
    await watching.waitFor(
      (events) => events.some((event) => event.type === EVENT_TYPES.sessionDeleted),
      'the stream to receive session.deleted',
    )
    await watching.stop()

    // Nothing left, immediately — and still nothing once the stopped turn cannot be writing
    // any more, whichever way it was stopped.
    expectNothingLeft(await rowsForSession(database.name, session.id))
    await sleep(2_000)
    expectNothingLeft(await rowsForSession(database.name, session.id))

    // The process is healthy: the delete stopped a brain, it did not take one down.
    expect(server.isRunning()).toBe(true)
    expect((await fetch(`${server.baseUrl}/health`)).status).toBe(200)
    await killServers()
  })

  it('closes open streams with the deleted frame as the last thing they see', async () => {
    const server = await harness.server()
    const me = personFor(server, await harness.user(server, {}))
    const session = await sessionWithATurn(me.client, 'a quiet session with a stream on it')

    // The SSE frames by hand: what is asserted is the wire's own goodbye — a client hides the
    // closing behind its reconnect loop, and this is the fact underneath.
    const response = await fetch(`${server.baseUrl}/v1/sessions/${session.id}/events/stream`, {
      headers: { authorization: `Bearer ${me.signedIn.token}` },
    })
    expect(response.status).toBe(200)
    const frames: string[] = []
    let ended = false
    const reading = (async () => {
      const reader = response.body?.getReader()
      if (reader === undefined) {
        throw new Error('the stream response has no body')
      }
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          ended = true
          return
        }
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const end = buffer.indexOf('\n\n')
          if (end === -1) {
            break
          }
          frames.push(buffer.slice(0, end))
          buffer = buffer.slice(end + 2)
        }
      }
    })()

    // The stream is live before the delete is asked for: its subscription exists, so the
    // store's goodbye reaches a listener rather than a connect that races the delete.
    await me.client.sendMessage(session.id, 'something to make the stream announce itself')
    await waitFor('the live stream to deliver the message', () =>
      frames.some((frame) => frame.includes(EVENT_TYPES.userMessage)) ? true : undefined,
    )

    await me.client.sessions.delete(session.id)

    await waitFor('the stream to end after the deleted frame', () => (ended ? true : undefined), {
      timeoutMs: 15_000,
    })
    await reading

    const last = frames.at(-1) ?? ''
    expect(last).toContain('data:')
    expect(JSON.parse(last.split('data: ')[1] ?? '')).toMatchObject({
      type: EVENT_TYPES.sessionDeleted,
      session_id: session.id,
    })
    // The goodbye is the deletion, not a revocation: no `event: error` frame is sent on top.
    expect(frames.some((frame) => frame.startsWith('event: error'))).toBe(false)
    // And it is stream-only: no `id:` line, because there is no log left for a resume.
    expect(last).not.toMatch(/^id:/mu)
    await killServers()
  })

  it('works across two instances: the delete stops the turn the other instance is running', async () => {
    // Two servers sharing one database with the partition scheduler (#11) — the deployment
    // shape where a session's turn runs on whichever instance holds its partition, and a
    // request handled by the other one has to reach across.
    const partitionEnv = {
      SCHEDULER: 'postgres',
      OPENHARNESS_LEASE_TTL_MS: '2000',
      OPENHARNESS_HEARTBEAT_MS: '500',
    }
    const first = await harness.server({
      env: { ...partitionEnv, OPENHARNESS_INSTANCE_ID: 'delete-first' },
    })
    const second = await harness.server({
      env: { ...partitionEnv, OPENHARNESS_INSTANCE_ID: 'delete-second' },
    })
    const database = await harness.database()
    const me = personFor(first, await harness.user(first, {}))
    // The same session, one account: a token minted by either instance is the same row.
    const throughSecond = clientFor(second, me.signedIn)

    const session = await me.client.sessions.create({
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const watching = collectStream(me.client, session.id, { deltas: true, afterSeq: 0 })
    await me.client.sendMessage(session.id, `${MOCK_SLOW_MARKER} someone else will delete me`)
    await watching.waitFor((events) => events.some(isPreviewDelta), 'the turn to be mid-flight')

    // Delete through the instance that does **not** own the session's partition: the stop has
    // to be routed to the owner, which is the cross-instance half of U5. Which instance that
    // is depends on how the two split the partitions at boot, so the lease table says.
    const owner = await partitionOwner(session.id, database.name)
    expect(['delete-first', 'delete-second']).toContain(owner)
    const deleter = owner === 'delete-first' ? second : first
    const throughDeleter = clientFor(deleter, me.signedIn)
    expect(await throughDeleter.sessions.delete(session.id)).toBeUndefined()

    // Gone from both instances' point of view, and no row anywhere.
    expect((await errorOf(() => throughSecond.sessions.get(session.id))).status).toBe(404)
    expect((await errorOf(() => me.client.sessions.get(session.id))).status).toBe(404)
    expectNothingLeft(await rowsForSession(database.name, session.id))

    // The open stream — following through the *first* instance — received the goodbye, and
    // the other instance's turn was stopped rather than left writing into a gone log.
    await watching.waitFor(
      (events) => events.some((event) => event.type === EVENT_TYPES.sessionDeleted),
      'the stream to receive session.deleted',
    )
    await watching.stop()
    await sleep(2_000)
    expectNothingLeft(await rowsForSession(database.name, session.id))
    expect(first.isRunning()).toBe(true)
    expect(second.isRunning()).toBe(true)
    await killServers()
  })
})

/** The instance holding the lease on the session's partition, per `partition_leases`. */
async function partitionOwner(
  sessionId: string,
  databaseName: string,
): Promise<string | undefined> {
  const partition = partitionOf(sessionId, DEFAULT_PARTITION_COUNT)
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ owner: string | null }>(
        'select owner from partition_leases where partition = $1',
        [partition],
      )
      return result.rows[0]?.owner ?? undefined
    },
    { database: databaseName },
  )
}
