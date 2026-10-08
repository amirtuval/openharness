import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '@openharness/session'
import {
  API_VERSION_PREFIX,
  AgentSchema,
  ApiErrorBodySchema,
  EVENT_TYPES,
  ListAgentsResponseSchema,
  ListEventsResponseSchema,
  ListSessionsResponseSchema,
  REQUEST_ID_HEADER,
  SendEventsResponseSchema,
  SessionSchema,
  type Session,
  type SessionId,
  type StoredEvent,
} from '@openharness/protocol'

import { createApp } from './app'
import {
  createTestApp,
  TEST_PUBLIC_URL,
  httpCreateAgent,
  httpCreateSession,
  httpSendMessage,
  readHistory,
  signInCookie,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * The routes, their validation, and the things the app promises about every response: the
 * protocol's envelope for failures, a `request-id` on everything, and auth on `/v1` alone.
 */

let context: TestContext | undefined

afterEach(async () => {
  await context?.close()
  context = undefined
})

function setup(options: Parameters<typeof createTestApp>[0] = {}): TestContext {
  context = createTestApp(options)
  return context
}

/** A clock for a store: real time does not matter, but no two reads share a millisecond. */
function steppingClock(startMs: number): () => number {
  let tick = startMs
  return () => (tick += 1)
}

/** Read one session over HTTP, checked against the protocol's schema. */
async function readSession(test: TestContext, sessionId: SessionId): Promise<Session> {
  const response = await test.request(`${API_VERSION_PREFIX}/sessions/${sessionId}`)
  return SessionSchema.parse(await response.json())
}

/** Post events to a session over HTTP and return the response. */
async function postEvents(
  test: TestContext,
  sessionId: SessionId,
  events: readonly unknown[],
): Promise<Response> {
  return test.request(`${API_VERSION_PREFIX}/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  })
}

describe('GET /health', () => {
  it('answers with the health payload and needs no session', async () => {
    const app = setup().app

    const response = await app.request('/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })
})

describe('request ids', () => {
  it('puts a request-id on a successful response', async () => {
    const response = await setup().request('/health')

    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^req_/)
  })

  it('repeats the request id in an error body', async () => {
    const response = await setup().request(`${API_VERSION_PREFIX}/agents/agent_nope`)

    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.request_id).toBe(response.headers.get(REQUEST_ID_HEADER) ?? undefined)
  })
})

describe('the agents API', () => {
  it('creates an agent and returns it in the protocol shape', async () => {
    const response = await setup().request(`${API_VERSION_PREFIX}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Summarizer', model: { id: 'anthropic/claude-sonnet-5' } }),
    })

    expect(response.status).toBe(201)
    const agent = AgentSchema.parse(await response.json())
    expect(agent.name).toBe('Summarizer')
    expect(agent.model.id).toBe('anthropic/claude-sonnet-5')
    expect(agent.system).toBeNull()
  })

  it('reads one agent back', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)

    const response = await test.request(`${API_VERSION_PREFIX}/agents/${agent.id}`)

    expect(response.status).toBe(200)
    expect(AgentSchema.parse(await response.json())).toEqual(agent)
  })

  it('lists agents, oldest first, in the list envelope', async () => {
    // Two agents created inside the same millisecond share `created_at`, and the list's
    // tie-break is then the id: two ULIDs minted in one instant differ only in random bits,
    // which know nothing about creation order. On a fast enough machine the two creations do
    // land in one millisecond (it flaked on CI exactly that way), and the assertion below
    // became a coin flip — so the store's clock gives every call its own instant. That is
    // what "oldest first" is about: `(created_at, id)`, the order the list contract promises.
    const test = setup({ store: new InMemorySessionStore({ now: steppingClock(Date.now()) }) })
    const first = await httpCreateAgent(test, { name: 'First' })
    const second = await httpCreateAgent(test, { name: 'Second' })

    const response = await test.request(`${API_VERSION_PREFIX}/agents`)

    const page = ListAgentsResponseSchema.parse(await response.json())
    expect(page.data.map((agent) => agent.id)).toEqual([first.id, second.id])
    expect(page.next_page).toBeNull()
  })

  it('updates an agent and leaves the omitted fields alone', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test, { name: 'Before' })

    const response = await test.request(`${API_VERSION_PREFIX}/agents/${agent.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'After' }),
    })

    expect(response.status).toBe(200)
    const updated = AgentSchema.parse(await response.json())
    expect(updated.name).toBe('After')
    expect(updated.model).toEqual(agent.model)
  })

  it('answers 404 for an agent that does not exist', async () => {
    const response = await setup().request(
      `${API_VERSION_PREFIX}/agents/agent_01HZZZZZZZZZZZZZZZZZZZZZZZ`,
    )

    expect(response.status).toBe(404)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('not_found_error')
  })

  it('answers 404 for an unknown agent on update', async () => {
    const response = await setup().request(
      `${API_VERSION_PREFIX}/agents/agent_01HZZZZZZZZZZZZZZZZZZZZZZZ`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Nobody' }),
      },
    )

    expect(response.status).toBe(404)
  })

  it('answers 400 for a path id that is not an agent id', async () => {
    const response = await setup().request(`${API_VERSION_PREFIX}/agents/not-an-id`)

    expect(response.status).toBe(400)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('answers 400 for a body that does not match the schema', async () => {
    const response = await setup().request(`${API_VERSION_PREFIX}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })

    expect(response.status).toBe(400)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toContain('name')
  })

  it('answers 400 for a body that is not JSON', async () => {
    const response = await setup().request(`${API_VERSION_PREFIX}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })
})

describe('the sessions API', () => {
  it('creates a session that snapshots the agent', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test, { system: 'Be brief.' })

    const response = await test.request(`${API_VERSION_PREFIX}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agent.id, title: 'A chat' }),
    })

    expect(response.status).toBe(201)
    const session = SessionSchema.parse(await response.json())
    expect(session.status).toBe('idle')
    expect(session.title).toBe('A chat')
    expect(session.agent).toEqual({
      id: agent.id,
      name: agent.name,
      model: agent.model,
      system: 'Be brief.',
    })
  })

  it('answers 404 when the agent does not exist', async () => {
    const response = await setup().request(`${API_VERSION_PREFIX}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'agent_01HZZZZZZZZZZZZZZZZZZZZZZZ' }),
    })

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })

  it('reads and lists sessions', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const one = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}`)
    expect(one.status).toBe(200)
    expect(SessionSchema.parse(await one.json())).toEqual(session)

    const list = await test.request(`${API_VERSION_PREFIX}/sessions?agent_id=${agent.id}`)
    const page = ListSessionsResponseSchema.parse(await list.json())
    expect(page.data.map((entry) => entry.id)).toEqual([session.id])
  })

  it('filters sessions by another agent out', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const other = await httpCreateAgent(test, { name: 'Other' })
    await httpCreateSession(test, agent.id)

    const list = await test.request(`${API_VERSION_PREFIX}/sessions?agent_id=${other.id}`)

    expect(ListSessionsResponseSchema.parse(await list.json()).data).toEqual([])
  })

  it('answers 404 for a session that does not exist', async () => {
    const response = await setup().request(
      `${API_VERSION_PREFIX}/sessions/sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ`,
    )

    expect(response.status).toBe(404)
  })

  it('runs a session created with initial_events', async () => {
    const test = setup({ replies: [{ text: ['Hi back'] }] })
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id, {
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Hi' }] }],
    })

    await test.model.waitForRequests(1)
    await waitForIdle(test.store, session.id)
  })

  it('claims an interrupt a session was created with', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)

    const session = await httpCreateSession(test, agent.id, {
      initial_events: [{ type: 'user.interrupt' }],
    })

    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)
    const interrupt = history.find((event) => event.type === EVENT_TYPES.userInterrupt)
    expect(interrupt?.processed_at).not.toBeNull()
    expect(test.model.requests).toBe(0)
  })

  it('answers 400 for a malformed session id', async () => {
    const response = await setup().request(`${API_VERSION_PREFIX}/sessions/nope`)

    expect(response.status).toBe(400)
  })
})

