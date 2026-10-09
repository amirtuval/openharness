import { EVENT_TYPES, newEventId, type SessionId } from '@openharness/protocol'
import { InMemorySessionStore, type CompactOptions, type SessionStore } from '@openharness/session'
import { describe, expect, it } from 'vitest'

import { DeltaCompactor } from './compaction'
import type { Logger } from './types'
import { TEST_OWNER_ID, waitFor } from './test-support'

/**
 * The compaction job: what it deletes, when, and that it never takes the process with it.
 *
 * The heavy half of compaction — that the store deletes exactly the superseded chunks and
 * nothing else — is the session package's contract, tested by its conformance suite. What is
 * this package's own is the schedule around it: a retention window, a timer both scheduler
 * modes run, a clean stop, and a failure that is logged rather than thrown.
 */

/** A clock a test moves by hand; the store and the job read the same one. */
function movableClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/** A logger that keeps what it was told. */
function recordingLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    debug: (message) => lines.push(`debug ${message}`),
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  }
}

/** A session with a reply that was stored twice: its chunks, then the message over them. */
async function seedSupersededReply(
  store: SessionStore,
): Promise<{ sessionId: SessionId; chunkSeqs: number[] }> {
  const agent = await store.createAgent(
    { name: 'Agent', model: { id: 'test/model' } },
    TEST_OWNER_ID,
  )
  const session = await store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
  const messageId = newEventId()
  const chunks = await store.appendEvents(session.id, [
    { type: EVENT_TYPES.eventStart, event: { type: EVENT_TYPES.agentMessage, id: messageId } },
    {
      type: EVENT_TYPES.eventDelta,
      event_id: messageId,
      delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'Hello' } },
    },
  ])
  const chunkSeqs = chunks.map((event) => event.seq)
  await store.appendEvents(session.id, [
    {
      type: EVENT_TYPES.agentMessage,
      id: messageId,
      content: [{ type: 'text', text: 'Hello' }],
      supersedes: { from_seq: chunkSeqs[0] ?? 1, to_seq: chunkSeqs[chunkSeqs.length - 1] ?? 1 },
    },
  ])
  return { sessionId: session.id, chunkSeqs }
}

/** Whether the session's log still physically holds any chunk. */
async function holdsChunks(store: SessionStore, sessionId: SessionId): Promise<boolean> {
  const page = await store.listEventsUnscoped(sessionId, { includeSuperseded: true, limit: 100 })
  return page.data.some(
    (event) => event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta,
  )
}

