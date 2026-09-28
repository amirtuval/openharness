import { encodeKeyCursor, encodeSeqCursor } from '@openharness/protocol'
import {
  fixtureTimestamp,
  makeAgent,
  makeAgentMessage,
  makeSession,
  makeUserMessage,
} from '@openharness/protocol/fixtures'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from './client'
import { ApiError, ResponseValidationError } from './errors'
import { createMockFetch, errorResponse, jsonResponse } from './test-support/mock-fetch'

const BASE_URL = 'https://api.test'

/** A client whose `fetch` answers from the script the test gives it. */
function clientWith(
  handler: Parameters<typeof createMockFetch>[0],
  options: { apiKey?: string | undefined } = { apiKey: 'oh_test_key' },
) {
  const mock = createMockFetch(handler)
  const client = createClient({ baseUrl: BASE_URL, apiKey: options.apiKey, fetch: mock.fetch })
  return { client, mock }
}

/** The JSON body of a recorded request. */
function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body
  return JSON.parse(typeof body === 'string' ? body : '') as unknown
}

describe('request building', () => {
  it('creates an agent with the documented headers and body', async () => {
    const agent = makeAgent()
    const { client, mock } = clientWith(() => jsonResponse(agent))

    const created = await client.agents.create({
      name: 'Summarizer',
      model: { id: 'anthropic/claude-sonnet-5' },
    })

    expect(created).toEqual(agent)
    expect(mock.requests).toHaveLength(1)
    const request = mock.requests[0]
    expect(request?.url).toBe(`${BASE_URL}/v1/agents`)
    expect(request?.init?.method).toBe('POST')
    expect(request?.headers.get('x-api-key')).toBe('oh_test_key')
    expect(request?.headers.get('content-type')).toBe('application/json')
    expect(request?.headers.get('accept')).toBe('application/json')
    expect(bodyOf(request?.init)).toEqual({
      name: 'Summarizer',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
  })

  it('ignores a trailing slash on the base URL', async () => {
    const mock = createMockFetch(() => jsonResponse(makeAgent()))
    const client = createClient({ baseUrl: `${BASE_URL}/`, fetch: mock.fetch })

    await client.agents.get('agent_01HZZZZZZZZZZZZZZZZZZZZZZZ')

    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/agents/agent_01HZZZZZZZZZZZZZZZZZZZZZZZ`)
  })

  it('sends no api key header when there is no key', async () => {
    const { client, mock } = clientWith(() => jsonResponse(makeSession()), { apiKey: undefined })

    await client.sessions.get('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ')

    expect(mock.requests[0]?.headers.get('x-api-key')).toBeNull()
  })

  it('passes a page cursor through untouched', async () => {
    const cursor = encodeKeyCursor({
      created_at: fixtureTimestamp(3),
      id: 'agent_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    })
    const { client, mock } = clientWith(() => jsonResponse({ data: [], next_page: null }))

    await client.agents.list({ limit: 5, page: cursor })

    const query = new URL(mock.urlOf(0)).searchParams
    expect(query.get('limit')).toBe('5')
    expect(query.get('page')).toBe(cursor)
  })

  it('spells array query parameters the way the protocol documents', async () => {
    const { client, mock } = clientWith(() => jsonResponse({ data: [], next_page: null }))

    await client.sessions.events.list('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ', {
      limit: 10,
      order: 'asc',
      types: ['user.message', 'agent.message'],
      after_seq: 0,
    })

    const url = mock.urlOf(0)
    expect(url).toContain('types[]=user.message&types[]=agent.message')
    expect(url).toContain('after_seq=0')
    expect(url).toContain(`limit=10`)
    expect(url).toContain(`order=asc`)
  })

  it('posts user events as an array, whether given one or many', async () => {
    const stored = makeUserMessage('hi', { seq: 1 })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    await client.sessions.events.send('sesn_1', {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    })

    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }],
    })

    await client.sessions.events.send('sesn_1', [
      { type: 'user.message', content: [{ type: 'text', text: 'one' }] },
      { type: 'user.interrupt' },
    ])

    expect(bodyOf(mock.requests[1]?.init)).toEqual({
      events: [
        { type: 'user.message', content: [{ type: 'text', text: 'one' }] },
        { type: 'user.interrupt' },
      ],
    })
  })
})

describe('response parsing', () => {
  it('parses a list envelope', async () => {
    const session = makeSession()
    const { client } = clientWith(() => jsonResponse({ data: [session], next_page: 'page_abc' }))

    const response = await client.sessions.list()

    expect(response.data).toEqual([session])
    expect(response.next_page).toBe('page_abc')
  })

  it('strips fields the protocol does not know', async () => {
    const agent = makeAgent()
    const { client } = clientWith(() =>
      jsonResponse({ ...agent, version: 3, mcp_servers: [{ url: 'https://mcp.test' }] }),
    )

    const parsed = await client.agents.get(agent.id)

    expect(parsed).toEqual(agent)
    expect(parsed).not.toHaveProperty('version')
  })

  it('throws a validation error, not a half-typed object, when the body does not match', async () => {
    const { client } = clientWith(() => jsonResponse({ id: 'agent_1' }))

    const failure = client.agents.get('agent_1')
    await expect(failure).rejects.toBeInstanceOf(ResponseValidationError)
    await expect(failure).rejects.toMatchObject({ status: 200 })
  })

  it('rejects a body that is not JSON at all', async () => {
    const { client } = clientWith(() => new Response('<html>hello</html>', { status: 200 }))

    await expect(client.sessions.list()).rejects.toBeInstanceOf(ResponseValidationError)
  })
})

describe('errors', () => {
  it('turns a non-2xx answer into an ApiError', async () => {
    const { client } = clientWith(() =>
      errorResponse(404, 'not_found_error', 'No such session.', 'req_123'),
    )

    const failure = client.sessions.get('sesn_missing')
    await expect(failure).rejects.toBeInstanceOf(ApiError)
    await expect(failure).rejects.toMatchObject({
      status: 404,
      type: 'not_found_error',
      message: 'No such session.',
      requestId: 'req_123',
    })
  })

  it('reads the request id from the header when the body omits it', async () => {
    const mock = createMockFetch(
      () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }),
          {
            status: 500,
            headers: { 'content-type': 'application/json', 'request-id': 'req_header' },
          },
        ),
    )
    const client = createClient({ baseUrl: BASE_URL, fetch: mock.fetch })

    await expect(client.agents.list()).rejects.toMatchObject({ requestId: 'req_header' })
  })

  it('still types an error whose body is not the envelope', async () => {
    const { client } = clientWith(() => new Response('gateway timeout', { status: 504 }))

    await expect(client.sessions.list()).rejects.toMatchObject({
      status: 504,
      type: 'timeout_error',
      retryable: true,
    })
  })

  it('passes a fetch rejection through untouched', async () => {
    const boom = new TypeError('Failed to fetch')
    const { client } = clientWith(() => {
      throw boom
    })

    await expect(client.agents.list()).rejects.toBe(boom)
  })
})

describe('helpers', () => {
  it('sendMessage posts one text block and returns the stored event', async () => {
    const stored = makeUserMessage('Hello agent', { seq: 7 })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    const message = await client.sendMessage('sesn_1', 'Hello agent')

    expect(message).toEqual(stored)
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/sessions/sesn_1/events`)
    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'Hello agent' }] }],
    })
  })

  it('sendMessage fails loudly when the answer does not carry the message', async () => {
    const { client } = clientWith(() =>
      jsonResponse({ data: [makeAgentMessage('not what we sent')] }),
    )

    await expect(client.sendMessage('sesn_1', 'hi')).rejects.toBeInstanceOf(ResponseValidationError)
  })

  it('interrupt posts a user.interrupt event', async () => {
    const stored = {
      id: 'sevt_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      type: 'user.interrupt',
      seq: 9,
      processed_at: null,
    }
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    const event = await client.interrupt('sesn_1')

    expect(event).toEqual(stored)
    expect(bodyOf(mock.requests[0]?.init)).toEqual({ events: [{ type: 'user.interrupt' }] })
  })
})

