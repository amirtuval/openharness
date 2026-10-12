import { makeMcpServer, makeMcpToolSettingEntry } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  MCP_AUTH_TYPES,
  MCP_CONNECTED_PARAM,
  TOOL_POLICIES,
  estimatedTokensLabel,
  mcpAuthHint,
  mcpAuthLabel,
  mcpConnectedServerId,
  mcpFailureNotice,
  mcpServerById,
  mcpServerByName,
  mcpServerFromError,
  mcpServerPolicyBody,
  mcpServerTools,
  mcpStatusDetail,
  mcpStatusLabel,
  mcpStatusTone,
  mcpTestOutcome,
  mcpToolEntriesByServer,
  mcpToolPolicyBody,
  mcpToolPolicyState,
  mcpToolPolicyStateLabel,
  toolPolicyLabel,
  waitForMcpConnection,
} from './mcp'
import type { McpServerTool } from './mcp'

describe('the MCP vocabulary', () => {
  it('names every auth type a form offers, in order', () => {
    expect(MCP_AUTH_TYPES).toEqual(['none', 'headers', 'oauth'])
    expect(MCP_AUTH_TYPES.map(mcpAuthLabel)).toEqual(['None', 'Headers', 'OAuth'])
  })

  it('spells out what each auth type means', () => {
    // Every type has a hint, and each says something different — a form that offered two
    // identical explanations would not be explaining anything.
    const hints = MCP_AUTH_TYPES.map(mcpAuthHint)
    expect(hints.every((hint) => hint.length > 0)).toBe(true)
    expect(new Set(hints).size).toBe(MCP_AUTH_TYPES.length)
    expect(mcpAuthHint('oauth')).toContain('OAuth')
  })

  it('names every status and tones it', () => {
    expect(mcpStatusLabel('connected')).toBe('Connected')
    expect(mcpStatusLabel('needs_reconnect')).toBe('Needs reconnect')
    expect(mcpStatusLabel('error')).toBe('Error')
    // A reconnect is a warning — something to act on — and an error is an error.
    expect(mcpStatusTone('connected')).toBe('ok')
    expect(mcpStatusTone('needs_reconnect')).toBe('warning')
    expect(mcpStatusTone('error')).toBe('error')
  })

  it('names every permission a per-tool picker offers, in order', () => {
    expect(TOOL_POLICIES).toEqual(['allow', 'ask', 'deny'])
    expect(TOOL_POLICIES.map(toolPolicyLabel)).toEqual(['Allow', 'Ask', 'Deny'])
  })
})

describe('estimatedTokensLabel', () => {
  it('writes an estimate as one, in both magnitudes', () => {
    expect(estimatedTokensLabel(0)).toBe('~0 tokens')
    expect(estimatedTokensLabel(999)).toBe('~999 tokens')
    // The boundary is a rounding boundary, not a unit change: 1000 tokens is 1k, not 1000.
    expect(estimatedTokensLabel(1000)).toBe('~1k tokens')
    expect(estimatedTokensLabel(2450)).toBe('~2.5k tokens')
    expect(estimatedTokensLabel(9999)).toBe('~10k tokens')
    expect(estimatedTokensLabel(21000)).toBe('~21k tokens')
  })
})

describe('mcpStatusDetail', () => {
  it('reports the last error when there is one', () => {
    expect(
      mcpStatusDetail(
        makeMcpServer({ status: 'error', last_error: 'The server could not be reached.' }),
      ),
    ).toBe('The server could not be reached.')
  })

  it('falls back to a sentence for an error with no message', () => {
    expect(mcpStatusDetail(makeMcpServer({ status: 'error', last_error: null }))).toBe(
      'The last check failed.',
    )
  })

  it('asks for a sign-in on a server that needs reconnecting', () => {
    expect(mcpStatusDetail(makeMcpServer({ status: 'needs_reconnect', last_error: null }))).toBe(
      'Sign in to the server to use its tools.',
    )
  })

  it('says a connected server has not been checked yet', () => {
    expect(
      mcpStatusDetail(makeMcpServer({ last_tested_at: null, tools: [], definition_tokens: 0 })),
    ).toBe('Not checked yet.')
  })

  it('says a checked server listed no tools', () => {
    expect(mcpStatusDetail(makeMcpServer({ tools: [], definition_tokens: 0 }))).toBe(
      'No tools listed.',
    )
  })

  it('counts the tools and prices them', () => {
    expect(mcpStatusDetail(makeMcpServer())).toBe('1 tool, about ~24 tokens.')
    expect(
      mcpStatusDetail(
        makeMcpServer({
          tools: [
            { name: 'search', description: null, definition_tokens: 24 },
            { name: 'write', description: null, definition_tokens: 2000 },
          ],
          definition_tokens: 2024,
        }),
      ),
    ).toBe('2 tools, about ~2k tokens.')
  })
})

