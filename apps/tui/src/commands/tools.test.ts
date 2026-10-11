import type { ToolsPatch } from '../args'
import { describe, expect, it } from 'vitest'

import { createFakeClient } from '@openharness/client/testing'

import { formatTools, runTools } from './tools'

/**
 * `oh tools` (epic #303, X4; #307; #308).
 *
 * `formatTools` holds the words still — the state, the permission, the default note and the
 * "not available" case — and `runTools` is driven against the fake client, which backs
 * `/v1/me/tools` the way the server does.
 */

/** A `CommandIo` that collects what was written, and never blocks on stdin. */
function recorder() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      context: { server: 'https://api.test', debug: false },
    },
  }
}

describe('formatTools (#308)', () => {
  it('shows each tool’s state, permission and default', () => {
    const lines = formatTools([
      {
        name: 'web_fetch',
        source: 'builtin',
        enabled: true,
        policy: 'allow',
        default_policy: 'allow',
        available: true,
      },
      {
        name: 'todo_write',
        source: 'builtin',
        enabled: false,
        policy: 'ask',
        default_policy: 'allow',
        available: true,
      },
    ])

    expect(lines[0]).toContain('web_fetch')
    expect(lines[0]).toContain('on')
    expect(lines[0]).toContain('allow (default)')
    expect(lines[1]).toContain('off')
    expect(lines[1]).toContain('ask (default allow)')
  })

  it('says when a tool this server does not register', () => {
    const lines = formatTools([
      {
        name: 'web_search',
        source: 'builtin',
        enabled: true,
        policy: 'allow',
        default_policy: null,
        available: false,
      },
    ])

    expect(lines[0]).toContain('not available on this server')
  })

  it('says so when nothing is registered', () => {
    expect(formatTools([])).toEqual(['No tools are registered on this server.'])
  })
})

describe('runTools (#308)', () => {
  it('prints the tools when no name is given', async () => {
    const fake = createFakeClient()
    const { io, out } = recorder()

    expect(await runTools(fake, io, {})).toBe(0)
    expect(out.join('\n')).toContain('web_fetch')
    expect(out.join('\n')).toContain('todo_write')
  })

  it('turns one tool off without disturbing the others, and reports it', async () => {
    const fake = createFakeClient()
    const { io, out } = recorder()

    const patch: ToolsPatch = { name: 'web_search', enabled: false }
    expect(await runTools(fake, io, patch)).toBe(0)
    expect(out[0]).toBe('Saved web_search: off, allow.')

    const stored = await fake.tools.list()
    expect(stored.data.find((entry) => entry.name === 'web_search')?.enabled).toBe(false)
    expect(stored.data.find((entry) => entry.name === 'web_fetch')?.enabled).toBe(true)
  })

  it('changes the permission alone, keeping the on/off state', async () => {
    const fake = createFakeClient()
    const { io } = recorder()

    await runTools(fake, io, { name: 'todo_write', policy: 'deny' })
    const stored = await fake.tools.list()
    const entry = stored.data.find((candidate) => candidate.name === 'todo_write')
    expect(entry?.policy).toBe('deny')
    expect(entry?.enabled).toBe(true)
  })

  it('refuses a name this server does not register', async () => {
    const fake = createFakeClient()
    const { io, err } = recorder()

    expect(await runTools(fake, io, { name: 'nope', enabled: true })).toBe(1)
    expect(err[0]).toContain('no tool named nope')
  })
})
