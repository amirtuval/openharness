import { EVENT_TYPES, MODE_DEFAULT_MODEL, SessionSchema } from '@openharness/protocol'
import type { ModelRequestStartEvent, Mode, SessionId } from '@openharness/protocol'
import type { Client } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import type { ServerProcess } from './harness'
import {
  e2eHarness,
  errorOf,
  personFor,
  readLog,
  seedProviderCredential,
  waitForTurnEnd,
} from './harness'

/**
 * Modes, end to end (epic #245, M6).
 *
 * A mode is a per-user named preset — a model, a reasoning effort and a system-prompt addition
 * — that a chat follows **live**: every request resolves the mode as it is now. The evidence is
 * in the log: `span.model_request_start` records the mode's id and name and the model and effort
 * the mode resolved to, so "an edit applied" is a claim about the spans, and the session's
 * `mode`/`model` are the projections the clients read.
 *
 * The mock model answers whatever it is asked, so what the mode *resolved to* is the observable,
 * not what the model replied. The in-process suites cover the storage and route rules
 * (`apps/server/src/modes.test.ts`, `packages/session`); this file proves them against a real
 * server and a real Postgres, with the client the frontends use.
 */

const harness = e2eHarness('modes')

const FIRST_MODEL = 'openai/gpt-5.1'
const SECOND_MODEL = 'anthropic/claude-sonnet-5'

/**
 * A person of this file's own.
 *
 * Every scenario gets its own account: the file shares one database, so modes, credentials and
 * preferences written by one test would otherwise be read by the next — and the dev login
 * seeds exactly one user.
 */
async function person(server: ServerProcess, label: string) {
  return personFor(
    server,
    await harness.user(server, {
      email: `${label}@modes.example.com`,
      password: 'e2e-password-123',
    }),
  )
}

