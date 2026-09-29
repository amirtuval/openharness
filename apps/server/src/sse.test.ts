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
  ObservableStore,
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

/** A store that runs a hook inside `getPreview`, so a delta lands while the snapshot is read. */
class GatedPreviewStore extends InMemorySessionStore {
  /** Run once, before the next `getPreview` answers. */
  gate: (() => Promise<void>) | undefined

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
   */
  it('gives a connection opened mid-reply the text that was already streamed', async () => {
    const chunks = Array.from({ length: 8 }, (_unused, index) => `part ${index + 1}/8 `)
    const test = await startTestServer({ replies: [{ text: chunks, delayMs: 120 }] })
    context = test
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    // The turn as it looked before the reload: the first deltas of the reply, on the wire.
    const before = openSse(await fetch(streamUrl(test, session.id, DELTAS)))
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
      const messages = await readUntil(
        after,
        (read) => read.some((message) => message.event.type === EVENT_TYPES.sessionStatusIdle),
        15_000,
      )

      // The replay comes first, then the snapshot: `event_start` for the id the preview is
      // under, and one delta carrying everything published for it so far.
      const firstPreview = messages.findIndex(
        (message) => message.event.type === EVENT_TYPES.eventStart,
      )
      expect(firstPreview).toBeGreaterThan(-1)
      expect(messages[firstPreview + 1]?.event.type).toBe(EVENT_TYPES.eventDelta)
      expect(messages.slice(0, firstPreview).every((message) => 'seq' in message.event)).toBe(true)

      const snapshot = messages[firstPreview + 1]
      expect(previewIdOf(messages)).toBe(previewId)
      // The snapshot is the whole reply so far: what the connection before the reload saw, and
      // whatever the model streamed between the disconnect and this read.
      expect(deltaText(snapshot!).startsWith(streamedBeforeReload.text)).toBe(true)

      // Then the stream carries on live, and the accumulated preview is exactly the stored
      // `agent.message` it is a preview of: no gap, and nothing applied twice.
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
  })

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
      // Long enough for the store to deliver it: it is in the buffer, not applied yet.
      await new Promise((resolve) => setTimeout(resolve, 20))
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
