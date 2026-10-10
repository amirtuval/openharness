import { describe, expect, it } from 'vitest'
import { API_VERSION_PREFIX, ApiErrorBodySchema } from '@openharness/protocol'
import { makeUserPreferences } from '@openharness/protocol/fixtures'
import type { PreferencesDefaults, UserPreferences } from '@openharness/protocol'

import { asUser, createTestApp, type TestContext } from './test-support'

/**
 * `GET`/`PUT /v1/me/preferences` (epic #116, U1; the theme: #203, epic #201 X3; the compaction
 * controls: epic #277 C3, #282): the caller's stored `default_model` — the model a new chat
 * starts with — the web app's `theme`, and the three compaction settings. Owner-only, shared by
 * the web app and `oh`, and shape-checked only: a free-text model id the catalogue has not
 * caught up with is allowed.
 *
 * A `PUT` merges: the fields the body carries are stored and the rest keep their stored value,
 * so the settings cannot clear each other — which is the property #203 is about, and the reason
 * `oh default-model`, a body with no theme in it, is safe.
 *
 * The response carries a `defaults` object (C3): what each `null` compaction control means. It
 * is the deployment's trigger share and the engine's pass limit, so a client cannot know either
 * without being told.
 */

const PREFERENCES = `${API_VERSION_PREFIX}/me/preferences`