describe('mcpServerTools', () => {
  const server = makeMcpServer({
    name: 'notes',
    tools: [
      { name: 'search', description: 'Search notes', definition_tokens: 41 },
      { name: 'write', description: null, definition_tokens: 12 },
    ],
    definition_tokens: 53,
  })

  it('joins a server tool list with the permissions the settings hold', () => {
    const tools = mcpServerTools(server, [
      makeMcpToolSettingEntry({ name: 'notes__search', mcp_server: 'notes', policy: 'allow' }),
      makeMcpToolSettingEntry({ name: 'notes__write', mcp_server: 'notes', policy: 'deny' }),
    ])

    expect(tools).toEqual([
      {
        offeredName: 'notes__search',
        name: 'search',
        description: 'Search notes',
        definitionTokens: 41,
        policy: 'allow',
        listed: true,
      },
      {
        offeredName: 'notes__write',
        name: 'write',
        description: null,
        definitionTokens: 12,
        policy: 'deny',
        listed: true,
      },
    ])
  })

  it('reads a tool the settings do not name as its own declaration', () => {
    const tools = mcpServerTools(server, [])
    expect(tools.map((tool) => tool.policy)).toEqual(['ask', 'ask'])
  })

  it('keeps a stored policy for a tool the server no longer lists', () => {
    const tools = mcpServerTools(server, [
      makeMcpToolSettingEntry({ name: 'notes__archive', mcp_server: 'notes', policy: 'allow' }),
    ])
    expect(tools).toHaveLength(3)
    expect(tools[2]).toEqual({
      offeredName: 'notes__archive',
      name: 'archive',
      description: null,
      definitionTokens: null,
      policy: 'allow',
      listed: false,
    })
  })

  it('ignores another server’s tools and this build’s own', () => {
    const tools = mcpServerTools(server, [
      makeMcpToolSettingEntry({ name: 'other__search', mcp_server: 'other', policy: 'allow' }),
      makeMcpToolSettingEntry({ name: 'web_fetch', source: 'builtin', policy: 'deny' }),
    ])
    expect(tools.map((tool) => tool.offeredName)).toEqual(['notes__search', 'notes__write'])
    expect(tools.every((tool) => tool.policy === 'ask')).toBe(true)
  })
})

describe('mcpToolPolicyBody', () => {
  it('writes a permission and nothing else', () => {
    expect(mcpToolPolicyBody('notes__search', 'allow')).toEqual({
      mcp: { notes__search: 'allow' },
    })
  })
})

describe('mcpServerTools’ batch half (#313)', () => {
  /** One server's tools, as `mcpServerTools` joins them. */
  const tools = (policies: readonly ('allow' | 'ask' | 'deny')[]): McpServerTool[] =>
    policies.map((policy, position) => ({
      offeredName: `notes__tool${position}`,
      name: `tool${position}`,
      description: null,
      definitionTokens: null,
      policy,
      listed: true,
    }))

  it('writes every tool of the server in one `mcp` map', () => {
    expect(mcpServerPolicyBody(tools(['ask', 'allow', 'deny']), 'deny')).toEqual({
      mcp: { notes__tool0: 'deny', notes__tool1: 'deny', notes__tool2: 'deny' },
    })
  })

  it('answers null for a server with nothing to set', () => {
    expect(mcpServerPolicyBody([], 'allow')).toBeNull()
  })

  it('reads a permission every tool shares as uniform', () => {
    expect(mcpToolPolicyState(tools(['ask', 'ask']))).toEqual({ kind: 'uniform', policy: 'ask' })
    expect(mcpToolPolicyState(tools(['ask']))).toEqual({ kind: 'uniform', policy: 'ask' })
  })

  it('reads tools that disagree as mixed, and no tools as no state', () => {
    expect(mcpToolPolicyState(tools(['ask', 'deny']))).toEqual({ kind: 'mixed' })
    expect(mcpToolPolicyState([])).toBeNull()
  })

  it('names the two states the way a control shows them', () => {
    expect(mcpToolPolicyStateLabel({ kind: 'uniform', policy: 'ask' })).toBe('Ask (all)')
    expect(mcpToolPolicyStateLabel({ kind: 'uniform', policy: 'allow' })).toBe('Allow (all)')
    expect(mcpToolPolicyStateLabel({ kind: 'mixed' })).toBe('Mixed')
  })
})

