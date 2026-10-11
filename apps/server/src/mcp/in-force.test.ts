import type { McpServer, ModeToolOverride } from '@openharness/protocol'
import { makeMcpServer, makeUser } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { listMcpServersInForce, mcpServersInForce } from './in-force'
import type { McpServerService } from './service'

/**
 * The MCP servers in force for a request (epic #303, X10; #311).
 *
 * The rule has two levels — the user's `enabled` on the resource is the default, and a mode's
 * `mcp_servers` map is a patch over it — and what matters here is every boundary: a server
 * nobody overrode, one the mode turned off, one it turned on, and an id that names no server
 * because the server was deleted after the mode was stored.
 */

const OWNER = makeUser().id

/** One server owned by the test's user, `enabled` as given. */
function server(enabled: boolean, overrides: Partial<McpServer> = {}): McpServer {
  return makeMcpServer({ owner_id: OWNER, enabled, ...overrides })
}

/** A `mcps_` id that names no server in any of these tests — a deleted server's, or a fiction. */
function unknownServerId(): string {
  return makeMcpServer().id
}

/** The override a mode carries: the MCP map, or `null` for a mode that says nothing about tools. */
function modeOverride(mcp: Record<string, boolean>): ModeToolOverride {
  return { builtin: {}, mcp_servers: mcp }
}

/** A `McpServerService` whose `list` answers exactly these servers, for the async half. */
function service(servers: readonly McpServer[]): Pick<McpServerService, 'list'> {
  return { list: async () => [...servers] }
}

describe('mcpServersInForce', () => {
  it('follows the user when no mode says anything: enabled in, disabled out', () => {
    const on = server(true)
    const off = server(false)
    expect(mcpServersInForce([on, off], null)).toEqual([on])
  })

  it('lets a mode turn an enabled server off, and a disabled one on', () => {
    const on = server(true)
    const off = server(false)
    expect(mcpServersInForce([on], modeOverride({ [on.id]: false }))).toEqual([])
    expect(mcpServersInForce([off], modeOverride({ [off.id]: true }))).toEqual([off])
  })

  it('follows the user for every server the mode does not name', () => {
    const named = server(true)
    const other = server(true)
    const disabled = server(false)
    expect(
      mcpServersInForce(
        [named, other, disabled],
        modeOverride({ [named.id]: false, [disabled.id]: true }),
      ),
    ).toEqual([other, disabled])
  })

  it('ignores an entry that names no server — a deleted one, or an id nothing ever had', () => {
    // The mode routes store the map by id without checking it, so deleting a server must leave
    // the modes that named it alone: the entry simply matches nothing, and the servers the user
    // does have follow the user's own choice as if the entry were not there.
    const live = server(true)
    const off = server(false)
    for (const wanted of [true, false]) {
      expect(mcpServersInForce([live, off], modeOverride({ [unknownServerId()]: wanted }))).toEqual(
        [live],
      )
    }
  })

  it('keeps an enabled server whatever its connection status is', () => {
    // Being enabled is the user's choice; a server that is down is a failure to report when the
    // loop tries it (#312), not a reason to drop it here.
    const needsReconnect = server(true, { auth: 'oauth', status: 'needs_reconnect' })
    const errored = server(true, { status: 'error', last_error: 'unreachable' })
    expect(mcpServersInForce([needsReconnect, errored], null)).toEqual([needsReconnect, errored])
  })

  it('keeps the list’s own order — a user’s servers, oldest first — with the mode applied', () => {
    const first = server(true)
    const second = server(false)
    const third = server(true)
    expect(
      mcpServersInForce(
        [first, second, third],
        modeOverride({ [second.id]: true, [third.id]: false }),
      ),
    ).toEqual([first, second])
  })

  it('reads an empty map as a mode that overrides nothing, not one that turns everything off', () => {
    const on = server(true)
    const off = server(false)
    expect(mcpServersInForce([on, off], modeOverride({}))).toEqual([on])
  })
})

describe('listMcpServersInForce', () => {
  it('reads the owner’s servers and applies the mode’s override over them', async () => {
    const on = server(true)
    const off = server(false)
    const deps = { mcpServers: service([on, off]) }
    expect(await listMcpServersInForce(deps, OWNER, null)).toEqual([on])
    expect(
      await listMcpServersInForce(deps, OWNER, modeOverride({ [off.id]: true, [on.id]: false })),
    ).toEqual([off])
  })

  it('answers nothing for an owner with no servers, whatever the mode says', async () => {
    const deps = { mcpServers: service([]) }
    expect(
      await listMcpServersInForce(deps, OWNER, modeOverride({ [unknownServerId()]: true })),
    ).toEqual([])
  })
})
