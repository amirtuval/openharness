import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type Session,
  type StoredEvent,
} from '@openharness/protocol'

import type { ModelRegistry } from './catalog/registry'
import { createTestApp, httpSendMessage, postJson, waitForIdle } from './test-support'

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

describe('the context budget follows the model switch (#246)', () => {
  /** Two windows a test can tell apart: `wide` keeps everything, `narrow` only the newest. */
  const registry: ModelRegistry = {
    models: (provider) => {
      if (provider === 'wide') {
        return [{ id: 'model', contextWindow: 1_000_000, maxOutput: 100_000 }]
      }
      if (provider === 'narrow') {
        return [{ id: 'model', contextWindow: 200, maxOutput: 50 }]
      }
      return []
    },
  }

  it('trims the request after a switch to the new model’s budget', async () => {
    const test = createTestApp({ registry, replies: [{ text: ['ok'] }] })
    const created = await postJson(test, SESSIONS, { model: { id: 'wide/model' } })
    const session = (await created.json()) as Session

    // Two long turns on the wide model: ~100 tokens of history each, far under its budget.
    const first = 'a'.repeat(400)
    const second = 'b'.repeat(400)
    await httpSendMessage(test, session.id, first)
    await waitForIdle(test.store, session.id)
    await httpSendMessage(test, session.id, second)
    await waitForIdle(test.store, session.id)

    // The third message carries the switch; the request it starts runs `narrow/model`.
    const third = 'c'.repeat(400)
    await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: third }],
          model: { id: 'narrow/model' },
        },
      ],
    })
    await waitForIdle(test.store, session.id)

    // One request per message, and each prompt the context strategy built is visible.
    expect(test.model.histories).toHaveLength(3)
    // The wide model's request carried the whole conversation.
    expect(test.model.histories[1]).toEqual([
      { role: 'user', text: first },
      { role: 'assistant', text: 'ok' },
      { role: 'user', text: second },
    ])
    // The narrow one — a 200-token window with 50 reserved, so 150 tokens of history — could
    // not fit the whole thing and was trimmed oldest-first to the newest message alone.
    expect(test.model.histories[2]).toEqual([{ role: 'user', text: third }])
  })
})
