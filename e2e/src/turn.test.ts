import {
  createTranscript,
  selectIsRunning,
  selectMessages,
  selectStreamingMessage,
  type Client,
} from '@openharness/client'
import {
  EVENT_TYPES,
  newEventId,
  type ModelRequestEndEvent,
  type Session,
} from '@openharness/protocol'
import {
  MOCK_ECHO_CHUNKS,
  MOCK_MODEL_USAGE,
  MOCK_SLOW_MARKER,
  MOCK_SLOW_TOTAL_MS,
} from '@openharness/server'
import { describe, expect, it } from 'vitest'

import {
  agentMessages,
  collectStream,
  deltaText,
  e2eHarness,
  expectedSlowReply,
  isPreviewDelta,
  isStoredIdle,
  previewedEventId,
  readLog,
  textOf,
  typesOf,
  userMessages,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * A turn, from the outside: what the client sees while it is running, what the log says once
 * it is over, and the two things a user can do to a turn in flight — steer it, and interrupt
 * it.
 *
 * Everything here runs against a real server process, a real Postgres and the built packages;
 * the model is the server's deterministic mock, so the assertions can be exact.
 */

const harness = e2eHarness('turn')

/** An agent and a session, the pair every test here drives. */
async function newSession(client: Client): Promise<Session> {
  const agent = await client.agents.create({
    name: 'Echo agent',
    model: { id: 'anthropic/claude-sonnet-5' },
  })
  return await client.sessions.create({ agent: agent.id })
}

describe('a full turn', () => {
  it('streams previews under the id of the reply they announce', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = 'hello from the end-to-end suite'

    // The boot log is the only place that says the schema came from the migrations this
    // process applied, rather than from a database somebody set up by hand.
    expect(server.output()).toMatch(/applied \d+ migration file\(s\)/)

    const transcript = createTranscript()
    const stream = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)

    // A preview is visible while the reply is still being written.
    await stream.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')
    const previewed = previewedEventId(stream.events)
    expect(previewed).toMatch(/^sevt_/)
    const whileStreaming = [...stream.events]
    for (const event of whileStreaming) {
      transcript.apply(event)
    }
    const streaming = selectStreamingMessage(transcript.getState())
    expect(streaming?.id).toBe(previewed)
    expect(streaming?.text).toBe(deltaText(whileStreaming, previewed ?? ''))
    expect(streaming?.text.length).toBeGreaterThan(0)

    // The reply that ends up in the log carries the same id, so a UI can replace the preview
    // with the stored event in place.
    await stream.waitFor((events) => events.some(isStoredIdle), 'the turn to end')
    await stream.stop()
    const log = await readLog(client, session.id)
    const reply = agentMessages(log)[0]
    expect(reply?.id).toBe(previewed)
    expect(textOf(reply!)).toBe(prompt)

    // Previews may be shed — what arrived is a prefix of what was stored, never a rewrite.
    expect(prompt.startsWith(deltaText(whileStreaming, previewed ?? ''))).toBe(true)

    // The client's transcript reducer, driven by the same events, ends up with the chat.
    for (const event of stream.events) {
      transcript.apply(event)
    }
    expect(
      selectMessages(transcript.getState()).map((message) => [message.role, message.text]),
    ).toEqual([
      ['user', prompt],
      ['agent', prompt],
    ])
    expect(selectStreamingMessage(transcript.getState())).toBeNull()
    expect(selectIsRunning(transcript.getState())).toBe(false)
    expect(selectMessages(transcript.getState())[0]?.pending).toBe(false)
  })

  it('writes the log in the documented order, with usage and no gaps', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = 'another turn, please'

    const sent = await client.sendMessage(session.id, prompt)
    await waitForTurnEnd(client, session.id, { afterSeq: sent.seq })

    // The replay read (`events.iterate`) is what a client folds: the reply's stored chunks are
    // superseded by its message and are not in it — which is why the seqs have a gap where the
    // chunks were (the log positions are never reused; see D9, issue #46).
    const log = await readLog(client, session.id)
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    // seq 4 is the reply's `event_start`, 5.. its deltas; the message supersedes them all.
    const messageSeq = 3 + MOCK_ECHO_CHUNKS + 2
    expect(log.map((event) => event.seq)).toEqual([
      1,
      2,
      3,
      messageSeq,
      messageSeq + 1,
      messageSeq + 2,
    ])
    expect(log.every((event) => event.processed_at !== null)).toBe(true)

    const reply = log.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(reply).toMatchObject({
      supersedes: { from_seq: 4, to_seq: 3 + MOCK_ECHO_CHUNKS + 1 },
    })

    const spanEnd = log.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.model_usage).toEqual(MOCK_MODEL_USAGE)
    expect(spanEnd?.is_error).toBeNull()

    const [user] = userMessages(log)
    expect(user?.processed_at).not.toBeNull()
    expect(textOf(user!)).toBe(prompt)
    expect((await client.sessions.get(session.id)).status).toBe('idle')
  })

  it('answers a steering message in a second request', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} take your time`
    const steering = 'actually, keep it short'

    const stream = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)
    await stream.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')

    // The turn is mid-stream; this message is not part of the request in flight.
    await client.sendMessage(session.id, steering)
    await stream.waitFor((events) => events.some(isStoredIdle), 'the turn to end', {
      timeoutMs: MOCK_SLOW_TOTAL_MS * 2,
    })
    await stream.stop()

    const log = await readLog(client, session.id)
    // Two requests: the one that was streaming, and the one that answers the steering message.
    expect(log.filter((event) => event.type === EVENT_TYPES.modelRequestStart)).toHaveLength(2)
    expect(log.filter((event) => event.type === EVENT_TYPES.sessionStatusRunning)).toHaveLength(1)
    expect(log.filter((event) => event.type === EVENT_TYPES.sessionStatusIdle)).toHaveLength(1)
    expect(agentMessages(log).map(textOf)).toEqual([expectedSlowReply(), steering])
    expect(userMessages(log).every((message) => message.processed_at !== null)).toBe(true)
  })

  it('keeps the partial reply and claims the interrupt on the span end it stopped', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const prompt = `${MOCK_SLOW_MARKER} interrupt this one`

    const stream = collectStream(client, session.id, { deltas: true, afterSeq: 0 })
    await client.sendMessage(session.id, prompt)
    await stream.waitFor((events) => events.some(isPreviewDelta), 'the first preview delta')
    const announced = previewedEventId(stream.events)

    await client.interrupt(session.id)
    await stream.waitFor((events) => events.some(isStoredIdle), 'the interrupted turn to end')
    await stream.stop()

    const log = await readLog(client, session.id)
    // One span only: the model request the interrupt cut short. Since P4 an interrupt is
    // claimed by the request's span end, not by a span of its own — no span exists without a
    // model call behind it.
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])

    const spanEnd = log.find(
      (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
    )
    expect(spanEnd?.error?.type).toBe('interrupted')
    expect(spanEnd?.is_error).toBe(true)
    // The interrupt is claimed by the span end that stopped its request, so nothing is queued.
    expect(spanEnd?.consumes).toEqual([log[3]?.id])

    // The reply that was cut short is kept, under the id its chunks announced, and it is a
    // strict prefix of what the model was streaming: proof the interrupt landed mid-flight.
    const reply = agentMessages(log)[0]
    expect(reply?.id).toBe(announced)
    // The partial message supersedes the chunks it was streamed as, so replay showed it once.
    expect(reply?.supersedes).toBeDefined()
    const partial = textOf(reply!)
    expect(partial.length).toBeGreaterThan(0)
    expect(expectedSlowReply().startsWith(partial)).toBe(true)
    expect(partial).not.toBe(expectedSlowReply())

    expect(userMessages(log).every((message) => message.processed_at !== null)).toBe(true)
    expect(userMessages(log)).toHaveLength(1)
  })

  it('claims an interrupt that arrives with nothing running on the status idle', async () => {
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)

    // Nothing was running; the server still starts a turn for the queued interrupt, and the
    // `session.status_idle` that ends it claims the interrupt — no model request is opened
    // for an interrupt (P4).
    const interrupt = await client.interrupt(session.id)
    await waitForTurnEnd(client, session.id, { afterSeq: interrupt.seq })

    const log = await readLog(client, session.id)
    expect(typesOf(log)).toEqual([
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const idle = log.at(-1)
    expect(idle?.type === EVENT_TYPES.sessionStatusIdle ? idle.consumes : undefined).toEqual([
      interrupt.id,
    ])
    expect(agentMessages(log)).toHaveLength(0)
    // The claim is the fact: the interrupt reads processed, and nothing is left queued.
    expect(log[0]?.processed_at).not.toBeNull()
    await expect(
      client.sessions.events.list(session.id).then((page) => page.data),
    ).resolves.toEqual(log)
  })

  it('reads a log stored before D9 correctly: no consumes, no supersedes, no chunks', async () => {
    // Existing databases hold turns a pre-D9 writer stored, and they must keep reading right:
    // a span start with no `consumes` means everything queued was picked up, and a reply with
    // no `supersedes` has no chunk range to sort at. The only way to have such a log is to
    // write one, so this test inserts the rows the old store would have.
    const server = await harness.server()
    const client = harness.client(server)
    const session = await newSession(client)
    const database = await harness.database()

    const ids = {
      running: newEventId(),
      prompt: newEventId(),
      start: newEventId(),
      reply: newEventId(),
      end: newEventId(),
      idle: newEventId(),
    }
    const createdAt = new Date().toISOString()

    /**
     * One `events` row as the pre-D9 append wrote it: the envelope, the payload with its own
     * `type` (the column duplicates it), and none of the D9 fields.
     */
    const insert = async (
      db: Parameters<Parameters<typeof withDatabaseClient>[0]>[0],
      row: {
        id: string
        seq: number
        type: string
        payload: unknown
        processedAt: string | null
      },
    ): Promise<void> => {
      await db.query(
        'insert into events (id, session_id, seq, type, payload, created_at, processed_at) values ($1, $2, $3, $4, $5, $6, $7)',
        [
          row.id,
          session.id,
          row.seq,
          row.type,
          { type: row.type, ...(row.payload as object) },
          createdAt,
          row.processedAt,
        ],
      )
    }

    await withDatabaseClient(
      async (db) => {
        await insert(db, {
          id: ids.running,
          seq: 1,
          type: EVENT_TYPES.sessionStatusRunning,
          payload: {},
          processedAt: createdAt,
        })
        // The old store wrote the claim into the event's own `processed_at` column (which
        // `0008_event_claims_backfill.sql` later copied into a claim row, as below).
        await insert(db, {
          id: ids.prompt,
          seq: 2,
          type: EVENT_TYPES.userMessage,
          payload: { content: [{ type: 'text', text: 'an old prompt' }] },
          processedAt: createdAt,
        })
        await db.query(
          'insert into event_claims (session_id, event_id, claimed_by_event_id, claimed_at) values ($1, $2, null, $3)',
          [session.id, ids.prompt, createdAt],
        )
        // No `consumes`, no `model`: the pre-D9 span start.
        await insert(db, {
          id: ids.start,
          seq: 3,
          type: EVENT_TYPES.modelRequestStart,
          payload: {},
          processedAt: createdAt,
        })
        // No `supersedes`: the pre-D9 reply, whose chunks were never stored.
        await insert(db, {
          id: ids.reply,
          seq: 4,
          type: EVENT_TYPES.agentMessage,
          payload: { content: [{ type: 'text', text: 'an old reply' }] },
          processedAt: createdAt,
        })
        await insert(db, {
          id: ids.end,
          seq: 5,
          type: EVENT_TYPES.modelRequestEnd,
          payload: {
            model_request_start_id: ids.start,
            model_usage: {
              input_tokens: 3,
              output_tokens: 2,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
            is_error: null,
          },
          processedAt: createdAt,
        })
        await insert(db, {
          id: ids.idle,
          seq: 6,
          type: EVENT_TYPES.sessionStatusIdle,
          payload: { stop_reason: { type: 'end_turn' } },
          processedAt: createdAt,
        })
      },
      { database: database.name },
    )

    // The log reads back through the API, and the transcript is the conversation it stored.
    const stored = (await client.sessions.events.list(session.id)).data
    expect(typesOf(stored)).toEqual([
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.userMessage,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(stored[1]?.processed_at).not.toBeNull()

    const transcript = createTranscript()
    for await (const event of client.sessions.events.iterate(session.id)) {
      transcript.apply(event)
    }
    expect(
      selectMessages(transcript.getState()).map((message) => `${message.role}:${message.text}`),
    ).toEqual(['user:an old prompt', 'agent:an old reply'])
    // The pre-D9 reading cleared the pending flag at the span start, and the reply with no
    // range sorts at its own `seq`.
    expect(selectMessages(transcript.getState())[0]?.pending).toBe(false)
    expect(selectMessages(transcript.getState())[1]?.position).toBe(4)
    expect(transcript.getState().status).toBe('idle')
  })
})