/** The `span.model_request_start` events of a log, in order. */
function spans(log: readonly { type: string }[]): ModelRequestStartEvent[] {
  return log.filter(
    (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
  )
}

/** Send one message and wait for the turn it starts to end. */
async function sendAndWait(client: Client, sessionId: SessionId, text: string): Promise<void> {
  const sent = await client.sessions.events.send(sessionId, [
    { type: 'user.message', content: [{ type: 'text', text }] },
  ])
  const seq = sent.data[0]?.seq
  await waitForTurnEnd(client, sessionId, seq === undefined ? undefined : { afterSeq: seq })
}

describe('a chat that follows a mode (M6)', () => {
  it('runs the mode’s model, and records the mode, model and effort on the span', async () => {
    const server = await harness.server()
    const me = await person(server, 'runs')
    await seedProviderCredential(await harness.database(), {
      userId: me.signedIn.user.id,
      name: 'openai',
      apiKey: 'sk-e2e-openai-0000000000000000',
    })

    const mode: Mode = await me.client.modes.create({
      name: 'smart',
      model: FIRST_MODEL,
      reasoning_effort: 'high',
      system_prompt_addition: 'Think step by step.',
    })

    const session = SessionSchema.parse(await me.client.sessions.create({ mode: mode.id }))
    // The session's header carries the mode and the model it resolves to now — the fallback a
    // chat keeps once its mode is deleted.
    expect(session.mode).toBe(mode.id)
    expect(session.model).toEqual({ id: FIRST_MODEL })

    await sendAndWait(me.client, session.id, 'go')

    const [span] = spans(await readLog(me.client, session.id))
    expect(span?.mode).toEqual({ id: mode.id, name: 'smart' })
    expect(span?.model).toBe(FIRST_MODEL)
    expect(span?.reasoning_effort?.requested).toBe('high')
  })

  it('follows an edit made between messages: the next request uses the mode as it is now', async () => {
    const server = await harness.server()
    const me = await person(server, 'edited')
    for (const provider of ['openai', 'anthropic']) {
      await seedProviderCredential(await harness.database(), {
        userId: me.signedIn.user.id,
        name: provider,
        apiKey: `sk-e2e-${provider}-0000000000000000`,
      })
    }

    const mode: Mode = await me.client.modes.create({ name: 'smart', model: FIRST_MODEL })
    const session = await me.client.sessions.create({ mode: mode.id })
    await sendAndWait(me.client, session.id, 'first')

    // The edit: a new model, a new effort, and a rename — the log should follow all three.
    await me.client.modes.update(mode.id, {
      name: 'faster',
      model: SECOND_MODEL,
      reasoning_effort: 'low',
    })
    await sendAndWait(me.client, session.id, 'second')

    const recorded = spans(await readLog(me.client, session.id)).sort(
      (left, right) => left.seq - right.seq,
    )
    expect(recorded.map((span) => span.model)).toEqual([FIRST_MODEL, SECOND_MODEL])
    // The name recorded is the one the mode had when *that* request ran, so history is not
    // rewritten by the rename.
    expect(recorded[0]?.mode).toEqual({ id: mode.id, name: 'smart' })
    expect(recorded[1]?.mode).toEqual({ id: mode.id, name: 'faster' })
    expect(recorded[1]?.reasoning_effort?.requested).toBe('low')
  })

  it('follows the default model a mode defers to', async () => {
    const server = await harness.server()
    const me = await person(server, 'default-follows')
    for (const provider of ['openai', 'anthropic']) {
      await seedProviderCredential(await harness.database(), {
        userId: me.signedIn.user.id,
        name: provider,
        apiKey: `sk-e2e-${provider}-0000000000000000`,
      })
    }

    await me.client.preferences.put({ default_model: FIRST_MODEL })
    const mode = await me.client.modes.create({ name: 'mine', model: MODE_DEFAULT_MODEL })
    const session = await me.client.sessions.create({ mode: mode.id })
    expect(session.model).toEqual({ id: FIRST_MODEL })
    await sendAndWait(me.client, session.id, 'first')

    // The default changes; the mode follows it with no edit of its own.
    await me.client.preferences.put({ default_model: SECOND_MODEL })
    await sendAndWait(me.client, session.id, 'second')

    const recorded = spans(await readLog(me.client, session.id)).sort(
      (left, right) => left.seq - right.seq,
    )
    expect(recorded.map((span) => span.model)).toEqual([FIRST_MODEL, SECOND_MODEL])
  })

  it('refuses a chat on a mode whose model has no key — on create and on continue', async () => {
    const server = await harness.server()
    const me = await person(server, 'unavailable')
    // No credential for anthropic: the mode's model cannot be used.
    const mode = await me.client.modes.create({ name: 'deep', model: SECOND_MODEL })

    const refused = await errorOf(() => me.client.sessions.create({ mode: mode.id }))
    expect(refused.type).toBe('mode_unavailable_error')
    expect(refused.message).toContain("isn't available")

    // Continuing on the mode is refused too, once the key behind it is gone — and nothing is
    // appended. A chat created while the key exists, then the key removed.
    await seedProviderCredential(await harness.database(), {
      userId: me.signedIn.user.id,
      name: 'anthropic',
      apiKey: 'sk-e2e-anthropic-0000000000000000',
    })
    const session = await me.client.sessions.create({ mode: mode.id })
    await me.client.providerCredentials.delete('anthropic')

    const continuing = await errorOf(() =>
      me.client.sessions.events.send(session.id, [
        { type: 'user.message', content: [{ type: 'text', text: 'again' }] },
      ]),
    )
    expect(continuing.type).toBe('mode_unavailable_error')
    expect(await readLog(me.client, session.id)).toEqual([])
  })

  it('answers 404 for another person’s mode, and never leaks it', async () => {
    const server = await harness.server()
    const owner = await person(server, 'owner')
    const stranger = await person(server, 'stranger')

    const mode = await owner.client.modes.create({ name: 'private', model: FIRST_MODEL })

    const failure = await errorOf(() => stranger.client.modes.get(mode.id))
    expect(failure.type).toBe('not_found_error')
    expect((await stranger.client.modes.list()).data).toEqual([])
    // Starting a chat on somebody else's mode is the same 404, not a 403 that confirms it.
    const chat = await errorOf(() => stranger.client.sessions.create({ mode: mode.id }))
    expect(chat.type).toBe('not_found_error')
  })

  it('leaves the chats that followed a deleted mode on the model they last ran', async () => {
    const server = await harness.server()
    const me = await person(server, 'deleted')
    await seedProviderCredential(await harness.database(), {
      userId: me.signedIn.user.id,
      name: 'openai',
      apiKey: 'sk-e2e-openai-0000000000000000',
    })

    const mode = await me.client.modes.create({ name: 'smart', model: FIRST_MODEL })
    const session = await me.client.sessions.create({ mode: mode.id })
    await sendAndWait(me.client, session.id, 'first')

    await me.client.modes.delete(mode.id)

    const after = await me.client.sessions.get(session.id)
    expect(after.mode).toBeNull()
    expect(after.model).toEqual({ id: FIRST_MODEL })

    // The chat continues on its last model, recording no mode.
    await sendAndWait(me.client, session.id, 'second')
    const recorded = spans(await readLog(me.client, session.id)).sort(
      (left, right) => left.seq - right.seq,
    )
    expect(recorded.map((span) => span.model)).toEqual([FIRST_MODEL, FIRST_MODEL])
    expect(recorded[1]?.mode).toBeUndefined()
  })
})
