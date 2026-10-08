import {
  CreateAgentRequestSchema,
  EVENT_TYPES,
  SESSION_TITLE_MAX_LENGTH,
  SendEventsRequestSchema,
  StoredEventSchema,
  StreamEventSchema,
  UpdateAgentRequestSchema,
  UserMessageEventInputSchema,
  isStoredEvent,
  newAgentId,
} from '@openharness/protocol'
import type { StoredEvent, StreamEvent, UserEventInput } from '@openharness/protocol'
import {
  fixtureTimestamp,
  makeModelEntry,
  makeUserPreferences,
} from '@openharness/protocol/fixtures'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient, type SendMessageOptions } from '../client'
import { ApiError, AuthenticationError } from '../errors'
import { initialTranscriptState, reduceTranscriptAll, type TranscriptState } from '../transcript'
import { createMockFetch, sseLines, sseResponse } from '../test-support/mock-fetch'
import { FAKE_SESSION_TOKEN, createFakeClient, type FakeClient } from './index'

afterEach(() => {
  // The device-flow timing test runs on fake timers; nothing else may inherit them.
  vi.useRealTimers()
})

/**
 * What a replay of a log shows: the log without the chunks a finished reply superseded (D9).
 *
 * The fake's reads are the replay read — `sessions.events.list`, `.iterate` and the replaying
 * half of `.stream` all skip what a recorded range covers, exactly as the server's
 * `listEvents` does — so a test comparing one of them against the log compares it against
 * this view, which is also what a reloaded client sees.
 */
function replayOf(history: readonly StoredEvent[]): StoredEvent[] {
  return history.filter(
    (event) => event.type !== EVENT_TYPES.eventStart && event.type !== EVENT_TYPES.eventDelta,
  )
}

