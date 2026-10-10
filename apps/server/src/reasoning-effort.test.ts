import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  ApiErrorBodySchema,
  EVENT_TYPES,
  type ReasoningEffortRun,
  SessionSchema,
  type StoredEvent,
  type UserMessageEvent,
} from '@openharness/protocol'
import { createBundledRegistry, type ModelRegistry } from './catalog/registry'
import { createTestApp, postJson, readHistory, waitForIdle } from './test-support'

/**
 * The reasoning effort over HTTP (#252): `POST …/events` — and the `initial_events` of
 * `POST /v1/sessions` — accept a `user.message` carrying `reasoning_effort`, store it on the
 * event, and the turn the message starts runs at it, which its span records.
 *
 * The effort is the message's field and nothing else — the same reading as the per-message
 * model of #111 — so the server's part is that the wire accepts it, the store keeps it exactly
 * as sent, and a turn reads it back out of the log. Which models take an effort is the
 * registry's answer (#252's follow-up), so these tests wire the bundled snapshot in — the
 * production wiring — and the span's `applied` is read off the real data.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`

/** The production reasoning wiring: the resolver over the bundled models.dev snapshot. */
const REGISTRY: ModelRegistry = createBundledRegistry()

/** Create a session running `model` and return it. */
async function createSession(test: ReturnType<typeof createTestApp>, model: string) {
  return SessionSchema.parse(
    await (await postJson(test, SESSIONS, { model: { id: model } })).json(),
  )
}

/** The turn's `span.model_request_start`'s effort, or `undefined` when it wrote none. */
function spanEffortOf(history: readonly StoredEvent[]): ReasoningEffortRun | undefined {
  return history.find((event) => event.type === EVENT_TYPES.modelRequestStart)?.reasoning_effort
}

describe('a user.message carrying a reasoning effort', () => {
  it('is stored on the event, and the turn runs at it', async () => {
    const test = createTestApp({ replies: [{ text: ['thinking'] }], registry: REGISTRY })
    const session = await createSession(test, 'anthropic/claude-sonnet-5')

    const response = await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'think hard' }],
          reasoning_effort: 'high',
        },
      ],
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: UserMessageEvent[] }
    expect(body.data[0]).toMatchObject({ reasoning_effort: 'high' })

    await waitForIdle(test.store, session.id)
    expect(spanEffortOf(await readHistory(test.store, session.id))).toEqual({
      requested: 'high',
      applied: 'high',
    })
  })

  it('records an effort asked for and not applied when the model takes none', async () => {
    const test = createTestApp({ replies: [{ text: ['briefly'] }], registry: REGISTRY })
    // `openai/gpt-4o-mini` is not a reasoning model: the snapshot says so, the effort is asked
    // for, and the request keeps the provider's default.
    const session = await createSession(test, 'openai/gpt-4o-mini')

    await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'answer briefly' }],
          reasoning_effort: 'low',
        },
      ],
    })

    await waitForIdle(test.store, session.id)
    expect(spanEffortOf(await readHistory(test.store, session.id))).toEqual({
      requested: 'low',
      applied: null,
    })
  })

  it('clamps an effort the model does not take to one it does', async () => {
    // The registry says this model's own knob has `low` and `high` and no `medium`, so a request
    // for `medium` is sent as `high` — the level it really runs, not one its API would reject.
    const registry: ModelRegistry = {
      models: (provider) =>
        provider === 'openai' ? [{ id: 'o4-mini', reasoning: true, efforts: ['low', 'high'] }] : [],
    }
    const test = createTestApp({ replies: [{ text: ['thinking'] }], registry })
    const session = await createSession(test, 'openai/o4-mini')

    await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'think medium' }],
          reasoning_effort: 'medium',
        },
      ],
    })

    await waitForIdle(test.store, session.id)
    expect(spanEffortOf(await readHistory(test.store, session.id))).toEqual({
      requested: 'medium',
      applied: 'high',
    })
  })

  it('is accepted at session creation, on an initial event', async () => {
    const test = createTestApp({ replies: [{ text: ['hello'] }], registry: REGISTRY })

    const response = await postJson(test, SESSIONS, {
      model: { id: 'anthropic/claude-sonnet-5' },
      initial_events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'think medium' }],
          reasoning_effort: 'medium',
        },
      ],
    })

    expect(response.status).toBe(201)
    const session = SessionSchema.parse(await response.json())
    await waitForIdle(test.store, session.id)

    const history = await readHistory(test.store, session.id)
    expect(history.find((event) => event.type === EVENT_TYPES.userMessage)).toMatchObject({
      reasoning_effort: 'medium',
    })
    expect(spanEffortOf(history)).toEqual({ requested: 'medium', applied: 'medium' })
  })

  it('refuses a level the protocol does not have, and appends nothing', async () => {
    const test = createTestApp()
    const session = await createSession(test, 'anthropic/claude-sonnet-5')

    const response = await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [
        {
          type: EVENT_TYPES.userMessage,
          content: [{ type: 'text', text: 'never stored' }],
          reasoning_effort: 'xhigh',
        },
      ],
    })

    expect(response.status).toBe(400)
    expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe('invalid_request_error')
    expect(await readHistory(test.store, session.id)).toEqual([])
  })

  it('leaves a message without one, and the request that answers it, unchanged', async () => {
    const test = createTestApp({ replies: [{ text: ['hi'] }], registry: REGISTRY })
    const session = await createSession(test, 'anthropic/claude-sonnet-5')

    await postJson(test, `${SESSIONS}/${session.id}/events`, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: 'no effort' }] }],
    })

    await waitForIdle(test.store, session.id)
    const history = await readHistory(test.store, session.id)
    // Neither the event nor the span carries the field at all — the shape every session stored
    // before #252 has, and the one a replayed turn must keep writing.
    expect('reasoning_effort' in (history[0] ?? {})).toBe(false)
    expect(spanEffortOf(history)).toBeUndefined()
  })
})
