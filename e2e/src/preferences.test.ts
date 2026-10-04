import { describe, expect, it } from 'vitest'

import { e2eHarness, errorOf, personFor, type Person, type ServerProcess } from './harness'

/**
 * The caller's preferences, end to end (epic #116, U1): `GET`/`PUT /v1/me/preferences`.
 *
 * The server package tests the route in-process; what only a deployment proves is that the
 * value is where both frontends read it from — a real process, a real Postgres, the SDK the
 * web app and `oh` use — and that "per user" is a property of the authenticated session and
 * not of the request: the routes carry no id at all, so the only way to tell whose
 * preferences an answer is, is who asked.
 *
 * `default_model` is the `provider/model` a new chat starts with; shape-validated only, so an
 * id the catalog has not caught up with is a legitimate choice (C5). The automatic pick a
 * saved credential triggers is `default-model.test.ts`'s story (U4); this file is the routes.
 */

const harness = e2eHarness('preferences')

/** A signed-in person nobody else in this file shares. */
async function person(server: ServerProcess, name: string): Promise<Person> {
  return personFor(
    server,
    await harness.user(server, {
      email: `${name}@preferences.test`,
      password: `${name}-password`,
    }),
  )
}

describe('GET/PUT /v1/me/preferences (U1)', () => {
  it('answers null before anything is saved, round-trips a choice, and clears with null', async () => {
    const server = await harness.server()
    const me = await person(server, 'round-trip')

    // Never saved: the absence of a choice, not a 404.
    await expect(me.client.preferences.get()).resolves.toEqual({ default_model: null })

    // A pick the catalog does not list is legitimate — the check is the router id's shape,
    // never a catalogue lookup.
    const chosen = 'acme/not-in-any-catalogue-9x'
    await expect(me.client.preferences.put({ default_model: chosen })).resolves.toEqual({
      default_model: chosen,
    })
    // Both the write's answer and a fresh read carry it.
    await expect(me.client.preferences.get()).resolves.toEqual({ default_model: chosen })

    // A replacement is whole: there is no partial update to worry about.
    await expect(
      me.client.preferences.put({ default_model: 'anthropic/claude-sonnet-5' }),
    ).resolves.toEqual({ default_model: 'anthropic/claude-sonnet-5' })

    // And `null` is how the stored choice is cleared.
    await expect(me.client.preferences.put({ default_model: null })).resolves.toEqual({
      default_model: null,
    })
    await expect(me.client.preferences.get()).resolves.toEqual({ default_model: null })
  })

  it('is owner-only: one person’s choice is invisible to — and untouched by — another', async () => {
    const server = await harness.server()
    const a = await person(server, 'owner-a')
    const b = await person(server, 'owner-b')

    // Neither has one to begin with.
    await expect(a.client.preferences.get()).resolves.toEqual({ default_model: null })
    await expect(b.client.preferences.get()).resolves.toEqual({ default_model: null })

    await a.client.preferences.put({ default_model: 'anthropic/claude-sonnet-5' })
    await expect(b.client.preferences.get()).resolves.toEqual({ default_model: null })

    await b.client.preferences.put({ default_model: 'openai/gpt-5.1' })
    // A's answer is still A's after B wrote theirs, in both directions.
    await expect(a.client.preferences.get()).resolves.toEqual({
      default_model: 'anthropic/claude-sonnet-5',
    })
    await expect(b.client.preferences.get()).resolves.toEqual({ default_model: 'openai/gpt-5.1' })

    // And B clearing theirs leaves A's exactly where it was.
    await b.client.preferences.put({ default_model: null })
    await expect(a.client.preferences.get()).resolves.toEqual({
      default_model: 'anthropic/claude-sonnet-5',
    })
  })

  it('refuses a malformed default_model, and a body without one, without touching the stored value', async () => {
    const server = await harness.server()
    const me = await person(server, 'refusals')

    const stored = 'anthropic/claude-sonnet-5'
    await me.client.preferences.put({ default_model: stored })

    // The shape the router id has to have: one or more non-empty slash-separated parts, no
    // whitespace — the same check the protocol's schema spells. An unknown-but-well-formed id
    // is accepted (above); these are the ids no provider could ever resolve.
    for (const bad of ['gpt-5.1', 'openai/', '/gpt-5.1', 'openai//gpt-5.1', 'open ai/gpt']) {
      const refused = await errorOf(() => me.client.preferences.put({ default_model: bad }))
      expect([bad, refused.status]).toEqual([bad, 400])
      expect([bad, refused.type]).toEqual([bad, 'invalid_request_error'])
    }

    // A body that carries no `default_model` at all is refused the same way — there is no
    // partial update, so a body missing the one field is not "leave it alone".
    const missing = await errorOf(() =>
      me.client.preferences.put({} as unknown as { default_model: null }),
    )
    expect(missing.status).toBe(400)
    expect(missing.type).toBe('invalid_request_error')

    // Every refusal left the stored value alone.
    await expect(me.client.preferences.get()).resolves.toEqual({ default_model: stored })
  })
})
