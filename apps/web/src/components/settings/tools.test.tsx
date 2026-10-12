import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * Settings → Tools (epic #303, X4; #307; the screen is #308), against the fake server.
 *
 * The card lists the deployment's tools, per-tool on/off and the permission a call is evaluated
 * under, and it says when a tool this server does not register — so "why does my search do
 * nothing" has an answer on the screen.
 */

function renderSettings(options: Parameters<typeof makeFake>[0] = {}): void {
  renderApp(makeFake(options), { hash: '#/settings' })
}

const user = userEvent.setup()

/** The row for one tool, once the list has loaded. */
async function toolRow(name: string): Promise<HTMLElement> {
  const row = await screen.findByText(name)
  return row.closest('[data-slot="tool-row"]') as HTMLElement
}

describe('Settings → Tools (#308)', () => {
  it('lists the registered tools with their state and default', async () => {
    renderSettings()

    const row = await toolRow('web_fetch')
    expect(row).toHaveAttribute('data-available', 'true')
    expect(within(row).getByRole('checkbox', { name: 'Enable web_fetch' })).toBeChecked()
    expect(within(row).getByRole('combobox')).toHaveValue('allow')
    expect(within(row).getByText('Default (allow).')).toBeInTheDocument()
  })

  it('turns a tool off and writes only that tool', async () => {
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    const row = await toolRow('web_search')
    await user.click(within(row).getByRole('checkbox', { name: 'Enable web_search' }))

    await waitFor(async () => {
      const stored = await fake.tools.list()
      expect(stored.data.find((entry) => entry.name === 'web_search')?.enabled).toBe(false)
    })
    // The other tools keep their declaration: the write is a patch, not a replacement.
    const stored = await fake.tools.list()
    expect(stored.data.find((entry) => entry.name === 'web_fetch')?.enabled).toBe(true)
  })

  it('changes the permission a call is evaluated under', async () => {
    const fake = makeFake()
    renderApp(fake, { hash: '#/settings' })

    const row = await toolRow('todo_write')
    await user.selectOptions(within(row).getByRole('combobox'), 'ask')

    await waitFor(async () => {
      const stored = await fake.tools.list()
      expect(stored.data.find((entry) => entry.name === 'todo_write')?.policy).toBe('ask')
    })
    // The choice is the reader's, so the default is now named as the one it departs from.
    expect(await within(row).findByText('Default is allow.')).toBeInTheDocument()
  })

  it('says why a tool cannot be offered, when the server gives a reason (#335)', async () => {
    renderSettings({
      toolsAvailable: { web_search: false },
      toolsReason: { web_search: 'This model has no web search.' },
    })

    const row = await toolRow('web_search')
    // The tool is declared — `web_search` follows `allow` like every built-in — so its default
    // is named as usual, and the server's own sentence is what says why it is not on offer.
    expect(row).toHaveAttribute('data-available', 'false')
    expect(within(row).getByText('Default (allow).')).toBeInTheDocument()
    expect(within(row).getByText('This model has no web search.')).toBeInTheDocument()
    expect(within(row).getByRole('checkbox', { name: 'Enable web_search' })).toBeDisabled()
  })

  it('lists a tool this deployment does not register as unavailable', async () => {
    renderSettings({ toolsAvailable: { web_search: false } })

    const row = await toolRow('web_search')
    expect(row).toHaveAttribute('data-available', 'false')
    expect(within(row).getByText('not available')).toBeInTheDocument()
    expect(
      within(row).getByText('No default — this server does not register it.'),
    ).toBeInTheDocument()
    // It cannot be turned on: a chat never offers it whatever the switch says.
    expect(within(row).getByRole('checkbox', { name: 'Enable web_search' })).toBeDisabled()
  })
})

describe('Settings → Tools, and the remote MCP tools it leaves out (#313)', () => {
  const MCP_TOOLS = [
    { server: 'notes', name: 'search' },
    { server: 'notes', name: 'read' },
    { server: 'github', name: 'search' },
  ]

  it('renders no MCP tool when the listing has them', async () => {
    renderSettings({ mcpTools: MCP_TOOLS })

    // The card lists the build's own tools and stops: a remote tool belongs to its server, whose
    // screen is where its permission is set.
    const list = (await screen.findByText('web_fetch')).closest('[data-slot="tools-list"]')
    expect(list).not.toBeNull()
    expect(
      within(list as HTMLElement)
        .getAllByText(/web_fetch|web_search|todo_write|__/)
        .map((node) => node.textContent),
    ).toEqual(['web_fetch', 'web_search', 'todo_write'])
    expect(screen.queryByText('notes__search')).toBeNull()
    expect(screen.queryByText('github__search')).toBeNull()
    expect(screen.queryByText(/^MCP · notes$/)).toBeNull()
  })

  it('says where the MCP tools went, rather than dropping them silently', async () => {
    renderSettings({ mcpTools: MCP_TOOLS })

    const hint = await screen.findByText(/come from MCP servers/)
    expect(hint).toHaveAttribute('data-slot', 'tools-mcp-hint')
    expect(hint).toHaveTextContent('3 tools come from MCP servers.')
    expect(hint).toHaveTextContent('Tools from MCP servers are set below, per server.')
  })

  it('leaves the hint off a deployment that offers no remote tools', async () => {
    renderSettings()

    await screen.findByText('web_fetch')
    expect(document.querySelector('[data-slot="tools-mcp-hint"]')).toBeNull()
  })
})
