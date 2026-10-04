import type { Client } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { newAgentId, type Agent } from '@openharness/protocol'
import { makeAgent, makeModelEntry } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { listingAgents, listingSessions, pagedAgents, seedAgents } from '../test-support/fake'
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

  it('offers the catalog when neither --agent nor --model is given', async () => {
    const fake = createFakeClient({
      models: [makeModelEntry(), makeModelEntry({ id: 'openai/gpt-4.1-mini', provider: 'openai' })],
    })
    const target = await resolveTarget(fake, { continue: false })

    expect(target.kind).toBe('choose-model')
    expect(target.kind === 'choose-model' && target.models.map((model) => model.id)).toEqual([
      'anthropic/claude-sonnet-5',
      'openai/gpt-4.1-mini',
    ])
  })

  it('says there are no models when the account has no provider keys', async () => {
    const fake = createFakeClient({ models: [], providers: [] })

    expect(await resolveTarget(fake, { continue: false })).toEqual({ kind: 'no-models' })
  })

  it('starts a model-first session for --model, without reading the catalog', async () => {
    const fake = createFakeClient()
    const client: Client = {
      ...fake,
      models: {
        list: () => Promise.reject(new Error('the catalog should not be read')),
      },
    }

    const target = await resolveTarget(client, { continue: false, model: 'openai/gpt-4.1-mini' })

    expect(target.kind).toBe('session')
    expect(target.kind === 'session' && target.session.model.id).toBe('openai/gpt-4.1-mini')
    expect(target.kind === 'session' && target.session.agent).toBeNull()
  })

  it('lets --model override the model of an --agent preset', async () => {
    const fake = createFakeClient()
    const target = await resolveTarget(fake, {
      continue: false,
      agent: fake.agent.name,
      model: 'openai/gpt-4.1-mini',
    })

    expect(target.kind).toBe('session')
    expect(target.kind === 'session' && target.session.agent?.id).toBe(fake.agent.id)
    expect(target.kind === 'session' && target.session.model.id).toBe('openai/gpt-4.1-mini')
  })

  it('uses the agent --agent names, even when there are several', async () => {
    const fake = createFakeClient()
    const extra = await fake.agents.create({
      name: 'Reviewer',
      model: { id: 'anthropic/claude-opus-5-5' },
    })
    const client = listingAgents(fake, [fake.agent, extra])
    const target = await resolveTarget(client, { continue: false, agent: 'Reviewer' })

    expect(target.kind === 'session' && target.session.agent?.id).toBe(extra.id)
  })

  it('fails loudly when --agent names nothing', async () => {
    const fake = createFakeClient()

    await expect(resolveTarget(fake, { continue: false, agent: 'Nope' })).rejects.toThrow(
      /no agent matches 'Nope'/,
    )
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

describe('resolveTarget with a list longer than one page', () => {
  /**
   * 45 agents served 20 at a time, so the 45th is on the third page: the first two pages
   * are all a client that ignores `next_page` ever sees.
   */
  async function thirdPage(): Promise<{ client: Client; last: Agent }> {
    const fake = createFakeClient()
    const agents = await seedAgents(fake, 45)
    const last = agents.at(-1)
    if (last === undefined) throw new Error('seedAgents did not create the agents')

    return { client: pagedAgents(fake, agents), last }
  }

  it('finds an agent on the third page by name', async () => {
    const { client, last } = await thirdPage()

    const target = await resolveTarget(client, { continue: false, agent: 'Agent 45' })

    expect(target.kind === 'session' && target.session.agent?.id).toBe(last.id)
    expect(target.kind === 'session' && target.session.agent?.name).toBe('Agent 45')
  })

  it('finds an agent on the third page by id', async () => {
    const { client, last } = await thirdPage()

    const target = await resolveTarget(client, { continue: false, agent: last.id })

    expect(target.kind === 'session' && target.session.agent?.id).toBe(last.id)
  })

  it('reads an id instead of walking the list', async () => {
    const fake = createFakeClient()
    const [agent] = await seedAgents(fake, 1)
    if (agent === undefined) throw new Error('seedAgents did not create the agent')
    const client = {
      ...fake,
      agents: {
        ...fake.agents,
        list: () => Promise.reject(new Error('the list should not be read for an id')),
      },
    }

    const target = await resolveTarget(client, { continue: false, agent: agent.id })

    expect(target.kind === 'session' && target.session.agent?.id).toBe(agent.id)
  })

  it('falls back to the name match when an id is not found', async () => {
    const fake = createFakeClient()
    // A name with the shape of an agent id, naming no agent that exists: the direct read
    // 404s, and the name match is what finds it.
    const name = newAgentId()
    const named = await fake.agents.create({
      name,
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const client = pagedAgents(fake, [named])

    const target = await resolveTarget(client, { continue: false, agent: name })

    expect(target.kind === 'session' && target.session.agent?.id).toBe(named.id)
  })

  it('reports a name that is nowhere in the list, listing all of it', async () => {
    const { client } = await thirdPage()

    await expect(resolveTarget(client, { continue: false, agent: 'Nope' })).rejects.toThrow(
      /Agent 01, .*Agent 45/u,
    )
  })
})
