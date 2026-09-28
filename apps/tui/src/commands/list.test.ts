import { ApiError } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { makeAgent, makeSession } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { formatAgents, formatSessions, runAgents, runSessions, type CommandIo } from './list'

/** Collect what a command wrote, and how it left. */
function recorder() {
  const out: string[] = []
  const err: string[] = []

  return {
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      context: { server: 'http://localhost:3000' },
    } satisfies CommandIo,
    out,
    err,
  }
}

describe('formatSessions', () => {
  it('prints id, title, status and updated', () => {
    const session = makeSession({
      title: 'A chat about nothing',
      status: 'idle',
      updated_at: '2026-09-28T10:00:00.000Z',
    })

    const [line] = formatSessions([session])

    expect(line).toContain(session.id)
    expect(line).toContain('A chat about nothing')
    expect(line).toContain('idle')
    expect(line).toContain('2026-09-28T10:00:00.000Z')
  })

  it('calls an untitled session untitled', () => {
    expect(formatSessions([makeSession({ title: null })])[0]).toContain('(untitled)')
  })

  it('cuts a title too long for the column', () => {
    const [line] = formatSessions([makeSession({ title: 'x'.repeat(80) })])

    expect(line).toContain(`${'x'.repeat(31)}…`)
    expect(line).not.toContain('x'.repeat(40))
  })

  it('says how to start one when there are none', () => {
    expect(formatSessions([])).toEqual(['No sessions yet. Start one with `oh`.'])
  })
})

describe('formatAgents', () => {
  it('prints id, name and model', () => {
    const agent = makeAgent({ name: 'Summarizer', model: { id: 'anthropic/claude-sonnet-5' } })
    const [line] = formatAgents([agent])

    expect(line).toContain(agent.id)
    expect(line).toContain('Summarizer')
    expect(line).toContain('anthropic/claude-sonnet-5')
  })

  it('says where to create one when there are none', () => {
    expect(formatAgents([])[0]).toContain('web app')
  })
})

describe('runSessions', () => {
  it('lists the sessions the server has', async () => {
    const fake = createFakeClient()
    const { io, out, err } = recorder()

    const code = await runSessions(fake, io)

    expect(code).toBe(0)
    expect(err).toEqual([])
    expect(out.join('\n')).toContain(fake.session.id)
  })

  it('reports a failure on stderr and exits 1', async () => {
    const fake = createFakeClient()
    const client = {
      ...fake,
      sessions: {
        ...fake.sessions,
        list: () => Promise.reject(new ApiError(401, 'invalid api key')),
      },
    }
    const { io, out, err } = recorder()

    const code = await runSessions(client, io)

    expect(code).toBe(1)
    expect(out).toEqual([])
    expect(err.join('\n')).toContain('401')
    expect(err.join('\n')).toContain('--api-key')
  })
})

describe('runAgents', () => {
  it('lists the agents the server has', async () => {
    const fake = createFakeClient()
    const { io, out } = recorder()

    const code = await runAgents(fake, io)

    expect(code).toBe(0)
    expect(out.join('\n')).toContain(fake.agent.name)
  })

  it('reports a server that is not there', async () => {
    const failure = new TypeError('fetch failed')
    Object.assign(failure, {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })
    const fake = createFakeClient()
    const client = {
      ...fake,
      agents: { ...fake.agents, list: () => Promise.reject(failure) },
    }
    const { io, err } = recorder()

    const code = await runAgents(client, io)

    expect(code).toBe(1)
    expect(err.join('\n')).toContain('http://localhost:3000')
    expect(err.join('\n')).toContain('--server')
  })
})
