import {
  CreateSessionRequestSchema,
  PutPreferencesRequestSchema,
  encodeKeyCursor,
  encodeSeqCursor,
} from '@openharness/protocol'
import {
  fixtureTimestamp,
  makeAgent,
  makeAgentMessage,
  makeListModelsResponse,
  makeProviderCredential,
  makeSession,
  makeUser,
  makeUserMessage,
  makeUserPreferences,
} from '@openharness/protocol/fixtures'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClient } from './client'
import { ApiError, AuthenticationError, ResponseValidationError } from './errors'
import { createMockFetch, errorResponse, jsonResponse } from './test-support/mock-fetch'

const BASE_URL = 'https://api.test'

/** A client whose `fetch` answers from the script the test gives it. */
function clientWith(
  handler: Parameters<typeof createMockFetch>[0],
  options: { token?: string | undefined } = { token: 'oh_test_token' },
) {
  const mock = createMockFetch(handler)
  const client = createClient({ baseUrl: BASE_URL, token: options.token, fetch: mock.fetch })
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
    expect(request?.headers.get('authorization')).toBe('Bearer oh_test_token')
    expect(request?.headers.get('content-type')).toBe('application/json')
    expect(request?.headers.get('accept')).toBe('application/json')
    expect(bodyOf(request?.init)).toEqual({
      name: 'Summarizer',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
  })

  it('asks every request to carry the session cookie', async () => {
    const { client, mock } = clientWith(() => jsonResponse(makeSession()))

    await client.sessions.get('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ')

    // The web app's way in (epic #65, A2): the cookie is sent on every request, and the
    // bearer header this client also carries does not replace it.
    expect(mock.requests[0]?.init?.credentials).toBe('include')
  })

  it('ignores a trailing slash on the base URL', async () => {
    const mock = createMockFetch(() => jsonResponse(makeAgent()))
    const client = createClient({ baseUrl: `${BASE_URL}/`, fetch: mock.fetch })

    await client.agents.get('agent_01HZZZZZZZZZZZZZZZZZZZZZZZ')

    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/agents/agent_01HZZZZZZZZZZZZZZZZZZZZZZZ`)
  })

  it('sends no authorization header when there is no token', async () => {
    const { client, mock } = clientWith(() => jsonResponse(makeSession()), { token: undefined })

    await client.sessions.get('sesn_01HZZZZZZZZZZZZZZZZZZZZZZZ')

    expect(mock.requests[0]?.headers.get('authorization')).toBeNull()
    expect(mock.requests[0]?.init?.credentials).toBe('include')
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

  it('carries a model on a user.message through sessions.events.send', async () => {
    // `UserEventInput` grew an optional `model` (#111): whatever a caller puts on an input
    // must reach the wire body unchanged.
    const stored = makeUserMessage('switch', { seq: 1, model: { id: 'openai/gpt-4.1-mini' } })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    await client.sessions.events.send('sesn_1', {
      type: 'user.message',
      content: [{ type: 'text', text: 'switch' }],
      model: { id: 'openai/gpt-4.1-mini' },
    })

    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'switch' }],
          model: { id: 'openai/gpt-4.1-mini' },
        },
      ],
    })
  })
})

describe('creating a session', () => {
  it('creates a model-first session: a model, and nothing else', async () => {
    const session = makeSession({
      agent: null,
      model: { id: 'openai/gpt-4.1-mini' },
      system: null,
    })
    const { client, mock } = clientWith(() => jsonResponse(session))

    const created = await client.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })

    const request = mock.requests[0]
    expect(request?.url).toBe(`${BASE_URL}/v1/sessions`)
    expect(request?.init?.method).toBe('POST')
    // What goes on the wire is the new protocol request (issue #93): the body the client
    // sends is one `CreateSessionRequestSchema` accepts, agent-less as it is.
    const body = bodyOf(request?.init)
    expect(body).toEqual({ model: { id: 'openai/gpt-4.1-mini' } })
    expect(CreateSessionRequestSchema.safeParse(body).success).toBe(true)
    // And the response's new fields come back typed: no agent, the model it runs, no system.
    expect(created).toEqual(session)
    expect(created.agent).toBeNull()
    expect(created.model).toEqual({ id: 'openai/gpt-4.1-mini' })
    expect(created.system).toBeNull()
  })

  it('creates a session from an agent, overriding its model and its system', async () => {
    const agent = makeAgent()
    const { client, mock } = clientWith(() => jsonResponse(makeSession({ system: null })))

    await client.sessions.create({
      agent: agent.id,
      model: { id: 'openai/gpt-4.1-mini' },
      system: null,
    })

    const body = bodyOf(mock.requests[0]?.init)
    expect(body).toEqual({
      agent: agent.id,
      model: { id: 'openai/gpt-4.1-mini' },
      system: null,
    })
    // A `null` system is a value, not an omission: the request overrides the agent's prompt.
    expect(CreateSessionRequestSchema.safeParse(body).success).toBe(true)
  })

  it('sends a title, metadata and initial events beside the model', async () => {
    const session = makeSession({ agent: null })
    const { client, mock } = clientWith(() => jsonResponse(session))

    await client.sessions.create({
      model: { id: 'openai/gpt-4.1-mini' },
      title: 'A new chat',
      metadata: { source: 'test' },
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }],
    })

    const body = bodyOf(mock.requests[0]?.init)
    expect(body).toEqual({
      model: { id: 'openai/gpt-4.1-mini' },
      title: 'A new chat',
      metadata: { source: 'test' },
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'hi' }] }],
    })
    expect(CreateSessionRequestSchema.safeParse(body).success).toBe(true)
  })
})

describe('deleting a session (#111)', () => {
  it('sends DELETE and resolves void on the 204', async () => {
    const { client, mock } = clientWith(() => new Response(null, { status: 204 }))

    await expect(client.sessions.delete('sesn_1')).resolves.toBeUndefined()
    expect(mock.requests[0]?.init?.method).toBe('DELETE')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/sessions/sesn_1`)
  })

  it('rejects an unknown or someone else’s session as a not_found_error', async () => {
    const { client } = clientWith(() => errorResponse(404, 'not_found_error', 'No such session.'))

    await expect(client.sessions.delete('sesn_missing')).rejects.toMatchObject({
      status: 404,
      type: 'not_found_error',
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

  it('turns a 401 into an AuthenticationError', async () => {
    const { client } = clientWith(() =>
      errorResponse(401, 'authentication_error', 'Not signed in.'),
    )

    const failure = client.sessions.list()
    await expect(failure).rejects.toBeInstanceOf(AuthenticationError)
    await expect(failure).rejects.toMatchObject({
      name: 'AuthenticationError',
      status: 401,
      type: 'authentication_error',
      message: 'Not signed in.',
      retryable: false,
    })
  })

  it('still makes it an AuthenticationError when the 401 body is not the envelope', async () => {
    const { client } = clientWith(
      () => new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
    )

    const failure = client.sessions.list()
    await expect(failure).rejects.toBeInstanceOf(AuthenticationError)
    await expect(failure).rejects.toBeInstanceOf(ApiError)
    await expect(failure).rejects.toMatchObject({
      status: 401,
      type: 'authentication_error',
      message: 'The request failed with HTTP status 401 Unauthorized.',
    })
  })
})

describe('the signed-in user', () => {
  it('me reads GET /v1/me and parses the user', async () => {
    const user = makeUser()
    const { client, mock } = clientWith(() => jsonResponse(user))

    const me = await client.me()

    expect(me).toEqual(user)
    expect(mock.requests[0]?.init?.method).toBe('GET')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/me`)
  })

  it('propagates the 401 as an AuthenticationError', async () => {
    const { client } = clientWith(() => errorResponse(401, 'authentication_error', 'Expired.'))

    await expect(client.me()).rejects.toBeInstanceOf(AuthenticationError)
  })
})

describe('provider credentials', () => {
  it('lists metadata only, from GET /v1/provider-credentials', async () => {
    const credential = makeProviderCredential()
    const { client, mock } = clientWith(() => jsonResponse({ data: [credential] }))

    const response = await client.providerCredentials.list()

    expect(response).toEqual({ data: [credential] })
    expect(mock.requests[0]?.init?.method).toBe('GET')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/provider-credentials`)
  })

  it('puts one credential and reads back its metadata, never the key', async () => {
    const credential = makeProviderCredential({ name: 'anthropic', last4: 'k9Z2' })
    const { client, mock } = clientWith(() => jsonResponse(credential))

    const stored = await client.providerCredentials.put('anthropic', {
      type: 'api_key',
      api_key: 'sk-ant-secret-k9Z2',
    })

    expect(stored).toEqual(credential)
    expect(JSON.stringify(stored)).not.toContain('sk-ant-secret')
    expect(mock.requests[0]?.init?.method).toBe('PUT')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/provider-credentials/anthropic`)
    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      type: 'api_key',
      api_key: 'sk-ant-secret-k9Z2',
    })
  })

  it('deletes one credential and resolves without a body', async () => {
    const { client, mock } = clientWith(() => new Response(null, { status: 204 }))

    await expect(client.providerCredentials.delete('anthropic')).resolves.toBeUndefined()
    expect(mock.requests[0]?.init?.method).toBe('DELETE')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/provider-credentials/anthropic`)
  })

  it('propagates a rejected credential as an invalid_provider_credential ApiError', async () => {
    const { client } = clientWith(() =>
      errorResponse(422, 'invalid_provider_credential', 'The anthropic key was rejected.'),
    )

    await expect(
      client.providerCredentials.put('anthropic', { type: 'api_key', api_key: 'wrong' }),
    ).rejects.toMatchObject({ status: 422, type: 'invalid_provider_credential' })
  })
})

