import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, EVENT_TYPES, type StoredEvent } from '@openharness/protocol'
import { Kysely, PostgresDialect } from 'kysely'
import type { PostgresSchema } from '@openharness/session/postgres'

import {
  HELD_REPLY_TEST_TIMEOUT_MS,
  ObservablePostgresStore,
  POSTGRES_STARTUP_TIMEOUT_MS,
  defer,
  httpCreateAgent,
  httpCreateSession,
  httpSendMessage,
  openSse,
  postgresSource,
  readHistory,
  startPostgres,
  startTestServer,
  waitForIdle,
  type PostgresFixture,
  type SseMessage,
  type SseReader,
  type TestContext,
} from './test-support'

/**
 * The stream against Postgres: the same behaviour the in-memory suite covers, over the store a
 * real deployment runs.
 *
 * What is worth testing here is what only a database changes. Since D9 (issue #46) a reply in
 * flight is part of the log — its chunks are rows with a `seq` — so a connection that opens
 * mid-reply is served by whatever instance answers it, reading the chunks the *other*
 * instance's brain is writing. And compaction is SQL: the deletion of superseded chunks, after
 * a retention window, is the one thing no in-memory test can prove.
 *
 * ## Where the database comes from
 *
 * `DATABASE_URL` when it is set, otherwise Postgres in a container when a Docker daemon is
 * around, otherwise **skipped with a note** — the same rule the session package and the
 * partitioned scheduler use.
 */

const SOURCE = postgresSource()

/** A Kysely handle over the fixture's pool, for Better Auth's tables. */
function fixtureDb(fixture: PostgresFixture): Kysely<PostgresSchema> {
  return new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool: fixture.pool }) })
}

/**
 * Which chunk of a held reply the turn stops at.
 *
 * Three: enough for the connection before the reload to have read a couple of deltas, and
 * early enough that the reply has most of itself left to stream once the test lets it go.
 */
const HELD_AT = 3

