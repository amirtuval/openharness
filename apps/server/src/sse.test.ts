import { afterEach, describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  isStoredEvent,
  newEventId,
  type Agent,
  type Session,
  type SessionId,
  type StoredEvent,
  type StreamEvent,
} from '@openharness/protocol'
import type { SessionStore } from '@openharness/session'

import { TEST_OWNER_ID } from './test-support'
import { SSE_HEADERS, createSessionEventStream } from './sse'
import {
  HELD_REPLY_TEST_TIMEOUT_MS,
  ObservableStore,
  defer,
  httpCreateAgent,
  httpCreateSession,
  httpSendMessage,
  openSse,
  readHistory,
  startTestServer,
  waitFor,
  waitForIdle,
  type SseMessage,
  type SseReader,
  type TestContext,
} from './test-support'

/**
 * `GET /v1/sessions/{id}/events/stream`, over a real socket.
 *
 * The stream is where the server's promises are hardest to keep — no gaps, no duplicates,
 * resume where the client left off, chunks only for the connections that asked — so these
 * tests drive it the way a client does: connect, read, disconnect, reconnect.
 *
 * Since D9 (issue #46) the chunks of a reply are stored events with a `seq`, so a reply in
 * flight is part of what the replay read returns and a resume mid-reply is a resume like any
 * other. What these tests pin down is exactly that, plus the one filter that remains the
 * connection's own business: `event_deltas[]=agent.message`.
 */

let context: TestContext | undefined

afterEach(async () => {
  await context?.close()
  context = undefined
})

/** Build a session with an agent, over HTTP. */
async function fixture(
  options: Parameters<typeof startTestServer>[0] = {},
): Promise<{ context: TestContext; agent: Agent; session: Session }> {
  const test = await startTestServer(options)
  context = test
  const agent = await httpCreateAgent(test)
  const session = await httpCreateSession(test, agent.id)
  return { context: test, agent, session }
}

/**
 * The path of a session's stream, with optional query parameters.
 *
 * The tests go through {@link TestContext.request}, which carries the caller's bearer token:
 * `/v1` is authenticated now (A2), the SSE route included.
 */
function streamPath(sessionId: SessionId, query = ''): string {
  return `${API_VERSION_PREFIX}/sessions/${sessionId}/events/stream${query}`
}

/** The path of a session's events list, with optional query parameters. */
function eventsPath(sessionId: SessionId, query = ''): string {
  return `${API_VERSION_PREFIX}/sessions/${sessionId}/events${query}`
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

/** The `seq`s of the stored events among `messages`, in order. */
function seqsOf(messages: readonly SseMessage[]): number[] {
  return messages.flatMap((message) => ('seq' in message.event ? [message.event.seq] : []))
}

/** The `seq`s of a log, in order. */
function seqsOfLog(events: readonly StoredEvent[]): number[] {
  return events.map((event) => event.seq)
}

/** What opts a connection into `agent.message` chunks; the tests append `after_seq` to it. */
const DELTAS = '?event_deltas[]=agent.message'

/**
 * Which chunk of a held reply the turn stops at.
 *
 * Three: enough for the connection before the reload to have read a couple of deltas, and
 * early enough that the reply has most of itself left to stream once the test lets it go.
 */
const HELD_AT = 3

/** Eight chunks a test can join back into the reply they spell. */
function slowChunks(count = 8): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `part ${String(index + 1)}/${String(count)} `,
  )
}

const REPLY = slowChunks().join('')

/** The `event_delta` messages of a read, in order. */
function deltasOf(messages: readonly SseMessage[]): SseMessage[] {
  return messages.filter((message) => message.event.type === EVENT_TYPES.eventDelta)
}

/** The text an `event_delta` message carries. */
function deltaText(message: SseMessage): string {
  return message.event.type === EVENT_TYPES.eventDelta ? message.event.delta.content.text : ''
}

/** The text every `event_delta` of a read carried, joined. */
function deltaTextOf(messages: readonly SseMessage[]): string {
  return deltasOf(messages).map(deltaText).join('')
}

