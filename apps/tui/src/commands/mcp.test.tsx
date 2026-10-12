import { makeMcpServer } from '@openharness/protocol/fixtures'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { McpServersApp, formatMcpServers } from './mcp'
import { createFakeClient } from '@openharness/client/testing'

import {
  frameOf,
  pressKey,
  submit,
  typeText,
  waitForFrame,
  waitForScreen,
} from '../test-support/input'

/**
 * `oh mcp` (epic #303, X10; #313): the servers screen, and the listing a piped run prints.
 *
 * The screen is driven through `ink-testing-library` with the shared fake, so the keys, the
 * rows and the writes are the same ones a person gets — no terminal.
 */

const CONTEXT = { server: 'http://localhost:3000' }

/** The notes server: an OAuth one, connected, with two tools behind it. */
const NOTES = makeMcpServer({
  name: 'notes',
  tools: [
    { name: 'search', description: 'Search notes', definition_tokens: 41 },
    { name: 'read', description: null, definition_tokens: 12 },
  ],
  definition_tokens: 53,
})

/** Render the screen, and answer what the browser was asked to open. */
function renderMcp(options: Parameters<typeof createFakeClient>[0] = {}): {
  readonly app: ReturnType<typeof render>
  readonly fake: ReturnType<typeof createFakeClient>
  readonly opened: string[]
} {
  const fake = createFakeClient(options)
  const opened: string[] = []
  const app = render(
    <McpServersApp
      client={fake}
      context={CONTEXT}
      openUrl={(url) => {
        opened.push(url)
        return true
      }}
    />,
  )
  return { app, fake, opened }
}

describe('the servers listing (no terminal)', () => {
  it('says how a server is added when there are none', () => {
    expect(formatMcpServers([])).toEqual(['No MCP servers. Run `oh mcp` in a terminal to add one.'])
  })

  it('prints what each server is, where it is, and what state it is in', () => {
    const lines = formatMcpServers([
      NOTES,
      makeMcpServer({ name: 'git', auth: 'none', status: 'error', last_error: 'it is down' }),
    ])

    expect(lines[0]).toBe('notes · OAuth · Connected · 2 tools, about ~53 tokens')
    expect(lines[1]).toBe(`  ${NOTES.url}`)
    expect(lines[2]).toBe('  2 tools, about ~53 tokens.')
    expect(lines[3]).toContain('git · None · Error')
    expect(lines[5]).toBe('  it is down')
  })
})

