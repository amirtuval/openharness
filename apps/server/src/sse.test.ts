import { afterEach, describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  newEventId,
  type Agent,
  type EventId,
  type Session,
  type SessionId,
  type StreamOnlyEvent,
} from '@openharness/protocol'
import { InMemorySessionStore, type SessionPreview } from '@openharness/session'
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
 * resume where the client left off, previews only when asked — so these tests drive it the
 * way a client does: connect, read, disconnect, reconnect.
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

/** The URL of a session's stream, with optional query parameters. */
function streamUrl(test: TestContext, sessionId: SessionId, query = ''): string {
  return `${test.url}${API_VERSION_PREFIX}/sessions/${sessionId}/events/stream${query}`
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

/** What opts a connection into `agent.message` previews; the tests append `after_seq` to it. */
const DELTAS = '?event_deltas[]=agent.message'

/**
 * Which chunk of a held reply the turn stops at.
 *
 * Three: enough for the connection before the reload to have read a couple of deltas, and
 * early enough that the reply has most of itself left to stream once the test lets it go.
 */
const HELD_AT = 3

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

/** An `event_start` for a preview of `id`. */
function eventStart(id: EventId): StreamOnlyEvent {
  return { type: EVENT_TYPES.eventStart, event: { type: EVENT_TYPES.agentMessage, id } }
}

/** An `event_delta` carrying `text` for the preview of `id`. */
function eventDelta(id: EventId, text: string): StreamOnlyEvent {
  return {
    type: EVENT_TYPES.eventDelta,
    event_id: id,
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
  }
}

/** A store that runs a hook inside `getPreview`, so deltas land while the snapshot is read. */
class GatedPreviewStore extends InMemorySessionStore {
  /** Run once, before the next `getPreview` answers. */
  gate: (() => Promise<void>) | undefined

  /** How many events this store has handed to a listener; a gate can wait on one landing. */
  delivered = 0

  override async subscribe(
    sessionId: SessionId,
    listener: Parameters<InMemorySessionStore['subscribe']>[1],
  ): ReturnType<InMemorySessionStore['subscribe']> {
    return super.subscribe(sessionId, (event) => {
      this.delivered += 1
      return listener(event)
    })
  }

  override async getPreview(sessionId: SessionId): Promise<SessionPreview | null> {
    const gate = this.gate
    this.gate = undefined
    await gate?.()
    return super.getPreview(sessionId)
  }
}

/** A store whose preview is set by the test, whatever it has actually published. */
class ClaimingPreviewStore extends InMemorySessionStore {
  preview: SessionPreview | null = null

  override getPreview(): Promise<SessionPreview | null> {
    return Promise.resolve(this.preview)
  }
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

describe('a live-only stream', () => {
  it('delivers what happens next, not the history', async () => {
    const test = await startTestServer({ replies: [{ text: ['first reply'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    await httpSendMessage(test, session.id, 'first')
    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)

    // No `after_seq`: the client asked for what happens next, not for the log.
    const reader = openSse(await fetch(streamUrl(test, session.id)))
    try {
      await httpSendMessage(test, session.id, 'second')
      const live = await readUntil(reader, (messages) =>
        messages.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      expect(live[0]?.event.type).toBe(EVENT_TYPES.userMessage)
      expect(seqsOf(live)[0]).toBe(history.length + 1)
      expect(seqsOf(live)).toEqual(seqsOf(live).map((_seq, index) => history.length + 1 + index))
    } finally {
      reader.close()
    }
  })
})

describe('the stream response', () => {
  it('is an event stream with the request id on it', async () => {
    const { context: test, session } = await fixture()

    const response = await fetch(streamUrl(test, session.id))

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

    const reader = openSse(await fetch(streamUrl(test, session.id, '?after_seq=0')))
    try {
      const replayed = await readUntil(reader, (messages) => messages.length >= replay.length)
      expect(seqsOf(replayed)).toEqual(replay.map((event) => event.seq))
      expect(replayed.map((message) => message.event.type)).toEqual(
        replay.map((event) => event.type),
      )
      // A stored event's SSE id is its `seq`: that is what a client sends back to resume.
      expect(replayed.map((message) => message.id)).toEqual(
        replay.map((event) => String(event.seq)),
      )

      // The live half: the same connection keeps delivering, continuing the log.
      await httpSendMessage(test, session.id, 'second')
      const live = await readUntil(reader, (messages) =>
        messages.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      expect(live[0]?.event.type).toBe(EVENT_TYPES.userMessage)
      expect(seqsOf(live)[0]).toBe(replay.length + 1)

      const whole = [...seqsOf(replayed), ...seqsOf(live)]
      expect(whole).toEqual(whole.map((_seq, index) => index + 1))
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
      await fetch(streamUrl(test, session.id), { headers: { 'last-event-id': String(resumeAt) } }),
    )
    try {
      await httpSendMessage(test, session.id, 'second')
      const live = await readUntil(reader, (messages) =>
        messages.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      expect(seqsOf(live)[0]).toBe(resumeAt + 1)
      expect(seqsOf(live).every((seq) => seq > resumeAt)).toBe(true)
    } finally {
      reader.close()
    }
  })

  it('answers 404 for a session that does not exist', async () => {
    const test = await startTestServer()
    context = test

    const response = await fetch(streamUrl(test, 'sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ' as SessionId))

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })

  it('answers 400 for an event_deltas value the protocol does not know', async () => {
    const { context: test, session } = await fixture()

    const response = await fetch(streamUrl(test, session.id, '?event_deltas[]=agent.thinking'))

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
    expect(response.headers.get('content-type')).toContain('application/json')
  })
})

describe('previews', () => {
  it('are not sent unless the connection asked for them', async () => {
    const test = await startTestServer({ replies: [{ text: ['a', 'b'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const reader = openSse(await fetch(streamUrl(test, session.id)))
    try {
      await httpSendMessage(test, session.id, 'hello')
      const messages = await readUntil(reader, (read) =>
        read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      expect(messages.some((message) => message.event.type === EVENT_TYPES.eventStart)).toBe(false)
      expect(messages.some((message) => message.event.type === EVENT_TYPES.eventDelta)).toBe(false)
    } finally {
      reader.close()
    }
  })

  it('arrive under the same id as the stored message when requested', async () => {
    const test = await startTestServer({ replies: [{ text: ['Hel', 'lo you'] }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const reader = openSse(
      await fetch(streamUrl(test, session.id, '?event_deltas[]=agent.message')),
    )
    try {
      await httpSendMessage(test, session.id, 'hello')
      const messages = await readUntil(reader, (read) =>
        read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
      )

      const start = messages.find((message) => message.event.type === EVENT_TYPES.eventStart)
      const deltas = messages.filter((message) => message.event.type === EVENT_TYPES.eventDelta)
      const stored = messages.find((message) => message.event.type === EVENT_TYPES.agentMessage)

      expect(start).toBeDefined()
      expect(stored).toBeDefined()
      expect(deltas).toHaveLength(2)
      // A preview carries no `seq` of its own — `event_start` announces the stored event's id.
      expect(start?.id).toBeNull()
      const previewId = start?.event.type === EVENT_TYPES.eventStart ? start.event.event.id : ''
      expect(previewId).toMatch(/^sevt_/)
      expect(stored?.event.type === EVENT_TYPES.agentMessage && stored.event.id).toBe(previewId)
      expect(
        deltas.every(
          (delta) =>
            delta.event.type === EVENT_TYPES.eventDelta && delta.event.event_id === previewId,
        ),
      ).toBe(true)
    } finally {
      reader.close()
    }
  })
})

describe('a preview snapshot', () => {
  /**
   * The reproduction of #27: a reply is streaming, the page reloads, and the connection that
   * comes back has to show the beginning of it — not the first delta it happens to catch.
   *
   * The reply is held where the test wants it — three chunks in, by {@link defer} — rather
   * than paced by a clock: the turn cannot finish before the reload opens, and cannot stream
   * another character while the snapshot is being read, so the frames are the test's to
   * predict instead of a race to win.
   */
  it(
    'gives a connection opened mid-reply the text that was already streamed',
    async () => {
      const chunks = Array.from({ length: 8 }, (_unused, index) => `part ${index + 1}/8 `)
      const store = new ObservableStore()
      const held = defer()
      const test = await startTestServer({
        store,
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

      // The turn as it looked before the reload: the first deltas of the reply, on the wire.
      // The connection follows the session *before* the reply starts — a preview is delivered
      // only to the connections attached when it is published — so what it reads is the whole
      // beginning of the reply and not whichever delta it happened to catch.
      const before = openSse(await fetch(streamUrl(test, session.id, DELTAS)))
      await waitFor(() => store.subscriptions >= 1, {
        message: 'the connection never subscribed to the session',
      })
      let streamedBeforeReload: { previewId: string; text: string }
      try {
        await httpSendMessage(test, session.id, 'tell me something long')
        streamedBeforeReload = await readPreview(before)
      } finally {
        before.close()
      }
      const { previewId } = streamedBeforeReload
      expect(previewId).toMatch(/^sevt_/)
      expect(streamedBeforeReload.text.length).toBeGreaterThan(0)

      // The reload: a fresh connection, replaying the log from the start, still mid-reply.
      const after = openSse(await fetch(streamUrl(test, session.id, `${DELTAS}&after_seq=0`)))
      try {
        // Up to the snapshot, and no further: the turn is held, so the replay and the preview
        // are all this read can be. A delta arriving at all is the condition.
        const replayed = await readUntil(after, (read) =>
          read.some((message) => message.event.type === EVENT_TYPES.eventDelta),
        )

        // The replay comes first, then the snapshot: `event_start` for the id the preview is
        // under, and one delta carrying everything published for it so far.
        const firstPreview = replayed.findIndex(
          (message) => message.event.type === EVENT_TYPES.eventStart,
        )
        expect(firstPreview).toBeGreaterThan(-1)
        expect(replayed[firstPreview + 1]?.event.type).toBe(EVENT_TYPES.eventDelta)
        expect(replayed.slice(0, firstPreview).every((message) => 'seq' in message.event)).toBe(
          true,
        )

        // The snapshot is the whole reply so far: what the connection before the reload saw —
        // and, because the turn is held, nothing it could not have seen.
        const snapshot = replayed[firstPreview + 1]
        expect(previewIdOf(replayed)).toBe(previewId)
        expect(deltaText(snapshot!).startsWith(streamedBeforeReload.text)).toBe(true)
        expect(chunks.join('').startsWith(deltaText(snapshot!))).toBe(true)

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

        // Then the accumulated preview is exactly the stored `agent.message` it is a preview
        // of: no gap, and nothing applied twice.
        const stored = messages.find((message) => message.event.type === EVENT_TYPES.agentMessage)
        expect(previewIdOf(messages)).toBe(
          stored?.event.type === EVENT_TYPES.agentMessage ? stored.event.id : '',
        )
        const accumulated = deltasOf(messages)
          .map((message) => deltaText(message))
          .join('')
        expect(accumulated).toBe(chunks.join(''))
        expect(
          stored?.event.type === EVENT_TYPES.agentMessage ? stored.event.content[0]?.text : '',
        ).toBe(chunks.join(''))
      } finally {
        after.close()
      }
    },
    HELD_REPLY_TEST_TIMEOUT_MS,
  )

  /**
   * The race the snapshot has to lose gracefully: the model streams a delta *while* the store
   * is being asked for the preview, so the delta is already in the snapshot and is also in the
   * buffer, waiting to be written out live.
   */
  it('does not deliver twice a delta that landed while the snapshot was being read', async () => {
    const store = new GatedPreviewStore()
    const agent = await store.createAgent({
      name: 'Agent',
      model: { id: 'openharness-test/test-model' },
    })
    const session = await store.createSession(agent.id)
    const previewId = newEventId()
    await store.publishEphemeral(session.id, eventStart(previewId))
    await store.publishEphemeral(session.id, eventDelta(previewId, 'Hel'))
    store.gate = async () => {
      await store.publishEphemeral(session.id, eventDelta(previewId, 'lo'))
      // Until the store has handed it to the connection: the buffer, at the moment the
      // snapshot's text is read, is what this test is about.
      await waitFor(() => store.delivered >= 1, { message: 'the delta never reached the stream' })
    }

    const reader = openSse(
      new Response(
        createSessionEventStream({ store, sessionId: session.id, afterSeq: 0, deltas: true }),
        { headers: SSE_HEADERS },
      ),
    )
    try {
      const messages = [await reader.next(), await reader.next()]
      expect(messages.map((message) => message?.event.type)).toEqual([
        EVENT_TYPES.eventStart,
        EVENT_TYPES.eventDelta,
      ])
      // The snapshot holds the text as it was when it was read — including the delta that
      // arrived during the read — and that delta is not written out a second time.
      expect(deltaText(messages[1]!)).toBe('Hello')

      // The end of the preview, as the brain writes it: the same id, the authoritative text.
      await store.appendEvents(session.id, [
        {
          id: previewId,
          type: EVENT_TYPES.agentMessage,
          content: [{ type: 'text', text: 'Hello' }],
        },
      ])
      const stored = await reader.next()
      expect(stored?.event.type).toBe(EVENT_TYPES.agentMessage)
      expect(messages.map((message) => message?.event.type)).toEqual([
        EVENT_TYPES.eventStart,
        EVENT_TYPES.eventDelta,
      ])
    } finally {
      reader.close()
    }
  })

  /**
   * The same race with more than one delta in it, which is the common shape of it: a
   * connection that opened before the reply did — a page whose turn was already running —
   * buffers every delta published, and a snapshot read a round trip later covers all of them.
   * Comparing the buffer from its start finds only the *last* one covered, so the earlier ones
   * are written out a second time and the reply doubles in the middle of the stream. The whole
   * covered run goes, and the delta published after the snapshot goes out live.
   */
  it('drops every buffered delta the snapshot covered, not just the last one', async () => {
    const store = new GatedPreviewStore()
    const agent = await store.createAgent({
      name: 'Agent',
      model: { id: 'openharness-test/test-model' },
    })
    const session = await store.createSession(agent.id)
    const previewId = newEventId()
    // Published before the connection subscribes: in the snapshot's text, in no buffer.
    await store.publishEphemeral(session.id, eventStart(previewId))
    await store.publishEphemeral(session.id, eventDelta(previewId, 'one '))
    store.gate = async () => {
      // Published while the snapshot is read: in the snapshot's text *and* in the buffer.
      await store.publishEphemeral(session.id, eventDelta(previewId, 'two '))
      await store.publishEphemeral(session.id, eventDelta(previewId, 'three'))
      // Two: the `event_start` and the first delta went out before the connection existed.
      await waitFor(() => store.delivered >= 2, { message: 'the deltas never reached the stream' })
    }

    const reader = openSse(
      new Response(
        createSessionEventStream({ store, sessionId: session.id, afterSeq: 0, deltas: true }),
        { headers: SSE_HEADERS },
      ),
    )
    try {
      const snapshot = [await reader.next(), await reader.next()]
      expect(snapshot.map((message) => message?.event.type)).toEqual([
        EVENT_TYPES.eventStart,
        EVENT_TYPES.eventDelta,
      ])
      expect(deltaText(snapshot[1]!)).toBe('one two three')

      // What comes next is the reply moving on — not the deltas the snapshot already carried.
      await store.publishEphemeral(session.id, eventDelta(previewId, ' four'))
      await store.publishEphemeral(session.id, eventDelta(previewId, ' five'))
      const live = [await reader.next(), await reader.next()]
      expect(live.map((message) => deltaText(message!))).toEqual([' four', ' five'])
    } finally {
      reader.close()
    }
  })

  /**
   * The window between the brain's `event_start` and its first delta, which lasts one store
   * round trip. A connection that snapshots inside it holds a preview with no text, and the
   * accumulated delta for that preview has nothing to carry. Sending it anyway puts
   * `text: ''` on the wire, which is not a block the protocol accepts — an `event_delta`
   * whose `text` is empty is a frame a validating client stops at, taking the rest of the
   * stream down with it. The id is still announced: it is what the live deltas hang off.
   */
  it('announces a preview with no text yet, and no delta for it', async () => {
    const store = new InMemorySessionStore()
    const agent = await store.createAgent({
      name: 'Agent',
      model: { id: 'openharness-test/test-model' },
    })
    const session = await store.createSession(agent.id)
    const previewId = newEventId()
    // As the brain leaves it: the preview is in flight, and not a character is published.
    await store.publishEphemeral(session.id, eventStart(previewId))

    const reader = openSse(
      new Response(
        createSessionEventStream({ store, sessionId: session.id, afterSeq: 0, deltas: true }),
        { headers: SSE_HEADERS },
      ),
    )
    try {
      // The announcement, under the id the brain gave the preview, and nothing claiming
      // text behind it.
      const announced = [await reader.next()].filter(
        (message): message is SseMessage => message !== null,
      )
      expect(announced[0]?.event.type).toBe(EVENT_TYPES.eventStart)
      expect(previewIdOf(announced)).toBe(previewId)

      // The text arrives with the deltas that follow, under the same id, counted once.
      await store.publishEphemeral(session.id, eventDelta(previewId, 'Hel'))
      await store.publishEphemeral(session.id, eventDelta(previewId, 'lo'))
      const deltas = [await reader.next(), await reader.next()]
      expect(deltas.map((message) => message?.event.type)).toEqual([
        EVENT_TYPES.eventDelta,
        EVENT_TYPES.eventDelta,
      ])
      expect(deltas.map((message) => deltaText(message!)).join('')).toBe('Hello')
    } finally {
      reader.close()
    }
  })

  it('is not sent for a preview the replay already delivered as a stored event', async () => {
    const store = new ClaimingPreviewStore()
    const agent = await store.createAgent({
      name: 'Agent',
      model: { id: 'openharness-test/test-model' },
    })
    const session = await store.createSession(agent.id)
    const [message] = await store.appendEvents(session.id, [
      { type: EVENT_TYPES.agentMessage, content: [{ type: 'text', text: 'already stored' }] },
    ])
    // A preview of an event that is in the log is not something a real store can hold — the
    // append clears it — but a stream must not hand it out even if one somehow did.
    store.preview = { eventId: message?.id ?? newEventId(), text: 'already stored' }

    const reader = openSse(
      new Response(
        createSessionEventStream({ store, sessionId: session.id, afterSeq: 0, deltas: true }),
        { headers: SSE_HEADERS },
      ),
    )
    try {
      const replayed = await reader.next()
      expect(replayed?.event.type).toBe(EVENT_TYPES.agentMessage)
      expect(await reader.next(100).catch(() => null)).toBeNull()
    } finally {
      reader.close()
    }
  })
})

describe('keepalive', () => {
  it('sends a ping comment when nothing is happening', async () => {
    const test = await startTestServer({ sseKeepaliveMs: 30 })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await fetch(streamUrl(test, session.id))
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

    const reader = openSse(await fetch(streamUrl(test, session.id, '?after_seq=0')))
    await httpSendMessage(test, session.id, 'hello')
    await readUntil(reader, (messages) => messages.length > 0)
    await waitFor(() => store.subscriptions > 0)

    reader.close()

    await waitFor(() => store.unsubscribed > 0, {
      message: 'the store subscription was never released',
    })
  })
})