describe('paging', () => {
  it('walks every page of the event log, carrying the cursor', async () => {
    const first = [makeUserMessage('one', { seq: 1 }), makeUserMessage('two', { seq: 2 })]
    const second = [makeUserMessage('three', { seq: 3 })]
    const pages = [
      { data: first, next_page: encodeSeqCursor(2) },
      { data: second, next_page: null },
    ]
    const { client, mock } = clientWith((_request, call) => jsonResponse(pages[call]))

    const events = []
    for await (const event of client.sessions.events.iterate('sesn_1', { limit: 2 })) {
      events.push(event)
    }

    expect(events).toEqual([...first, ...second])
    expect(new URL(mock.urlOf(1)).searchParams.get('page')).toBe(encodeSeqCursor(2))
  })

  it('stops when the server repeats a cursor instead of looping forever', async () => {
    const stuck = encodeSeqCursor(1)
    const { client, mock } = clientWith(() =>
      jsonResponse({ data: [makeUserMessage('one', { seq: 1 })], next_page: stuck }),
    )

    const events = []
    for await (const event of client.sessions.events.iterate('sesn_1')) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(mock.requests).toHaveLength(2)
  })
})

describe('the default fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is the global fetch, called with the right receiver', async () => {
    const agent = makeAgent()
    const stub = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis)
      return Promise.resolve(jsonResponse(agent))
    })
    vi.stubGlobal('fetch', stub)
    const client = createClient({ baseUrl: BASE_URL })

    await client.agents.get(agent.id)

    expect(stub).toHaveBeenCalledTimes(1)
  })
})
