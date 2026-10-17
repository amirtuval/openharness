import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  SessionSchema,
  newTaskId,
  type ListSessionsResponse,
  type Session,
} from '@openharness/protocol'

import { createTestApp, postJson, waitForIdle, type TestContext } from './test-support'

/**
 * The session tree at the API (epic #340, S1/S3): a non-interactive session is created by
 * asking for one, the tree fields are the server's alone to write, and `GET /v1/sessions` is
 * the caller's **top-level chats** unless it asks for one session's children.
 *
 * A child is created through the store rather than the API, because the API has no route that
 * creates one: only the server does (#344), which is exactly what the "not client-settable"
 * tests here pin.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`

/** `POST /v1/sessions` as the context's default caller. */
function createSession(test: TestContext, body: Record<string, unknown>): Promise<Response> {
  return postJson(test, SESSIONS, body)
}

/** Create a session through the route, and answer it. */
async function created(test: TestContext, body: Record<string, unknown> = {}): Promise<Session> {
  const response = await createSession(test, {
    model: { id: 'openharness-test/model' },
    ...body,
  })
  if (response.status !== 201) {
    throw new Error(`creating a session failed: ${response.status} ${await response.text()}`)
  }
  return SessionSchema.parse(await response.json())
}

/**
 * Hang a child off a session the way the server will (#344): through the store, with the
 * owner the parent belongs to. The route has no way to ask for one.
 */
async function createChild(test: TestContext, parent: Session, task = true): Promise<Session> {
  return test.store.createSession(null, {
    ownerId: parent.owner_id,
    model: { id: 'openharness-test/model' },
    interactive: false,
    parentSessionId: parent.id,
    ...(task ? { parentTaskId: newTaskId() } : {}),
  })
}

/** `GET /v1/sessions` with the query the caller wants, as the default caller. */
async function list(test: TestContext, query = ''): Promise<ListSessionsResponse> {
  const response = await test.request(`${SESSIONS}${query}`)
  expect(response.status).toBe(200)
  return (await response.json()) as ListSessionsResponse
}

describe('creating a session (epic #340, S1)', () => {
  it('is interactive unless the caller asks for a non-interactive one', async () => {
    const test = createTestApp()
    const chat = await created(test)
    expect(chat.interactive).toBe(true)
    expect(chat).toMatchObject({
      parent_session_id: null,
      parent_task_id: null,
      depth: 0,
    })
    // A top-level chat is its own root.
    expect(chat.root_session_id).toBe(chat.id)

    const run = await created(test, { interactive: false })
    expect(run.interactive).toBe(false)
    // It reads back the same way: the flag is a property of the session, not of the response.
    const read = await test.request(`${SESSIONS}/${run.id}`)
    expect(SessionSchema.parse(await read.json()).interactive).toBe(false)
  })

  it('refuses an interactive that is not a boolean', async () => {
    const test = createTestApp()
    const response = await createSession(test, {
      model: { id: 'openharness-test/model' },
      interactive: 'yes',
    })
    expect(response.status).toBe(400)
  })

  it('never takes the tree fields from a client: only the server creates children (#344)', async () => {
    const test = createTestApp()
    const parent = await created(test)
    const response = await createSession(test, {
      model: { id: 'openharness-test/model' },
      interactive: false,
      parent_session_id: parent.id,
      parent_task_id: 'task_01JZZZZZZZZZZZZZZZZZZZZZZZ',
      root_session_id: parent.id,
      depth: 1,
    })
    expect(response.status).toBe(201)

    // Stripped like any unknown field, so the session is a top-level chat of its own — the
    // request may not place itself in somebody's tree.
    const session = SessionSchema.parse(await response.json())
    expect(session).toMatchObject({
      parent_session_id: null,
      parent_task_id: null,
      depth: 0,
    })
    expect(session.root_session_id).toBe(session.id)
  })
})

