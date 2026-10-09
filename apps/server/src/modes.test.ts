import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  MODE_DEFAULT_MODEL,
  ModeSchema,
  SessionSchema,
  type Mode,
  type ModelRequestStartEvent,
  type Session,
  type SessionId,
} from '@openharness/protocol'
import { createBundledRegistry } from './catalog/registry'
import {
  asUser,
  createTestApp,
  postJson,
  readHistory,
  waitForIdle,
  type TestContext,
} from './test-support'

/**
 * Modes over HTTP (epic #245, M6): the CRUD under `/v1/me/modes`, and a chat that follows one.
 *
 * The mode lives in the store, its "my default model" in the user's preferences and its
 * availability in the caller's credentials — so all three halves are exercised through the real
 * routes here, with the bundled registry wired in so the mode's effort is observable on the
 * span. The model runs on the scripted model (no key, no network); availability is decided by
 * the stored credential rows alone, which the tests seed through the credential route.
 */

const MODES = `${API_VERSION_PREFIX}/me/modes`
const SESSIONS = `${API_VERSION_PREFIX}/sessions`
const CREDENTIALS = `${API_VERSION_PREFIX}/provider-credentials`

const REGISTRY = createBundledRegistry()

/** A credential for `provider`, saved through the real route (the default validator accepts). */
async function putKey(test: TestContext, provider: string): Promise<void> {
  const response = await test.request(`${CREDENTIALS}/${provider}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'api_key', api_key: `sk-test-${provider}-0123456789` }),
  })
  expect(response.status).toBe(200)
}

/** Create a mode through the route and return it. */
async function createMode(test: TestContext, body: unknown): Promise<Mode> {
  const response = await postJson(test, MODES, body)
  expect(response.status).toBe(201)
  return ModeSchema.parse(await response.json())
}

/** Create a session through the route and return it. */
async function createSession(test: TestContext, body: unknown): Promise<Session> {
  const response = await postJson(test, SESSIONS, body)
  expect(response.status).toBe(201)
  return SessionSchema.parse(await response.json())
}

/** Send a message to a session, asserting the append was accepted. */
async function send(test: TestContext, sessionId: SessionId, event: unknown): Promise<Response> {
  return postJson(test, `${SESSIONS}/${sessionId}/events`, { events: [event] })
}

/** The error type of a response body, for the refusals. */
async function errorTypeOf(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { type?: string } }
  return body.error?.type
}

/** The `span.model_request_start` events of a session, in order. */
async function spans(test: TestContext, sessionId: SessionId): Promise<ModelRequestStartEvent[]> {
  const history = await readHistory(test.store, sessionId)
  return history.filter(
    (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
  )
}

describe('the mode endpoints', () => {
  it('creates, reads, lists, updates and deletes a mode', async () => {
    const test = createTestApp()
    const created = await createMode(test, {
      name: 'deep',
      model: 'anthropic/claude-sonnet-5',
      reasoning_effort: 'high',
      system_prompt_addition: 'Think step by step.',
    })
    expect(created).toMatchObject({
      type: 'mode',
      name: 'deep',
      model: 'anthropic/claude-sonnet-5',
      reasoning_effort: 'high',
      system_prompt_addition: 'Think step by step.',
    })
    const user = await test.currentUser()
    expect(created.owner_id).toBe(user.id)

    const listed = (await (await test.request(MODES)).json()) as { data: Mode[] }
    expect(listed.data.map((mode) => mode.id)).toEqual([created.id])

    const one = ModeSchema.parse(await (await test.request(`${MODES}/${created.id}`)).json())
    expect(one).toEqual(created)

    const updated = ModeSchema.parse(
      await (
        await postJson(test, `${MODES}/${created.id}`, { name: 'fast', reasoning_effort: null })
      ).json(),
    )
    expect(updated).toMatchObject({ name: 'fast', reasoning_effort: null })
    expect(updated.model).toBe('anthropic/claude-sonnet-5')

    const deleted = await test.request(`${MODES}/${created.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect((await test.request(`${MODES}/${created.id}`)).status).toBe(404)
    const empty = (await (await test.request(MODES)).json()) as { data: Mode[] }
    expect(empty.data).toEqual([])
  })

  it('accepts "my default model", and defaults the optional fields to null', async () => {
    const test = createTestApp()
    const mode = await createMode(test, { name: 'mine', model: MODE_DEFAULT_MODEL })
    expect(mode).toMatchObject({
      model: MODE_DEFAULT_MODEL,
      reasoning_effort: null,
      system_prompt_addition: null,
    })
  })

  it('refuses a duplicate name with 409, on create and on rename', async () => {
    const test = createTestApp()
    await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const duplicate = await postJson(test, MODES, {
      name: 'deep',
      model: 'openai/gpt-4.1-mini',
    })
    expect(duplicate.status).toBe(409)
    expect(await errorTypeOf(duplicate)).toBe('conflict_error')

    const other = await createMode(test, { name: 'fast', model: 'openai/gpt-4.1-mini' })
    const rename = await postJson(test, `${MODES}/${other.id}`, { name: 'deep' })
    expect(rename.status).toBe(409)
    expect(await errorTypeOf(rename)).toBe('conflict_error')
  })

  it('caps a user at twenty modes with 409', async () => {
    const test = createTestApp()
    for (let index = 0; index < 20; index += 1) {
      await createMode(test, { name: `mode ${index}`, model: 'anthropic/claude-sonnet-5' })
    }
    const tooMany = await postJson(test, MODES, {
      name: 'one too many',
      model: 'anthropic/claude-sonnet-5',
    })
    expect(tooMany.status).toBe(409)
    expect(await errorTypeOf(tooMany)).toBe('conflict_error')
  })

  it('refuses a body the protocol does not accept, and a malformed id', async () => {
    const test = createTestApp()
    expect((await postJson(test, MODES, { name: '', model: 'x/y' })).status).toBe(400)
    expect((await postJson(test, MODES, { name: 'a', model: 'not-a-model' })).status).toBe(400)
    expect(
      (await postJson(test, MODES, { name: 'a', model: 'x/y', reasoning_effort: 'extreme' }))
        .status,
    ).toBe(400)
    expect((await test.request(`${MODES}/nope-nope`)).status).toBe(400)
  })

  it('answers 404 for another user’s mode, on every verb', async () => {
    const test = createTestApp()
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const other = await test.signIn('other@example.com')
    const headers = asUser(other.token)
    expect((await test.anonymous(`${MODES}/${mode.id}`, { headers })).status).toBe(404)
    expect(
      (
        await test.anonymous(`${MODES}/${mode.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ name: 'stolen' }),
        })
      ).status,
    ).toBe(404)
    expect(
      (await test.anonymous(`${MODES}/${mode.id}`, { method: 'DELETE', headers })).status,
    ).toBe(404)
    // The list is the caller's own and nothing leaked into it.
    const listed = (await (await test.anonymous(MODES, { headers })).json()) as { data: Mode[] }
    expect(listed.data).toEqual([])
  })
})

describe('a chat on a mode', () => {
  it('runs the mode’s model and effort, and records the mode on the span', async () => {
    const test = createTestApp({ replies: [{ text: ['deeply'] }], registry: REGISTRY })
    await putKey(test, 'anthropic')
    const mode = await createMode(test, {
      name: 'deep',
      model: 'anthropic/claude-sonnet-5',
      reasoning_effort: 'high',
    })
    const session = await createSession(test, { mode: mode.id })
    // The session's header model is what the mode resolves to now, so a chat has a model even
    // if the mode is later deleted.
    expect(session.mode).toBe(mode.id)
    expect(session.model).toEqual({ id: 'anthropic/claude-sonnet-5' })

    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'go' }],
    })
    await waitForIdle(test.store, session.id)

    const [span] = await spans(test, session.id)
    expect(span).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      mode: { id: mode.id, name: 'deep' },
      reasoning_effort: { requested: 'high', applied: 'high' },
    })
  })

  it('follows the mode live when it is edited mid-chat', async () => {
    const test = createTestApp({
      replies: [{ text: ['one'] }, { text: ['two'] }],
      registry: REGISTRY,
    })
    await putKey(test, 'anthropic')
    await putKey(test, 'openai')
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const session = await createSession(test, { mode: mode.id })

    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'first' }],
    })
    await waitForIdle(test.store, session.id)

    // The mode is edited: a new model. The next message uses it, with no switch of its own.
    const edited = ModeSchema.parse(
      await (await postJson(test, `${MODES}/${mode.id}`, { model: 'openai/gpt-4.1-mini' })).json(),
    )
    expect(edited.model).toBe('openai/gpt-4.1-mini')
    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'second' }],
    })
    await waitForIdle(test.store, session.id)

    const recorded = await spans(test, session.id)
    expect(recorded.map((span) => span.model)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-4.1-mini',
    ])
    expect(recorded[1]?.mode?.id).toBe(mode.id)
  })

  it('follows "my default model" after the default changes', async () => {
    const test = createTestApp({
      replies: [{ text: ['one'] }, { text: ['two'] }],
      registry: REGISTRY,
    })
    await putKey(test, 'anthropic')
    await putKey(test, 'openai')
    await test.request(`${API_VERSION_PREFIX}/me/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ default_model: 'anthropic/claude-sonnet-5' }),
    })
    const mode = await createMode(test, { name: 'mine', model: MODE_DEFAULT_MODEL })
    const session = await createSession(test, { mode: mode.id })
    expect(session.model).toEqual({ id: 'anthropic/claude-sonnet-5' })

    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'first' }],
    })
    await waitForIdle(test.store, session.id)

    // The default changes; the mode follows it, with no edit and no switch.
    await test.request(`${API_VERSION_PREFIX}/me/preferences`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ default_model: 'openai/gpt-4.1-mini' }),
    })
    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'second' }],
    })
    await waitForIdle(test.store, session.id)

    const recorded = await spans(test, session.id)
    expect(recorded.map((span) => span.model)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-4.1-mini',
    ])
  })

  it('appends the mode’s prompt addition after the session’s system prompt', async () => {
    const test = createTestApp({ replies: [{ text: ['ok'] }] })
    await putKey(test, 'anthropic')
    const mode = await createMode(test, {
      name: 'deep',
      model: 'anthropic/claude-sonnet-5',
      system_prompt_addition: 'Think step by step.',
    })
    const session = await createSession(test, { mode: mode.id, system: 'Be terse.' })

    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'go' }],
    })
    await waitForIdle(test.store, session.id)

    const prompt = test.model.histories[0]
    expect(prompt?.[0]).toEqual({ role: 'system', text: 'Be terse.\n\nThink step by step.' })
  })

  it('refuses a chat on a mode whose model has no credential — on create and on continue', async () => {
    const test = createTestApp({ replies: [{ text: ['ok'] }] })
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })

    const refused = await postJson(test, SESSIONS, { mode: mode.id })
    expect(refused.status).toBe(422)
    const body = (await refused.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('mode_unavailable_error')
    expect(body.error.message).toContain("isn't available")

    // A chat already on the mode is refused too, once the key behind it is gone: never a
    // silent fallback to another model.
    await putKey(test, 'anthropic')
    const session = await createSession(test, { mode: mode.id })
    expect((await test.request(`${CREDENTIALS}/anthropic`, { method: 'DELETE' })).status).toBe(204)
    const continueRefused = await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'again' }],
    })
    expect(continueRefused.status).toBe(422)
    expect(await errorTypeOf(continueRefused)).toBe('mode_unavailable_error')
    // Nothing was stored.
    expect(await readHistory(test.store, session.id)).toEqual([])
  })

  it('refuses "my default model" with no default set', async () => {
    const test = createTestApp()
    const mode = await createMode(test, { name: 'mine', model: MODE_DEFAULT_MODEL })
    const refused = await postJson(test, SESSIONS, { mode: mode.id })
    expect(refused.status).toBe(422)
    expect(await errorTypeOf(refused)).toBe('mode_unavailable_error')
  })

  it('answers 404 for another user’s mode when starting a chat on it', async () => {
    const test = createTestApp()
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const other = await test.signIn('other@example.com')
    const response = await test.anonymous(SESSIONS, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...asUser(other.token) },
      body: JSON.stringify({ mode: mode.id }),
    })
    expect(response.status).toBe(404)
  })

  it('detaches from the mode when a plain model is picked', async () => {
    const test = createTestApp({
      replies: [{ text: ['one'] }, { text: ['two'] }],
      registry: REGISTRY,
    })
    await putKey(test, 'anthropic')
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const session = await createSession(test, { mode: mode.id })

    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'plain' }],
      model: { id: 'openai/gpt-4.1-mini' },
    })
    await waitForIdle(test.store, session.id)

    const after = SessionSchema.parse(
      await (await test.request(`${SESSIONS}/${session.id}`)).json(),
    )
    expect(after.mode).toBeNull()
    expect(after.model).toEqual({ id: 'openai/gpt-4.1-mini' })
    const [span] = await spans(test, session.id)
    expect(span?.mode).toBeUndefined()
    expect(span?.model).toBe('openai/gpt-4.1-mini')
  })

  it('continues on the last model when the mode is deleted mid-chat', async () => {
    const test = createTestApp({
      replies: [{ text: ['one'] }, { text: ['two'] }],
      registry: REGISTRY,
    })
    await putKey(test, 'anthropic')
    const mode = await createMode(test, { name: 'deep', model: 'anthropic/claude-sonnet-5' })
    const session = await createSession(test, { mode: mode.id })

    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'first' }],
    })
    await waitForIdle(test.store, session.id)

    expect((await test.request(`${MODES}/${mode.id}`, { method: 'DELETE' })).status).toBe(204)
    // The chat is an ordinary one now, on the model it last ran.
    const detached = SessionSchema.parse(
      await (await test.request(`${SESSIONS}/${session.id}`)).json(),
    )
    expect(detached.mode).toBeNull()
    expect(detached.model).toEqual({ id: 'anthropic/claude-sonnet-5' })

    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'second' }],
    })
    await waitForIdle(test.store, session.id)

    const recorded = await spans(test, session.id)
    expect(recorded.map((span) => span.model)).toEqual([
      'anthropic/claude-sonnet-5',
      'anthropic/claude-sonnet-5',
    ])
    expect(recorded[1]?.mode).toBeUndefined()
  })

  it('runs the session’s own model for a chat that never picked a mode', async () => {
    const test = createTestApp({ replies: [{ text: ['ok'] }], registry: REGISTRY })
    const session = await createSession(test, { model: { id: 'openai/gpt-4.1-mini' } })
    await send(test, session.id, {
      type: EVENT_TYPES.userMessage,
      content: [{ type: 'text', text: 'hi' }],
    })
    await waitForIdle(test.store, session.id)
    const [span] = await spans(test, session.id)
    expect(span?.mode).toBeUndefined()
    expect(span?.model).toBe('openai/gpt-4.1-mini')
  })
})
