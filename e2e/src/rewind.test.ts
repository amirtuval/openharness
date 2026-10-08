import { createTranscript, selectMessages, type Client, type Transcript } from '@openharness/client'
import { EVENT_TYPES, type Session } from '@openharness/protocol'
import { MOCK_SLOW_MARKER, MOCK_SLOW_TOTAL_MS } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  e2eHarness,
  errorOf,
  readLog,
  typesOf,
  waitFor,
  waitForModelRequestStart,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * Edit and resend, end to end (#238): a reader edits a message they sent, and the conversation
 * restarts from it — live, after a reload, and after compaction has deleted what the edit
 * replaced.
 *
 * The pieces are checked in their own packages; what only a real server, a real Postgres and
 * the SDK can say is that they agree: the transcript a client watched the rewind arrive on, the
 * transcript a fresh read builds, and the rows the log physically holds.
 */

const harness = e2eHarness('rewind')

/** An agent and a session, the pair every test here drives. */
async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

/** One view of a session: a transcript, and the way to stop following. */
interface View {
  readonly transcript: Transcript
  stop(): Promise<void>
}

/**
 * Follow a session live, folding every event into a transcript.
 *
 * `afterSeq: 0` is "from the beginning": the log is replayed first and the stream continues
 * from there, which is the client's documented flow — so a connection that lands after the
 * next append replays it instead of missing it.
 */
function follow(client: Client, sessionId: string, afterSeq: number): View {
  const transcript = createTranscript()
  const controller = new AbortController()
  const reading = (async () => {
    try {
      for await (const event of client.sessions.events.stream(sessionId, {
        deltas: true,
        afterSeq,
        signal: controller.signal,
      })) {
        transcript.apply(event)
      }
    } catch {
      // The abort `stop()` makes is how this iteration normally ends.
    }
  })()
  return {
    transcript,
    stop: async () => {
      controller.abort()
      await reading
    },
  }
}

/** The conversation a transcript holds, as `role: text` pairs. */
function conversationOf(transcript: Transcript): string[] {
  return selectMessages(transcript.getState()).map((message) => `${message.role}:${message.text}`)
}

/** The whole log as a reader gets it: the replay read, folded into a fresh transcript. */
async function reload(client: Client, sessionId: string): Promise<Transcript> {
  const transcript = createTranscript()
  for await (const event of client.sessions.events.iterate(sessionId)) {
    transcript.apply(event)
  }
  return transcript
}

/** How many rows the session's log physically holds, counted by event type. */
async function countEventsByType(sessionId: string): Promise<Record<string, number>> {
  const database = await harness.database()
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ type: string; count: number }>(
        'select type, count(*)::int as count from events where session_id = $1 group by type',
        [sessionId],
      )
      return Object.fromEntries(result.rows.map((row) => [row.type, row.count]))
    },
    { database: database.name },
  )
}

