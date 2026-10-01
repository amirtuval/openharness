import {
  createTranscript,
  selectMessages,
  selectStreamingMessage,
  type Client,
  type Transcript,
} from '@openharness/client'
import type { Session } from '@openharness/protocol'
import { MOCK_SLOW_MARKER, MOCK_SLOW_TOTAL_MS } from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  e2eHarness,
  expectedSlowReply,
  waitFor,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * The D9 promise, end to end: a client that followed a reply live, one that joined mid-reply,
 * and one that resumed from inside its chunks all end with the same transcript — before and
 * after the chunks have been compacted away.
 *
 * Since the chunks are stored events, "resuming" is a `seq` like everywhere else, and the
 * checks here are the ones no single package can make: a real server process, a real Postgres,
 * and the SDK the web app and the TUI use, on one session.
 */

const harness = e2eHarness('d9-convergence')

/** An agent and a session, the pair these tests drive. */
async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

/** One view of a session: a transcript, and the way to stop following. */
interface View {
  /** What this client has folded so far. */
  readonly transcript: Transcript
  /** Abort the stream and wait for the read to end. */
  stop(): Promise<void>
}

/**
 * Start following a session — from `afterSeq`, or live-only when it is omitted — and fold every
 * event into a transcript.
 *
 * This is the client's documented flow: `iterate` the log for history, then `stream` from the
 * `lastSeq` it reached; a client that joined mid-reply and one that reconnected are the same
 * call with a different starting position.
 */
