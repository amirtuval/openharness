import {
  EVENT_TYPES,
  StoredEventSchema,
  StreamEventSchema,
  isStoredEvent,
  newAgentId,
} from '@openharness/protocol'
import type { StoredEvent, StreamEvent } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { createClient } from '../client'
import { ApiError } from '../errors'
import { initialTranscriptState, reduceTranscriptAll, type TranscriptState } from '../transcript'
import { createMockFetch, sseLines, sseResponse } from '../test-support/mock-fetch'
import { createFakeClient, type FakeClient } from './index'

describe('the fake client', () => {
  it('implements the client interface', () => {
    const fake = createFakeClient()

    expect(typeof fake.sendMessage).toBe('function')
    expect(typeof fake.interrupt).toBe('function')
    expect(typeof fake.agents.create).toBe('function')
    expect(typeof fake.sessions.events.stream).toBe('function')
    expect(fake.session.type).toBe('session')
    expect(fake.agent.type).toBe('agent')
  })

  it('emits a realistic, schema-valid turn', async () => {
    const fake = createFakeClient()
    fake.respondWith('Hello from the fake!', { chunks: 3 })

    const { events } = await runTurn(fake)

    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])

    const stored = events.filter(isStoredEvent)
    expect(stored.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(stored[3]).toMatchObject({
      type: EVENT_TYPES.agentMessage,
      content: [{ type: 'text', text: 'Hello from the fake!' }],
    })
    expect(stored[4]).toMatchObject({ type: EVENT_TYPES.modelRequestEnd, is_error: null })

    for (const event of events) {
      const schema = isStoredEvent(event) ? StoredEventSchema : StreamEventSchema
      expect(schema.safeParse(event).success, JSON.stringify(event)).toBe(true)
    }
  })

  it('writes the user message before the turn it starts', async () => {
    const fake = createFakeClient()

    const { events } = await runTurn(fake)
    const streamed = events.find((event) => event.type === EVENT_TYPES.userMessage)

    expect(events[0]?.type).toBe(EVENT_TYPES.userMessage)
    expect(events[1]?.type).toBe(EVENT_TYPES.sessionStatusRunning)
    expect(streamed).toMatchObject({
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'hello fake' }],
    })
    // A live subscriber sees the message as it was written — queued, like the server's copy.
    expect(streamed && 'processed_at' in streamed ? streamed.processed_at : 'missing').toBeNull()
    // The log, read later, shows the brain has since reached it.
    const [logged] = fake.history()
    expect(logged?.type).toBe(EVENT_TYPES.userMessage)
    expect(logged?.type === EVENT_TYPES.userMessage ? logged.processed_at : null).not.toBeNull()
  })

  it('reconciles its preview with the stored message', async () => {
    const fake = createFakeClient()
    fake.respondWith('A reply in pieces', { chunks: 4 })

    const { events, transcript } = await runTurn(fake)

    expect(transcript.messages).toHaveLength(2)
    expect(transcript.messages[1]).toMatchObject({
      role: 'agent',
      text: 'A reply in pieces',
      streaming: false,
      pending: false,
    })
    expect(transcript.status).toBe('idle')
    expect(transcript.lastError).toBeNull()
    expect(events.filter((event) => !isStoredEvent(event)).map((event) => event.type)).toEqual([
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
      EVENT_TYPES.eventDelta,
    ])
  })

  it('fails once and then succeeds when the error is retryable', async () => {
    const fake = createFakeClient()
    fake.failWith({ retryStatus: 'retrying', message: 'The model is overloaded.' })
    fake.respondWith('Second time lucky.')

    const { events, transcript } = await runTurn(fake)

    expect(events.filter(isStoredEvent).map((event) => event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    // The failed span says why it ended; the retry answered.
    expect(events.find((event) => event.type === EVENT_TYPES.modelRequestEnd)).toMatchObject({
      is_error: true,
      error: { type: 'model_error' },
    })
    expect(transcript.messages.at(-1)?.text).toBe('Second time lucky.')
    // The error was superseded by the reply that followed the retry.
    expect(transcript.lastError).toBeNull()
  })

  it('ends the turn on a terminal error', async () => {
    const fake = createFakeClient()
    fake.failWith({ retryStatus: 'exhausted', type: 'model_rate_limited_error' })

    const { events, transcript } = await runTurn(fake)

    expect(events.filter(isStoredEvent).map((event) => event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(transcript.lastError).toMatchObject({
      type: 'model_rate_limited_error',
      retryStatus: 'exhausted',
    })
    expect(transcript.status).toBe('idle')
  })

  it('keeps the partial reply when it is interrupted mid-stream', async () => {
    const fake = createFakeClient({ delayMs: 1 })
    fake.respondWith('One two three four five six', { chunks: 6 })
    const controller = new AbortController()
    const events: StreamEvent[] = []
    let deltas = 0

    const iterating = (async () => {
      for await (const event of fake.sessions.events.stream(fake.session.id, {
        deltas: true,
        afterSeq: 0,
        signal: controller.signal,
      })) {
        events.push(event)
        if (event.type === EVENT_TYPES.eventDelta) {
          deltas += 1
          if (deltas === 2) {
            await fake.interrupt(fake.session.id)
          }
        }
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await fake.sendMessage(fake.session.id, 'type slowly')
    await iterating

    const drained = events.filter(isStoredEvent)
    const partial = events
      .filter((event) => event.type === EVENT_TYPES.eventDelta)
      .map((event) => (event.type === EVENT_TYPES.eventDelta ? event.delta.content.text : ''))
      .join('')
    const storedMessage = drained.find((event) => event.type === EVENT_TYPES.agentMessage)

    expect(deltas).toBeLessThan(6)
    expect(storedMessage).toMatchObject({ content: [{ type: 'text', text: partial }] })
    expect(drained.map((event) => event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    expect(drained.find((event) => event.type === EVENT_TYPES.modelRequestEnd)).toMatchObject({
      is_error: true,
      error: { type: 'interrupted' },
    })

    const transcript = reduceTranscriptAll(initialTranscriptState(), events)
    expect(transcript.messages.at(-1)?.text).toBe(partial)
    expect(transcript.messages.at(-1)?.streaming).toBe(false)
    expect(transcript.status).toBe('idle')
  })

  it('is unimpressed by an interrupt when nothing is running', async () => {
    const fake = createFakeClient()

    await fake.interrupt(fake.session.id)

    expect(fake.history().map((event) => event.type)).toEqual([EVENT_TYPES.userInterrupt])
    expect(fake.session.status).toBe('idle')
  })

  it('picks up a steering message inside the running turn, in order', async () => {
    const fake = createFakeClient({ delayMs: 1 })
    fake.respondWith('first reply', { chunks: 4 }).respondWith('second reply')

    const controller = new AbortController()
    const events: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of fake.sessions.events.stream(fake.session.id, {
        deltas: true,
        afterSeq: 0,
        signal: controller.signal,
      })) {
        events.push(event)
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await fake.sendMessage(fake.session.id, 'one')
    await fake.sendMessage(fake.session.id, 'two')
    await iterating
    const transcript = reduceTranscriptAll(initialTranscriptState(), events)

    // The reply's bubble was opened when its preview started — before the steering message
    // was sent — and it stays where it appeared when the stored event replaces the preview.
    expect(transcript.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:one',
      'agent:first reply',
      'user:two',
      'agent:second reply',
    ])
    // The queued message was folded into the second model request of the same turn.
    const userMessages = fake.history().filter((event) => event.type === EVENT_TYPES.userMessage)
    expect(userMessages[1]?.processed_at).not.toBeNull()
    expect(transcript.status).toBe('idle')
  })

  it('answers with a default reply when nothing is scripted', async () => {
    const fake = createFakeClient()

    const { transcript } = await runTurn(fake)

    expect(transcript.messages.at(-1)?.text).toBe('Fake reply: hello fake')
  })
})

describe('the fake stream', () => {
  it('holds previews back unless deltas were asked for', async () => {
    const fake = createFakeClient()
    fake.respondWith('no previews here')

    const controller = new AbortController()
    const events: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of fake.sessions.events.stream(fake.session.id, {
        signal: controller.signal,
      })) {
        events.push(event)
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await fake.sendMessage(fake.session.id, 'hi')
    await iterating

    expect(events.every(isStoredEvent)).toBe(true)
    expect(events.map((event) => event.type)).toContain(EVENT_TYPES.agentMessage)
  })

  it('replays the log after afterSeq, and nothing without it', async () => {
    const fake = createFakeClient()
    fake.respondWith('done')

    await runTurn(fake)
    const history = fake.history()
    const lastSeq = history.at(-1)?.seq ?? 0

    // `afterSeq: 0` replays the whole log; a later position replays only what follows it.
    expect(await collect(fake, { afterSeq: 0 })).toEqual(history)
    expect(await collect(fake, { afterSeq: lastSeq - 2 })).toEqual(history.slice(-2))
    // And nothing at all without one: a stream delivers what happens next, not the history.
    expect(await collect(fake, {})).toEqual([])
  })

  it('ends the iteration when the caller aborts', async () => {
    const fake = createFakeClient({ delayMs: 1 })
    fake.respondWith('slowly', { chunks: 20 })

    const controller = new AbortController()
    const events: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of fake.sessions.events.stream(fake.session.id, {
        deltas: true,
        signal: controller.signal,
      })) {
        events.push(event)
        if (event.type === EVENT_TYPES.eventStart) {
          controller.abort()
        }
      }
    })()
    await fake.sendMessage(fake.session.id, 'hi')
    await iterating

    expect(events.map((event) => event.type)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
    ])
  })
})

describe('the fake resources', () => {
  it('creates, reads, updates and lists agents', async () => {
    const fake = createFakeClient()

    const created = await fake.agents.create({
      name: 'Second',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    expect(created).toMatchObject({ name: 'Second', description: null, system: null })
    expect(await fake.agents.get(created.id)).toEqual(created)

    const updated = await fake.agents.update(created.id, { name: 'Renamed' })
    expect(updated.name).toBe('Renamed')
    expect((await fake.agents.get(created.id)).name).toBe('Renamed')

    const page = await fake.agents.list()
    expect(page.data.map((agent) => agent.name)).toEqual(['Summarizer', 'Renamed'])
    expect(page.next_page).toBeNull()
  })

  it('pages a list with an opaque cursor', async () => {
    const fake = createFakeClient()
    await fake.agents.create({ name: 'two', model: { id: 'anthropic/claude-sonnet-5' } })
    await fake.agents.create({ name: 'three', model: { id: 'anthropic/claude-sonnet-5' } })

    const first = await fake.agents.list({ limit: 2 })
    expect(first.data).toHaveLength(2)
    expect(first.next_page).not.toBeNull()

    const second = await fake.agents.list({ limit: 2, page: first.next_page ?? undefined })
    expect(second.data).toHaveLength(1)
    expect(second.next_page).toBeNull()
  })

  it('rejects an unknown agent or session the way the server does', async () => {
    const fake = createFakeClient()

    await expect(fake.agents.get('agent_01HZZZZZZZZZZZZZZZZZZZZZZZ')).rejects.toBeInstanceOf(
      ApiError,
    )
    await expect(fake.sessions.create({ agent: newAgentId() })).rejects.toMatchObject({
      status: 404,
      type: 'not_found_error',
    })
    await expect(fake.sessions.get('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ')).rejects.toMatchObject({
      status: 404,
    })
  })

  it('creates a session with initial events and starts its turn', async () => {
    const fake = createFakeClient()
    fake.respondWith('welcome')

    const session = await fake.sessions.create({
      agent: fake.agent.id,
      title: 'A new session',
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
    })
    await fake.waitForIdle(session.id)

    expect(session.title).toBe('A new session')
    expect(session.status).toBe('idle')
    expect(fake.history(session.id).map((event) => event.type)).toContain(EVENT_TYPES.agentMessage)

    const listed = await fake.sessions.list()
    expect(listed.data.map((candidate) => candidate.id)).toContain(session.id)
  })

  it('appends user events through the events resource', async () => {
    const fake = createFakeClient()
    fake.respondWith('answer')

    const response = await fake.sessions.events.send(fake.session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'through send' }],
    })

    expect(response.data).toHaveLength(1)
    expect(response.data[0]).toMatchObject({ seq: 1, processed_at: null })
    await fake.waitForIdle()
    expect(fake.session.status).toBe('idle')
  })

  it('walks the log page by page', async () => {
    const fake = createFakeClient()
    fake.respondWith('one').respondWith('two')
    await sendAndSettle(fake, 'first')
    await sendAndSettle(fake, 'second')

    const walked: StoredEvent[] = []
    for await (const event of fake.sessions.events.iterate(fake.session.id, { limit: 3 })) {
      walked.push(event)
    }

    expect(walked).toEqual(fake.history())
    expect(walked.length).toBeGreaterThan(3)
  })

  it('filters the log by after_seq and types', async () => {
    const fake = createFakeClient()
    fake.respondWith('reply')
    await sendAndSettle(fake, 'hello')

    const page = await fake.sessions.events.list(fake.session.id, {
      after_seq: 1,
      types: [EVENT_TYPES.agentMessage],
    })

    expect(page.data.map((event) => event.type)).toEqual([EVENT_TYPES.agentMessage])
  })
})

describe('the fake and the real client agree', () => {
  it('produce the same transcript for the same scripted scenario', async () => {
    const fake = createFakeClient({ now: () => new Date('2026-03-15T10:00:00.000Z') })
    fake.failWith({ retryStatus: 'retrying' })
    fake.respondWith('One more time.', { chunks: 3 })

    const { events, transcript } = await runTurn(fake)
    const replayed = await replayThroughClient(events, fake.session.id)

    expect(replayed).toEqual(transcript)
    expect(transcript.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:hello fake',
      'agent:One more time.',
    ])
    expect(transcript.lastSeq).toBe(fake.history().at(-1)?.seq)
  })

  it('agree after an interrupt as well', async () => {
    const fake = createFakeClient({ delayMs: 1 })
    fake.respondWith('One two three four five', { chunks: 5 })
    const controller = new AbortController()
    const events: StreamEvent[] = []
    let interrupted = false
    const iterating = (async () => {
      for await (const event of fake.sessions.events.stream(fake.session.id, {
        deltas: true,
        afterSeq: 0,
        signal: controller.signal,
      })) {
        events.push(event)
        if (event.type === EVENT_TYPES.eventDelta && !interrupted) {
          interrupted = true
          await fake.interrupt(fake.session.id)
        }
        if (event.type === EVENT_TYPES.sessionStatusIdle) {
          controller.abort()
        }
      }
    })()
    await fake.sendMessage(fake.session.id, 'go')
    await iterating

    const transcript = reduceTranscriptAll(initialTranscriptState(), events)

    expect(await replayThroughClient(events, fake.session.id)).toEqual(transcript)
    expect(transcript.messages.at(-1)?.streaming).toBe(false)
    expect(transcript.messages.at(-1)?.text).not.toBe('One two three four five')
  })
})