describe('mcpToolEntriesByServer', () => {
  it('groups the remote entries by the server they belong to', () => {
    const groups = mcpToolEntriesByServer([
      makeMcpToolSettingEntry({ name: 'web_fetch', source: 'builtin' }),
      makeMcpToolSettingEntry({ name: 'notes__search', mcp_server: 'notes' }),
      makeMcpToolSettingEntry({ name: 'other__read', mcp_server: 'other' }),
      makeMcpToolSettingEntry({ name: 'notes__write', mcp_server: 'notes' }),
    ])

    expect([...groups.keys()]).toEqual(['notes', 'other'])
    expect(groups.get('notes')?.map((entry) => entry.name)).toEqual([
      'notes__search',
      'notes__write',
    ])
    expect(groups.get('other')?.map((entry) => entry.name)).toEqual(['other__read'])
  })
})

describe('mcpServerByName and mcpServerById', () => {
  const notes = makeMcpServer({ name: 'notes' })
  const other = makeMcpServer({ name: 'other' })

  it('finds a server by the name a settings read carries', () => {
    expect(mcpServerByName([notes, other], 'other')).toBe(other)
    expect(mcpServerByName([notes, other], 'gone')).toBeNull()
    expect(mcpServerByName([notes, other], undefined)).toBeNull()
  })

  it('finds a server by id, and answers null for nothing', () => {
    expect(mcpServerById([notes, other], other.id)).toBe(other)
    expect(mcpServerById([notes, other], 'mcps_unknown')).toBeNull()
    expect(mcpServerById([notes, other], null)).toBeNull()
    expect(mcpServerById([notes, other], undefined)).toBeNull()
  })
})

describe('mcpFailureNotice', () => {
  it('reads a container failure as a warning with a server to reconnect', () => {
    const notice = mcpFailureNotice({
      type: 'mcp_connection_failed_error',
      message:
        'The MCP server "notes" could not be used: getaddrinfo ENOTFOUND. ' +
        'This chat continues without its tools.',
    })

    expect(notice).toEqual({
      server: 'notes',
      message:
        'The MCP server "notes" could not be used: getaddrinfo ENOTFOUND. ' +
        'This chat continues without its tools.',
      reconnectable: true,
    })
  })

  it('reads an authentication failure the same way', () => {
    const notice = mcpFailureNotice({
      type: 'mcp_authentication_failed_error',
      message:
        'The MCP server "notes" could not be used: the token was refused. This chat continues without its tools.',
    })
    expect(notice?.reconnectable).toBe(true)
    expect(notice?.server).toBe('notes')
  })

  it('is nothing for another error, or for none', () => {
    expect(mcpFailureNotice(null)).toBeNull()
    expect(
      mcpFailureNotice({ type: 'tool_steps_exhausted_error', message: 'too many steps' }),
    ).toBeNull()
    expect(mcpFailureNotice({ type: 'model_request_failed_error', message: 'boom' })).toBeNull()
  })

  it('still shows the failure when the message names no server', () => {
    const notice = mcpFailureNotice({ type: 'mcp_connection_failed_error', message: 'it broke' })
    expect(notice).toEqual({ server: null, message: 'it broke', reconnectable: true })
  })
})

describe('mcpServerFromError', () => {
  it('reads the name the brain quotes', () => {
    expect(
      mcpServerFromError('The MCP server "my-notes" could not be used: down. This chat continues.'),
    ).toBe('my-notes')
  })

  it('is null for a message that does not open the way the brain writes one', () => {
    expect(mcpServerFromError('Something else went wrong.')).toBeNull()
    expect(mcpServerFromError('the MCP server "notes" could not be used: x')).toBeNull()
    expect(mcpServerFromError('The MCP server "notes" was fine')).toBeNull()
    expect(mcpServerFromError('The MCP server  could not be used: x')).toBeNull()
  })

  it('keeps a name the brain did not quote rather than dropping it', () => {
    expect(mcpServerFromError('The MCP server notes could not be used: x')).toBe('notes')
  })
})

describe('mcpConnectedServerId', () => {
  it('reads the id a web callback named', () => {
    expect(mcpConnectedServerId('?mcp_connected=mcps_01JABC')).toBe('mcps_01JABC')
    expect(mcpConnectedServerId('mcp_connected=mcps_01JABC')).toBe('mcps_01JABC')
  })

  it('finds it among other parameters, and past the hash', () => {
    expect(mcpConnectedServerId('?tab=servers&mcp_connected=mcps_1#/settings')).toBe('mcps_1')
    expect(mcpConnectedServerId('?mcp_connected=mcps_1#/settings')).toBe('mcps_1')
  })

  it('decodes what it read', () => {
    expect(mcpConnectedServerId('?mcp_connected=mcps%5F1')).toBe('mcps_1')
  })

  it('is null when nothing named a server', () => {
    expect(mcpConnectedServerId('')).toBeNull()
    expect(mcpConnectedServerId('?other=1')).toBeNull()
    expect(mcpConnectedServerId('?mcp_connected=')).toBeNull()
    expect(mcpConnectedServerId(`?${MCP_CONNECTED_PARAM}`)).toBeNull()
  })
})

