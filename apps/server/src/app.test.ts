import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  API_KEY_HEADER,
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
} from '@openharness/protocol'

import { createApp } from './app'
import {
  createTestApp,
  httpCreateAgent,
  httpCreateSession,
  httpSendMessage,
  readHistory,
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

/** Read one session over HTTP, checked against the protocol's schema. */
async function readSession(test: TestContext, sessionId: SessionId): Promise<Session> {
  const response = await test.app.request(`${API_VERSION_PREFIX}/sessions/${sessionId}`)
  return SessionSchema.parse(await response.json())
}

/** Post events to a session over HTTP and return the response. */
async function postEvents(
  test: TestContext,
  sessionId: SessionId,
  events: readonly unknown[],
): Promise<Response> {
  return test.app.request(`${API_VERSION_PREFIX}/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  })
}

describe('GET /health', () => {
  it('answers with the health payload and needs no key', async () => {
    const app = setup({ apiKey: 'oh_secret' }).app

    const response = await app.request('/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })
})

describe('request ids', () => {
  it('puts a request-id on a successful response', async () => {
    const response = await setup().app.request('/health')

    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^req_/)
  })

  it('repeats the request id in an error body', async () => {
    const response = await setup().app.request(`${API_VERSION_PREFIX}/agents/agent_nope`)

    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.request_id).toBe(response.headers.get(REQUEST_ID_HEADER) ?? undefined)
  })
})

describe('the agents API', () => {
  it('creates an agent and returns it in the protocol shape', async () => {
    const response = await setup().app.request(`${API_VERSION_PREFIX}/agents`, {
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

    const response = await test.app.request(`${API_VERSION_PREFIX}/agents/${agent.id}`)

    expect(response.status).toBe(200)
    expect(AgentSchema.parse(await response.json())).toEqual(agent)
  })

  it('lists agents, oldest first, in the list envelope', async () => {
    const test = setup()
    const first = await httpCreateAgent(test, { name: 'First' })
    const second = await httpCreateAgent(test, { name: 'Second' })

    const response = await test.app.request(`${API_VERSION_PREFIX}/agents`)

    const page = ListAgentsResponseSchema.parse(await response.json())
    expect(page.data.map((agent) => agent.id)).toEqual([first.id, second.id])
    expect(page.next_page).toBeNull()
  })

  it('updates an agent and leaves the omitted fields alone', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test, { name: 'Before' })

    const response = await test.app.request(`${API_VERSION_PREFIX}/agents/${agent.id}`, {
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
    const response = await setup().app.request(
      `${API_VERSION_PREFIX}/agents/agent_01HZZZZZZZZZZZZZZZZZZZZZZZ`,
    )

    expect(response.status).toBe(404)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('not_found_error')
  })

  it('answers 404 for an unknown agent on update', async () => {
    const response = await setup().app.request(
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
    const response = await setup().app.request(`${API_VERSION_PREFIX}/agents/not-an-id`)

    expect(response.status).toBe(400)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('answers 400 for a body that does not match the schema', async () => {
    const response = await setup().app.request(`${API_VERSION_PREFIX}/agents`, {
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
    const response = await setup().app.request(`${API_VERSION_PREFIX}/agents`, {
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

    const response = await test.app.request(`${API_VERSION_PREFIX}/sessions`, {
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
    const response = await setup().app.request(`${API_VERSION_PREFIX}/sessions`, {
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

    const one = await test.app.request(`${API_VERSION_PREFIX}/sessions/${session.id}`)
    expect(one.status).toBe(200)
    expect(SessionSchema.parse(await one.json())).toEqual(session)

    const list = await test.app.request(`${API_VERSION_PREFIX}/sessions?agent_id=${agent.id}`)
    const page = ListSessionsResponseSchema.parse(await list.json())
    expect(page.data.map((entry) => entry.id)).toEqual([session.id])
  })

  it('filters sessions by another agent out', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const other = await httpCreateAgent(test, { name: 'Other' })
    await httpCreateSession(test, agent.id)

    const list = await test.app.request(`${API_VERSION_PREFIX}/sessions?agent_id=${other.id}`)

    expect(ListSessionsResponseSchema.parse(await list.json()).data).toEqual([])
  })

  it('answers 404 for a session that does not exist', async () => {
    const response = await setup().app.request(
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
    const response = await setup().app.request(`${API_VERSION_PREFIX}/sessions/nope`)

    expect(response.status).toBe(400)
  })
})

describe('the events API', () => {
  it('stores a user message and returns it in the response envelope', async () => {
    const test = setup()
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)

    const response = await test.app.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
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

    const response = await test.app.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
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

    const response = await test.app.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 'agent.message', content: [] }] }),
    })

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })

  it('answers 404 for an unknown session on append and on read', async () => {
    const app = setup().app
    const missing = 'sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ'

    const appended = await app.request(`${API_VERSION_PREFIX}/sessions/${missing}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'x' }] }],
      }),
    })
    const read = await app.request(`${API_VERSION_PREFIX}/sessions/${missing}/events`)

    expect(appended.status).toBe(404)
    expect(read.status).toBe(404)
  })

  it('lists the log with types[] and after_seq', async () => {
    const test = setup({ replies: [{ text: ['Answer'] }] })
    const agent = await httpCreateAgent(test)
    const session = await httpCreateSession(test, agent.id)
    await test.app.request(`${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.message', content: [{ type: 'text', text: 'Hello' }] }],
      }),
    })
    await test.model.waitForRequests(1)
    await waitForIdle(test.store, session.id)

    const filtered = await test.app.request(
      `${API_VERSION_PREFIX}/sessions/${session.id}/events?types[]=agent.message`,
    )
    const page = ListEventsResponseSchema.parse(await filtered.json())
    expect(page.data.map((event) => event.type)).toEqual(['agent.message'])

    const afterFirst = await test.app.request(
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

    const response = await test.app.request(
      `${API_VERSION_PREFIX}/sessions/${session.id}/events?page=page_${keyCursor}`,
    )

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
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
    const response = await setup().app.request(`${API_VERSION_PREFIX}/models`)

    expect(response.status).toBe(404)
    const body = ApiErrorBodySchema.parse(await response.json())
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('not_found_error')
  })

  it('answer 404 outside the API too', async () => {
    const response = await setup().app.request('/nothing-here')

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })
})

describe('auth', () => {
  const key = 'oh_test_key'

  it('rejects a request with no key', async () => {
    const test = setup({ apiKey: key })

    const response = await test.app.request(`${API_VERSION_PREFIX}/agents`)

    expect(response.status).toBe(401)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('authentication_error')
  })

  it('rejects a wrong key', async () => {
    const test = setup({ apiKey: key })

    const response = await test.app.request(`${API_VERSION_PREFIX}/agents`, {
      headers: { [API_KEY_HEADER]: 'oh_wrong' },
    })

    expect(response.status).toBe(401)
  })

  it('accepts the right key', async () => {
    const test = setup({ apiKey: key })

    const response = await test.app.request(`${API_VERSION_PREFIX}/agents`, {
      headers: { [API_KEY_HEADER]: key },
    })

    expect(response.status).toBe(200)
    expect(ListAgentsResponseSchema.parse(await response.json()).data).toEqual([])
  })

  it('leaves /health open', async () => {
    const test = setup({ apiKey: key })

    expect((await test.app.request('/health')).status).toBe(200)
  })

  it('protects unknown /v1 routes too', async () => {
    const test = setup({ apiKey: key })

    expect((await test.app.request(`${API_VERSION_PREFIX}/models`)).status).toBe(401)
  })
})

describe('CORS', () => {
  it('is off by default', async () => {
    const response = await setup().app.request('/health', {
      headers: { origin: 'http://localhost:5173' },
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers the configured origins', async () => {
    const test = setup()
    const app = createApp({
      store: test.store,
      scheduler: test.scheduler,
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
    return directory
  }

  it('serves index.html at /', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.app.request('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    await expect(response.text()).resolves.toContain('the app')
  })

  it('serves a real file with its content type', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.app.request('/app.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
  })

  it('falls back to index.html for a path inside the app', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.app.request('/sessions/abc')

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('the app')
  })

  it('never serves the app for /v1', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.app.request(`${API_VERSION_PREFIX}/nope`)

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })

  it('refuses to climb out of the directory', async () => {
    const test = setup({ webDir: await webDir() })

    const response = await test.app.request('/..%2f..%2fetc%2fpasswd')

    // Whatever happens, it is not the file: the app's shell, not the system's.
    await expect(response.text()).resolves.not.toContain('root:')
  })

  it('answers the envelope when no web directory is configured', async () => {
    const test = setup()

    const response = await test.app.request('/')

    expect(response.status).toBe(404)
  })
})

describe('the app is built from its parts', () => {
  it('does not share state between two instances', async () => {
    const first = createTestApp()
    const second = createTestApp()
    try {
      const agent = await httpCreateAgent(first)
      const list = await second.app.request(`${API_VERSION_PREFIX}/agents`)
      expect(ListAgentsResponseSchema.parse(await list.json()).data).toEqual([])
      expect(agent.id).toMatch(/^agent_/)
    } finally {
      await first.close()
      await second.close()
    }
  })
})