/** The whole response the routes answer: the stored value, plus the defaults its `null`s mean. */
function preferences(
  stored: Partial<UserPreferences> = {},
  defaults: Partial<PreferencesDefaults> = {},
): UserPreferences & { defaults: PreferencesDefaults } {
  return {
    ...makeUserPreferences({ default_model: null, ...stored }),
    defaults: { compaction_threshold: 0.7, summary_max_passes: 3, ...defaults },
  }
}

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

    // Never saved anything: every setting is present at its default, not missing.
    expect(await getPreferences(test)).toEqual(preferences())

    const written = await putPreferences(test, { default_model: 'anthropic/claude-haiku-4-5' })
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual(
      preferences({ default_model: 'anthropic/claude-haiku-4-5' }),
    )
    expect(await getPreferences(test)).toEqual(
      preferences({ default_model: 'anthropic/claude-haiku-4-5' }),
    )

    // A model id the catalogue does not know is fine (U1): the shape is the whole check, and
    // a field the body does not carry keeps its stored value.
    const freeText = await putPreferences(test, { default_model: 'acme/experimental-9' })
    expect(freeText.status).toBe(200)
    expect(await getPreferences(test)).toEqual(
      preferences({ default_model: 'acme/experimental-9' }),
    )

    const cleared = await putPreferences(test, { default_model: null })
    expect(cleared.status).toBe(200)
    expect(await getPreferences(test)).toEqual(preferences())
  })

  it('stores the theme, and neither setting clears the other (epic #201, X3)', async () => {
    const test = createTestApp()

    // A theme on its own: the default model it did not mention stays null.
    const themed = await putPreferences(test, { theme: 'dim' })
    expect(themed.status).toBe(200)
    expect(await themed.json()).toEqual(preferences({ theme: 'dim' }))

    // A default model on its own, the way `oh default-model` writes one: the theme survives.
    const modelled = await putPreferences(test, { default_model: 'openai/gpt-5-mini' })
    expect(await modelled.json()).toEqual(
      preferences({ default_model: 'openai/gpt-5-mini', theme: 'dim' }),
    )
    expect(await getPreferences(test)).toEqual(
      preferences({ default_model: 'openai/gpt-5-mini', theme: 'dim' }),
    )

    // And a write carrying both sets both.
    const both = await putPreferences(test, { default_model: null, theme: 'dark' })
    expect(await both.json()).toEqual(preferences({ theme: 'dark' }))

    // An empty body changes nothing — a merge over what is stored.
    expect((await putPreferences(test, {})).status).toBe(200)
    expect(await getPreferences(test)).toEqual(preferences({ theme: 'dark' }))
  })

  it('stores the compaction controls, each independently, and clears them with null (C3, #282)', async () => {
    const test = createTestApp()

    // A threshold alone leaves the summary model and the pass limit at their defaults.
    const threshold = await putPreferences(test, { compaction_threshold: 0.5 })
    expect(threshold.status).toBe(200)
    expect(await threshold.json()).toEqual(preferences({ compaction_threshold: 0.5 }))

    const summary = await putPreferences(test, {
      summary_model: 'anthropic/claude-haiku-4-5',
      summary_max_passes: 5,
    })
    expect(await summary.json()).toEqual(
      preferences({
        compaction_threshold: 0.5,
        summary_model: 'anthropic/claude-haiku-4-5',
        summary_max_passes: 5,
      }),
    )

    // `same-as-chat` is a value, not a clearing: it is the default the sentinel spells.
    const sentinel = await putPreferences(test, { summary_model: 'same-as-chat' })
    expect(await sentinel.json()).toEqual(
      preferences({ compaction_threshold: 0.5, summary_max_passes: 5 }),
    )

    // `null` clears each control back to "follow the default" (the `null` slots, not a reset
    // of the others).
    const cleared = await putPreferences(test, {
      compaction_threshold: null,
      summary_max_passes: null,
    })
    expect(await cleared.json()).toEqual(preferences())
    expect(await getPreferences(test)).toEqual(preferences())
  })

  it('reports the deployment’s own threshold as the default a null follows (C3, #282)', async () => {
    const test = createTestApp({ compactionThreshold: 0.4 })

    expect(await getPreferences(test)).toEqual(
      preferences({}, { compaction_threshold: 0.4, summary_max_passes: 3 }),
    )
    // A stored choice is reported as stored; the default still says what the deployment set.
    const written = await putPreferences(test, { compaction_threshold: 0.9 })
    expect(await written.json()).toEqual(
      preferences({ compaction_threshold: 0.9 }, { compaction_threshold: 0.4 }),
    )
  })

  it('refuses an unknown theme name with a 400 and stores nothing', async () => {
    const test = createTestApp()
    await putPreferences(test, { default_model: 'openai/gpt-5-mini', theme: 'dim' })

    const refused = await putPreferences(test, { theme: 'midnight' })
    expect(refused.status).toBe(400)
    const body = ApiErrorBodySchema.parse(await refused.json())
    expect(body.error.type).toBe('invalid_request_error')

    // The refusal left every stored field where it was.
    expect(await getPreferences(test)).toEqual(
      preferences({ default_model: 'openai/gpt-5-mini', theme: 'dim' }),
    )
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
    expect(await getPreferences(test)).toEqual(preferences({ default_model: 'openai/gpt-5-mini' }))
  })

  it('refuses an out-of-range or badly-shaped compaction control with a 400 (C3, #282)', async () => {
    const test = createTestApp()
    await putPreferences(test, { compaction_threshold: 0.5, summary_max_passes: 4 })

    const refused = [
      { compaction_threshold: 0.29 },
      { compaction_threshold: 0.96 },
      { compaction_threshold: 1 },
      { summary_model: 'not-a-router-id' },
      { summary_model: 'same as chat' },
      { summary_max_passes: 0 },
      { summary_max_passes: 11 },
      { summary_max_passes: 2.5 },
    ]
    for (const body of refused) {
      const response = await putPreferences(test, body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(ApiErrorBodySchema.parse(await response.json()).error.type).toBe(
        'invalid_request_error',
      )
    }

    // Nothing the refusals carried reached the stored value.
    expect(await getPreferences(test)).toEqual(
      preferences({ compaction_threshold: 0.5, summary_max_passes: 4 }),
    )
  })

  it('is owner-only: one user never reads or writes another user’s preferences', async () => {
    const test = createTestApp()
    await putPreferences(test, { default_model: 'openai/gpt-5-mini' })

    const other = await test.signIn('preferences-other@example.com')
    expect(await getPreferences(test, other.token)).toEqual(preferences())

    const written = await putPreferences(
      test,
      { default_model: 'anthropic/claude-haiku-4-5' },
      other.token,
    )
    expect(written.status).toBe(200)

    // Each caller sees exactly their own value.
    expect(await getPreferences(test)).toEqual(preferences({ default_model: 'openai/gpt-5-mini' }))
    expect(await getPreferences(test, other.token)).toEqual(
      preferences({ default_model: 'anthropic/claude-haiku-4-5' }),
    )
  })
})