/**
 * The transport-side half of the leak suites (the vault's own covers the crypto side): a key
 * on its way out and a token on its way in belong in the request, and nowhere else the client
 * produces — not an error's message, request id or stack, not a debug line.
 */
describe('secrets in failures', () => {
  it('keeps a rejected key out of the error, the debug hook and the stack', async () => {
    const key = 'sk-ant-api03-real-looking-9Zk42x'
    const debug: unknown[][] = []
    const mock = createMockFetch(() =>
      errorResponse(422, 'invalid_provider_credential', 'The anthropic key was rejected.'),
    )
    const client = createClient({
      baseUrl: BASE_URL,
      token: 'oh_test_token',
      fetch: mock.fetch,
      onDebug: (...args) => debug.push(args),
    })

    const failure = await client.providerCredentials
      .put('anthropic', { type: 'api_key', api_key: key })
      .catch((error: unknown) => error)

    // The request is where the key belongs — that is the API's contract.
    expect(bodyOf(mock.requests[0]?.init)).toEqual({ type: 'api_key', api_key: key })
    expect(mock.requests[0]?.url).not.toContain(key)
    // Everything the client hands back is checked for it — the message, the request id, the
    // stack, the stringified error, and whatever the debug hook was told.
    expect(failure).toBeInstanceOf(ApiError)
    const report = [
      String(failure),
      (failure as ApiError).requestId ?? '',
      (failure as ApiError).stack ?? '',
      JSON.stringify(debug),
    ].join('\n')
    expect(report).not.toContain(key)
    expect(report).not.toContain('9Zk42x')
  })

  it('keeps the bearer token out of a failure the server answers', async () => {
    const token = 'oh_session_real-looking-token-42'
    const debug: unknown[][] = []
    const mock = createMockFetch(() => errorResponse(500, 'api_error', 'Boom.'))
    const client = createClient({
      baseUrl: BASE_URL,
      token,
      fetch: mock.fetch,
      onDebug: (...args) => debug.push(args),
    })

    const failure = await client.me().catch((error: unknown) => error)

    // The token authenticates the request — that is its job — and nothing the failure says
    // repeats it.
    expect(mock.requests[0]?.headers.get('authorization')).toBe(`Bearer ${token}`)
    const report = [String(failure), (failure as ApiError).stack ?? '', JSON.stringify(debug)].join(
      '\n',
    )
    expect(report).not.toContain(token)
    expect(report).not.toContain('real-looking-token')
  })
})

