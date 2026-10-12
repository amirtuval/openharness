import { makeMcpServer } from '@openharness/protocol/fixtures'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { FakeClientOptions } from '@openharness/client/testing'

import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * Settings → MCP servers (epic #303, X10; the screen is #313), against the fake server.
 *
 * The card is the reader's remote servers: what each one is (name, auth, address), what state it
 * is in (status, the last error, the tools a check listed and what they cost), and every verb a
 * server has — on/off, Test, Connect/Reconnect, Disconnect, Edit, Delete — plus the permission
 * each of its tools runs under.
 */

function renderSettings(options: FakeClientOptions = {}): void {
  renderApp(makeFake(options), { hash: '#/settings' })
}

const user = userEvent.setup()

const NOTES = makeMcpServer({
  name: 'notes',
  tools: [
    { name: 'search', description: 'Search your notes', definition_tokens: 41 },
    { name: 'read', description: 'Read one note', definition_tokens: 12 },
  ],
  definition_tokens: 53,
})

/** One server's row. */
async function serverRow(name: string): Promise<HTMLElement> {
  const heading = await screen.findByText(name)
  const row = heading.closest('[data-slot="mcp-server-row"]')
  if (row === null) {
    throw new Error(`no server row for ${name}`)
  }
  return row as HTMLElement
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Settings → MCP servers', () => {
  it('shows an empty state, and registers a server from the dialog', async () => {
    const fake = makeFake({
      // The fake lists a `none` server's tools from this seed, so a freshly registered `wiki`
      // comes back from its save-time check with the tool its server really offers.
      mcpTools: [{ server: 'wiki', name: 'page', definitionTokens: 28 }],
    })
    renderApp(fake, { hash: '#/settings' })

    expect(await screen.findByText(/No servers yet\./)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'wiki')
    await user.type(within(dialog).getByLabelText('URL'), 'https://wiki.example.com/mcp')
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }))

    const row = await serverRow('wiki')
    expect(row).toHaveAttribute('data-status', 'connected')
    expect(row).toHaveAttribute('data-auth', 'none')
    expect(within(row).getByText('None')).toBeInTheDocument()
    expect(within(row).getByText('Connected')).toBeInTheDocument()
    // A `none` server needs no flow: Test, Edit and Delete, and nothing to connect.
    expect(within(row).getByRole('button', { name: 'Test wiki' })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /Connect wiki/ })).toBeNull()
    // The check listed the tool and priced its definition.
    expect(within(row).getByText('1 tool · ~28 tokens')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: /1 tool/ }))
    expect(await within(row).findByText('wiki__page')).toBeInTheDocument()
  })

  it('refuses a name and a URL the protocol refuses, beside the field', async () => {
    renderApp(makeFake(), { hash: '#/settings' })
    await user.click(await screen.findByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog')

    await user.type(within(dialog).getByLabelText('Name'), 'Notes Server')
    await user.type(within(dialog).getByLabelText('URL'), 'not-a-url')
    expect(await within(dialog).findByText(/lowercase letters, digits/)).toBeInTheDocument()
    expect(within(dialog).getByText(/absolute http or https URL/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add server' })).toBeDisabled()
  })

  it('refuses a name the reader already has, as the server’s 409', async () => {
    renderSettings({ mcpServers: [NOTES] })
    await serverRow('notes')

    await user.click(screen.getByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Name'), 'notes')
    await user.type(within(dialog).getByLabelText('URL'), 'https://other.example.com/mcp')
    await user.click(within(dialog).getByRole('button', { name: 'Add server' }))

    const failure = await within(dialog).findByRole('alert')
    expect(failure).toHaveTextContent(/already exists/)
    expect(failure).toHaveAttribute('data-kind', 'conflict')
  })

  it('asks for a header when a new server authenticates with one', async () => {
    renderApp(makeFake(), { hash: '#/settings' })
    await user.click(await screen.findByRole('button', { name: 'Add server' }))
    const dialog = await screen.findByRole('dialog')

    await user.type(within(dialog).getByLabelText('Name'), 'wiki')
    await user.type(within(dialog).getByLabelText('URL'), 'https://wiki.example.com/mcp')
    await user.selectOptions(within(dialog).getByLabelText('Authentication'), 'headers')

    // A `headers` server with no header is a `none` server that says otherwise, and the wire
    // refuses one: the form holds the save and says why.
    expect(await within(dialog).findByText(/needs at least one header/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add server' })).toBeDisabled()

    await user.click(within(dialog).getByRole('button', { name: 'Add header' }))
    await user.type(within(dialog).getByLabelText('Header 1 name'), 'Authorization')
    await user.type(within(dialog).getByLabelText('Header 1 value'), 'Bearer sk-secret')
    expect(within(dialog).getByRole('button', { name: 'Add server' })).toBeEnabled()

    await user.click(within(dialog).getByRole('button', { name: 'Add server' }))
    const row = await serverRow('wiki')
    // The listing reports the header's **name** and never its value.
    expect(within(row).getByText('Headers')).toBeInTheDocument()
    expect(row.textContent).not.toContain('sk-secret')
  })

  it('shows a server’s tools with their policies and estimated cost, and writes one', async () => {
    const fake = makeFake({ mcpServers: [NOTES] })
    renderApp(fake, { hash: '#/settings' })

    const row = await serverRow('notes')
    expect(within(row).getByText('OAuth')).toBeInTheDocument()
    expect(within(row).getByText('Connected')).toBeInTheDocument()
    expect(within(row).getByText('2 tools · ~53 tokens')).toBeInTheDocument()
    expect(within(row).getByText('https://mcp.example.com/mcp')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: /2 tools/ }))
    const policy = await within(row).findByLabelText('notes__search when called')
    // Every remote tool declares `ask`, which is what the server reports until the reader says
    // otherwise.
    expect(policy).toHaveValue('ask')
    expect(within(row).getByText('~41 tokens')).toBeInTheDocument()

    await user.selectOptions(policy, 'allow')
    await waitFor(async () => {
      const { data } = await fake.tools.list()
      expect(data.find((entry) => entry.name === 'notes__search')?.policy).toBe('allow')
    })
  })

  it('tests a server, reports its failure, and turns it off', async () => {
    const fake = makeFake({
      mcpServers: [makeMcpServer({ name: 'git', status: 'connected' })],
      mcpUnreachable: ['git'],
    })
    renderApp(fake, { hash: '#/settings' })

    const row = await serverRow('git')
    await user.click(within(row).getByRole('button', { name: 'Test git' }))

    await waitFor(() => expect(row).toHaveAttribute('data-status', 'error'))
    expect(await within(row).findByText('The server could not be reached.')).toBeInTheDocument()

    await user.click(within(row).getByLabelText('Enable git'))
    await waitFor(async () => {
      expect((await fake.mcpServers.list()).data[0]?.enabled).toBe(false)
    })
  })

  it('connects a server in a new tab, and disconnects it', async () => {
    const fake = makeFake({ mcpServers: [{ ...NOTES, status: 'needs_reconnect' }] })
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    renderApp(fake, { hash: '#/settings' })

    const row = await serverRow('notes')
    await user.click(within(row).getByRole('button', { name: 'Connect notes' }))

    await waitFor(() => expect(fake.mcpConnects).toEqual([{ serverId: NOTES.id, client: 'web' }]))
    expect(open).toHaveBeenCalledWith(
      `https://auth.example.com/authorize?server=${NOTES.id}&state=fake_state`,
      '_blank',
      'noopener,noreferrer',
    )

    // The browser comes back: the callback completes the flow, and the row's own Test reads the
    // new status — this screen's Disconnect is for a server that has tokens.
    fake.completeMcpOAuth(NOTES.id)
    open.mockRestore()
    await user.click(within(row).getByRole('button', { name: 'Test notes' }))
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'connected'))

    await user.click(within(row).getByRole('button', { name: 'Disconnect notes' }))
    await waitFor(() => expect(row).toHaveAttribute('data-status', 'needs_reconnect'))
  })

  it('edits an address, and keeps a sealed header map when nothing is typed', async () => {
    const fake = makeFake({
      mcpServers: [
        makeMcpServer({ name: 'wiki', auth: 'headers', header_names: ['Authorization'] }),
      ],
    })
    const update = vi.spyOn(fake.mcpServers, 'update')
    renderApp(fake, { hash: '#/settings' })

    const row = await serverRow('wiki')
    await user.click(within(row).getByRole('button', { name: 'Edit wiki' }))
    const dialog = await screen.findByRole('dialog')

    // The values are sealed and never come back: the form shows the names it holds and starts
    // the map empty.
    expect(within(dialog).getByText(/Stored: Authorization/)).toBeInTheDocument()

    const url = within(dialog).getByLabelText('URL')
    await user.clear(url)
    await user.type(url, 'https://wiki-2.example.com/mcp')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(update).toHaveBeenCalled())
    expect(update.mock.calls[0]?.[1]).toEqual({
      name: 'wiki',
      url: 'https://wiki-2.example.com/mcp',
      auth: 'headers',
      enabled: true,
    })
    expect((await fake.mcpServers.list()).data[0]).toMatchObject({
      url: 'https://wiki-2.example.com/mcp',
      header_names: ['Authorization'],
    })
  })

  it('deletes a server after an in-page confirmation', async () => {
    const fake = makeFake({ mcpServers: [NOTES] })
    renderApp(fake, { hash: '#/settings' })

    const row = await serverRow('notes')
    await user.click(within(row).getByRole('button', { name: 'Delete notes' }))
    expect(within(row).getByText(/Delete notes\?/)).toBeInTheDocument()

    // Cancelling leaves it alone.
    await user.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect((await fake.mcpServers.list()).data).toHaveLength(1)

    await user.click(within(row).getByRole('button', { name: 'Delete notes' }))
    await user.click(within(row).getByRole('button', { name: 'Delete notes' }))

    await waitFor(async () => {
      expect((await fake.mcpServers.list()).data).toHaveLength(0)
    })
    expect(await screen.findByText(/No servers yet\./)).toBeInTheDocument()
  })

  it('confirms an OAuth callback and refreshes the server it named (#311)', async () => {
    const fake = makeFake({ mcpServers: [NOTES] })
    renderApp(fake, { hash: '#/settings', search: `?mcp_connected=${NOTES.id}` })

    const confirmation = await screen.findByText('Connected notes.')
    expect(confirmation).toHaveAttribute('data-slot', 'mcp-connected')
    // The parameter is taken off the URL, so a reload does not confirm it again.
    expect(window.location.search).toBe('')
  })
})
