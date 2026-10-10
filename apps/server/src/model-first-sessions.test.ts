import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  ListSessionsResponseSchema,
  SessionSchema,
} from '@openharness/protocol'
import { InMemoryCredentialStore, InMemorySessionStore } from '@openharness/session'
import { createVault, envKeyProvider } from '@openharness/vault'

import { createSessionCredentialResolver } from './credentials'
import {
  TEST_SECRETS_KEY,
  createScriptedModel,
  createTestApp,
  httpCreateAgent,
  postJson,
  postJsonAs,
  readHistory,
  waitForIdle,
} from './test-support'

/**
 * Model-first sessions (epic #92, issue #94): `POST /v1/sessions` takes an agent and/or an
 * inline model, the effective `model`/`system` is what the session stores, `agent` is `null`
 * for a session created from a model alone — and a turn on one runs that model with its
 * owner's credential.
 */

/** A distinctive key, so "the owner's credential" is a fact the assertions can point at. */
const SECRET = 'sk-model-first-do-not-log-me-424242424242'

/** `PUT /v1/provider-credentials/{provider}` as the context's default caller. */
function putCredential(
  test: ReturnType<typeof createTestApp>,
  provider: string,
  apiKey: string,
): Promise<Response> {
  return test.request(`${API_VERSION_PREFIX}/provider-credentials/${provider}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'api_key', api_key: apiKey }),
  })
}

describe('creating a session from a model', () => {
  it('stores the inline model and system, with no agent and no stored credential', async () => {
    const test = createTestApp()

    const response = await postJson(test, `${API_VERSION_PREFIX}/sessions`, {
      model: { id: 'openai/gpt-5.1' },
      // The title fallback (#29) reads the first message, not the agent — it names a
      // model-first session exactly as it names an agent-based one.
      initial_events: [
        { type: 'user.message', content: [{ type: 'text', text: 'Name me\nand more' }] },
      ],
    })

    expect(response.status).toBe(201)
    const session = SessionSchema.parse(await response.json())
    expect(session.agent).toBeNull()
    expect(session.model).toEqual({ id: 'openai/gpt-5.1' })
    expect(session.system).toBeNull()
    expect(session.title).toBe('Name me')
    // No provider was called and no credential exists for OpenAI: creating a session is a
    // store write, and a missing key is the turn's problem (`missing_provider_credential`).
    expect(await test.credentials.list({ userId: session.owner_id })).toEqual([])
  })

  it('copies the agent’s model and system, and snapshots the agent', async () => {
    const test = createTestApp()
    const agent = await httpCreateAgent(test, {
      model: { id: 'openai/gpt-5.1' },
      system: 'The agent system.',
    })

    const response = await postJson(test, `${API_VERSION_PREFIX}/sessions`, { agent: agent.id })

    expect(response.status).toBe(201)
    const session = SessionSchema.parse(await response.json())
    expect(session.model).toEqual({ id: 'openai/gpt-5.1' })
    expect(session.system).toBe('The agent system.')
    expect(session.agent).toEqual({
      id: agent.id,
      name: agent.name,
      model: { id: 'openai/gpt-5.1' },
      system: 'The agent system.',
    })
  })

  it('lets an inline model and system override what the agent contributes', async () => {
    const test = createTestApp()
    const agent = await httpCreateAgent(test, {
      model: { id: 'openai/gpt-5.1' },
      system: 'The agent system.',
    })

    const overridden = await postJson(test, `${API_VERSION_PREFIX}/sessions`, {
      agent: agent.id,
      model: { id: 'anthropic/claude-sonnet-5' },
      system: 'The session system.',
    })
    expect(overridden.status).toBe(201)
    const first = SessionSchema.parse(await overridden.json())
    expect(first.model).toEqual({ id: 'anthropic/claude-sonnet-5' })
    expect(first.system).toBe('The session system.')
    // The snapshot is where the session came from, not what it runs: the agent's own values.
    expect(first.agent).toEqual({
      id: agent.id,
      name: agent.name,
      model: { id: 'openai/gpt-5.1' },
      system: 'The agent system.',
    })

    // An override is per field: a session naming only a model keeps the agent's system.
    const partial = await postJson(test, `${API_VERSION_PREFIX}/sessions`, {
      agent: agent.id,
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const second = SessionSchema.parse(await partial.json())
    expect(second.model).toEqual({ id: 'anthropic/claude-sonnet-5' })
    expect(second.system).toBe('The agent system.')
  })

  it('round-trips agent: null with its model and system through GET and the list', async () => {
    const test = createTestApp()
    const created = SessionSchema.parse(
      await (
        await postJson(test, `${API_VERSION_PREFIX}/sessions`, {
          model: { id: 'openai/gpt-5.1' },
          system: 'Be nice.',
        })
      ).json(),
    )

    const one = await test.request(`${API_VERSION_PREFIX}/sessions/${created.id}`)
    const read = SessionSchema.parse(await one.json())
    expect(read).toEqual(created)
    expect(read.agent).toBeNull()
    expect(read.model).toEqual({ id: 'openai/gpt-5.1' })
    expect(read.system).toBe('Be nice.')

    const list = await test.request(`${API_VERSION_PREFIX}/sessions`)
    const page = ListSessionsResponseSchema.parse(await list.json())
    const listed = page.data.find((session) => session.id === created.id)
    expect(listed).toEqual(created)
    expect(listed?.agent).toBeNull()
  })
})

describe('the requests POST /v1/sessions refuses', () => {
  it('answers 400 when neither an agent nor a model is given', async () => {
    const response = await postJson(createTestApp(), `${API_VERSION_PREFIX}/sessions`, {
      title: 'A chat',
    })

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
  })

  it.each(['gpt-5.1', '/gpt-5.1', 'openai/', 'openai//gpt-5.1', ''])(
    'answers 400 for the malformed model id %j',
    async (id) => {
      const response = await postJson(createTestApp(), `${API_VERSION_PREFIX}/sessions`, {
        model: { id },
      })

      expect(response.status).toBe(400)
      expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe(
        'invalid_request_error',
      )
    },
  )

  it('answers 404 for another user’s agent', async () => {
    const test = createTestApp()
    const agent = await httpCreateAgent(test)
    const other = await test.signIn('somebody-else@example.com')

    const response = await postJsonAs(test, other.token, `${API_VERSION_PREFIX}/sessions`, {
      agent: agent.id,
    })

    expect(response.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('not_found_error')
  })
})

describe('a turn on a model-first session', () => {
  it('runs the session’s model, with the owner’s credential for its provider', async () => {
    const store = new InMemorySessionStore()
    const credentials = new InMemoryCredentialStore()
    const vault = createVault(envKeyProvider(TEST_SECRETS_KEY))
    const scripted = createScriptedModel({ text: ['Hi there'] })
    // What each model request was built with: the id the brain read and the key it resolved.
    const requests: { readonly modelId: string; readonly apiKey: string }[] = []
    const test = createTestApp({
      store,
      credentials,
      vault,
      resolveCredential: createSessionCredentialResolver({ store, credentials, vault }),
      model: (modelId, credential) => {
        requests.push({
          modelId,
          apiKey: credential.type === 'api_key' ? credential.apiKey : '',
        })
        return scripted.factory(modelId, credential)
      },
    })
    // The owner's key exists for Anthropic only — the provider the session's model names.
    expect((await putCredential(test, 'anthropic', SECRET)).status).toBe(200)

    const session = SessionSchema.parse(
      await (
        await postJson(test, `${API_VERSION_PREFIX}/sessions`, {
          model: { id: 'anthropic/claude-sonnet-5' },
          system: 'Be terse.',
        })
      ).json(),
    )

    await postJson(test, `${API_VERSION_PREFIX}/sessions/${session.id}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
    })
    await waitForIdle(store, session.id)

    // The span says which model served the request, and the factory was built with the
    // session's model and the owner's Anthropic key — resolved from `session.model`, not
    // from anything an agent would have carried.
    const history = await readHistory(store, session.id)
    const span = history.find((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(span).toMatchObject({ model: 'anthropic/claude-sonnet-5' })
    expect(requests).toEqual([{ modelId: 'anthropic/claude-sonnet-5', apiKey: SECRET }])
  })
})