describe('the events API', () => {
  it('stores a user message and returns it in the response envelope', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    })

    expect(response.status).toBe(200)
    const body = SendEventsResponseSchema.parse(await response.json())
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      type: 'user.message',
      seq: 1,
      processed_at: null,
      content: [{ type: 'text', text: 'Hello' }],
    })
  })

  it('answers 400 for an empty events array', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    })

    expect(response.status).toBe(400)
  })

  it('answers 400 for an event type the API does not accept', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'agent.message', content: [] }] }),
    })

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })

  it('answers 404 for an unknown session on append and on read', async () => {
    const test = setup()
    const missing = 'sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ'

    const appended = await test.request(`${API_VERSION_PREFIX}/sessions/${missing}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'x' }] }],
      }),
    })
    const read = await test.request(`${API_VERSION_PREFIX}/sessions/${missing}/events`)

    expect(appended.status).toBe(404)
    expect(read.status).toBe(404)
  })

  it('lists the log with types[] and after_seq', async () => {
    const test = setup({ replies: [{ text: ['Answer'] }] })
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    await test.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    })
    await test.model.waitForRequests(1)
    await waitForIdle(test.store, session.id)

    const filtered = await test.request(
      `${API_VERSION_PREFIX}/sessions/${session.id}/events?types[]=agent.message`,
    )
    const page = ListEventsResponseSchema.parse(await filtered.json())
    expect(page.data.map((event) => event.type)).toEqual(['agent.message'])

    const afterFirst = await test.request(
      `${API_VERSION_PREFIX}/sessions/${session.id}/events?after_seq=1`,
    )
    const rest = ListEventsResponseSchema.parse(await afterFirst.json())
    expect(rest.data.every((event) => ('seq' in event ? event.seq > 1 : false))).toBe(true)
    expect(rest.data.length).toBeGreaterThan(0)
  })

  it('answers 400 for a page cursor this endpoint cannot use', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    // A valid `key` cursor — the resource lists' kind, not the events log's.
    const keyCursor = Buffer.from(
      JSON.stringify({ kind: 'key', created_at: '2026-01-01T00:00:00Z', id: 'agent_x' }),
    )
      .toString('base64url')
      .replace(/=+$/, '')

    const response = await test.request(
      `${API_VERSION_PREFIX}/sessions/${session.id}/events?page=page_${keyCursor}`,
    )

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })
})

describe('edit and resend: the rewind (#238)', () => {
  /**
   * A session that has said one thing and been answered: the message the reader will edit, and
   * the `seq` the log ends at (the turn's `session.status_idle`), which a rewind covers too.
   */
  async function sessionWithAMessage(test: TestContext): Promise<{
    sessionId: SessionId
    message: { id: string; seq: number }
    tail: number
    raw: readonly StoredEvent[]
  }> {
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    const response = await postEvents(test, session.id, [
      { type: 'user.message', content: [{ type: 'text', text: 'write a haiku about rain' }] },
    ])
    const body = SendEventsResponseSchema.parse(await response.json())
    const stored = body.data[0]
    if (stored?.type !== EVENT_TYPES.userMessage) {
      throw new Error('the session was not stored with a message')
    }
    // The scripted model answers, so the session has a whole turn in it by the time this
    // returns — and the rewind the tests send replaces all of it.
    await waitForIdle(test.store, session.id)
    const raw = await readHistory(test.store, session.id, { includeSuperseded: true })
    const tail = raw[raw.length - 1]?.seq ?? 0
    return { sessionId: session.id, message: { id: stored.id, seq: stored.seq }, tail, raw }
  }

  it('restarts the session from an edited message, and the title stays', async () => {
    const test = setup()
    const { sessionId, message, tail, raw: before } = await sessionWithAMessage(test)
    const titled = await readSession(test, sessionId)
    expect(titled.title).toBe('write a haiku about rain')

    const response = await postEvents(test, sessionId, [
      { type: 'session.rewind', from_seq: message.seq },
      { type: 'user.message', content: [{ type: 'text', text: 'write a haiku about snow' }] },
    ])

    expect(response.status).toBe(200)
    const body = SendEventsResponseSchema.parse(await response.json())
    // The answer carries the stored message alone: the rewind's own event is the server's, and
    // a client reads it back from the log like any other session event.
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      type: EVENT_TYPES.userMessage,
      seq: tail + 2,
      processed_at: null,
    })

    // What a read of the log shows is the conversation restarted from the edit: the rewind,
    // and the message that replaced the one it took back — and then the turn that message
    // started, so the assertions below are about the head of the log and about what is *not*
    // anywhere in it.
    await waitForIdle(test.store, sessionId)
    const history = await readHistory(test.store, sessionId)
    expect(history.slice(0, 2).map((event) => event.type)).toEqual([
      EVENT_TYPES.sessionRewind,
      EVENT_TYPES.userMessage,
    ])
    expect(history[0]).toMatchObject({
      type: EVENT_TYPES.sessionRewind,
      supersedes: { from_seq: message.seq, to_seq: tail },
    })
    // Nothing of the branch the edit took back survives in what a reader sees.
    expect(JSON.stringify(history)).not.toContain('about rain')

    // Nothing already stored was modified: the raw log opens with the whole turn it did
    // before, field for field, and a session titled from its first message keeps the title it
    // has — the edit is a new message, not a new session.
    const raw = await readHistory(test.store, sessionId, { includeSuperseded: true })
    expect(raw.slice(0, before.length)).toEqual(before)
    expect((await readSession(test, sessionId)).title).toBe(titled.title)
  })

  it('answers 409 while a turn is running, and stores nothing', async () => {
    const test = setup()
    const { sessionId, message } = await sessionWithAMessage(test)
    // A turn in flight: the status event opens it and the span start is what makes it
    // `running` rather than merely open. Appended after the turn above went idle, so the
    // state is deterministic.
    await test.store.appendEvents(sessionId, [
      { type: EVENT_TYPES.sessionStatusRunning },
      { type: EVENT_TYPES.modelRequestStart, model: 'anthropic/claude-sonnet-5' },
    ])
    const before = await readHistory(test.store, sessionId, { includeSuperseded: true })

    const response = await postEvents(test, sessionId, [
      { type: 'session.rewind', from_seq: message.seq },
      { type: 'user.message', content: [{ type: 'text', text: 'write a haiku about snow' }] },
    ])

    expect(response.status).toBe(409)
    const error = ApiErrorBodySchema.parse(await response.json()).error
    expect(error.type).toBe('conflict_error')
    expect(error.message).toContain('running')
    // Nothing of the batch was stored — the message behind the refused rewind included.
    expect(await readHistory(test.store, sessionId, { includeSuperseded: true })).toEqual(before)
  })

  it('answers 400, and stores nothing, for a rewind that names no message', async () => {
    const test = setup()
    const { sessionId, message, tail } = await sessionWithAMessage(test)
    const before = await readHistory(test.store, sessionId, { includeSuperseded: true })

    // The turn's last event is a status event, and 99 is past the end of the log: neither is
    // something a reader could have edited.
    for (const fromSeq of [tail, 99]) {
      const response = await postEvents(test, sessionId, [
        { type: 'session.rewind', from_seq: fromSeq },
        { type: 'user.message', content: [{ type: 'text', text: 'write a haiku about snow' }] },
      ])

      expect(response.status, String(fromSeq)).toBe(400)
      expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe(
        'invalid_request_error',
      )
    }
    // Neither refusal stored anything: the batch is one append, so a rewind the log cannot
    // honour takes the message behind it with it.
    expect(await readHistory(test.store, sessionId, { includeSuperseded: true })).toEqual(before)

    // And a rewind to the message itself does work, so the refusals were about the `seq`.
    expect(
      (
        await postEvents(test, sessionId, [
          { type: 'session.rewind', from_seq: message.seq },
          { type: 'user.message', content: [{ type: 'text', text: 'write a haiku about snow' }] },
        ])
      ).status,
    ).toBe(200)
  })

  it('answers 400 for a rewind without a message to restart from', async () => {
    const test = setup()
    const { sessionId } = await sessionWithAMessage(test)

    const response = await postEvents(test, sessionId, [{ type: 'session.rewind' }])

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })

  it('answers 400, and stores nothing, for a message ahead of its rewind, or two rewinds', async () => {
    const test = setup()
    const { sessionId, message } = await sessionWithAMessage(test)
    const before = await readHistory(test.store, sessionId, { includeSuperseded: true })

    // A message ahead of the rewind would be stored and then swallowed by the range the rewind
    // records — returned in the answer as if a turn were going to answer it — and a second
    // rewind would supersede the first's restart. The protocol's request schema refuses both
    // before the route reads anything, so it is the 400 and nothing is stored.
    for (const events of [
      [
        { type: 'user.message', content: [{ type: 'text', text: 'write a haiku about snow' }] },
        { type: 'session.rewind', from_seq: message.seq },
      ],
      [
        { type: 'session.rewind', from_seq: message.seq },
        { type: 'user.message', content: [{ type: 'text', text: 'write a haiku about snow' }] },
        { type: 'session.rewind', from_seq: message.seq },
      ],
    ]) {
      const response = await postEvents(test, sessionId, events)

      expect(response.status).toBe(400)
      expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe(
        'invalid_request_error',
      )
    }
    // Nothing of either batch was stored, the message behind the refused rewind included.
    expect(await readHistory(test.store, sessionId, { includeSuperseded: true })).toEqual(before)
  })
})

describe('session titles', () => {
  it('names a session after the first message it was sent', async () => {
    const test = setup({ replies: [{ text: ['ok'] }] })
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    expect(session.title).toBeNull()

    await httpSendMessage(test, session.id, 'Fix the SSE reload bug\n\nit never replays previews')

    expect((await readSession(test, session.id)).title).toBe('Fix the SSE reload bug')
  })

  it('does not rename a session when later messages arrive', async () => {
    const test = setup({ replies: [{ text: ['ok'] }] })
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    await httpSendMessage(test, session.id, 'the first thing')
    await waitForIdle(test.store, session.id)

    await httpSendMessage(test, session.id, 'and now something else, at some length')

    expect((await readSession(test, session.id)).title).toBe('the first thing')
  })

  it('keeps the title a session was created with', async () => {
    const test = setup({ replies: [{ text: ['ok'] }] })
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id, { title: 'Named up front' })

    await httpSendMessage(test, session.id, 'a message that would have named it otherwise')

    expect((await readSession(test, session.id)).title).toBe('Named up front')
  })

  it('names a session created with initial_events, and answers with the title', async () => {
    const test = setup({ replies: [{ text: ['ok'] }] })
    const agent = await httpCreateAgent(test)

    const session = await httpCreateSession(test, agent.id, {
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Hi there' }] }],
    })

    expect(session.title).toBe('Hi there')
    expect((await readSession(test, session.id)).title).toBe('Hi there')
  })

  it('leaves the title null when the first message carries no text', async () => {
    const test = setup({ replies: [{ text: ['ok'] }] })
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    // A `user.message` may carry no blocks at all; there is nothing to name the session after.
    await postEvents(test, session.id, [{ type: 'user.message', content: [] }])

    expect((await readSession(test, session.id)).title).toBeNull()
  })

  it('leaves the title null for an interrupt', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    await postEvents(test, session.id, [{ type: 'user.interrupt' }])
    await waitForIdle(test.store, session.id)

    expect((await readSession(test, session.id)).title).toBeNull()
  })
})

describe('unknown routes', () => {
  it('answer 404 in the protocol envelope', async () => {
    // `/v1/models` used to be the example of an unimplemented route; the model catalogue
    // (epic #92) took it over, so this is some other path the API does not define.
    const response = await setup().request(`${API_VERSION_PREFIX}/captures`)

    expect(response.status).toBe(404)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('not_found_error')
  })

  it('answer 404 outside the API too', async () => {
    const response = await setup().request('/nothing-here')

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })
})

describe('auth', () => {
  it('rejects a request with no session at all', async () => {
    const test = setup()

    const response = await test.anonymous(`${API_VERSION_PREFIX}/agents`)

    expect(response.status).toBe(401)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('authentication_error')
  })

  it('rejects a bearer token that is not a session', async () => {
    const test = setup()

    const response = await test.anonymous(`${API_VERSION_PREFIX}/agents`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    })

    expect(response.status).toBe(401)
  })

  it('accepts the signed-in caller and scopes the listing to them', async () => {
    const test = setup()

    const response = await test.request(`${API_VERSION_PREFIX}/agents`)

    expect(response.status).toBe(200)
    expect(ListAgentsResponseSchema.parse(await response.json()).data).toEqual([])
  })

  it('accepts a bearer token (the CLI’s form) as well as the cookie', async () => {
    const test = setup()
    const { token } = await test.signIn()

    // No cookie, no default caller: exactly what `oh` sends.
    const response = await test.request(`${API_VERSION_PREFIX}/me`, {
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.status).toBe(200)
  })

  it('leaves /health open', async () => {
    const test = setup()

    expect((await test.anonymous('/health')).status).toBe(200)
  })

  it('leaves /v1/auth-config open, and reports the deployment’s sign-in', async () => {
    const test = setup({
      providers: { github: { clientId: 'gh-id', clientSecret: 'gh-secret' } },
    })

    const response = await test.anonymous(`${API_VERSION_PREFIX}/auth-config`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      providers: ['github'],
      dev_login: true,
    })
  })

  it('protects unknown /v1 routes too', async () => {
    const test = setup()

    expect((await test.anonymous(`${API_VERSION_PREFIX}/models`)).status).toBe(401)
  })

  it('rejects a cookie-authenticated write from an untrusted origin (CSRF)', async () => {
    const test = setup()
    const cookie = await signInCookie(test)

    const refused = await test.anonymous(`${API_VERSION_PREFIX}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://evil.test' },
      body: JSON.stringify({ name: 'A', model: { id: 'x/y' } }),
    })
    expect(refused.status).toBe(403)
    expect(ApiErrorBodySchema.parse(await refused.json()).error.type).toBe('permission_error')

    const allowed = await test.anonymous(`${API_VERSION_PREFIX}/agents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: TEST_PUBLIC_URL,
      },
      body: JSON.stringify({ name: 'A', model: { id: 'x/y' } }),
    })
    expect(allowed.status).toBe(201)
  })

  it('does not demand an origin from a bearer-authenticated write', async () => {
    const test = setup()

    const response = await test.request(`${API_VERSION_PREFIX}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', model: { id: 'x/y' } }),
    })

    expect(response.status).toBe(201)
  })
})