describe('preferences (#111)', () => {
  it('reads GET /v1/me/preferences and parses the value', async () => {
    const preferences = makeUserPreferences({ default_model: 'anthropic/claude-sonnet-5' })
    const { client, mock } = clientWith(() => jsonResponse(preferences))

    const response = await client.preferences.get()

    expect(response).toEqual(preferences)
    expect(mock.requests[0]?.init?.method).toBe('GET')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/me/preferences`)
  })

  it('reads the absence of a default model as null, not a 404', async () => {
    const { client } = clientWith(() => jsonResponse({ default_model: null, theme: 'system' }))

    await expect(client.preferences.get()).resolves.toEqual({
      default_model: null,
      theme: 'system',
    })
  })

  it('puts the whole value to PUT /v1/me/preferences and reads back the stored one', async () => {
    const stored = makeUserPreferences({ default_model: 'openai/gpt-4.1-mini' })
    const { client, mock } = clientWith(() => jsonResponse(stored))

    const response = await client.preferences.put({ default_model: 'openai/gpt-4.1-mini' })

    expect(response).toEqual(stored)
    expect(mock.requests[0]?.init?.method).toBe('PUT')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/me/preferences`)
    const body = bodyOf(mock.requests[0]?.init)
    expect(body).toEqual({ default_model: 'openai/gpt-4.1-mini' })
    expect(PutPreferencesRequestSchema.safeParse(body).success).toBe(true)
  })

  it('clears the default with null, which is a value the request schema accepts', async () => {
    const { client, mock } = clientWith(() =>
      jsonResponse({ default_model: null, theme: 'system' }),
    )

    await client.preferences.put({ default_model: null })

    const body = bodyOf(mock.requests[0]?.init)
    expect(body).toEqual({ default_model: null })
    expect(PutPreferencesRequestSchema.safeParse(body).success).toBe(true)
  })

  it('surfaces a refused value as an ApiError', async () => {
    const { client } = clientWith(() =>
      errorResponse(400, 'invalid_request_error', 'default_model: invalid shape'),
    )

    await expect(client.preferences.put({ default_model: 'not a model' })).rejects.toMatchObject({
      status: 400,
      type: 'invalid_request_error',
    })
  })

  it('propagates the 401 as an AuthenticationError', async () => {
    const { client } = clientWith(() => errorResponse(401, 'authentication_error', 'Expired.'))

    await expect(client.preferences.get()).rejects.toBeInstanceOf(AuthenticationError)
  })
})

