import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, EVENT_TYPES } from '@openharness/protocol'

import {
  POSTGRES_STARTUP_TIMEOUT_MS,
  httpCreateAgent,
  httpCreateSession,
  httpSendMessage,
  openSse,
  postgresSource,
  readHistory,
  startPostgres,
  startTestServer,
  type PostgresFixture,
  type SseMessage,
  type SseReader,
  type TestContext,
} from './test-support'

/**
 * The preview snapshot against Postgres: the same stream the in-memory suite covers, over the
 * store a real deployment runs, where the preview lives in a table rather than in one process's
 * memory.
 *
 * That is the difference worth testing here. A connection that opens mid-reply is served by
 * whatever instance answers it, and the deltas were published — and their text accumulated — by
 * whichever instance is running the brain; `getPreview` is what puts the two together, and only
 * a real database proves it does.
 *
 * ## Where the database comes from
 *
 * `DATABASE_URL` when it is set, otherwise Postgres in a container when a Docker daemon is
 * around, otherwise **skipped with a note** — the same rule the session package and the
 * partitioned scheduler use.
 */

const SOURCE = postgresSource()

if (SOURCE === null) {
  describe.skip('the preview snapshot on Postgres (skipped: no DATABASE_URL, no Docker)', () => {
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

  describe('the preview snapshot on Postgres', () => {
    it('hands a connection opened mid-reply the text that was already streamed', async () => {
      const store = requireFixture(db).store()
      const chunks = Array.from({ length: 8 }, (_unused, index) => `part ${index + 1}/8 `)
      const test = await startTestServer({
        store,
        replies: [{ text: chunks, delayMs: 120 }],
      })
      context = test
      const agent = await httpCreateAgent(test)
      const session = await httpCreateSession(test, agent.id)
      const url = `${test.url}${API_VERSION_PREFIX}/sessions/${session.id}/events/stream`

      // Before the reload: the first deltas of a reply that is still streaming.
      const before = openSse(await fetch(`${url}?event_deltas[]=agent.message`))
      let streamed: { previewId: string; text: string }
      try {
        await httpSendMessage(test, session.id, 'tell me something long')
        streamed = await readPreview(before)
      } finally {
        before.close()
      }
      const { previewId } = streamed
      expect(previewId).toMatch(/^sevt_/)
      expect(streamed.text.length).toBeGreaterThan(0)

      // The reload, from the start of the log, still mid-reply.
      const after = openSse(await fetch(`${url}?event_deltas[]=agent.message&after_seq=0`))
      try {
        const messages = await readUntil(
          after,
          (read) => read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
          15_000,
        )
        const firstPreview = messages.findIndex(
          (message) => message.event.type === EVENT_TYPES.eventStart,
        )
        expect(firstPreview).toBeGreaterThan(-1)
        // The preview the snapshot is for is the one the brain announced — the same `sevt_` id,
        // read out of the table by a request the streaming brain never touched.
        expect(previewIdOf(messages)).toBe(previewId)
        expect(messages[firstPreview + 1]?.event.type).toBe(EVENT_TYPES.eventDelta)
        expect(deltaText(messages[firstPreview + 1]!).startsWith(streamed.text)).toBe(true)

        // And the accumulated preview is exactly the stored message: nothing missing, nothing
        // counted twice.
        const accumulated = deltasOf(messages).map(deltaText).join('')
        const stored = (await readHistory(test.store, session.id)).find(
          (event) => event.type === EVENT_TYPES.agentMessage,
        )
        expect(stored?.content[0]?.text).toBe(chunks.join(''))
        expect(accumulated).toBe(chunks.join(''))
      } finally {
        after.close()
      }
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

/** Read a stream until it has shown the start of a preview and a couple of its deltas. */
async function readPreview(reader: SseReader): Promise<{ previewId: string; text: string }> {
  const messages = await readUntil(
    reader,
    (read) => previewIdOf(read) !== '' && deltasOf(read).length >= 2,
    10_000,
  )
  return { previewId: previewIdOf(messages), text: deltasOf(messages).map(deltaText).join('') }
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

/** The id the previews of a read are under: what its `event_start` announced. */
function previewIdOf(messages: readonly SseMessage[]): string {
  const start = messages.find((message) => message.event.type === EVENT_TYPES.eventStart)
  return start?.event.type === EVENT_TYPES.eventStart ? start.event.event.id : ''
}

/** The text an `event_delta` message carries. */
function deltaText(message: SseMessage): string {
  return message.event.type === EVENT_TYPES.eventDelta ? message.event.delta.content.text : ''
}