describe('edit and resend (#238)', () => {
  it('restarts the conversation from the edit, for a client that watched and one that reloads', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    const session = await newSession(client)

    // A reader's first message: the deterministic model echoes it back, so the reply is the
    // prompt and every assertion below can be exact.
    const original = await client.sendMessage(session.id, 'write a haiku about rain')
    await waitForTurnEnd(client, session.id, { afterSeq: original.seq })

    // A client that was following from the start: it has the turn the edit will replace on
    // screen, and it is the one that has to drop it when the rewind arrives.
    const live = follow(client, session.id, 0)
    await waitFor('the live client to fold the original turn', () =>
      conversationOf(live.transcript).length === 2 ? true : undefined,
    )

    // The edit: the rewind and the message travel in one request, and the turn that follows
    // answers the edit.
    const edited = await client.sendMessage(session.id, 'write a haiku about snow', {
      rewindTo: original.seq,
    })
    await waitForTurnEnd(client, session.id, { afterSeq: edited.seq })
    await live.stop()

    // What a reader sees is the conversation restarted from the edit — in the tab that
    // watched it happen and in one that reads the log now.
    const expected = [`user:write a haiku about snow`, 'agent:write a haiku about snow']
    expect(conversationOf(live.transcript), 'the client that followed the rewind live').toEqual(
      expected,
    )
    expect(conversationOf(await reload(client, session.id)), 'a reload after the rewind').toEqual(
      expected,
    )

    // The replay read is the rewind first, then the edit and the turn it started: the replaced
    // turn is not in it at all, which is what makes the two views above agree.
    const log = await readLog(client, session.id)
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.sessionRewind,
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const rewind = log[0]
    expect(rewind).toMatchObject({
      type: EVENT_TYPES.sessionRewind,
      supersedes: { from_seq: original.seq, to_seq: (rewind?.seq ?? 0) - 1 },
    })

    // The log is append-only, so the raw rows are still there — the original message and its
    // reply included — and the positions they hold are never reused.
    const rows = await countEventsByType(session.id)
    expect(rows[EVENT_TYPES.sessionRewind]).toBe(1)
    expect(rows[EVENT_TYPES.userMessage]).toBe(2)
    expect(rows[EVENT_TYPES.agentMessage]).toBe(2)
  })

  it('leaves every view the same conversation after compaction has deleted the replaced turn', async () => {
    // Retention zero and a fast compaction tick: the rewound rows are gone by the time the
    // assertions run, and a reader must not be able to tell.
    const server = await harness.server({
      env: {
        OPENHARNESS_DELTA_RETENTION_MS: '0',
        OPENHARNESS_COMPACT_INTERVAL_MS: '100',
      },
    })
    const client = await harness.client(server)
    const session = await newSession(client)

    const first = await client.sendMessage(session.id, 'write a haiku about rain')
    await waitForTurnEnd(client, session.id, { afterSeq: first.seq })
    const second = await client.sendMessage(session.id, 'and one about sleet')
    await waitForTurnEnd(client, session.id, { afterSeq: second.seq })

    // The reader edits the *first* message: everything after it goes with it.
    const edit = await client.sendMessage(session.id, 'write a haiku about snow', {
      rewindTo: first.seq,
    })
    await waitForTurnEnd(client, session.id, { afterSeq: edit.seq })

    const conversation = ['user:write a haiku about snow', 'agent:write a haiku about snow']
    expect(conversationOf(await reload(client, session.id))).toEqual(conversation)

    // Compaction has deleted what the rewind replaced: one user message and one reply are left
    // in the log, both of them the edit's.
    await waitFor(
      'the compaction job to delete the replaced turn',
      async () => {
        const rows = await countEventsByType(session.id)
        return rows[EVENT_TYPES.userMessage] === 1 ? true : undefined
      },
      { timeoutMs: 30_000 },
    )
    const rows = await countEventsByType(session.id)
    expect(rows[EVENT_TYPES.agentMessage]).toBe(1)
    expect(rows[EVENT_TYPES.sessionStatusRunning]).toBe(1)
    // The rewind itself stays: it is not covered by its own range, and it is what says where
    // the log restarts.
    expect(rows[EVENT_TYPES.sessionRewind]).toBe(1)

    // And the same conversation comes back, from the log alone — whether compaction ran is
    // invisible to a reader.
    expect(conversationOf(await reload(client, session.id))).toEqual(conversation)
    const live = follow(client, session.id, 0)
    await waitFor('the live client to fold the whole log', () =>
      conversationOf(live.transcript).length === 2 ? true : undefined,
    )
    await live.stop()
    expect(conversationOf(live.transcript)).toEqual(conversation)
  })

  it('refuses a rewind while a turn is running, and takes it once the turn is over', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    const session = await newSession(client)

    const original = await client.sendMessage(session.id, 'the first thing')
    await waitForTurnEnd(client, session.id, { afterSeq: original.seq })

    const running = await client.sendMessage(session.id, `${MOCK_SLOW_MARKER} slowly now`)
    // The span start is the request being in flight — the session is `running` from here until
    // the slow reply finishes — so the rewind below is aimed at a turn that is really running,
    // rather than racing the brain to the first append.
    await waitForModelRequestStart(client, session.id, {
      timeoutMs: MOCK_SLOW_TOTAL_MS * 3,
    })

    // The turn in flight owns the branch being taken back, so the server refuses the rewind
    // with the protocol's 409 — and stores nothing of the batch.
    const refusal = await errorOf(() =>
      client.sendMessage(session.id, 'the edited thing', { rewindTo: original.seq }),
    )
    expect(refusal.status).toBe(409)
    expect(refusal.type).toBe('conflict_error')

    await waitForTurnEnd(client, session.id, {
      afterSeq: running.seq,
      timeoutMs: MOCK_SLOW_TOTAL_MS * 3,
    })

    // Once the turn is over the same rewind is accepted, and the conversation restarts from it.
    const edited = await client.sendMessage(session.id, 'the edited thing', {
      rewindTo: original.seq,
    })
    await waitForTurnEnd(client, session.id, { afterSeq: edited.seq })
    expect(conversationOf(await reload(client, session.id))).toEqual([
      'user:the edited thing',
      'agent:the edited thing',
    ])
  })
})