describe('CORS', () => {
  it('is off by default', async () => {
    const response = await setup().request('/health', {
      headers: { origin: 'http://localhost:5173' },
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers the configured origins', async () => {
    const test = setup()
    const app = createApp({
      store: test.store,
      scheduler: test.scheduler,
      auth: {
        instance: test.auth.auth,
        enabledProviders: test.auth.enabledProviders,
        devLogin: test.auth.config.devLogin,
        trustedOrigins: [TEST_PUBLIC_URL],
      },
      credentialRoutes: {
        credentials: test.credentials,
        vault: test.vault,
        validate: () => Promise.resolve(),
      },
      catalog: test.catalog,
      corsOrigins: ['http://localhost:5173'],
    })

    const allowed = await app.request('/health', { headers: { origin: 'http://localhost:5173' } })
    const denied = await app.request('/health', { headers: { origin: 'http://evil.test' } })

    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('static web assets', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  async function webDir(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'openharness-web-'))
    await writeFile(join(directory, 'index.html'), '<html>the app</html>')
    await writeFile(join(directory, 'app.js'), 'console.log(1)')
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'assets', 'index-a1b2c3d4.js'), 'console.log(2)')
    return directory
  }

  it('serves index.html at /', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    await expect(response.text()).resolves.toContain('the app')
  })

  it('serves a real file with its content type', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.request('/app.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
  })

  it('falls back to index.html for a path inside the app', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.request('/sessions/abc')

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('the app')
  })

  it('never serves the app for /v1', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.request(`${API_VERSION_PREFIX}/nope`)

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })

  it('refuses to climb out of the directory', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.request('/..%2f..%2fetc%2fpasswd')

    // Whatever happens, it is not the file: the app's shell, not the system's.
    await expect(response.text()).resolves.not.toContain('root:')
  })

  it('redirects the plain /device path to the app’s hash route, query and all', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.request('/device?user_code=WXYZ-1234')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/#/device?user_code=WXYZ-1234')
  })

  it('does not serve /device when there is no web app to send the reader to', async () => {
    const test = setup()

    const response = await test.request('/device?user_code=WXYZ-1234')

    expect(response.status).toBe(404)
  })

  it('answers the envelope when no web directory is configured', async () => {
    const test = setup()

    const response = await test.request('/')

    expect(response.status).toBe(404)
  })

  it('serves HEAD exactly like GET, with no body (#196)', async () => {
    const test = setup({ webDir: await webDir() })

    // The shell, a hashed asset, an SPA route and a root file: every class the server hands
    // out. A HEAD used to fall past the static fallback to the API's `404 no-store` — which
    // is what stopped Cloud CDN from caching the file the GET serves.
    for (const path of ['/', '/assets/index-a1b2c3d4.js', '/sessions/abc', '/app.js']) {
      const get = await test.request(path)
      const head = await test.request(path, { method: 'HEAD' })

      expect(get.status, path).toBe(200)
      expect(head.status, path).toBe(get.status)
      for (const header of ['content-type', 'content-length', 'cache-control']) {
        expect(head.headers.get(header), `${path} ${header}`).toBe(get.headers.get(header))
      }
      await expect(head.text(), path).resolves.toBe('')
      await expect(get.text(), path).resolves.not.toBe('')
    }
  })

  it('answers HEAD for a missing asset like the GET it falls back to', async () => {
    const test = setup({ webDir: await webDir() })

    // The request names `assets/`, the response *is* `index.html`: the same shell a GET gets,
    // headers and all, with nothing in the body.
    const get = await test.request('/assets/gone-00000000.js')
    const head = await test.request('/assets/gone-00000000.js', { method: 'HEAD' })

    expect(get.status).toBe(200)
    expect(head.status).toBe(get.status)
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'))
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
    expect(head.headers.get('cache-control')).toBe('no-cache')
    expect(head.headers.get('cache-control')).toBe(get.headers.get('cache-control'))
    await expect(head.text()).resolves.toBe('')
  })

  it('still 404s HEAD for a path with no web app behind it', async () => {
    const test = setup()

    const response = await test.request('/nothing-here', { method: 'HEAD' })

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('redirects HEAD /device the way it redirects GET', async () => {
    const test = setup({ webDir: await webDir() })

    const head = await test.request('/device?user_code=WXYZ-1234', { method: 'HEAD' })

    expect(head.status).toBe(302)
    expect(head.headers.get('location')).toBe('/#/device?user_code=WXYZ-1234')
    await expect(head.text()).resolves.toBe('')
  })
})

describe('the app is built from its parts', () => {
  it('does not share state between two instances', async () => {
    const first = createTestApp()
    const second = createTestApp()
    try {
      const agent = await httpCreateAgent(first)
      const list = await second.request(`${API_VERSION_PREFIX}/agents`)
      expect(ListAgentsResponseSchema.parse(await list.json()).data).toEqual([])
      expect(agent.id).toMatch(/^agent_/)
    } finally {
      await first.close()
      await second.close()
    }
  })
})