describe('DeltaCompactor', () => {
  it('deletes superseded chunks only after the retention window', async () => {
    const clock = movableClock(1_000_000)
    const store = new InMemorySessionStore({ now: clock.now })
    const { sessionId } = await seedSupersededReply(store)
    const compactor = new DeltaCompactor({ store, retentionMs: 60_000, now: clock.now })

    // Inside the window: the chunks stay where they are.
    expect(await compactor.run()).toBe(0)
    expect(await holdsChunks(store, sessionId)).toBe(true)

    // Past it: the superseded chunks go, and only they — the message is not a chunk.
    clock.advance(60_001)
    expect(await compactor.run()).toBe(2)
    expect(await holdsChunks(store, sessionId)).toBe(false)
    const raw = await store.listEventsUnscoped(sessionId, { includeSuperseded: true, limit: 100 })
    expect(raw.data.some((event) => event.type === EVENT_TYPES.agentMessage)).toBe(true)

    // Idempotent: nothing left to delete, and no error for trying.
    expect(await compactor.run()).toBe(0)
  })

  it('keeps an in-flight reply out of the window: nothing supersedes it', async () => {
    const clock = movableClock(1_000_000)
    const store = new InMemorySessionStore({ now: clock.now })
    const agent = await store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await store.createSession(agent.id, { ownerId: TEST_OWNER_ID })
    const messageId = newEventId()
    await store.appendEvents(session.id, [
      { type: EVENT_TYPES.eventStart, event: { type: EVENT_TYPES.agentMessage, id: messageId } },
      {
        type: EVENT_TYPES.eventDelta,
        event_id: messageId,
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'still coming' } },
      },
    ])
    const compactor = new DeltaCompactor({ store, retentionMs: 0, now: clock.now })

    clock.advance(60_000)
    expect(await compactor.run()).toBe(0)
    expect(await holdsChunks(store, session.id)).toBe(true)
  })

  it('runs on its interval, and stops cleanly', async () => {
    const clock = movableClock(1_000_000)
    const store = new InMemorySessionStore({ now: clock.now })
    const { sessionId } = await seedSupersededReply(store)
    // One step past the write: a cutoff of "now" only deletes what was written strictly
    // before it, and the chunks were written at exactly this instant.
    clock.advance(1)
    const logger = recordingLogger()
    const compactor = new DeltaCompactor({
      store,
      retentionMs: 0,
      intervalMs: 20,
      logger,
      now: clock.now,
    })
    expect(compactor.running).toBe(false)

    compactor.start()
    expect(compactor.running).toBe(true)
    try {
      await waitFor(async () => !(await holdsChunks(store, sessionId)), {
        message: 'the interval never ran a compaction',
      })
    } finally {
      await compactor.stop()
    }
    expect(compactor.running).toBe(false)
    expect(logger.lines.join('\n')).toMatch(/debug compaction deleted 2 superseded chunk/)
  })

  it('schedules nothing at an interval of zero', async () => {
    const store = new InMemorySessionStore()
    const { sessionId } = await seedSupersededReply(store)
    const compactor = new DeltaCompactor({ store, retentionMs: 0, intervalMs: 0 })

    compactor.start()

    expect(compactor.running).toBe(false)
    // The chunks stay: only an explicit `run()` compacts when the job is off.
    expect(await holdsChunks(store, sessionId)).toBe(true)
    await compactor.stop()
  })

  it('logs a failing run instead of throwing, and runs again next time', async () => {
    const clock = movableClock(1_000_000)
    let failing = true
    /** A store whose compaction fails while a test says so; the log underneath is real. */
    class FlakyStore extends InMemorySessionStore {
      override async compact(options: CompactOptions): Promise<number> {
        if (failing) {
          throw new Error('the database is away')
        }
        return super.compact(options)
      }
    }
    const store = new FlakyStore({ now: clock.now })
    const { sessionId } = await seedSupersededReply(store)
    clock.advance(1)
    const logger = recordingLogger()
    const compactor = new DeltaCompactor({
      store,
      retentionMs: 0,
      intervalMs: 20,
      logger,
      now: clock.now,
    })

    compactor.start()
    try {
      await waitFor(() => logger.lines.some((line) => line.startsWith('error compaction failed')), {
        message: 'the failing run was never logged',
      })
      // The job survives it: still scheduled, and the next run does the work.
      expect(compactor.running).toBe(true)
      expect(await holdsChunks(store, sessionId)).toBe(true)

      failing = false
      await waitFor(async () => !(await holdsChunks(store, sessionId)), {
        message: 'the job never recovered from the failed run',
      })
    } finally {
      await compactor.stop()
    }
    expect(logger.lines.join('\n')).toMatch(/debug compaction deleted 2 superseded chunk/)
  })

  it('waits for a run in flight when it stops', async () => {
    const clock = movableClock(1_000_000)
    let release: () => void = () => {}
    let reached: (() => void) | null = null
    const inside = new Promise<void>((resolve) => {
      reached = resolve
    })
    /** A store whose first compaction is held open until the test lets it go. */
    class HeldStore extends InMemorySessionStore {
      held = false

      override async compact(options: CompactOptions): Promise<number> {
        if (!this.held) {
          this.held = true
          reached?.()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return super.compact(options)
      }
    }
    const store = new HeldStore({ now: clock.now })
    const { sessionId } = await seedSupersededReply(store)
    clock.advance(1)
    const compactor = new DeltaCompactor({ store, retentionMs: 0, intervalMs: 20, now: clock.now })

    compactor.start()
    await inside
    const stopping = compactor.stop()
    release()

    // `stop()` does not resolve until the in-flight run has — which is what makes it safe for
    // shutdown to close the store right after.
    await stopping
    expect(compactor.running).toBe(false)
    expect(await holdsChunks(store, sessionId)).toBe(false)
  })
})
