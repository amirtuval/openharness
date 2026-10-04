import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type Session,
  type StoredEvent,
} from '@openharness/protocol'

import { createTestApp, httpSendMessage, postJson } from './test-support'

/**
 * The model switch over HTTP (epic #116, U3): `POST …/events` (and `initial_events`) accept a
 * `user.message` carrying `model`, the store projects it onto the session, and an id with no
 * `provider/model` shape is refused with a 400 before anything is appended.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`

describe('a user.message carrying a model', () => {
  it('switches the session’s model and is stored on the event', async () => {
    const test = createTestApp()
    const created = await postJson(test, SESSIONS, { model: { id: 'anthropic/claude-sonnet-5' } })
    const session = (await created.json()) as Session

    const response = await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'switch please' }],
          model: { id: 'openai/gpt-5-mini' },
        },
      ],
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: StoredEvent[] }
    expect(body.data[0]).toMatchObject({ model: { id: 'openai/gpt-5-mini' } })

    const read = await test.request(`${SESSIONS}/${session.id}`)
    expect(((await read.json()) as Session).model).toEqual({ id: 'openai/gpt-5-mini' })
  })

  it('refuses a malformed model id with a 400 and appends nothing', async () => {
    const test = createTestApp()
    const created = await postJson(test, SESSIONS, { model: { id: 'anthropic/claude-sonnet-5' } })
    const session = (await created.json()) as Session

    const response = await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'never stored' }],
          model: { id: 'gpt-5-mini' },
        },
      ],
    })
    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')

    // Nothing was appended, and the session still runs the model it was created with.
    const events = await test.request(`${SESSIONS}/${session.id}/events`)
    expect(((await events.json()) as { data: StoredEvent[] }).data).toEqual([])
    const read = await test.request(`${SESSIONS}/${session.id}`)
    expect(((await read.json()) as Session).model).toEqual({ id: 'anthropic/claude-sonnet-5' })
  })

  it('refuses one among initial_events at creation, before the session exists', async () => {
    const test = createTestApp()
    const response = await postJson(test, SESSIONS, {
      model: { id: 'anthropic/claude-sonnet-5' },
      initial_events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'go' }],
          model: { id: 'no-provider-here' },
        },
      ],
    })
    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
    const list = await test.request(SESSIONS)
    expect(((await list.json()) as { data: Session[] }).data).toEqual([])
  })

  it('leaves the model alone for a message without one', async () => {
    const test = createTestApp()
    const created = await postJson(test, SESSIONS, { model: { id: 'anthropic/claude-sonnet-5' } })
    const session = (await created.json()) as Session

    await httpSendMessage(test, session.id, 'no switch here')

    const read = await test.request(`${SESSIONS}/${session.id}`)
    expect(((await read.json()) as Session).model).toEqual({ id: 'anthropic/claude-sonnet-5' })
  })
})
