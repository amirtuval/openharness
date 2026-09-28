import { afterEach, describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type Agent,
  type Session,
  type SessionId,
} from '@openharness/protocol'
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
