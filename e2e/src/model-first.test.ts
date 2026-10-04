import { describe, expect, it } from 'vitest'

import { EVENT_TYPES, SessionSchema, type ModelRequestStartEvent } from '@openharness/protocol'

import { agentMessages, e2eHarness, errorOf, readLog, waitForTurnEnd } from './harness'

/**
 * Model-first sessions, end to end (epic #92, issues #93/#94): chatting does not require an
 * agent.
 *
 * The server package tests this in-process (`apps/server/src/model-first-sessions.test.ts`);
 * what only a deployment can prove is on the wire here — a real process, a real Postgres, the
 * client the frontends use: the session comes back with `agent: null` and the model it runs,
 * both reads round-trip it, and a turn on it is attributed to that model in the log the
 * clients actually read. Creating a session needs no credential, so this runs on the mock
 * model with no keys and no network.
 */

const harness = e2eHarness('model-first')

describe('a session created from a model alone (#94)', () => {
  it('stores the model and system, round-trips agent: null, and runs a turn the span attributes to it', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const session = SessionSchema.parse(
      await client.sessions.create({ model: { id: 'openai/gpt-5.1' }, system: 'Be terse.' }),
    )
    expect(session.agent).toBeNull()
    expect(session.model).toEqual({ id: 'openai/gpt-5.1' })
    expect(session.system).toBe('Be terse.')
    expect(session.status).toBe('idle')

    // Both reads answer the same session: the resource and the list the sidebar walks.
    const read = SessionSchema.parse(await client.sessions.get(session.id))
    expect(read.agent).toBeNull()
    expect(read.model).toEqual({ id: 'openai/gpt-5.1' })
    const listed = await client.sessions.list()
    expect(listed.data.find((candidate) => candidate.id === session.id)?.agent).toBeNull()

    // A turn runs on it — the mock model answers — and the span the brain stores names the
    // session's model, which is where per-request attribution comes from.
    const sent = await client.sessions.events.send(session.id, [
      { type: 'user.message', content: [{ type: 'text', text: 'hello there' }] },
    ])
    await waitForTurnEnd(client, session.id, { afterSeq: sent.data[0]?.seq })

    const log = await readLog(client, session.id)
    const starts = log.filter(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    )
    expect(starts).toHaveLength(1)
    expect(starts[0]?.model).toBe('openai/gpt-5.1')
    expect(agentMessages(log)).toHaveLength(1)
    expect(log.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
  })

  it('takes the inline model and system over an agent’s, and keeps the agent snapshot', async () => {
    const server = await harness.server()
    const client = await harness.client(server)
    const agent = await client.agents.create({
      name: 'Preset',
      model: { id: 'anthropic/claude-sonnet-5' },
      system: 'The agent system.',
    })

    const session = SessionSchema.parse(
      await client.sessions.create({ agent: agent.id, model: { id: 'openai/gpt-5.1' } }),
    )
    expect(session.model).toEqual({ id: 'openai/gpt-5.1' })
    // The override is per field: what it omits falls back to the agent's.
    expect(session.system).toBe('The agent system.')
    expect(session.agent).toMatchObject({
      id: agent.id,
      model: { id: 'anthropic/claude-sonnet-5' },
    })
  })

  it('refuses a request that names neither, and a model id that is not provider/model', async () => {
    const server = await harness.server()
    const client = await harness.client(server)

    const neither = await errorOf(() => client.sessions.create({}))
    expect(neither.status).toBe(400)
    expect(neither.type).toBe('invalid_request_error')

    // The shape check is the router's `provider/model`, at least two non-empty parts — and it
    // is deliberately a shape, not a catalogue lookup (C5): an unknown but well-formed id is
    // accepted, because the router takes models the catalogue does not know yet.
    for (const id of ['gpt-5.1', 'openai/', '/gpt-5.1', 'openai//gpt-5.1']) {
      const refused = await errorOf(() => client.sessions.create({ model: { id } }))
      expect([id, refused.status]).toEqual([id, 400])
      expect([id, refused.type]).toEqual([id, 'invalid_request_error'])
    }

    const accepted = await client.sessions.create({ model: { id: 'acme/not-in-any-catalogue' } })
    expect(accepted.model).toEqual({ id: 'acme/not-in-any-catalogue' })
  })
})
