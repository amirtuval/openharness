import { describe, expect, it } from 'vitest'

import { e2eHarness, errorOf, personFor } from './harness'

/**
 * The per-user default model, end to end (epic #116, U1).
 *
 * `GET`/`PUT /v1/me/preferences` is the one setting the web app and `oh` share: the router id
 * a new chat starts with. `apps/server/src/preferences.test.ts` covers the route in process;
 * what only a deployment proves is that the resource really is *the caller's* — there is no
 * id in the path, so the isolation is a property of the guard and the store's owner scope, and
 * a bug there would hand one person another's default over the wire.
 *
 * `default_model` is a router id (`provider/model`), shape-validated and deliberately **not**
 * a catalogue lookup (C5): the pickers offer what the catalogue lists, but a stored default
 * the catalogue does not know is still a legitimate value the router accepts.
 */

const harness = e2eHarness('preferences')

describe('the caller’s default model (U1)', () => {
  it('answers null before anything is stored, round-trips a value, and clears again', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    // Never saved anything: the field is present and null, not missing and not a 404.
    await expect(client.preferences.get()).resolves.toEqual({ default_model: null })

    const stored = await client.preferences.put({ default_model: 'anthropic/claude-haiku-4-5' })
    // The write answers the stored value, which is what the settings screen renders.
    expect(stored).toEqual({ default_model: 'anthropic/claude-haiku-4-5' })
    await expect(client.preferences.get()).resolves.toEqual({
      default_model: 'anthropic/claude-haiku-4-5',
    })

    await expect(client.preferences.put({ default_model: null })).resolves.toEqual({
      default_model: null,
    })
    await expect(client.preferences.get()).resolves.toEqual({ default_model: null })

    // A replacement is a whole write: there is no partial update to get out of step.
    await client.preferences.put({ default_model: 'openai/gpt-4.1-mini' })
    await expect(client.preferences.get()).resolves.toEqual({
      default_model: 'openai/gpt-4.1-mini',
    })
  })

  it('keeps one person’s default out of another’s way, on the same server', async () => {
    const server = await harness.server()
    const a = personFor(
      server,
      await harness.user(server, { email: 'a@preferences.test', password: 'a-password' }),
    )
    const b = personFor(
      server,
      await harness.user(server, { email: 'b@preferences.test', password: 'b-password' }),
    )

    await a.client.preferences.put({ default_model: 'anthropic/claude-sonnet-5' })

    // B is not offered A's value — not as a default and not as a fallback — and B's own write
    // does not disturb A's.
    await expect(b.client.preferences.get()).resolves.toEqual({ default_model: null })
    await b.client.preferences.put({ default_model: 'groq/llama-3.3-70b-versatile' })
    await expect(b.client.preferences.get()).resolves.toEqual({
      default_model: 'groq/llama-3.3-70b-versatile',
    })
    await expect(a.client.preferences.get()).resolves.toEqual({
      default_model: 'anthropic/claude-sonnet-5',
    })

    // B clearing their own leaves A's alone too.
    await b.client.preferences.put({ default_model: null })
    await expect(a.client.preferences.get()).resolves.toEqual({
      default_model: 'anthropic/claude-sonnet-5',
    })
  })

  it('accepts an id the catalogue does not list, and refuses one that is not provider/model', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    // Shape, not lookup (C5): the router takes models the catalogue has never heard of, and a
    // default that is ahead of the catalogue is exactly how a new provider arrives.
    await expect(
      client.preferences.put({ default_model: 'acme/not-in-any-catalogue' }),
    ).resolves.toEqual({ default_model: 'acme/not-in-any-catalogue' })
    await expect(client.preferences.get()).resolves.toEqual({
      default_model: 'acme/not-in-any-catalogue',
    })

    for (const bad of ['model-without-a-provider', 'openai/', '/gpt-5.1', 'openai//gpt-5.1']) {
      const refused = await errorOf(() => client.preferences.put({ default_model: bad }))
      expect([bad, refused.status]).toEqual([bad, 400])
      expect([bad, refused.type]).toEqual([bad, 'invalid_request_error'])
    }

    // A rejected write stores nothing: the valid value above is still what a read answers.
    await expect(client.preferences.get()).resolves.toEqual({
      default_model: 'acme/not-in-any-catalogue',
    })

    // The field itself is required — the resource is written whole, so a body without it is a
    // 400 rather than a silent clear.
    const missing = await errorOf(() => client.preferences.put({} as never))
    expect(missing.status).toBe(400)
    expect(missing.type).toBe('invalid_request_error')
  })
})
