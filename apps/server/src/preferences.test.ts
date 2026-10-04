import { describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, ApiErrorBodySchema } from '@openharness/protocol'

import { asUser, createTestApp, type TestContext } from './test-support'

/**
 * `GET`/`PUT /v1/me/preferences` (epic #116, U1): the caller's stored `default_model` — the
 * model a new chat starts with. Owner-only, shared by the web app and `oh`, and shape-checked
 * only: a free-text router id the catalogue has not caught up with is allowed.
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

    expect(await getPreferences(test)).toEqual({ default_model: null })

    const written = await putPreferences(test, { default_model: 'anthropic/claude-haiku-4-5' })
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ default_model: 'anthropic/claude-haiku-4-5' })
    expect(await getPreferences(test)).toEqual({ default_model: 'anthropic/claude-haiku-4-5' })

    // A router id the catalogue does not know is fine (U1): the shape is the whole check, and
    // the value replaces in place — there is no partial update.
    const freeText = await putPreferences(test, { default_model: 'acme/experimental-9' })
    expect(freeText.status).toBe(200)
    expect(await getPreferences(test)).toEqual({ default_model: 'acme/experimental-9' })

    const cleared = await putPreferences(test, { default_model: null })
    expect(cleared.status).toBe(200)
    expect(await getPreferences(test)).toEqual({ default_model: null })
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

    // A body with no `default_model` at all is refused too: the value is written whole.
    expect((await putPreferences(test, {})).status).toBe(400)

    // Every refusal left the stored value where it was.
    expect(await getPreferences(test)).toEqual({ default_model: 'openai/gpt-5-mini' })
  })

  it('is owner-only: one user never reads or writes another user’s preferences', async () => {
    const test = createTestApp()
    await putPreferences(test, { default_model: 'openai/gpt-5-mini' })

    const other = await test.signIn('preferences-other@example.com')
    expect(await getPreferences(test, other.token)).toEqual({ default_model: null })

    const written = await putPreferences(
      test,
      { default_model: 'anthropic/claude-haiku-4-5' },
      other.token,
    )
    expect(written.status).toBe(200)

    // Each caller sees exactly their own value.
    expect(await getPreferences(test)).toEqual({ default_model: 'openai/gpt-5-mini' })
    expect(await getPreferences(test, other.token)).toEqual({
      default_model: 'anthropic/claude-haiku-4-5',
    })
  })
})