if (SOURCE === null) {
  describe.skip('the reply in flight on Postgres (skipped: no DATABASE_URL, no Docker)', () => {
    it('would run against a real database', () => {
      expect.unreachable('unreachable: the suite is skipped')
    })
  })
} else {
  let db: PostgresFixture | undefined
  let context: TestContext | undefined

  beforeAll(async () => {
    db = await startPostgres()
  }, POSTGRES_STARTUP_TIMEOUT_MS)

  afterEach(async () => {
    await context?.close()
    context = undefined
    await db?.truncate()
  })

  afterAll(async () => {
    await db?.close()
    db = undefined
  })

  describe('a reply in flight on Postgres', () => {
    /**
     * The reply is held where the test wants it — three chunks in, by {@link defer} — rather
     * than paced by a clock. Through a container, the store round trips are slow enough that a
     * paced reply can finish before the reload opens, which is a race the test would lose on a
     * loaded machine; held, the turn cannot move until the test says so, and the frames are
     * the test's to predict.
     */
    it(
      'replays the chunks another connection can read out of the log',
      async () => {
        const fixture = requireFixture(db)
        const store = fixture.track(new ObservablePostgresStore({ pool: fixture.pool }))
        const chunks = Array.from({ length: 8 }, (_unused, index) => `part ${index + 1}/8 `)
        const held = defer()
        const test = await startTestServer({
          store,
          // Sign-in runs on the same Postgres: the dev user's `user` row is what `owner_id`
          // references.
          authDatabase: { kind: 'postgres', db: fixtureDb(fixture) },
          replies: [
            {
              text: chunks,
              onChunk: (_chunk, index) => (index === HELD_AT ? held.promise : undefined),
            },
          ],
        })
        context = test
        const agent = await httpCreateAgent(test)
        const session = await httpCreateSession(test, agent.id)
        // The stream is authenticated like every /v1 route now (A2), so the requests go
        // through the context's request helper.
        const url = `${API_VERSION_PREFIX}/sessions/${session.id}/events/stream`

        // Before the reload: the beginning of a reply that is still streaming, read live.
        const before = openSse(await test.request(`${url}?event_deltas[]=agent.message`))
        const streamed = await (async () => {
          try {
            await httpSendMessage(test, session.id, 'tell me something long')
            const seen = await readUntil(before, (read) => deltasOf(read).length >= 2, 10_000)
            return { text: deltasOf(seen).map(deltaText).join(''), id: previewIdOf(seen) }
          } finally {
            before.close()
          }
        })()
        expect(streamed.text.length).toBeGreaterThan(0)
        expect(streamed.id).toMatch(/^sevt_/)

        // The reload, from the start of the log, still mid-reply. The chunks are rows another
        // connection wrote; this read finds them in the table, under the same id.
        const after = openSse(await test.request(`${url}?event_deltas[]=agent.message&after_seq=0`))
        try {
          const replayed = await readUntil(
            after,
            (read) => deltasOf(read).map(deltaText).join('').length >= streamed.text.length,
          )
          expect(previewIdOf(replayed)).toBe(streamed.id)
          const replayedText = deltasOf(replayed).map(deltaText).join('')
          expect(replayedText.startsWith(streamed.text)).toBe(true)
          expect(chunks.join('').startsWith(replayedText)).toBe(true)

          // Let the rest of the reply through, and follow it to the end of the turn.
          held.release()
          const messages = [
            ...replayed,
            ...(await readUntil(
              after,
              (read) =>
                read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
              15_000,
            )),
          ]

          // The chunks the connection accumulated are exactly the stored message — read back
          // by the *same* connection after the turn, from the same database.
          const accumulated = deltasOf(messages).map(deltaText).join('')
          const stored = (await readHistory(test.store, session.id)).find(
            (event) => event.type === EVENT_TYPES.agentMessage,
          )
          expect(stored?.content[0]?.text).toBe(chunks.join(''))
          expect(accumulated).toBe(chunks.join(''))
        } finally {
          after.close()
        }
      },
      HELD_REPLY_TEST_TIMEOUT_MS,
    )

    it(
      'runs Better Auth on exactly the tables the migrations created (A1)',
      async () => {
        const fixture = requireFixture(db)
        const test = await startTestServer({
          store: fixture.store(),
          authDatabase: { kind: 'postgres', db: fixtureDb(fixture) },
        })
        context = test
        // Better Auth validates the schema it is configured against on every request; this
        // asks it directly, so a migration that drifts from what 1.7.7 expects fails here by
        // name rather than as a strange sign-in failure later.
        const authContext = await test.auth.auth.$context
        const checkSchema: unknown = (authContext as { checkSchema?: unknown }).checkSchema
        expect(typeof checkSchema).toBe('function')
        await expect(
          (checkSchema as () => Promise<unknown> | undefined).call(authContext),
        ).resolves.toBeUndefined()
        // And a sign-in really works on it — the same dev user the other suites use.
        const signedIn = await test.signIn()
        expect(signedIn.user.id.length).toBeGreaterThan(0)
      },
      POSTGRES_STARTUP_TIMEOUT_MS,
    )

    it('compacts superseded chunks away, leaving every reader the same answer', async () => {
      const fixture = requireFixture(db)
      const store = fixture.track(new ObservablePostgresStore({ pool: fixture.pool }))
      const test = await startTestServer({
        store,
        authDatabase: { kind: 'postgres', db: fixtureDb(requireFixture(db)) },
      })
      context = test
      const agent = await httpCreateAgent(test)
      const session = await httpCreateSession(test, agent.id)
      await httpSendMessage(test, session.id, 'hello')
      await waitForIdle(store, session.id)

      // A turn whose reply streamed: the chunks are in the table, superseded by the message.
      const before = await readHistory(store, session.id, { includeSuperseded: true })
      const chunks = before.filter(
        (event) => event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta,
      )
      expect(chunks.length).toBeGreaterThan(0)

      // Inside the window nothing goes; past it, exactly the superseded chunks do.
      expect(await store.compact({ olderThan: new Date(0) })).toBe(0)
      const removed = await store.compact({ olderThan: Date.now() + 60_000 })
      expect(removed).toBe(chunks.length)

      const after = await readHistory(store, session.id, { includeSuperseded: true })
      expect(
        after.some(
          (event) => event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta,
        ),
      ).toBe(false)
      // The replay read is what a client folds in, and it was already what it is now.
      expect(await readHistory(store, session.id)).toEqual(before.filter(isNotChunk))
    })
  })
}

/** The fixture `beforeAll` built; a test that runs without one is a bug in the suite. */
function requireFixture(fixture: PostgresFixture | undefined): PostgresFixture {
  if (fixture === undefined) {
    throw new Error('the Postgres fixture was never started')
  }
  return fixture
}

/** Whether a stored event is a reply chunk. */
function isNotChunk(event: StoredEvent): boolean {
  return event.type !== EVENT_TYPES.eventStart && event.type !== EVENT_TYPES.eventDelta
}

/** Read until `done` says so, and answer with everything read. */
async function readUntil(
  reader: SseReader,
  done: (messages: SseMessage[]) => boolean,
  timeoutMs = 5000,
): Promise<SseMessage[]> {
  const messages: SseMessage[] = []
  while (!done(messages)) {
    const message = await reader.next(timeoutMs)
    if (message === null) {
      throw new Error('the stream ended before the expected events arrived')
    }
    messages.push(message)
  }
  return messages
}

/** The `event_delta` messages of a read, in order. */
function deltasOf(messages: readonly SseMessage[]): SseMessage[] {
  return messages.filter((message) => message.event.type === EVENT_TYPES.eventDelta)
}

/** The id the chunks of a read are under: what its `event_start` announced. */
function previewIdOf(messages: readonly SseMessage[]): string {
  const start = messages.find((message) => message.event.type === EVENT_TYPES.eventStart)
  return start?.event.type === EVENT_TYPES.eventStart ? start.event.event.id : ''
}

/** The text an `event_delta` message carries. */
function deltaText(message: SseMessage): string {
  return message.event.type === EVENT_TYPES.eventDelta ? message.event.delta.content.text : ''
}