/**
 * Send `hello fake`, read the whole turn off the fake's stream with previews on, and return
 * both what was streamed and what the transcript makes of it.
 */
async function runTurn(
  fake: FakeClient,
  text = 'hello fake',
): Promise<{ events: StreamEvent[]; transcript: TranscriptState }> {
  const controller = new AbortController()
  const events: StreamEvent[] = []
  const iterating = (async () => {
    for await (const event of fake.sessions.events.stream(fake.session.id, {
      deltas: true,
      afterSeq: 0,
      signal: controller.signal,
    })) {
      events.push(event)
      if (event.type === EVENT_TYPES.sessionStatusIdle) {
        controller.abort()
      }
    }
  })()
  await fake.sendMessage(fake.session.id, text)
  await fake.waitForIdle(fake.session.id)
  await iterating
  return { events, transcript: reduceTranscriptAll(initialTranscriptState(), events) }
}

/** Read the fake's stream from `afterSeq` until it goes idle. */
/** Read the fake's stream from `afterSeq`, send `text` when given, and stop at idle. */
async function collect(
  fake: FakeClient,
  options: { afterSeq?: number; text?: string } = {},
): Promise<StreamEvent[]> {
  const controller = new AbortController()
  const events: StreamEvent[] = []
  const iterating = (async () => {
    for await (const event of fake.sessions.events.stream(fake.session.id, {
      afterSeq: options.afterSeq,
      signal: controller.signal,
    })) {
      events.push(event)
      if (event.type === EVENT_TYPES.sessionStatusIdle) {
        controller.abort()
      }
    }
  })()
  if (options.text !== undefined) {
    await fake.sendMessage(fake.session.id, options.text)
    await fake.waitForIdle(fake.session.id)
  } else {
    // Nothing to send: give the backlog a tick to arrive, then stop reading.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  controller.abort()
  await iterating
  return events
}

/** Append a user message and let the whole turn finish. */
async function sendAndSettle(fake: FakeClient, text: string): Promise<void> {
  await fake.sendMessage(fake.session.id, text)
  await fake.waitForIdle(fake.session.id)
}

/** The same events, replayed through the real client as an SSE stream. */
async function replayThroughClient(
  events: readonly StreamEvent[],
  sessionId: string,
): Promise<TranscriptState> {
  const mock = createMockFetch(() => sseResponse(sseLines(events)))
  const client = createClient({ baseUrl: 'https://api.test', fetch: mock.fetch })
  const controller = new AbortController()
  const collecting: StreamEvent[] = []
  const iterating = (async () => {
    for await (const event of client.sessions.events.stream(sessionId, {
      deltas: true,
      afterSeq: 0,
      signal: controller.signal,
    })) {
      collecting.push(event)
      if (event.type === EVENT_TYPES.sessionStatusIdle) {
        controller.abort()
      }
    }
  })()
  await iterating
  return reduceTranscriptAll(initialTranscriptState(), collecting)
}