describe('the fake client', () => {
  it('implements the client interface', () => {
    const fake = createFakeClient()

    expect(typeof fake.sendMessage).toBe('function')
    expect(typeof fake.interrupt).toBe('function')
    expect(typeof fake.me).toBe('function')
    expect(typeof fake.agents.create).toBe('function')
    expect(typeof fake.sessions.events.stream).toBe('function')
    expect(typeof fake.sessions.delete).toBe('function')
    expect(typeof fake.providerCredentials.put).toBe('function')
    expect(typeof fake.models.list).toBe('function')
    expect(typeof fake.preferences.get).toBe('function')
    expect(typeof fake.auth.startDeviceLogin).toBe('function')
    expect(fake.session.type).toBe('session')
    expect(fake.agent.type).toBe('agent')
    expect(fake.user.email).toBe('ada@example.com')
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

    // Every event is stored (P4): the chunks carry a `seq` like the rest, which is what makes
    // a reply in flight resumable by position. (`session.deleted` is the one stream event
    // without a position, and this turn has none.)
    expect(events.every(isStoredEvent)).toBe(true)
    expect(events.filter(isStoredEvent).map((event) => event.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
    const message = events.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(message).toMatchObject({
      type: EVENT_TYPES.agentMessage,
      content: [{ type: 'text', text: 'Hello from the fake!' }],
      // The reply supersedes the chunk range it was streamed as.
      supersedes: { from_seq: 4, to_seq: 7 },
    })
    expect(events.find((event) => event.type === EVENT_TYPES.modelRequestEnd)).toMatchObject({
      type: EVENT_TYPES.modelRequestEnd,
      is_error: null,
    })
    // The request claimed the message it answered.
    const first = events[0]
    expect(events.find((event) => event.type === EVENT_TYPES.modelRequestStart)).toMatchObject({
      consumes: [first?.type === EVENT_TYPES.userMessage ? first.id : undefined],
    })

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

  it('emits deep-frozen events and derives processed_at instead of rewriting the log', async () => {
    const fake = createFakeClient()
    fake.respondWith('frozen')

    const { events } = await runTurn(fake)

    for (const event of events) {
      expect(Object.isFrozen(event), JSON.stringify(event)).toBe(true)
    }

    // The live copy is the event exactly as it was written — a queued message — and it
    // cannot be rewritten.
    const streamed = events.find((event) => event.type === EVENT_TYPES.userMessage)
    expect(streamed).toMatchObject({ type: EVENT_TYPES.userMessage, processed_at: null })
    expect(() => {
      ;(streamed as Record<string, unknown>).processed_at = 'rewritten'
    }).toThrow(TypeError)

    // The log keeps the event as written too; a read derives the processed timestamp from the
    // brain's note, which is what source-of-truth readers see from phase P2a on.
    const logged = fake.history().find((event) => event.type === EVENT_TYPES.userMessage)
    expect(logged).toMatchObject({
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'hello fake' }],
    })
    expect(logged?.type === EVENT_TYPES.userMessage ? logged.processed_at : null).not.toBeNull()
  })

  it('reconciles the accumulated chunks with the stored message', async () => {
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
    // The chunks are stored events under the id of the reply they announce (P4).
    const chunks = events.filter(
      (event) => event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta,
    )
    const message = events.find((event) => event.type === EVENT_TYPES.agentMessage)
    expect(chunks.every((chunk) => chunk.seq > 0 && isStoredEvent(chunk))).toBe(true)
    for (const chunk of chunks) {
      expect(chunk.type === EVENT_TYPES.eventStart ? chunk.event.id : chunk.event_id).toBe(
        message?.id,
      )
    }
    // What the client accumulated equals what was stored.
    const accumulated = chunks
      .flatMap((chunk) => (chunk.type === EVENT_TYPES.eventDelta ? [chunk.delta.content.text] : []))
      .join('')
    expect(
      message?.type === EVENT_TYPES.agentMessage
        ? message.content.map((block) => block.text).join('')
        : '',
    ).toBe(accumulated)
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
      // The failed attempt streams nothing: its span closes with an error...
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionError,
      EVENT_TYPES.sessionStatusRescheduled,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      // ...and the retry streams its own chunks under a fresh message id (P4).
      EVENT_TYPES.eventStart,
      EVENT_TYPES.eventDelta,
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
    // The chunks that were streamed before the abort are stored events, so they are in the
    // log (and in `drained`); the ones the interrupt cut off never were, and the interrupt is
    // appended among the fragments the loop was still finishing.
    const types = drained.map((event) => event.type)
    expect(types.slice(0, 4)).toEqual([
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.eventStart,
    ])
    expect(types.slice(-3)).toEqual([
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const middle = types.slice(4, -3)
    expect(middle.filter((type) => type !== EVENT_TYPES.eventDelta)).toEqual([
      EVENT_TYPES.userInterrupt,
    ])
    expect(middle.filter((type) => type === EVENT_TYPES.eventDelta)).toHaveLength(deltas)
    const end = drained.find((event) => event.type === EVENT_TYPES.modelRequestEnd)
    expect(end).toMatchObject({
      is_error: true,
      error: { type: 'interrupted' },
    })
    // The interrupt that cut the request short is claimed by its span end (P4).
    const interrupt = drained.find((event) => event.type === EVENT_TYPES.userInterrupt)
    expect(end?.type === EVENT_TYPES.modelRequestEnd ? end.consumes : undefined).toEqual([
      interrupt?.id,
    ])

    const transcript = reduceTranscriptAll(initialTranscriptState(), events)
    expect(transcript.messages.at(-1)?.text).toBe(partial)
    expect(transcript.messages.at(-1)?.streaming).toBe(false)
    expect(transcript.status).toBe('idle')
  })

  it('claims an interrupt that arrives with nothing running, in an idle turn', async () => {
    const fake = createFakeClient()

    await fake.interrupt(fake.session.id)
    await fake.waitForIdle()

    // The interrupt has no request to stop, so the turn's idle event claims it (P4): the
    // server starts a turn for a queued interrupt even when none was running.
    const history = fake.history()
    expect(history.map((event) => event.type)).toEqual([
      EVENT_TYPES.userInterrupt,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.sessionStatusIdle,
    ])
    const [stored] = history
    expect(stored?.type === EVENT_TYPES.userInterrupt ? stored.processed_at : null).not.toBeNull()
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

    // The first reply sorts where its chunks started — before the steering message arrived —
    // because its `supersedes` range says so, the same view a reloaded client gets.
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
  it('holds the chunks back unless deltas were asked for', async () => {
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

    // `afterSeq: 0` replays the whole log — without the reply's superseded chunks, which is
    // what the server's stream carries too — and a later position replays only what follows
    // it.
    const replay = replayOf(history)
    expect(await collect(fake, { afterSeq: 0 })).toEqual(replay)
    expect(await collect(fake, { afterSeq: lastSeq - 2 })).toEqual(replay.slice(-2))
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

  it('follows an agent update through fake.agent, the fix for #106', async () => {
    const fake = createFakeClient()

    const updated = await fake.agents.update(fake.agent.id, {
      name: 'Renamed',
      model: { id: 'openai/gpt-4.1-mini' },
    })

    // The getter reads the fake's own store, not the seed object it was handed (#106): the
    // update is visible without another lookup.
    expect(fake.agent).toBe(updated)
    expect(fake.agent.name).toBe('Renamed')
    expect(fake.agent.model).toEqual({ id: 'openai/gpt-4.1-mini' })
    expect((await fake.agents.get(fake.agent.id)).name).toBe('Renamed')

    // And the fields a turn runs come from the same store: a session created after the
    // update snapshots the new configuration, and its span carries the new model.
    const session = await fake.sessions.create({ agent: fake.agent.id })
    fake.respondWith('hi', { sessionId: session.id })
    await fake.sendMessage(session.id, 'go')
    await fake.waitForIdle(session.id)
    const span = fake
      .history(session.id)
      .find((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(span).toMatchObject({ model: 'openai/gpt-4.1-mini' })
  })

  it('switches the session model when a user.message carries one (#111)', async () => {
    const fake = createFakeClient()
    fake.respondWith('first').respondWith('second')

    await sendAndSettle(fake, 'hello')
    await sendAndSettle(fake, 'hello again', { model: { id: 'openai/gpt-4.1-mini' } })

    // The switch is stored on the event that carried it...
    const switcher = fake
      .history()
      .find((event) => event.type === EVENT_TYPES.userMessage && event.model !== undefined)
    expect(switcher).toMatchObject({ model: { id: 'openai/gpt-4.1-mini' } })
    // ...and it is the session's live projection now.
    expect(fake.session.model).toEqual({ id: 'openai/gpt-4.1-mini' })
    // The next turn's span carries the switched model; the first turn ran the seeded one.
    const spans = fake.history().filter((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(spans.map((span) => span.model)).toEqual([fake.agent.model.id, 'openai/gpt-4.1-mini'])
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

  it('answers a cursor of the wrong kind with the server’s 400, never a silent page 1', async () => {
    const fake = createFakeClient()
    fake.respondWith('ok')
    await sendAndSettle(fake, 'hello')
    await fake.agents.create({ name: 'Second', model: { id: 'anthropic/claude-sonnet-5' } })

    // A `seq` cursor is the events log's resume position; a `key` cursor is an agent or
    // session list's keyset position. Each one carries what the other endpoint cannot use.
    const events = await fake.sessions.events.list(fake.session.id, { limit: 1 })
    const seqCursor = events.next_page
    const agents = await fake.agents.list({ limit: 1 })
    const keyCursor = agents.next_page
    expect(seqCursor).not.toBeNull()
    expect(keyCursor).not.toBeNull()

    // The server answers 400 `invalid_request_error` for either mix-up — its query schema
    // refuses a string that is no cursor at all, its store refuses a cursor of the wrong
    // kind — and the fake answers the same instead of serving page 1.
    await expect(fake.sessions.list({ page: seqCursor ?? undefined })).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
    await expect(fake.agents.list({ page: seqCursor ?? undefined })).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
    await expect(
      fake.sessions.events.list(fake.session.id, { page: keyCursor ?? undefined }),
    ).rejects.toMatchObject({ status: 400, type: 'invalid_request_error' })
    await expect(fake.sessions.list({ page: 'page_not-a-cursor' })).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
    await expect(
      fake.sessions.events.list(fake.session.id, { page: 'nonsense' }),
    ).rejects.toMatchObject({ status: 400, type: 'invalid_request_error' })

    // The refusal names what the server's refusal names.
    await expect(
      fake.sessions.events.list(fake.session.id, { page: keyCursor ?? undefined }),
    ).rejects.toThrow('listEvents takes a seq cursor, but got a key cursor')

    // And the cursor of the right kind still pages, so the check refuses only what it must.
    const rest = await fake.agents.list({ limit: 1, page: keyCursor ?? undefined })
    expect(rest.data).toHaveLength(1)
    expect(rest.next_page).toBeNull()
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

  it('creates a model-first session: no agent, the model it runs, no system prompt', async () => {
    const fake = createFakeClient()

    const session = await fake.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })
    fake.respondWith('hello', { sessionId: session.id })

    expect(session).toMatchObject({
      type: 'session',
      status: 'idle',
      model: { id: 'openai/gpt-4.1-mini' },
      system: null,
      agent: null,
    })
    // It is a session like any other: it reads back the same way, and its turn runs the model
    // it was created from — the span says which model served the request (issue #93).
    expect(await fake.sessions.get(session.id)).toEqual(session)
    await fake.sendMessage(session.id, 'hello')
    await fake.waitForIdle(session.id)
    const span = fake
      .history(session.id)
      .find((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(span).toMatchObject({ model: 'openai/gpt-4.1-mini' })
  })

  it('takes the effective model and system from the request, overriding the agent', async () => {
    const fake = createFakeClient()

    const fromAgent = await fake.sessions.create({ agent: fake.agent.id })
    expect(fromAgent.model).toEqual(fake.agent.model)
    expect(fromAgent.system).toBe(fake.agent.system)
    expect(fromAgent.agent?.id).toBe(fake.agent.id)

    const overridden = await fake.sessions.create({
      agent: fake.agent.id,
      model: { id: 'openai/gpt-4.1-mini' },
      system: null,
    })
    expect(overridden.model).toEqual({ id: 'openai/gpt-4.1-mini' })
    expect(overridden.system).toBeNull()
    // The snapshot is untouched: it records what the agent was, not what it contributed.
    expect(overridden.agent?.model).toEqual(fake.agent.model)
    expect(overridden.agent?.system).toBe(fake.agent.system)
  })

  it('refuses a request that names neither an agent nor a model, like the server', async () => {
    const fake = createFakeClient()

    await expect(fake.sessions.create({ title: 'A chat' })).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
  })

  it('refuses an inline model id that is not provider/model, like the server (#94)', async () => {
    const fake = createFakeClient()

    // `gpt-4.1-mini`, `openai/`, `/gpt-4.1-mini` and `openai//gpt-4.1-mini` all fail the
    // server's shape check; the fake has to refuse them too, or a picker tested here can
    // ship ids the server answers 400 for.
    for (const id of ['gpt-4.1-mini', 'openai/', '/gpt-4.1-mini', 'openai//gpt-4.1-mini']) {
      await expect(fake.sessions.create({ model: { id } })).rejects.toMatchObject({
        status: 400,
        type: 'invalid_request_error',
      })
    }

    // A shape check, not a catalogue lookup: an unknown but well-formed id is accepted.
    const session = await fake.sessions.create({ model: { id: 'acme/unknown' } })
    expect(session.model).toEqual({ id: 'acme/unknown' })
  })

  it('names a session after its first message, once, as the server does (#29)', async () => {
    const fake = createFakeClient()
    fake.respondWith('ok')

    const session = await fake.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })
    expect(session.title).toBeNull()

    await fake.sendMessage(session.id, '  Fix the SSE reload bug\nand then explain')
    // The title is the first non-empty line, whitespace collapsed — and the same read
    // (`sessions.get`) the web app's header and sidebar use shows it.
    await expect(fake.sessions.get(session.id)).resolves.toMatchObject({
      title: 'Fix the SSE reload bug',
    })

    await fake.sendMessage(session.id, 'a second message')
    await expect(fake.sessions.get(session.id)).resolves.toMatchObject({
      title: 'Fix the SSE reload bug',
    })

    // A title supplied at creation is never replaced.
    const titled = await fake.sessions.create({
      title: 'Already named',
      model: { id: 'openai/gpt-4.1-mini' },
    })
    await fake.sendMessage(titled.id, 'this must not rename it')
    await expect(fake.sessions.get(titled.id)).resolves.toMatchObject({ title: 'Already named' })

    // A session created with a message is named in the creating request, so the creation
    // response — not just a later read — carries the title.
    const born = await fake.sessions.create({
      model: { id: 'openai/gpt-4.1-mini' },
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'name me' }] }],
    })
    expect(born.title).toBe('name me')

    // A first line longer than the protocol's limit is cut with the ellipsis, exactly as the
    // server cuts it — the length is the protocol's, never over it.
    const long = await fake.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })
    await fake.sendMessage(long.id, 'x'.repeat(SESSION_TITLE_MAX_LENGTH + 50))
    const longTitle = (await fake.sessions.get(long.id)).title
    expect(longTitle).toHaveLength(SESSION_TITLE_MAX_LENGTH)
    expect(longTitle?.endsWith('…')).toBe(true)

    // A message with no text to name it after leaves the title null.
    const blank = await fake.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })
    await fake.sessions.events.send(blank.id, {
      type: 'user.message',
      content: [{ type: 'text', text: '   ' }],
    })
    await expect(fake.sessions.get(blank.id)).resolves.toMatchObject({ title: null })
  })

  it('lists a model-first session, and never under an agent filter', async () => {
    const fake = createFakeClient()

    const modelFirst = await fake.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })
    const fromAgent = await fake.sessions.create({ agent: fake.agent.id })

    const all = await fake.sessions.list()
    expect(all.data.map((session) => session.id)).toEqual(
      expect.arrayContaining([fromAgent.id, modelFirst.id]),
    )
    const filtered = await fake.sessions.list({ agent_id: fake.agent.id })
    const filteredIds = filtered.data.map((session) => session.id)
    expect(filteredIds).toContain(fromAgent.id)
    // The agent filter matches the sessions created with that agent — and nothing else: a
    // model-first session has no agent id to match.
    expect(filteredIds).not.toContain(modelFirst.id)
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

    expect(walked).toEqual(replayOf(fake.history()))
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

describe('the fake answers the server’s validation envelope (#121)', () => {
  it('refuses an agent body the protocol rejects, instead of a raw parse error', async () => {
    const fake = createFakeClient()

    const badCreate = { name: '', model: { id: 'anthropic/claude-sonnet-5' } }
    // The protocol's schema is the server's check; the fake must answer its 400.
    expect(CreateAgentRequestSchema.safeParse(badCreate).success).toBe(false)
    await expect(fake.agents.create(badCreate)).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
    // A refused create stores nothing.
    expect((await fake.agents.list()).data.map((agent) => agent.name)).toEqual(['Summarizer'])

    // An update goes through the update schema — and a refused one leaves the agent alone.
    const badUpdate = { name: '' }
    expect(UpdateAgentRequestSchema.safeParse(badUpdate).success).toBe(false)
    await expect(fake.agents.update(fake.agent.id, badUpdate)).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
    expect((await fake.agents.get(fake.agent.id)).name).toBe(fake.agent.name)

    // The server parses the body before it looks the agent up, so a malformed body on an
    // unknown id is the 400, not the 404.
    await expect(fake.agents.update(newAgentId(), { name: '' })).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
  })

  it('refuses events the protocol rejects, and stores what the schema parsed', async () => {
    const fake = createFakeClient()

    // A text block the protocol refuses — statically fine, empty at runtime.
    const emptyText = {
      type: 'user.message' as const,
      content: [{ type: 'text' as const, text: '' }],
    }
    expect(UserMessageEventInputSchema.safeParse(emptyText).success).toBe(false)
    await expect(fake.sessions.events.send(fake.session.id, emptyText)).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })

    // An empty batch: `SendEventsRequestSchema` requires at least one event.
    expect(SendEventsRequestSchema.safeParse({ events: [] }).success).toBe(false)
    await expect(fake.sessions.events.send(fake.session.id, [])).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })

    // An event type the protocol does not accept on this route.
    const unknownType = { type: 'agent.message' } as unknown as UserEventInput
    await expect(fake.sessions.events.send(fake.session.id, unknownType)).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })

    // None of the refusals reached the log, so none of them started a turn.
    expect(fake.history()).toEqual([])

    // A body the schema accepts is stored as the schema parsed it: a field the server would
    // strip is stripped here too, not stored as the caller wrote it.
    const noisy = {
      type: 'user.message' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
      surprise: 'not in the protocol',
    }
    const response = await fake.sessions.events.send(fake.session.id, noisy)
    expect('surprise' in (response.data[0] ?? {})).toBe(false)
    await fake.waitForIdle()
  })

  it('refuses a message the server would refuse, before it reaches the log', async () => {
    const fake = createFakeClient()

    // `sendMessage` builds the body `POST …/events` would carry, and the server parses it
    // with the same schema: an empty text is a 400 there, and now here too.
    await expect(fake.sendMessage(fake.session.id, '')).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
    expect(fake.history()).toEqual([])
  })
})

describe('the fake rewinds a session (#238)', () => {
  it('restarts the conversation from an edited message, and reads skip what it replaced', async () => {
    const fake = createFakeClient()
    fake.respondWith('rain, on the window').respondWith('snow, on the window')
    await sendAndSettle(fake, 'write a haiku about rain')
    const original = fake.history()
    const edited = original.find((event) => event.type === EVENT_TYPES.userMessage)
    expect(edited).toBeDefined()

    await sendAndSettle(fake, 'write a haiku about snow', {
      rewindTo: edited?.seq ?? 0,
    })

    // The log is append-only: the turn that was replaced is still in it, in place, and the
    // rewind behind it says what it covers — the edited message through the last event before
    // the rewind.
    const log = fake.history()
    const rewind = log.find((event) => event.type === EVENT_TYPES.sessionRewind)
    expect(rewind).toMatchObject({
      supersedes: { from_seq: edited?.seq, to_seq: rewind === undefined ? 0 : rewind.seq - 1 },
    })

    // What a client reads is the conversation restarted from the edit: a reload would never
    // have seen the replaced branch, and the fake's replay read skips the range the same way
    // the server's does.
    const replay = (await fake.sessions.events.list(fake.session.id)).data
    expect(replay.map((event) => event.type)).toEqual([
      EVENT_TYPES.sessionRewind,
      EVENT_TYPES.userMessage,
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.modelRequestStart,
      EVENT_TYPES.agentMessage,
      EVENT_TYPES.modelRequestEnd,
      EVENT_TYPES.sessionStatusIdle,
    ])

    // And the transcript the reader is looking at agrees with what a reload would build.
    const live = reduceTranscriptAll(initialTranscriptState(), log)
    const reloaded = reduceTranscriptAll(initialTranscriptState(), replay)
    expect(live.messages.map((message) => `${message.role}:${message.text}`)).toEqual([
      'user:write a haiku about snow',
      'agent:snow, on the window',
    ])
    expect(reloaded.messages).toEqual(live.messages)
  })

  it('answers the two refusals the server answers, with the server’s envelopes', async () => {
    const fake = createFakeClient()
    fake.respondWith('slowly', { chunks: 20 })
    const sent = fake.sendMessage(fake.session.id, 'first')
    await fake
      .sendMessage(fake.session.id, 'second', { rewindTo: 1 })
      .then(() => expect.unreachable('a rewind while the turn runs must be refused'))
      .catch((error: unknown) => {
        // The turn in flight owns the branch being taken back: the route's 409.
        expect(error).toMatchObject({ status: 409, type: 'conflict_error' })
      })
    await sent
    await fake.waitForIdle(fake.session.id)

    // A `from_seq` that names nothing a reader could edit — no event there, or an event that
    // is not the user's — is the 400 the store's `RangeError` becomes.
    const log = fake.history()
    const reply = log.find((event) => event.type === EVENT_TYPES.agentMessage)
    for (const rewindTo of [0, reply?.seq ?? 0, 999]) {
      await expect(fake.sendMessage(fake.session.id, 'edited', { rewindTo })).rejects.toMatchObject(
        { status: 400, type: 'invalid_request_error' },
      )
    }
    // Nothing of a refused batch was stored: the log is exactly what it was.
    expect(fake.history()).toEqual(log)
  })

  it('asks for no turn when the batch is a rewind alone', async () => {
    const fake = createFakeClient()
    fake.respondWith('a reply')
    await sendAndSettle(fake, 'first')
    const before = fake.history()

    await fake.sessions.events.send(fake.session.id, {
      type: EVENT_TYPES.sessionRewind,
      from_seq: 1,
    })
    await fake.waitForIdle(fake.session.id)

    // One event, and no turn around it: the route signals the scheduler from the user events
    // a request stored, and a rewind is not one.
    const after = fake.history()
    expect(after).toHaveLength(before.length + 1)
    const rewind = after.at(-1)
    expect(rewind?.type).toBe(EVENT_TYPES.sessionRewind)
    // A read of the session is the rewind alone: the range it recorded covers the turn that
    // was there, and nothing took its place.
    expect((await fake.sessions.events.list(fake.session.id)).data).toEqual([rewind])
  })
})

describe('the fake deletes a session (#111)', () => {
  it('delivers one final session.deleted event, ends the stream, and answers 404 after', async () => {
    const fake = createFakeClient()
    fake.respondWith('bye')
    await sendAndSettle(fake, 'hi')
    const logged = fake.history()

    const controller = new AbortController()
    const events: StreamEvent[] = []
    const iterating = (async () => {
      for await (const event of fake.sessions.events.stream(fake.session.id, {
        // The whole log replayed — the deletion is what ends the stream, and the events
        // before it are the log's, less the chunks the reply's message superseded.
        deltas: true,
        afterSeq: 0,
        signal: controller.signal,
      })) {
        events.push(event)
      }
    })()

    await fake.sessions.delete(fake.session.id)
    // The stream ends by itself after the deletion: no abort is needed, and the deletion is
    // its last event.
    await iterating

    // The replay half of the stream, with the reply's superseded chunks skipped — the same
    // events the log holds, minus what its own message replaced (D9).
    expect(events.filter(isStoredEvent)).toEqual(replayOf(logged))
    expect(events.at(-1)).toEqual({
      type: EVENT_TYPES.sessionDeleted,
      session_id: fake.session.id,
    })
    expect(events.filter((event) => event.type === EVENT_TYPES.sessionDeleted)).toHaveLength(1)

    // The session and its log are gone: reads, sends, a second delete and a new stream are
    // all the server's 404, and it is no longer listed.
    await expect(fake.sessions.get(fake.session.id)).rejects.toMatchObject({
      status: 404,
      type: 'not_found_error',
    })
    await expect(fake.sessions.events.list(fake.session.id)).rejects.toMatchObject({ status: 404 })
    await expect(fake.sendMessage(fake.session.id, 'anyone there?')).rejects.toMatchObject({
      status: 404,
    })
    await expect(fake.sessions.delete(fake.session.id)).rejects.toMatchObject({ status: 404 })
    expect(() => fake.history()).toThrow()
    const listed = await fake.sessions.list()
    expect(listed.data.map((session) => session.id)).not.toContain(fake.session.id)

    const streaming = (async () => {
      for await (const _event of fake.sessions.events.stream(fake.session.id)) {
        // Nothing arrives: the session is gone.
      }
    })()
    await expect(streaming).rejects.toMatchObject({ status: 404 })
  })

  it('deletes only the session it names', async () => {
    const fake = createFakeClient()
    const other = await fake.sessions.create({ agent: fake.agent.id })

    await fake.sessions.delete(fake.session.id)

    await expect(fake.sessions.get(other.id)).resolves.toEqual(other)
    await expect(fake.sessions.delete(other.id)).resolves.toBeUndefined()
    await expect(fake.sessions.get(other.id)).rejects.toMatchObject({ status: 404 })
  })
})

describe('the fake preferences (#111)', () => {
  it('starts at the protocol defaults and merges what a put carries', async () => {
    const fake = createFakeClient()

    await expect(fake.preferences.get()).resolves.toEqual({ default_model: null, theme: 'system' })

    const stored = await fake.preferences.put({ default_model: 'openai/gpt-4.1-mini' })
    // The default model alone: the theme it did not carry keeps its stored value.
    expect(stored).toEqual({ default_model: 'openai/gpt-4.1-mini', theme: 'system' })
    await expect(fake.preferences.get()).resolves.toEqual({
      default_model: 'openai/gpt-4.1-mini',
      theme: 'system',
    })

    // A theme alone likewise leaves the default model alone (#203) — the two never clear
    // each other.
    await expect(fake.preferences.put({ theme: 'dim' })).resolves.toEqual({
      default_model: 'openai/gpt-4.1-mini',
      theme: 'dim',
    })
    await expect(fake.preferences.get()).resolves.toEqual({
      default_model: 'openai/gpt-4.1-mini',
      theme: 'dim',
    })

    // null clears the choice, like the server's PUT.
    await expect(fake.preferences.put({ default_model: null })).resolves.toEqual({
      default_model: null,
      theme: 'dim',
    })
    await expect(fake.preferences.get()).resolves.toEqual({ default_model: null, theme: 'dim' })
  })

  it('seeds the value from createFakeClient', async () => {
    const fake = createFakeClient({
      preferences: makeUserPreferences({ default_model: 'anthropic/claude-sonnet-5' }),
    })

    await expect(fake.preferences.get()).resolves.toEqual({
      default_model: 'anthropic/claude-sonnet-5',
      theme: 'system',
    })
  })
})

describe('the fake catalog', () => {
  it('lists the configured models sorted by provider then name, with the configured statuses', async () => {
    const fake = createFakeClient({
      models: [
        makeModelEntry({ id: 'openai/gpt-5.1', provider: 'openai', name: 'GPT-5.1' }),
        makeModelEntry({ id: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5' }),
        makeModelEntry({ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }),
      ],
      providers: [
        {
          provider: 'anthropic',
          status: 'fallback',
          fetched_at: null,
          message: 'The provider model list timed out.',
        },
        {
          provider: 'openai',
          status: 'ok',
          fetched_at: fixtureTimestamp(),
          message: null,
        },
      ],
    })

    const response = await fake.models.list()

    expect(response.data.map((entry) => entry.id)).toEqual([
      'anthropic/claude-opus-5-5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-5.1',
    ])
    expect(response.providers.map((status) => status.provider)).toEqual(['anthropic', 'openai'])
    expect(response.providers[0]?.status).toBe('fallback')
  })

  it('defaults to one anthropic entry with an ok status', async () => {
    const fake = createFakeClient()

    const response = await fake.models.list()

    expect(response.data.map((entry) => entry.id)).toEqual(['anthropic/claude-sonnet-5'])
    expect(response.data[0]?.source).toBe('provider')
    expect(response.providers).toHaveLength(1)
    expect(response.providers[0]).toMatchObject({ provider: 'anthropic', status: 'ok' })
  })

  it('records every call, so a test can see which reads asked for a refresh', async () => {
    const fake = createFakeClient()

    await fake.models.list()
    await fake.models.list({})
    await fake.models.list({ refresh: true })

    expect(fake.modelListCalls).toEqual([{ refresh: false }, { refresh: false }, { refresh: true }])
  })
})

describe("the fake's authentication", () => {
  it('signs in by default and answers me with its user', async () => {
    const fake = createFakeClient()

    await expect(fake.me()).resolves.toEqual(fake.user)
    expect(fake.user.email).toBe('ada@example.com')
  })

  it('answers every wire method with an AuthenticationError when signed out', async () => {
    const fake = createFakeClient({ authenticated: false })

    await expect(fake.me()).rejects.toBeInstanceOf(AuthenticationError)
    await expect(fake.agents.list()).rejects.toBeInstanceOf(AuthenticationError)
    await expect(fake.sessions.get(fake.session.id)).rejects.toBeInstanceOf(AuthenticationError)
    await expect(fake.sessions.delete(fake.session.id)).rejects.toBeInstanceOf(AuthenticationError)
    await expect(fake.sendMessage(fake.session.id, 'hi')).rejects.toBeInstanceOf(
      AuthenticationError,
    )
    await expect(fake.providerCredentials.list()).rejects.toBeInstanceOf(AuthenticationError)
    await expect(fake.models.list()).rejects.toBeInstanceOf(AuthenticationError)
    await expect(fake.preferences.get()).rejects.toBeInstanceOf(AuthenticationError)
    await expect(fake.preferences.put({ default_model: null })).rejects.toBeInstanceOf(
      AuthenticationError,
    )
    await expect(fake.auth.signOut()).rejects.toBeInstanceOf(AuthenticationError)

    const streaming = (async () => {
      for await (const _event of fake.sessions.events.stream(fake.session.id)) {
        // Nothing arrives: the stream fails on its first `next()`.
      }
    })()
    await expect(streaming).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('runs the device flow while signed out and signs in on approval', async () => {
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ pendingPolls: 2, outcome: 'approved' })

    const start = await fake.auth.startDeviceLogin()
    // The server's URI shape (A6): the web app's hash route, the code inside the fragment.
    expect(start).toEqual({
      deviceCode: 'fake_device_code',
      userCode: 'FAKE-CODE',
      verificationUri: 'http://localhost:3000/#/device',
      verificationUriComplete: 'http://localhost:3000/#/device?user_code=FAKE-CODE',
      interval: 0,
      expiresIn: 600,
    })

    const token = await fake.auth.pollDeviceLogin(start.deviceCode)
    expect(token).toBe(FAKE_SESSION_TOKEN)
    await expect(fake.me()).resolves.toEqual(fake.user)
  })

  it('polls through a scripted slow_down the way the real client does', async () => {
    vi.useFakeTimers()
    const fake = createFakeClient({ authenticated: false })
    fake.scriptDeviceLogin({ interval: 1, pendingPolls: 1, slowDownPolls: 1, outcome: 'approved' })

    let settled = false
    const polling = fake.auth.pollDeviceLogin('fake_device_code')
    void polling.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    // Poll 1 answers `authorization_pending`; poll 2 answers `slow_down`, which is where the
    // client adds RFC 8628's five seconds to the interval — so the third poll is due at
    // 2s + 6s, not at 2s + 1s.
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(5_999)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(polling).resolves.toBe(FAKE_SESSION_TOKEN)
    await expect(fake.me()).resolves.toEqual(fake.user)
  })

  it('rejects the poll with access_denied or expired_token when scripted so', async () => {
    const denied = createFakeClient({ authenticated: false })
    denied.scriptDeviceLogin({ outcome: 'denied' })
    const expired = createFakeClient({ authenticated: false })
    expired.scriptDeviceLogin({ outcome: 'expired' })

    await expect(denied.auth.pollDeviceLogin('fake_device_code')).rejects.toMatchObject({
      name: 'DeviceLoginError',
      code: 'access_denied',
    })
    await expect(expired.auth.pollDeviceLogin('fake_device_code')).rejects.toMatchObject({
      code: 'expired_token',
    })
    await expect(denied.me()).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('rejects a poll for a code no flow started', async () => {
    const fake = createFakeClient({ authenticated: false })

    await expect(fake.auth.pollDeviceLogin('some_other_code')).rejects.toMatchObject({
      code: 'invalid_grant',
    })
  })

  it('signs out and refuses the next request', async () => {
    const fake = createFakeClient()

    await fake.auth.signOut()

    await expect(fake.me()).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('stores credentials as metadata, replaces them, and never returns the key', async () => {
    const fake = createFakeClient()

    const stored = await fake.providerCredentials.put('anthropic', {
      type: 'api_key',
      api_key: 'sk-ant-secret-k9Z2',
    })
    expect(stored).toMatchObject({ provider: 'anthropic', type: 'api_key', last4: 'k9Z2' })
    expect(JSON.stringify(stored)).not.toContain('sk-ant-secret')

    const replaced = await fake.providerCredentials.put('anthropic', {
      type: 'api_key',
      api_key: 'sk-ant-other-1111',
    })
    expect(replaced.id).toBe(stored.id)
    expect(replaced.created_at).toBe(stored.created_at)
    expect(replaced.last4).toBe('1111')

    const listed = await fake.providerCredentials.list()
    expect(listed.data).toEqual([replaced])

    await fake.providerCredentials.delete('anthropic')
    await expect(fake.providerCredentials.list()).resolves.toEqual({ data: [] })
  })

  it('rejects an empty key the way a provider rejection is answered', async () => {
    const fake = createFakeClient()

    await expect(
      fake.providerCredentials.put('anthropic', { type: 'api_key', api_key: '  ' }),
    ).rejects.toMatchObject({ status: 422, type: 'invalid_provider_credential' })
  })

  it('picks a default model for the first key, and never replaces one (#116, U4)', async () => {
    const fake = createFakeClient({
      models: [
        {
          id: 'anthropic/claude-sonnet-5',
          provider: 'anthropic',
          name: 'Claude Sonnet 5',
          context_window: 200_000,
          max_output_tokens: 64_000,
          source: 'provider',
        },
        {
          id: 'openai/gpt-4.1-mini',
          provider: 'openai',
          name: 'GPT-4.1 mini',
          context_window: 128_000,
          max_output_tokens: 16_000,
          source: 'provider',
        },
      ],
    })
    expect((await fake.preferences.get()).default_model).toBeNull()

    await fake.providerCredentials.put('openai', { type: 'api_key', api_key: 'sk-openai-1234' })
    // The saved provider's model, not the catalog's first.
    expect((await fake.preferences.get()).default_model).toBe('openai/gpt-4.1-mini')

    // The reader's own choice stands: a second key does not move the default.
    await fake.preferences.put({ default_model: 'anthropic/claude-sonnet-5' })
    await fake.providerCredentials.put('openai', { type: 'api_key', api_key: 'sk-openai-5678' })
    expect((await fake.preferences.get()).default_model).toBe('anthropic/claude-sonnet-5')
  })

  it('leaves the default null when no catalog model can be picked', async () => {
    const fake = createFakeClient({ models: [] })

    await fake.providerCredentials.put('anthropic', { type: 'api_key', api_key: 'sk-ant-1234' })

    expect((await fake.preferences.get()).default_model).toBeNull()
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

  it('give a retried reply the same metadata live and replayed (#201, U1)', async () => {
    const fake = createFakeClient()
    fake.failWith({ retryStatus: 'retrying' })
    fake.respondWith('Second time lucky.', { chunks: 3 })

    const { events, transcript } = await runTurn(fake)
    const live = transcript.messages.at(-1)?.meta

    // Both requests report FAKE_MODEL_USAGE — the one that failed and the retry that answered
    // — and a reply that took two of them ran on the model of the second.
    expect(live).toMatchObject({
      model: fake.session.model.id,
      usage: { input: 1024, output: 64, total: 1088 },
    })
    expect((await replayThroughClient(events, fake.session.id)).messages.at(-1)?.meta).toEqual(live)
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

/** Read the fake's stream from `afterSeq`, send `text` when given, and stop at idle. */
async function collect(
  fake: FakeClient,
  options: { afterSeq?: number; text?: string } = {},
): Promise<StreamEvent[]> {
  const controller = new AbortController()
  const events: StreamEvent[] = []
  const iterating = (async () => {
    for await (const event of fake.sessions.events.stream(fake.session.id, {
      // Chunks are stored events now (P4), so a replay-with-deltas connection gets the whole
      // log — the same thing a reader of `history()` sees.
      deltas: true,
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
async function sendAndSettle(
  fake: FakeClient,
  text: string,
  options?: SendMessageOptions,
): Promise<void> {
  await fake.sendMessage(fake.session.id, text, options)
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
