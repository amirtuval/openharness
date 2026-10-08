import { describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, ApiErrorBodySchema } from '@openharness/protocol'

import { asUser, createTestApp, type TestContext } from './test-support'

/**
 * `GET`/`PUT /v1/me/preferences` (epic #116, U1; the theme: #203, epic #201 X3): the caller's
 * stored `default_model` — the model a new chat starts with — and the web app's `theme`.
 * Owner-only, shared by the web app and `oh`, and shape-checked only: a free-text model id
 * the catalogue has not caught up with is allowed.
 *
 * A `PUT` merges: the fields the body carries are stored and the rest keep their stored
 * value, so the two settings cannot clear each other — which is the property #203 is about,
 * and the reason `oh default-model`, a body with no theme in it, is safe.
 */

const PREFERENCES = `${API_VERSION_PREFIX}/me/preferences`

/** `GET /v1/me/preferences` as the context's default caller. */
async function getPreferences(test: TestContext, token?: string): Promise<unknown> {
  const response = await test.request(
    PREFERENCES,
    token === undefined ? {} : { headers: asUser(token) },
  )
  expect(response.status).toBe(200)
  return response.json()
}

/** `PUT /v1/me/preferences` with a body, as one caller. */
function putPreferences(test: TestContext, body: unknown, token?: string): Promise<Response> {
  return test.request(PREFERENCES, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : asUser(token)),
    },
    body: JSON.stringify(body),
  })
}

describe('the preferences API', () => {
  it('reads as "no choice" until one is written, then round-trips, then clears', async () => {
    const test = createTestApp()

    // Never saved anything: both settings are present at their defaults, not missing.
    expect(await getPreferences(test)).toEqual({ default_model: null, theme: 'system' })

    const written = await putPreferences(test, { default_model: 'anthropic/claude-haiku-4-5' })
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({
      default_model: 'anthropic/claude-haiku-4-5',
      theme: 'system',
    })
    expect(await getPreferences(test)).toEqual({
      default_model: 'anthropic/claude-haiku-4-5',
      theme: 'system',
    })

    // A model id the catalogue does not know is fine (U1): the shape is the whole check, and
    // a field the body does not carry keeps its stored value.
    const freeText = await putPreferences(test, { default_model: 'acme/experimental-9' })
    expect(freeText.status).toBe(200)
    expect(await getPreferences(test)).toEqual({
      default_model: 'acme/experimental-9',
      theme: 'system',
    })

    const cleared = await putPreferences(test, { default_model: null })
    expect(cleared.status).toBe(200)
    expect(await getPreferences(test)).toEqual({ default_model: null, theme: 'system' })
  })

  it('stores the theme, and neither setting clears the other (epic #201, X3)', async () => {
    const test = createTestApp()

    // A theme on its own: the default model it did not mention stays null.
    const themed = await putPreferences(test, { theme: 'dim' })
    expect(themed.status).toBe(200)
    expect(await themed.json()).toEqual({ default_model: null, theme: 'dim' })

    // A default model on its own, the way `oh default-model` writes one: the theme survives.
    const modelled = await putPreferences(test, { default_model: 'openai/gpt-5-mini' })
    expect(await modelled.json()).toEqual({ default_model: 'openai/gpt-5-mini', theme: 'dim' })
    expect(await getPreferences(test)).toEqual({ default_model: 'openai/gpt-5-mini', theme: 'dim' })

    // And a write carrying both sets both.
    const both = await putPreferences(test, { default_model: null, theme: 'dark' })
    expect(await both.json()).toEqual({ default_model: null, theme: 'dark' })

    // An empty body changes nothing — a merge over what is stored.
    expect((await putPreferences(test, {})).status).toBe(200)
    expect(await getPreferences(test)).toEqual({ default_model: null, theme: 'dark' })
  })

  it('refuses an unknown theme name with a 400 and stores nothing', async () => {
    const test = createTestApp()
    await putPreferences(test, { default_model: 'openai/gpt-5-mini', theme: 'dim' })

    const refused = await putPreferences(test, { theme: 'midnight' })
    expect(refused.status).toBe(400)
    const body = ApiErrorBodySchema.parse(await refused.json())
    expect(body.error.type).toBe('invalid_request_error')

    // The refusal left both stored fields where they were.
    expect(await getPreferences(test)).toEqual({ default_model: 'openai/gpt-5-mini', theme: 'dim' })
  })

  it('refuses a malformed default_model with a 400 and stores nothing', async () => {
    const test = createTestApp()
    await putPreferences(test, { default_model: 'openai/gpt-5-mini' })

    const malformed = ['gpt-5-mini', '/gpt-5-mini', 'openai/', 'openai//gpt', 'open ai/mini', 'x']
    for (const defaultModel of malformed) {
      const response = await putPreferences(test, { default_model: defaultModel })
      expect(response.status).toBe(400)
      const body = ApiErrorBodySchema.parse(await response.json())
      expect(body.error.type).toBe('invalid_request_error')
    }

    // A field the body does not carry is a merge, not a reset: `null` is the only way to
    // clear a default, so a malformed one never leaves the caller without a model.
    expect(await getPreferences(test)).toEqual({
      default_model: 'openai/gpt-5-mini',
      theme: 'system',
    })
  })

  it('is owner-only: one user never reads or writes another user’s preferences', async () => {
    const test = createTestApp()
    await putPreferences(test, { default_model: 'openai/gpt-5-mini' })

    const other = await test.signIn('preferences-other@example.com')
    expect(await getPreferences(test, other.token)).toEqual({
      default_model: null,
      theme: 'system',
    })

    const written = await putPreferences(
      test,
      { default_model: 'anthropic/claude-haiku-4-5' },
      other.token,
    )
    expect(written.status).toBe(200)

    // Each caller sees exactly their own value.
    expect(await getPreferences(test)).toEqual({
      default_model: 'openai/gpt-5-mini',
      theme: 'system',
    })
    expect(await getPreferences(test, other.token)).toEqual({
      default_model: 'anthropic/claude-haiku-4-5',
      theme: 'system',
    })
  })
})
