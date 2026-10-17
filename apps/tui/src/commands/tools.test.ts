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

  it('leaves the remote MCP tools out, and says how many and where (#313)', () => {
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
        name: 'notes__search',
        source: 'mcp',
        enabled: true,
        policy: 'ask',
        default_policy: 'ask',
        available: true,
        mcp_server: 'notes',
      },
      {
        name: 'notes__read',
        source: 'mcp',
        enabled: true,
        policy: 'ask',
        default_policy: 'ask',
        available: true,
        mcp_server: 'notes',
      },
    ])

    // The tool's own line, nothing from the server but the line that says so, and where the
    // same settings are in a chat (#335).
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('web_fetch')
    expect(lines.join('\n')).not.toContain('notes__search')
    expect(lines[1]).toBe(
      '2 tools come from MCP servers; their permissions are set per server with `/mcp`.',
    )
    expect(lines[2]).toBe('In a chat, `/tools` sets these without leaving it.')
  })

  it('counts a single remote tool in the singular', () => {
    const lines = formatTools([
      {
        name: 'notes__search',
        source: 'mcp',
        enabled: true,
        policy: 'ask',
        default_policy: 'ask',
        available: true,
        mcp_server: 'notes',
      },
    ])

    expect(lines).toEqual([
      'No tools are registered on this server.',
      '1 tool comes from MCP servers; their permissions are set per server with `/mcp`.',
    ])
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

  it('leaves a remote MCP tool out of the listing, and says where it is set (#313)', async () => {
    const fake = createFakeClient({ mcpTools: [{ server: 'notes', name: 'search' }] })
    const { io, out } = recorder()

    expect(await runTools(fake, io, {})).toBe(0)
    expect(out).toContain(
      '1 tool comes from MCP servers; their permissions are set per server with `/mcp`.',
    )
    expect(out.join('\n')).not.toContain('notes__search')
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

  it('refuses `ask` for a subagent tool the settings screen does not offer it for (#368)', async () => {
    // Epic #340, S9: the `agent` call is drawn as a card rather than as a tool line, so there is
    // no prompt any client could draw for a pause on it — the server refuses the write, and this
    // command refuses it before sending one. The fake registers three built-ins and no subagent
    // tools, so a stored setting is how the row exists here at all; the real listing is the
    // server's.
    const fake = createFakeClient({
      toolSettings: {
        builtin: { agent: { enabled: true, policy: 'allow' } },
        mcp: {},
      },
    })
    const { io, err, out } = recorder()

    expect(await runTools(fake, io, { name: 'agent', policy: 'ask' })).toBe(2)
    expect(err[0]).toContain('agent cannot take `ask`')
    expect(out).toEqual([])
    // Nothing was written: the stored permission is what it was.
    const stored = await fake.tools.list()
    expect(stored.data.find((entry) => entry.name === 'agent')?.policy).toBe('allow')
  })

  it('refuses a name this server does not register', async () => {
    const fake = createFakeClient()
    const { io, err } = recorder()

    expect(await runTools(fake, io, { name: 'nope', enabled: true })).toBe(1)
    expect(err[0]).toContain('no tool named nope')
  })

  it('writes a remote MCP tool’s permission to the `mcp` map, not `builtin` (#314)', async () => {
    const fake = createFakeClient({ mcpTools: [{ server: 'notes', name: 'search' }] })
    const { io, out } = recorder()

    expect(await runTools(fake, io, { name: 'notes__search', policy: 'deny' })).toBe(0)
    expect(out[0]).toBe('Saved notes__search: deny.')

    const entry = (await fake.tools.list()).data.find(
      (candidate) => candidate.name === 'notes__search',
    )
    // The permission really moved, on the remote entry — with the old `builtin` write it stayed
    // at the tool's own `ask` declaration and a stray, unavailable built-in row appeared beside
    // it instead.
    expect(entry?.policy).toBe('deny')
    expect(entry?.default_policy).toBe('ask')
    expect(entry?.available).toBe(true)
    expect(
      (await fake.tools.list()).data.filter((candidate) => candidate.name === 'notes__search'),
    ).toHaveLength(1)
  })

  it('refuses --on/--off for a remote MCP tool, pointing at /mcp (#314)', async () => {
    const fake = createFakeClient({ mcpTools: [{ server: 'notes', name: 'search' }] })
    const { io, err } = recorder()

    expect(await runTools(fake, io, { name: 'notes__search', enabled: false })).toBe(2)
    expect(err[0]).toContain('/mcp')

    // Nothing was written: the tool still follows its own `ask` declaration.
    const entry = (await fake.tools.list()).data.find(
      (candidate) => candidate.name === 'notes__search',
    )
    expect(entry?.policy).toBe('ask')
  })
})