describe('waitForMcpConnection', () => {
  /** A `get` answering from a script, counting its calls, and a sleep that never waits. */
  function scripted(servers: readonly ReturnType<typeof makeMcpServer>[]) {
    const reads: number[] = []
    let index = 0
    return {
      reads,
      get: (): Promise<ReturnType<typeof makeMcpServer>> => {
        reads.push(index)
        const server = servers[Math.min(index, servers.length - 1)]
        index += 1
        if (server === undefined) {
          throw new Error('the script ran dry')
        }
        return Promise.resolve(server)
      },
      sleep: (): Promise<void> => Promise.resolve(),
    }
  }

  it('reads the server before waiting, and answers a completed flow at once', async () => {
    const fake = scripted([makeMcpServer({ status: 'connected' })])
    const wait = await waitForMcpConnection({ get: fake.get, sleep: fake.sleep })

    expect(wait.outcome).toBe('connected')
    expect(fake.reads).toEqual([0])
  })

  it('polls until the status changes', async () => {
    const fake = scripted([
      makeMcpServer({ status: 'needs_reconnect' }),
      makeMcpServer({ status: 'needs_reconnect' }),
      makeMcpServer({ status: 'connected' }),
    ])
    const wait = await waitForMcpConnection({ get: fake.get, sleep: fake.sleep })

    expect(wait.outcome).toBe('connected')
    expect(fake.reads).toHaveLength(3)
  })

  it('reports a server that landed on error as a failure, not a throw', async () => {
    const fake = scripted([
      makeMcpServer({ status: 'needs_reconnect' }),
      makeMcpServer({ status: 'error', last_error: 'the token exchange was refused' }),
    ])
    const wait = await waitForMcpConnection({ get: fake.get, sleep: fake.sleep })

    expect(wait.outcome).toBe('failed')
    expect(wait.server.last_error).toBe('the token exchange was refused')
  })

  it('gives up after the timeout, answering the newest read', async () => {
    const fake = scripted([makeMcpServer({ status: 'needs_reconnect' })])
    const wait = await waitForMcpConnection({
      get: fake.get,
      sleep: fake.sleep,
      timeoutMs: 0,
    })

    // A zero timeout still reads once — the read is what the caller is owed, and only the
    // waiting is skipped.
    expect(wait.outcome).toBe('timeout')
    expect(wait.server.status).toBe('needs_reconnect')
    expect(fake.reads).toHaveLength(1)
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const fake = scripted([makeMcpServer({ status: 'needs_reconnect' })])
    const wait = await waitForMcpConnection({
      get: fake.get,
      sleep: (): Promise<void> => {
        controller.abort()
        return Promise.resolve()
      },
      signal: controller.signal,
    })

    expect(wait.outcome).toBe('stopped')
  })
})

describe('what a Test came to (#314)', () => {
  it('reports the tools a check listed, in the same estimate the row uses', () => {
    const outcome = mcpTestOutcome(
      makeMcpServer({
        status: 'connected',
        tools: [
          { name: 'search', description: 'Search', definition_tokens: 41 },
          { name: 'read', description: null, definition_tokens: 12 },
        ],
        definition_tokens: 53,
      }),
    )
    expect(outcome).toEqual({ ok: true, message: 'Connected. Listed 2 tools, about ~53 tokens.' })
  })

  it('says a connected server lists nothing, rather than reporting a bare success', () => {
    expect(mcpTestOutcome(makeMcpServer({ status: 'connected', tools: [] }))).toEqual({
      ok: true,
      message: 'Connected. The server lists no tools.',
    })
  })

  it('shows the reason a check recorded, status and body included', () => {
    // The maintainer's Linear report: a 401 whose SDK message stopped at a colon. The server
    // stores the status and a body excerpt now, and the row shows exactly that.
    const outcome = mcpTestOutcome(
      makeMcpServer({
        status: 'error',
        last_error: 'the MCP server answered 401 Unauthorized: {"error":"invalid_token"}',
      }),
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('401')
    expect(outcome.message).toContain('invalid_token')
  })

  it('tells a reader to connect when an OAuth server has no token at all', () => {
    const outcome = mcpTestOutcome(
      makeMcpServer({ auth: 'oauth', status: 'needs_reconnect', last_error: null }),
    )
    expect(outcome).toEqual({
      ok: false,
      message: 'Connect first — this server needs a sign-in.',
    })
  })

  it('never reports an empty message', () => {
    const outcome = mcpTestOutcome(
      makeMcpServer({ auth: 'none', status: 'error', last_error: null }),
    )
    expect(outcome.message.length).toBeGreaterThan(0)
  })
})
