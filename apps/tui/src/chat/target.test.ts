import { createFakeClient } from '@openharness/client/testing'
import { makeAgent } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { listingAgents, listingSessions } from '../test-support/fake'
import { resolveTarget, selectAgent } from './target'

describe('selectAgent', () => {
  const summarizer = makeAgent({ name: 'Summarizer' })
  const reviewer = makeAgent({ name: 'Reviewer' })
  const agents = [summarizer, reviewer]

  it('matches an id', () => {
    expect(selectAgent(agents, reviewer.id)).toEqual({ ok: true, agent: reviewer })
  })

  it('matches an exact name', () => {
    expect(selectAgent(agents, 'Summarizer')).toEqual({ ok: true, agent: summarizer })
  })

  it('matches a name ignoring case', () => {
    expect(selectAgent(agents, 'rEvIeWeR')).toEqual({ ok: true, agent: reviewer })
  })

  it('trims what it was given', () => {
    expect(selectAgent(agents, '  Reviewer ')).toEqual({ ok: true, agent: reviewer })
  })

  it('lists the names when nothing matches', () => {
    const result = selectAgent(agents, 'Nope')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('Summarizer, Reviewer')
  })

  it('says to create one when the server has none', () => {
    const result = selectAgent([], 'Nope')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('no agents yet')
  })

  it('refuses to guess between agents that share a name', () => {
    const first = makeAgent({ name: 'Twin' })
    const second = makeAgent({ name: 'twin' })
    // Neither name is an exact match for this, and both are a case-insensitive one.
    const result = selectAgent([first, second], 'TWIN')

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('matches 2 agents')
  })

  it('still matches an exact name when another differs only in case', () => {
    const first = makeAgent({ name: 'Twin' })
    const second = makeAgent({ name: 'twin' })

    expect(selectAgent([first, second], 'Twin')).toEqual({ ok: true, agent: first })
    expect(selectAgent([first, second], 'twin')).toEqual({ ok: true, agent: second })
  })
})

describe('resolveTarget', () => {
  it('resumes the session it was given', async () => {
    const fake = createFakeClient()
    const target = await resolveTarget(fake, { session: fake.session.id, continue: false })

    expect(target).toEqual({ kind: 'session', session: fake.session })
  })

  it('throws when there is no such session', async () => {
    const fake = createFakeClient()

    await expect(resolveTarget(fake, { session: 'sesn_missing', continue: false })).rejects.toThrow(
      /not_found|missing/i,
    )
  })

  it('continues the newest session', async () => {
    const fake = createFakeClient()
    const older = fake.session.id
    const target = await resolveTarget(listingSessions(fake, ['sesn_newest', older]), {
      continue: true,
    })

    expect(target.kind === 'session' && target.session.id).toBe('sesn_newest')
  })

  it('starts a new session when there is nothing to continue', async () => {
    const fake = createFakeClient()
    const target = await resolveTarget(listingSessions(fake, []), { continue: true })

    expect(target.kind).toBe('session')
    expect(target.kind === 'session' && target.session.agent.id).toBe(fake.agent.id)
  })

  it('uses the only agent there is', async () => {
    const fake = createFakeClient()
    const target = await resolveTarget(fake, { continue: false })

    expect(target.kind === 'session' && target.session.agent.name).toBe(fake.agent.name)
  })

  it('asks which agent when there are several', async () => {
    const fake = createFakeClient()
    const extra = await fake.agents.create({
      name: 'Reviewer',
      model: { id: 'anthropic/claude-opus-5-5' },
    })
    const target = await resolveTarget(listingAgents(fake, [fake.agent, extra]), {
      continue: false,
    })

    expect(target.kind).toBe('choose')
    expect(target.kind === 'choose' && target.agents.map((agent) => agent.name)).toEqual([
      fake.agent.name,
      'Reviewer',
    ])
  })

  it('uses the agent --agent names, even when there are several', async () => {
    const fake = createFakeClient()
    const extra = await fake.agents.create({
      name: 'Reviewer',
      model: { id: 'anthropic/claude-opus-5-5' },
    })
    const client = listingAgents(fake, [fake.agent, extra])
    const target = await resolveTarget(client, { continue: false, agent: 'Reviewer' })

    expect(target.kind === 'session' && target.session.agent.id).toBe(extra.id)
  })

  it('fails loudly when --agent names nothing', async () => {
    const fake = createFakeClient()

    await expect(resolveTarget(fake, { continue: false, agent: 'Nope' })).rejects.toThrow(
      /no agent matches 'Nope'/,
    )
  })

  it('says there is nothing to chat with when there are no agents', async () => {
    const fake = createFakeClient()
    expect(await resolveTarget(listingAgents(fake, []), { continue: false })).toEqual({
      kind: 'none',
    })
  })

  it('prefers --session to everything else', async () => {
    const fake = createFakeClient()
    const target = await resolveTarget(listingAgents(fake, []), {
      session: fake.session.id,
      continue: true,
      agent: 'Nope',
    })

    expect(target).toEqual({ kind: 'session', session: fake.session })
  })
})
