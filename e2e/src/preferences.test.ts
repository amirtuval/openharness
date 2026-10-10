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

    // Never saved anything: both fields are present at their defaults, not missing, not a 404.
    await expect(client.preferences.get()).resolves.toMatchObject({
      default_model: null,
      theme: 'system',
    })

    const stored = await client.preferences.put({ default_model: 'anthropic/claude-haiku-4-5' })
    // The write answers the stored value, which is what the settings screen renders — with
    // the theme the body did not mention left where it was.
    expect(stored).toMatchObject({ default_model: 'anthropic/claude-haiku-4-5', theme: 'system' })
    await expect(client.preferences.get()).resolves.toMatchObject({
      default_model: 'anthropic/claude-haiku-4-5',
      theme: 'system',
    })

    await expect(client.preferences.put({ default_model: null })).resolves.toMatchObject({
      default_model: null,
      theme: 'system',
    })
    await expect(client.preferences.get()).resolves.toMatchObject({
      default_model: null,
      theme: 'system',
    })

    // A second write replaces the field it carries, over what is stored (epic #201, X3).
    await client.preferences.put({ default_model: 'openai/gpt-4.1-mini' })
    await expect(client.preferences.get()).resolves.toMatchObject({
      default_model: 'openai/gpt-4.1-mini',
      theme: 'system',
    })

    // The theme is its own setting, and writing it does not touch the model (epic #201, X3).
    await expect(client.preferences.put({ theme: 'dim' })).resolves.toMatchObject({
      default_model: 'openai/gpt-4.1-mini',
      theme: 'dim',
    })
    await expect(client.preferences.get()).resolves.toMatchObject({
      default_model: 'openai/gpt-4.1-mini',
      theme: 'dim',
    })

    // The harness shares this user with the tests below, which start from the default theme.
    await client.preferences.put({ theme: 'system' })
  })

  it('carries the compaction controls, with the defaults a null follows (epic #277, C3; #282)', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    // Never saved: every control is at its default, and the response says what the two
    // nullable ones mean — the deployment's own trigger share and the engine's pass limit,
    // which a client cannot know (0.7 and 3, unless the server was started otherwise).
    const fresh = await client.preferences.get()
    expect(fresh.compaction_threshold).toBeNull()
    expect(fresh.summary_model).toBe('same-as-chat')
    expect(fresh.summary_max_passes).toBeNull()
    expect(fresh.defaults.compaction_threshold).toBeGreaterThan(0)
    expect(fresh.defaults.summary_max_passes).toBeGreaterThan(0)

    // A round trip of each control, and the default model beside them left alone.
    await client.preferences.put({ default_model: 'anthropic/claude-haiku-4-5' })
    const stored = await client.preferences.put({
      compaction_threshold: 0.5,
      summary_model: 'openai/gpt-5-mini',
      summary_max_passes: 5,
    })
    expect(stored).toMatchObject({
      default_model: 'anthropic/claude-haiku-4-5',
      compaction_threshold: 0.5,
      summary_model: 'openai/gpt-5-mini',
      summary_max_passes: 5,
    })

    // `null` clears a nullable control back to the default, and the sentinel is a value.
    await client.preferences.put({ compaction_threshold: null, summary_max_passes: null })
    await expect(client.preferences.get()).resolves.toMatchObject({
      compaction_threshold: null,
      summary_model: 'openai/gpt-5-mini',
      summary_max_passes: null,
    })

    // The route's own validation: a share or a pass count outside its range is a 400 that
    // stores nothing, and a malformed summary model id is one too.
    for (const body of [
      { compaction_threshold: 0.1 },
      { summary_max_passes: 11 },
      { summary_model: 'not-a-router-id' },
    ] as const) {
      expect((await errorOf(() => client.preferences.put(body))).status).toBe(400)
    }
    await expect(client.preferences.get()).resolves.toMatchObject({
      compaction_threshold: null,
      summary_model: 'openai/gpt-5-mini',
      summary_max_passes: null,
    })

    await client.preferences.put({ default_model: null, summary_model: 'same-as-chat' })
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
    await expect(b.client.preferences.get()).resolves.toMatchObject({
      default_model: null,
      theme: 'system',
    })
    await b.client.preferences.put({ default_model: 'groq/llama-3.3-70b-versatile' })
    await expect(b.client.preferences.get()).resolves.toMatchObject({
      default_model: 'groq/llama-3.3-70b-versatile',
      theme: 'system',
    })
    await expect(a.client.preferences.get()).resolves.toMatchObject({
      default_model: 'anthropic/claude-sonnet-5',
      theme: 'system',
    })

    // B clearing their own leaves A's alone too.
    await b.client.preferences.put({ default_model: null })
    await expect(a.client.preferences.get()).resolves.toMatchObject({
      default_model: 'anthropic/claude-sonnet-5',
      theme: 'system',
    })
  })

  it('accepts an id the catalogue does not list, and refuses one that is not provider/model', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    // Shape, not lookup (C5): the router takes models the catalogue has never heard of, and a
    // default that is ahead of the catalogue is exactly how a new provider arrives.
    await expect(
      client.preferences.put({ default_model: 'acme/not-in-any-catalogue' }),
    ).resolves.toMatchObject({ default_model: 'acme/not-in-any-catalogue', theme: 'system' })
    await expect(client.preferences.get()).resolves.toMatchObject({
      default_model: 'acme/not-in-any-catalogue',
      theme: 'system',
    })

    for (const bad of ['model-without-a-provider', 'openai/', '/gpt-5.1', 'openai//gpt-5.1']) {
      const refused = await errorOf(() => client.preferences.put({ default_model: bad }))
      expect([bad, refused.status]).toEqual([bad, 400])
      expect([bad, refused.type]).toEqual([bad, 'invalid_request_error'])
    }

    // A refused theme is the same 400 — a name outside the four is a bad body, not a
    // preference to store.
    const badTheme = await errorOf(() => client.preferences.put({ theme: 'midnight' } as never))
    expect(badTheme.status).toBe(400)
    expect(badTheme.type).toBe('invalid_request_error')

    // Every refusal stores nothing: the valid value above is still what a read answers.
    await expect(client.preferences.get()).resolves.toMatchObject({
      default_model: 'acme/not-in-any-catalogue',
      theme: 'system',
    })

    // An empty body is a merge over what is stored — a no-op, not a reset: `null` is the only
    // way to clear a default.
    await expect(client.preferences.put({})).resolves.toMatchObject({
      default_model: 'acme/not-in-any-catalogue',
      theme: 'system',
    })
  })
})