/** The stored `agent.message` of a read, if it carried one. */
function messageOf(messages: readonly SseMessage[]): StreamEvent | undefined {
  return messages.find((message) => message.event.type === EVENT_TYPES.agentMessage)?.event
}

/** Whether a stored event is a reply chunk. */
function isChunk(event: StoredEvent): boolean {
  return event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta
}

describe('a live-only stream', () => {
  it('delivers what happens next, not the history', async () => {
    const test = await startTestServer({ replies: [{ text: ['first reply'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    await httpSendMessage(test, session.id, 'first')
    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)
    const lastSeq = history[history.length - 1]?.seq ?? 0

    // No `after_seq`: the client asked for what happens next, not for the log.
    const reader = openSse(await test.request(streamPath(session.id)))
    try {
      await httpSendMessage(test, session.id, 'second')
      const live = await readUntil(reader, (messages) =>
        messages.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      // Everything after where the history ended, in order and with nothing repeated.
      const after = await readHistory(test.store, session.id)
      expect(live[0]?.event.type).toBe(EVENT_TYPES.userMessage)
      expect(seqsOf(live)).toEqual(seqsOfLog(after.filter((event) => event.seq > lastSeq)))
    } finally {
      reader.close()
    }
  })
})

describe('the stream response', () => {
  it('is an event stream with the request id on it', async () => {
    const { context: test, session } = await fixture()

    const response = await test.request(streamPath(session.id))

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('request-id')).toMatch(/^req_/)
    await response.body?.cancel()
  })
})

describe('a replaying stream', () => {
  it('replays the log and then follows live, with no gaps and no duplicates', async () => {
    const test = await startTestServer({ replies: [{ text: ['one'] }, { text: ['two'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    await httpSendMessage(test, session.id, 'first')
    await waitForIdle(test.store, session.id)
    const replay = await readHistory(test.store, session.id)

    const reader = openSse(await test.request(streamPath(session.id, '?after_seq=0')))
    try {
      const replayed = await readUntil(reader, (messages) => messages.length >= replay.length)
      expect(seqsOf(replayed)).toEqual(seqsOfLog(replay))
      expect(replayed.map((message) => message.event.type)).toEqual(
        replay.map((event) => event.type),
      )
      // A stored event's SSE id is its `seq`: that is what a client sends back to resume.
      expect(replayed.map((message) => message.id)).toEqual(
        replay.map((event) => String(event.seq)),
      )

      // The live half: the same connection keeps delivering, continuing the log.
      const before = replay[replay.length - 1]?.seq ?? 0
      await httpSendMessage(test, session.id, 'second')
      const live = await readUntil(reader, (messages) =>
        messages.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      const after = await readHistory(test.store, session.id)
      expect(live[0]?.event.type).toBe(EVENT_TYPES.userMessage)
      expect(seqsOf(live)).toEqual(seqsOfLog(after.filter((event) => event.seq > before)))

      // Nothing was delivered twice, whichever half it came from.
      const whole = [...seqsOf(replayed), ...seqsOf(live)]
      expect(new Set(whole).size).toBe(whole.length)
    } finally {
      reader.close()
    }
  })

  it('resumes from last-event-id without re-sending what the client saw', async () => {
    const test = await startTestServer({ replies: [{ text: ['one'] }, { text: ['two'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    await httpSendMessage(test, session.id, 'first')
    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)
    const resumeAt = history[history.length - 1]?.seq ?? 0

    // A reconnect: the header carries the last `seq` this client saw.
    const reader = openSse(
      await test.request(streamPath(session.id), {
        headers: { 'last-event-id': String(resumeAt) },
      }),
    )
    try {
      await httpSendMessage(test, session.id, 'second')
      const live = await readUntil(reader, (messages) =>
        messages.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      expect(seqsOf(live)[0]).toBeGreaterThan(resumeAt)
      expect(seqsOf(live).every((seq) => seq > resumeAt)).toBe(true)
    } finally {
      reader.close()
    }
  })

  it('answers 404 for a session that does not exist', async () => {
    const test = await startTestServer()
    context = test

    const response = await test.request(streamPath('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ' as SessionId))

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })

  it('answers 400 for an event_deltas value the protocol does not know', async () => {
    const { context: test, session } = await fixture()

    const response = await test.request(streamPath(session.id, '?event_deltas[]=agent.thinking'))

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

describe('the chunks of a reply (D9)', () => {
  it('are stored events, sent only to the connections that asked for them', async () => {
    const test = await startTestServer({ replies: [{ text: ['Hel', 'lo you'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const reader = openSse(await test.request(streamPath(session.id, DELTAS)))
    try {
      await httpSendMessage(test, session.id, 'hello')
      const messages = await readUntil(reader, (read) =>
        read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      const start = messages.find((message) => message.event.type === EVENT_TYPES.eventStart)
      const deltas = deltasOf(messages)
      const stored = messageOf(messages)

      expect(start).toBeDefined()
      expect(stored?.type).toBe(EVENT_TYPES.agentMessage)
      expect(deltas).toHaveLength(2)
      // A chunk is a stored event: it carries its own `seq` and `id`, and the SSE `id:` field
      // is that `seq` — which is what makes a resume from mid-reply possible.
      const startEvent = start?.event
      expect(start?.id).not.toBeNull()
      expect(startEvent?.type).toBe(EVENT_TYPES.eventStart)
      expect(startEvent?.seq).toBeGreaterThan(0)
      const messageId = startEvent?.type === EVENT_TYPES.eventStart ? startEvent.event.id : ''
      expect(messageId).toMatch(/^sevt_/)
      expect(stored?.type === EVENT_TYPES.agentMessage && stored.id).toBe(messageId)
      expect(
        deltas.every(
          (delta) =>
            delta.event.type === EVENT_TYPES.eventDelta &&
            delta.event.event_id === messageId &&
            isStoredEvent(delta.event) &&
            delta.id === String(delta.event.seq),
        ),
      ).toBe(true)
      expect(deltas.map(deltaText).join('')).toBe('Hello you')
      // Every chunk is on the wire before the message that supersedes it.
      expect(seqsOf(messages)).toEqual(
        seqsOf(messages)
          .slice()
          .sort((left, right) => left - right),
      )
      expect(messageOf(messages)?.type === EVENT_TYPES.agentMessage).toBe(true)
    } finally {
      reader.close()
    }
  })

  it('never reach a connection that did not ask for them — live or replay', async () => {
    const test = await startTestServer({ replies: [{ text: ['a', 'b'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const reader = openSse(await test.request(streamPath(session.id, '?after_seq=0')))
    try {
      await httpSendMessage(test, session.id, 'hello')
      const messages = await readUntil(reader, (read) =>
        read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      expect(messages.some((message) => message.event.type === EVENT_TYPES.eventStart)).toBe(false)
      expect(messages.some((message) => message.event.type === EVENT_TYPES.eventDelta)).toBe(false)
      // The remainder is the replay read, chunk for chunk: the filter adds nothing and hides
      // nothing else.
      const log = await readHistory(test.store, session.id)
      expect(seqsOf(messages)).toEqual(seqsOfLog(log))
    } finally {
      reader.close()
    }
  })

  /**
   * The replacement for the preview snapshot (#27) under D9: the reply in flight is in the
   * log, so a connection that opens mid-reply reads it out of the replay — under the same id
   * the stored message will have, in the same order — instead of being handed a snapshot the
   * server kept beside the log.
   */
  it(
    'are replayed to a connection that opens mid-reply',
    async () => {
      const held = defer()
      const test = await startTestServer({
        replies: [
          {
            text: slowChunks(),
            onChunk: (_chunk, index) => (index === HELD_AT ? held.promise : undefined),
          },
        ],
      })
      context = test
      const agent = await httpCreateAgent(test)
      const session = await httpCreateSession(test, agent.id)

      // The turn as it looked before the reload: the first chunks of the reply, on the wire.
      const before = openSse(await test.request(streamPath(session.id, DELTAS)))
      const streamedBeforeReload = await (async () => {
        try {
          await httpSendMessage(test, session.id, 'tell me something long')
          const seen = await readUntil(before, (read) => deltasOf(read).length >= 2, 10_000)
          return deltaTextOf(seen)
        } finally {
          before.close()
        }
      })()
      expect(streamedBeforeReload.length).toBeGreaterThan(0)

      // The reload: a fresh connection, replaying the log from the start, still mid-reply.
      const after = openSse(await test.request(streamPath(session.id, `${DELTAS}&after_seq=0`)))
      try {
        const replayed = await readUntil(
          after,
          (read) => deltaTextOf(read).length >= streamedBeforeReload.length,
        )
        // The chunks the connection missed are in the replay, stored, in log order.
        const log = await readHistory(test.store, session.id)
        expect(seqsOf(replayed).every((seq) => log.some((event) => event.seq === seq))).toBe(true)

        const firstChunk = replayed.find((message) => message.event.type === EVENT_TYPES.eventStart)
        expect(firstChunk).toBeDefined()
        const messageId =
          firstChunk?.event.type === EVENT_TYPES.eventStart ? firstChunk.event.event.id : ''
        expect(deltaTextOf(replayed)).toBe(streamedBeforeReload)

        // Let the rest of the reply through, and follow it to the end of the turn on the same
        // connection.
        held.release()
        const messages = [
          ...replayed,
          ...(await readUntil(
            after,
            (read) => read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
            15_000,
          )),
        ]

        // The accumulated chunks are exactly the stored `agent.message` they were a preview
        // of — nothing missing, nothing applied twice.
        const stored = messageOf(messages)
        expect(stored?.type === EVENT_TYPES.agentMessage && stored.id).toBe(messageId)
        expect(deltaTextOf(messages)).toBe(REPLY)
        expect(stored?.type === EVENT_TYPES.agentMessage ? stored.content[0]?.text : '').toBe(REPLY)
      } finally {
        after.close()
      }
    },
    HELD_REPLY_TEST_TIMEOUT_MS,
  )

  it(
    'can be resumed from the middle, and the message alone is enough after compaction',
    async () => {
      const held = defer()
      const store = new ObservableStore()
      const test = await startTestServer({
        store,
        replies: [
          {
            text: slowChunks(),
            onChunk: (_chunk, index) => (index === HELD_AT ? held.promise : undefined),
          },
        ],
      })
      context = test
      const agent = await httpCreateAgent(test)
      const session = await httpCreateSession(test, agent.id)

      const before = openSse(await test.request(streamPath(session.id, DELTAS)))
      const resumeAt = await (async () => {
        try {
          await httpSendMessage(test, session.id, 'tell me something long')
          const seen = await readUntil(before, (read) => deltasOf(read).length >= 2, 10_000)
          return seqsOf(seen).at(-1) ?? 0
        } finally {
          before.close()
        }
      })()
      expect(resumeAt).toBeGreaterThan(0)

      // A resume while the reply is still in flight: the chunks the client has not seen, then
      // the stored message when the turn ends.
      const resumed = openSse(
        await test.request(streamPath(session.id, DELTAS), {
          headers: { 'last-event-id': String(resumeAt) },
        }),
      )
      try {
        const replayed = await readUntil(resumed, (read) =>
          read.some((message) => message.event.type === EVENT_TYPES.eventDelta),
        )
        expect(seqsOf(replayed).every((seq) => seq > resumeAt)).toBe(true)
        expect(replayed[0]?.event.type).toBe(EVENT_TYPES.eventDelta)

        held.release()
        const messages = [
          ...replayed,
          ...(await readUntil(
            resumed,
            (read) => read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
            15_000,
          )),
        ]
        // What the resumed connection missed is exactly the rest of the reply, and the stored
        // message is the whole of it.
        const accumulated = deltaTextOf(messages)
        expect(accumulated.length).toBeGreaterThan(0)
        expect(REPLY.endsWith(accumulated)).toBe(true)
        expect(messageOf(messages)?.type).toBe(EVENT_TYPES.agentMessage)
      } finally {
        resumed.close()
      }
      await waitForIdle(store, session.id)

      // Once the chunks have been compacted away, the same resume position is answered by the
      // message — which still lies after it, and is what a client needs to fold the reply in.
      const removed = await store.compact({ olderThan: Date.now() + 1000 })
      expect(removed).toBeGreaterThan(0)
      const raw = await readHistory(store, session.id, { includeSuperseded: true })
      expect(raw.some(isChunk)).toBe(false)

      const afterCompaction = openSse(
        await test.request(streamPath(session.id, DELTAS), {
          headers: { 'last-event-id': String(resumeAt) },
        }),
      )
      try {
        const replayed = await readUntil(afterCompaction, (read) =>
          read.some((message) => message.event.type === EVENT_TYPES.agentMessage),
        )
        expect(replayed.some((message) => message.event.type === EVENT_TYPES.eventDelta)).toBe(
          false,
        )
        const stored = messageOf(replayed)
        expect(stored?.type === EVENT_TYPES.agentMessage ? stored.content[0]?.text : '').toBe(REPLY)
      } finally {
        afterCompaction.close()
      }
    },
    HELD_REPLY_TEST_TIMEOUT_MS,
  )
})

describe('GET …/events while a reply is streaming', () => {
  /**
   * The clients load history with the list endpoint and then stream from its last `seq`, so a
   * client opening mid-reply must get the in-flight chunks **here** — if the list skipped them
   * (they are not superseded yet, and must not be), the stream that follows would start after
   * a reply the client never saw.
   */
  it(
    'returns the in-flight chunks, and the message alone once the turn is over',
    async () => {
      const held = defer()
      const store = new ObservableStore()
      const test = await startTestServer({
        store,
        replies: [
          {
            text: slowChunks(),
            onChunk: (_chunk, index) => (index === HELD_AT ? held.promise : undefined),
          },
        ],
      })
      context = test
      const agent = await httpCreateAgent(test)
      const session = await httpCreateSession(test, agent.id)

      await httpSendMessage(test, session.id, 'tell me something long')
      // Held three chunks in: the log holds the event_start and three deltas so far.
      await waitFor(async () => (await readHistory(store, session.id)).filter(isChunk).length > 0, {
        message: 'the chunks never reached the log',
      })

      const midReplyBody: unknown = await (await test.request(eventsPath(session.id))).json()
      const midReply = midReplyBody as { data: StoredEvent[] }
      const chunks = midReply.data.filter(isChunk)
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.map((chunk) => chunk.seq)).toEqual(
        seqsOfLog(chunks)
          .slice()
          .sort((left, right) => left - right),
      )
      expect(midReply.data.some((event) => event.type === EVENT_TYPES.agentMessage)).toBe(false)

      // The stream from the last chunk continues where the list ended.
      const start = openSse(
        await test.request(streamPath(session.id, DELTAS), {
          headers: {
            'last-event-id': String(chunks[chunks.length - 1]?.seq ?? 0),
          },
        }),
      )
      held.release()
      try {
        const rest = await readUntil(
          start,
          (read) => read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
          15_000,
        )
        const replayedAll = [...chunks, ...rest.map((message) => message.event)]
        const accumulated = replayedAll
          .flatMap((event) =>
            event.type === EVENT_TYPES.eventDelta ? [event.delta.content.text] : [],
          )
          .join('')
        expect(accumulated).toBe(REPLY)
      } finally {
        start.close()
      }
      await waitForIdle(store, session.id)

      // Once the turn is over, the same endpoint is the replay read: the message, no chunks.
      const endedBody: unknown = await (await test.request(eventsPath(session.id))).json()
      const ended = endedBody as { data: StoredEvent[] }
      expect(ended.data.some(isChunk)).toBe(false)
      // The message is what replaced the chunks, and it says so: the range is what a client
      // sorts the reply by, and what compaction later deletes.
      const reply = ended.data.find((event) => event.type === EVENT_TYPES.agentMessage)
      expect(reply?.type === EVENT_TYPES.agentMessage && reply.supersedes !== undefined).toBe(true)
    },
    HELD_REPLY_TEST_TIMEOUT_MS,
  )
})

describe('keepalive', () => {
  it('sends a ping comment when nothing is happening', async () => {
    const test = await startTestServer({ sseKeepaliveMs: 30 })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await test.request(streamPath(session.id))
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    try {
      const decoder = new TextDecoder()
      let text = ''
      const deadline = Date.now() + 2000
      while (!text.includes(': ping') && Date.now() < deadline) {
        const { done, value } = await reader!.read()
        if (done) {
          break
        }
        text += decoder.decode(value, { stream: true })
      }
      expect(text).toContain(': ping')
    } finally {
      await reader?.cancel()
    }
  })
})

describe('disconnecting', () => {
  it('ends the subscription in the store', async () => {
    const store = new ObservableStore()
    const test = await startTestServer({ store, replies: [{ text: ['hi'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const reader = openSse(await test.request(streamPath(session.id, '?after_seq=0')))
    await httpSendMessage(test, session.id, 'hello')
    await readUntil(reader, (messages) => messages.length > 0)
    await waitFor(() => store.subscriptions > 0)

    reader.close()

    await waitFor(() => store.unsubscribed > 0, {
      message: 'the store subscription was never released',
    })
  })
})

/**
 * The stream body over a store whose log is written by hand — what a unit test of the filter
 * needs, without a scheduler or a turn in the way.
 */
describe('the stream filter', () => {
  /** A log with a message and the chunks of a reply in flight, none of them superseded. */
  async function seed(): Promise<{ store: SessionStore; sessionId: SessionId }> {
    const store: SessionStore = new ObservableStore()
    const agent = await store.createAgent(
      { name: 'Agent', model: { id: 'test/model' } },
      TEST_OWNER_ID,
    )
    const session = await store.createSession(agent.id, {
      ownerId: TEST_OWNER_ID,
      initial_events: [
        { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'hello' }] },
      ],
    })
    const messageId = newEventId()
    await store.appendEvents(session.id, [
      { type: EVENT_TYPES.eventStart, event: { type: EVENT_TYPES.agentMessage, id: messageId } },
      {
        type: EVENT_TYPES.eventDelta,
        event_id: messageId,
        delta: { type: 'content_delta', index: 0, content: { type: 'text', text: 'live' } },
      },
    ])
    return { store, sessionId: session.id }
  }

  /**
   * Every message a replay from the start delivers, under the given opt-in.
   *
   * The stream stays open after the replay — it follows the session live — so the read ends on
   * a short gap rather than on the stream closing: what was delivered is what arrived before
   * the silence. A malformed frame ends the read too, as a missing message the assertions
   * below fail on.
   */
  async function replayWith(
    store: SessionStore,
    sessionId: SessionId,
    deltas: boolean,
    ownerId: string = TEST_OWNER_ID,
  ): Promise<SseMessage[]> {
    const reader = openSse(
      new Response(createSessionEventStream({ store, sessionId, ownerId, afterSeq: 0, deltas }), {
        headers: SSE_HEADERS,
      }),
    )
    const messages: SseMessage[] = []
    try {
      for (;;) {
        const message = await reader.next(150).catch(() => null)
        if (message === null) {
          return messages
        }
        messages.push(message)
      }
    } finally {
      reader.close()
    }
  }

  it('keeps the chunks of a reply in flight out of the replay unless it was asked for', async () => {
    const { store, sessionId } = await seed()

    // The opted-out connection reads the one stored event of the log, and nothing follows it:
    // the chunks are filtered out of the replay, exactly as they are out of the live half.
    const optedOut = await replayWith(store, sessionId, false)
    expect(optedOut.map((message) => message.event.type)).toEqual([EVENT_TYPES.userMessage])

    // The connection that asked for them gets them, stored, with the `seq`s of every other
    // event — the chunks of a reply in flight are the log.
    const optedIn = await replayWith(store, sessionId, true)
    expect(optedIn.map((message) => message.event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
    ])
    expect(optedIn.slice(1).every((message) => isStoredEvent(message.event))).toBe(true)
  })
})