describe('the model catalog', () => {
  it('lists from GET /v1/models and parses the response', async () => {
    const catalog = makeListModelsResponse()
    const { client, mock } = clientWith(() => jsonResponse(catalog))

    const response = await client.models.list()

    expect(response).toEqual(catalog)
    expect(mock.requests[0]?.init?.method).toBe('GET')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/models`)
    // No `refresh`, no query at all: a plain read is the cached one (C4).
    expect(new URL(mock.urlOf(0)).search).toBe('')
  })

  it('sends refresh=true only when a refresh was asked for', async () => {
    const { client, mock } = clientWith(() => jsonResponse(makeListModelsResponse()))

    await client.models.list()
    await client.models.list({})
    await client.models.list({ refresh: false })
    await client.models.list({ refresh: true })

    for (const request of mock.requests.slice(0, 3)) {
      expect(new URL(request.url).searchParams.has('refresh')).toBe(false)
    }
    expect(new URL(mock.urlOf(3)).searchParams.get('refresh')).toBe('true')
  })

  it('throws a validation error when the answer is not a catalog', async () => {
    const { client } = clientWith(() => jsonResponse({ data: [makeListModelsResponse().data[0]] }))

    await expect(client.models.list()).rejects.toBeInstanceOf(ResponseValidationError)
  })

  it('surfaces a too-frequent refresh as a retryable rate_limit_error', async () => {
    const { client } = clientWith(() =>
      errorResponse(429, 'rate_limit_error', 'Refreshed too recently; try again in a minute.'),
    )

    const failure = client.models.list({ refresh: true })
    await expect(failure).rejects.toMatchObject({
      status: 429,
      type: 'rate_limit_error',
      retryable: true,
    })
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

  it('sendMessage posts the model beside the text when one is given (#111)', async () => {
    const stored = makeUserMessage('switch model', { seq: 7, model: { id: 'openai/gpt-4.1-mini' } })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    const message = await client.sendMessage('sesn_1', 'switch model', {
      model: { id: 'openai/gpt-4.1-mini' },
    })

    expect(message).toEqual(stored)
    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'switch model' }],
          model: { id: 'openai/gpt-4.1-mini' },
        },
      ],
    })
  })

  it('sendMessage posts the reasoning effort beside the text when one is given (#252)', async () => {
    const stored = makeUserMessage('think hard', { seq: 7, reasoning_effort: 'high' })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    const message = await client.sendMessage('sesn_1', 'think hard', { reasoningEffort: 'high' })

    expect(message).toEqual(stored)
    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'think hard' }],
          reasoning_effort: 'high',
        },
      ],
    })
  })

  it('sendMessage posts an explicit null effort: "back to the provider default" (#252)', async () => {
    const stored = makeUserMessage('never mind', { seq: 7, reasoning_effort: null })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    await client.sendMessage('sesn_1', 'never mind', { reasoningEffort: null })

    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'never mind' }],
          reasoning_effort: null,
        },
      ],
    })
  })

  it('sendMessage rewinds the session in the same request as the edit (#238)', async () => {
    const stored = makeUserMessage('write a haiku about snow', { seq: 10 })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    const message = await client.sendMessage('sesn_1', 'write a haiku about snow', { rewindTo: 5 })

    expect(message).toEqual(stored)
    // One request, one batch: the rewind is the first event, so an append that stores either
    // stores both — and `data` carries the message alone, because the rewind's event is the
    // server's.
    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [
        { type: 'session.rewind', from_seq: 5 },
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'write a haiku about snow' }],
        },
      ],
    })
  })

  it('sendMessage carries a rewind and a model switch in one batch (#238)', async () => {
    const stored = makeUserMessage('again', { seq: 10, model: { id: 'openai/gpt-4.1-mini' } })
    const { client, mock } = clientWith(() => jsonResponse({ data: [stored] }))

    await client.sendMessage('sesn_1', 'again', {
      rewindTo: 5,
      model: { id: 'openai/gpt-4.1-mini' },
    })

    expect(bodyOf(mock.requests[0]?.init)).toEqual({
      events: [
        { type: 'session.rewind', from_seq: 5 },
        {
          type: 'user.message',
          content: [{ type: 'text', text: 'again' }],
          model: { id: 'openai/gpt-4.1-mini' },
        },
      ],
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

describe('usage (#247)', () => {
  const totals = {
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const entry = {
    model: 'anthropic/claude-sonnet-5',
    usage: totals,
    requests: 2,
    cost: 0.0045,
    unpriced_requests: 0,
  }

  it('reads one session’s usage from GET /v1/sessions/{id}/usage', async () => {
    const usage = {
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: 0.0045,
      unpriced_requests: 0,
      by_model: [entry],
    }
    const { client, mock } = clientWith(() => jsonResponse(usage))

    await expect(client.usage.session(usage.session_id)).resolves.toEqual(usage)
    expect(mock.requests[0]?.init?.method).toBe('GET')
    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/sessions/${usage.session_id}/usage`)
  })

  it('reads the caller’s own usage, with the range and zone it was given', async () => {
    const usage = {
      from: '2026-10-01',
      to: '2026-10-08',
      tz: 'Asia/Kolkata',
      totals,
      cost: 0.0045,
      unpriced_requests: 0,
      by_model: [entry],
      by_day: [{ day: '2026-10-08', totals, cost: 0.0045, unpriced_requests: 0 }],
    }
    const { client, mock } = clientWith(() => jsonResponse(usage))

    await expect(
      client.usage.me({ from: '2026-10-01', to: '2026-10-08', tz: 'Asia/Kolkata' }),
    ).resolves.toEqual(usage)
    expect(mock.requests[0]?.init?.method).toBe('GET')
    expect(mock.urlOf(0)).toBe(
      `${BASE_URL}/v1/me/usage?from=2026-10-01&to=2026-10-08&tz=Asia%2FKolkata`,
    )
  })

  it('leaves the parameters off the wire when none were given, so the server defaults apply', async () => {
    const { client, mock } = clientWith(() =>
      jsonResponse({
        from: '2026-10-01',
        to: '2026-10-08',
        tz: 'UTC',
        totals,
        cost: 0.0045,
        unpriced_requests: 0,
        by_model: [entry],
        by_day: [],
      }),
    )

    await client.usage.me()

    expect(mock.urlOf(0)).toBe(`${BASE_URL}/v1/me/usage`)
  })

  it('reads a total that sums the priced requests and counts the unpriced ones', async () => {
    // The 2026-10-09 decision (#247): the money is what the priced requests came to, and
    // `unpriced_requests` is how many were left out — never a `null` whole answer.
    const usage = {
      session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
      totals,
      cost: 0.0045,
      unpriced_requests: 3,
      by_model: [entry, { ...entry, model: 'acme/mystery-1', cost: null, unpriced_requests: 3 }],
    }
    const { client } = clientWith(() => jsonResponse(usage))

    const parsed = await client.usage.session(usage.session_id)
    expect(parsed.cost).toBeCloseTo(0.0045, 10)
    expect(parsed.unpriced_requests).toBe(3)
    expect(parsed.by_model[1]?.unpriced_requests).toBe(3)
  })

  it('reads an unknown cost as null, never as a number, and names what was left out', async () => {
    const { client } = clientWith(() =>
      jsonResponse({
        session_id: 'sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7',
        totals,
        cost: null,
        unpriced_requests: 2,
        by_model: [{ ...entry, cost: null, unpriced_requests: 2 }],
      }),
    )

    const usage = await client.usage.session('sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7')
    expect(usage.cost).toBeNull()
    expect(usage.unpriced_requests).toBe(2)
    expect(usage.by_model[0]?.cost).toBeNull()
    expect(usage.totals.input_tokens).toBe(1000)
  })

  it('propagates another user’s session as the not_found_error it is', async () => {
    const { client } = clientWith(() => errorResponse(404, 'not_found_error', 'no session'))

    await expect(client.usage.session('sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7')).rejects.toMatchObject({
      status: 404,
      type: 'not_found_error',
    })
  })
})