describe('listing sessions (epic #340, S3)', () => {
  it('answers the top-level chats by default, and one session’s children on request', async () => {
    const test = createTestApp()
    const root = await created(test, { title: 'The chat' })
    const child = await createChild(test, root)
    const grandchild = await createChild(test, child)

    // A child is not a chat of its own, so a list that names no parent leaves it out.
    const chats = await list(test)
    expect(chats.data.map((session) => session.id)).toEqual([root.id])

    const children = await list(test, `?parent_session_id=${root.id}`)
    expect(children.data.map((session) => session.id)).toEqual([child.id])
    const grandchildren = await list(test, `?parent_session_id=${child.id}`)
    expect(grandchildren.data.map((session) => session.id)).toEqual([grandchild.id])

    // A session with no children is an empty page, not a 404: the filter narrows a list.
    expect((await list(test, `?parent_session_id=${grandchild.id}`)).data).toEqual([])
  })

  it('is owner-scoped: another user’s parent id is an empty page', async () => {
    const test = createTestApp()
    const root = await created(test)
    await createChild(test, root)
    const other = await test.signIn('tree-other@example.com')

    const theirs = await test.request(`${SESSIONS}?parent_session_id=${root.id}`, {
      headers: { authorization: `Bearer ${other.token}` },
    })
    expect(theirs.status).toBe(200)
    expect(((await theirs.json()) as ListSessionsResponse).data).toEqual([])
    // And their own list is their own: the other user's chat is not in it.
    expect(
      (
        (await (
          await test.request(SESSIONS, { headers: { authorization: `Bearer ${other.token}` } })
        ).json()) as ListSessionsResponse
      ).data,
    ).toEqual([])
  })

  it('refuses a parent id that is not a session id', async () => {
    const test = createTestApp()
    expect((await test.request(`${SESSIONS}?parent_session_id=task_nope`)).status).toBe(400)
  })

  it('keeps the agent filter working inside the parent filter', async () => {
    const test = createTestApp()
    const root = await created(test)
    const child = await createChild(test, root)

    const unknownAgent = 'agent_01ZZZZZZZZZZZZZZZZZZZZZZZZ'
    const filtered = await list(test, `?parent_session_id=${root.id}&agent_id=${unknownAgent}`)
    expect(filtered.data).toEqual([])
    // The child really is that parent's, so the empty answer is the agent filter's.
    expect(await test.store.getSession(child.id, { ownerId: root.owner_id })).not.toBeNull()
  })
})

describe('the tree fields a session carries (epic #340, S3)', () => {
  it('reads a child back with its parent, its root and its depth', async () => {
    const test = createTestApp()
    const root = await created(test)
    const child = await createChild(test, root)

    const response = await test.request(`${SESSIONS}/${child.id}`)
    const read = SessionSchema.parse(await response.json())
    expect(read).toMatchObject({
      interactive: false,
      parent_session_id: root.id,
      root_session_id: root.id,
      depth: 1,
    })
    // The parent has no task id of its own: it was not started by anything.
    expect(child.parent_task_id).not.toBeNull()
  })

  it('takes a person’s message and interrupt like any other chat (S1)', async () => {
    // A non-interactive chat is a real chat: a person may still send it messages and interrupt
    // it, which is what makes "non-interactive" about the model asking and not about the
    // reader being locked out. The brain's half (no `ask_user`, `ask` denied) lives in
    // `@openharness/brain`; these are the routes'.
    const test = createTestApp({ replies: [{ text: ['Carrying on.'] }] })
    const run = await created(test, { interactive: false })

    const sent = await postJson(test, `${SESSIONS}/${run.id}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'carry on' }] }],
    })
    expect(sent.status).toBe(200)
    await waitForIdle(test.store, run.id)

    const interrupted = await postJson(test, `${SESSIONS}/${run.id}/events`, {
      events: [{ type: 'user.interrupt' }],
    })
    expect(interrupted.status).toBe(200)

    const log = await test.store.listEventsUnscoped(run.id, { limit: 50, order: 'asc' })
    expect(log.data.map((event) => event.type)).toContain(EVENT_TYPES.userMessage)
    expect(log.data.map((event) => event.type)).toContain(EVENT_TYPES.userInterrupt)
    // The turn ran on the non-interactive session exactly as it would on any other.
    expect(log.data.map((event) => event.type)).toContain(EVENT_TYPES.agentMessage)
  })
})