function follow(
  client: Client,
  sessionId: string,
  options: { readonly afterSeq?: number; readonly transcript?: Transcript } = {},
): View {
  const transcript = options.transcript ?? createTranscript()
  const controller = new AbortController()
  const reading = (async () => {
    try {
      for await (const event of client.sessions.events.stream(sessionId, {
        deltas: true,
        ...(options.afterSeq === undefined ? {} : { afterSeq: options.afterSeq }),
        signal: controller.signal,
      })) {
        transcript.apply(event)
      }
    } catch {
      // A stream only throws what reconnecting cannot fix; the abort `stop()` makes is how this
      // iteration normally ends.
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

/** A client that loads what the log holds and then follows it live — the documented flow. */
async function attachFromHistory(client: Client, sessionId: string): Promise<View> {
  const transcript = createTranscript()
  for await (const event of client.sessions.events.iterate(sessionId)) {
    transcript.apply(event)
  }
  return follow(client, sessionId, { afterSeq: transcript.getState().lastSeq, transcript })
}

/** How much of the reply a test waits for before it treats itself as "mid-reply". */
const MID_REPLY_CHARS = 30

/** Wait until the reply has started streaming into this view. */
async function waitForReply(view: View, what = 'the reply to start streaming'): Promise<void> {
  await waitFor(what, () =>
    selectStreamingMessage(view.transcript.getState()) !== null ? true : undefined,
  )
}

/** Wait until the view has folded a few chunks of the reply in flight. */
async function waitForReplyText(view: View, chars = MID_REPLY_CHARS): Promise<void> {
  await waitFor(`the view to have folded ${String(chars)} characters of the reply`, () => {
    const streaming = selectStreamingMessage(view.transcript.getState())
    return streaming !== null && streaming.text.length >= chars ? true : undefined
  })
}

/** Wait until every view has folded a turn that ended: the transcripts are settled. */
async function waitForSettled(
  views: readonly View[],
  timeoutMs = MOCK_SLOW_TOTAL_MS * 3,
): Promise<void> {
  await waitFor(
    'every view to settle on an idle session',
    () => {
      return views.every((view) => {
        const state = view.transcript.getState()
        return state.status === 'idle' && selectStreamingMessage(state) === null
      })
        ? true
        : undefined
    },
    { timeoutMs },
  )
}

/** The conversation a transcript holds, as `role: text` pairs. */
function conversationOf(view: View): string[] {
  return selectMessages(view.transcript.getState()).map(
    (message) => `${message.role}:${message.text}`,
  )
}

/** How many `event_start` / `event_delta` rows a test database physically holds. */
async function countStoredChunks(): Promise<number> {
  const database = await harness.database()
  return await withDatabaseClient(
    async (client) => {
      const result = await client.query<{ count: number }>(
        "select count(*)::int as count from events where type in ('event_start', 'event_delta')",
      )
      return result.rows[0]?.count ?? -1
    },
    { database: database.name },
  )
}

describe('clients that join a reply in flight (D9)', () => {
  it('converge on the transcript of a client that was live throughout', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} take your time`

    // (1) The reference: connected before the turn started, so it sees every event live.
    const reference = follow(client, session.id)
    // (3) A second client, connected at the same time, which will lose its connection
    // mid-chunks and come back: real reconnects send both `last-event-id` and `after_seq`,
    // and this is that resume, continued into the same transcript.
    const dropping = follow(client, session.id)

    await client.sendMessage(session.id, prompt)
    await waitForReply(reference)

    // (2) A client that opens mid-reply: it loads what the log holds — the chunks so far — and
    // then streams from their last `seq`.
    const joiner = await attachFromHistory(client, session.id)
    await waitForReplyText(joiner)

    await waitForReplyText(dropping)
    const reached = dropping.transcript.getState().lastSeq
    expect(reached).toBeGreaterThan(0)
    await dropping.stop()
    const resumed = follow(client, session.id, {
      afterSeq: reached,
      transcript: dropping.transcript,
    })

    await waitForSettled([reference, joiner, resumed])
    await Promise.all([reference.stop(), joiner.stop(), resumed.stop()])

    // The reply was the slow one, and the steering-free conversation is one user turn.
    expect(conversationOf(reference)).toEqual([`user:${prompt}`, `agent:${expectedSlowReply()}`])

    // Deep equality, not just the messages' text: positions, the streaming/pending flags and
    // the resume position must all agree — these clients fold different views of one turn.
    const expected = reference.transcript.getState()
    expect(joiner.transcript.getState().messages, 'the client that joined mid-reply').toEqual(
      expected.messages,
    )
    expect(resumed.transcript.getState().messages, 'the client that resumed mid-chunks').toEqual(
      expected.messages,
    )
    expect(joiner.transcript.getState().lastSeq).toBe(expected.lastSeq)
    expect(resumed.transcript.getState().lastSeq).toBe(expected.lastSeq)

    // And the log the reference replayed from agrees with what everyone rendered.
    const reloaded = createTranscript()
    for await (const event of client.sessions.events.iterate(session.id)) {
      reloaded.apply(event)
    }
    expect(reloaded.getState().messages).toEqual(expected.messages)
  })

  it('converge the same way once compaction has deleted the chunks', async () => {
    // The server compacts superseded chunks immediately (retention 0) and often, so the turn
    // below is one whose chunks are gone by the time the assertions run — a client must not be
    // able to tell.
    const server = await harness.server({
      env: {
        OPENHARNESS_DELTA_RETENTION_MS: '0',
        OPENHARNESS_COMPACT_INTERVAL_MS: '100',
      },
    })
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} take your time`

    const reference = follow(client, session.id)
    await client.sendMessage(session.id, prompt)
    await waitForReply(reference)

    const joiner = await attachFromHistory(client, session.id)
    await waitForReplyText(joiner)

    await waitForSettled([reference, joiner])
    await Promise.all([reference.stop(), joiner.stop()])
    await waitForTurnEnd(client, session.id, { timeoutMs: MOCK_SLOW_TOTAL_MS * 3 })

    // The compaction job has done its work: no chunk rows are left in the database.
    await waitFor(
      'the compaction job to delete the superseded chunks',
      async () => ((await countStoredChunks()) === 0 ? true : undefined),
      { timeoutMs: 30_000 },
    )

    expect(conversationOf(reference)).toEqual([`user:${prompt}`, `agent:${expectedSlowReply()}`])
    expect(joiner.transcript.getState().messages).toEqual(reference.transcript.getState().messages)

    // A client reading the log *now* — after the chunks are gone — sees the same conversation.
    const reloaded = createTranscript()
    for await (const event of client.sessions.events.iterate(session.id)) {
      reloaded.apply(event)
    }
    expect(reloaded.getState().messages).toEqual(reference.transcript.getState().messages)
  })

  it('orders a steered reply the same live and after a reload', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} take your time`
    const steering = 'actually, keep it short'

    const live = follow(client, session.id)
    await client.sendMessage(session.id, prompt)
    await waitForReply(live)

    // Sent while the reply is streaming: it is not part of the request in flight, and the
    // request that answers it comes second.
    await client.sendMessage(session.id, steering)

    await waitForSettled([live])
    await live.stop()

    // A reload: a client that only reads the log, nothing live.
    const reloaded = createTranscript()
    for await (const event of client.sessions.events.iterate(session.id)) {
      reloaded.apply(event)
    }

    // The reply is placed where it started — ahead of the steering message it was interleaved
    // with — so the order is the same in a tab that followed the stream and one that reloaded.
    const expectedOrder = [
      `user:${prompt}`,
      `agent:${expectedSlowReply()}`,
      `user:${steering}`,
      `agent:${steering}`,
    ]
    expect(conversationOf(live)).toEqual(expectedOrder)
    expect(
      selectMessages(reloaded.getState()).map((message) => `${message.role}:${message.text}`),
    ).toEqual(expectedOrder)
    // The whole state, not just the text: pending flags and positions included.
    expect(reloaded.getState().messages).toEqual(live.transcript.getState().messages)
  })
})