describe('the servers screen', () => {
  it('lists a server with its status detail, and says what it offers when empty', async () => {
    const empty = renderMcp()
    await waitForScreen(empty.app, 'MCP servers')
    await waitForFrame(empty.app, 'No servers yet.')

    const { app, fake } = renderMcp({ mcpServers: [NOTES] })
    await waitForScreen(app, 'MCP servers')
    await waitForFrame(app, 'notes · OAuth · Connected')
    await waitForFrame(app, '2 tools, about ~53 tokens.')

    // Turning a server off is one key, and the row says so.
    typeText(app, ' ')
    await waitFor(async () => (await fake.mcpServers.list()).data[0]?.enabled === false)
    await waitForFrame(app, 'notes · OAuth · Connected · off')
  })

  it('tests a server and shows the failure it comes back with', async () => {
    const { app } = renderMcp({
      mcpServers: [makeMcpServer({ name: 'git', auth: 'none' })],
      mcpUnreachable: ['git'],
    })
    await waitForScreen(app, 'MCP servers')
    await waitForFrame(app, 'git · None · Connected')

    typeText(app, 't')
    await waitForFrame(app, 'git · None · Error')
    await waitForFrame(app, 'The server could not be reached.')
  })

  it('deletes a server only after the y/N', async () => {
    const { app, fake } = renderMcp({ mcpServers: [NOTES] })
    await waitForScreen(app, 'MCP servers')
    await waitForFrame(app, 'notes · OAuth')

    typeText(app, 'd')
    await waitForFrame(app, 'Delete notes?')
    // n leaves it alone.
    typeText(app, 'n')
    await waitFor(() => !frameOf(app).includes('Delete notes?'))
    expect((await fake.mcpServers.list()).data).toHaveLength(1)

    typeText(app, 'd')
    await waitForFrame(app, 'Delete notes?')
    typeText(app, 'y')
    await waitFor(async () => (await fake.mcpServers.list()).data.length === 0)
    await waitForFrame(app, 'notes was deleted.')
    await waitForFrame(app, 'No servers yet.')
  })

  it('connects an OAuth server: opens the page, waits, and reports the outcome', async () => {
    const { app, fake, opened } = renderMcp({
      mcpServers: [{ ...NOTES, status: 'needs_reconnect' }],
    })
    await waitForScreen(app, 'MCP servers')
    await waitForFrame(app, 'notes · OAuth · Needs reconnect')

    typeText(app, 'c')
    await waitForFrame(app, 'Approve the sign-in for notes in your browser')
    expect(opened).toHaveLength(1)
    expect(fake.mcpConnects).toEqual([{ serverId: NOTES.id, client: 'cli' }])

    // The browser comes back: the callback completes the flow, and the wait sees it on its next
    // poll — two seconds, the client's default interval. The timeout is that, not the frame's.
    fake.completeMcpOAuth(NOTES.id)
    await waitForFrame(app, 'notes is connected.', 6000)
    await waitForFrame(app, 'notes · OAuth · Connected')
  })

  it('walks a server’s tools and changes one permission', async () => {
    const { app, fake } = renderMcp({ mcpServers: [NOTES] })
    await waitForScreen(app, 'MCP servers')

    typeText(app, 'p')
    await waitForFrame(app, 'notes · tools')
    await waitForFrame(app, 'notes__search · Ask · ~41 tokens')

    pressKey(app, 'right')
    await waitFor(async () => {
      const { data } = await fake.tools.list()
      return data.find((entry) => entry.name === 'notes__search')?.policy === 'deny'
    })
    await waitForFrame(app, 'notes__search · Deny')

    pressKey(app, 'escape')
    await waitForFrame(app, 'MCP servers')
  })

  it('registers a server through the form, one prompt at a time', async () => {
    const { app, fake } = renderMcp({
      // The fake lists a `none` server's tools from this seed, so the check that runs on save
      // has something to list — which is what the note is about.
      mcpTools: [{ server: 'wiki', name: 'page', definitionTokens: 28 }],
    })
    await waitForScreen(app, 'MCP servers')
    await waitForFrame(app, 'No servers yet.')

    typeText(app, 'n')
    await waitForFrame(app, 'Add an MCP server')
    // The URL comes first (issue #314): it is what the server probes.
    await waitForFrame(app, 'URL (the Streamable HTTP endpoint)')
    await waitForFrame(app, 'work out how it authenticates')
    submit(app, 'https://wiki.example.com/mcp')
    // Then an optional name — never an auth type; there is nothing to classify.
    await waitForFrame(app, 'Name (optional')
    expect(frameOf(app)).not.toContain('Authentication')
    submit(app, 'wiki')
    // Then the optional custom header, which is left blank here.
    await waitForFrame(app, 'Custom header name')
    pressKey(app, 'enter')
    await waitForFrame(app, 'Custom header value (optional)')
    pressKey(app, 'enter')
    // Whether it is on, then the save.
    await waitForFrame(app, 'On by default for your chats')
    pressKey(app, 'enter')

    await waitForFrame(app, 'wiki · None · Connected')
    await waitForFrame(app, '1 tool, about ~28 tokens')
    expect((await fake.mcpServers.list()).data[0]?.name).toBe('wiki')
  })

  it('refuses a name and a URL the protocol refuses, on the prompt', async () => {
    const { app } = renderMcp()
    await waitForScreen(app, 'MCP servers')

    typeText(app, 'n')
    await waitForFrame(app, 'URL (the Streamable HTTP endpoint)')
    submit(app, 'not-a-url')
    // Held on the same prompt, with the reason: what was typed is still in the box to fix.
    await waitForFrame(app, 'an absolute http or https URL')
    expect(frameOf(app)).not.toContain('Name (optional')

    // Esc leaves the form; a second run checks the name rule.
    pressKey(app, 'escape')
    await waitForFrame(app, 'No servers yet.')
    typeText(app, 'n')
    await waitForFrame(app, 'URL (the Streamable HTTP endpoint)')
    submit(app, 'https://wiki.example.com/mcp')
    await waitForFrame(app, 'Name (optional')
    submit(app, 'Notes Server')
    await waitForFrame(app, 'a name is 1–32 lowercase letters')
    pressKey(app, 'escape')
    await waitForFrame(app, 'No servers yet.')
  })

  it('leaves with Esc, and Ctrl+C inside the form leaves the form', async () => {
    const { app } = renderMcp({ mcpServers: [NOTES] })
    await waitForScreen(app, 'MCP servers')

    pressKey(app, 'enter')
    await waitForFrame(app, 'Edit notes')
    pressKey(app, 'ctrlC')
    await waitForFrame(app, 'notes · OAuth · Connected')
    expect(frameOf(app)).not.toContain('Edit notes')
  })
})

/** Wait for something about the fake, without the frame in the way. */
async function waitFor(condition: () => Promise<boolean> | boolean): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await condition()) return
    if (Date.now() - started > 5000) {
      throw new Error('the condition never held')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
