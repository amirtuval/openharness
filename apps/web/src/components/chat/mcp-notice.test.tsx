import { makeMcpServer } from '@openharness/protocol/fixtures'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * A turn's MCP failure, on screen (epic #303, X10; #313).
 *
 * The brain writes one `session.error` per server it could not use and the turn carries on
 * without that server's tools, so the page draws a **notice** — with a Reconnect action, the one
 * thing a reader can do about it — rather than the red error banner a failed turn gets.
 */

const NOTES = makeMcpServer({ name: 'notes' })

const FAILURE =
  'The MCP server "notes" could not be used: the token was refused. ' +
  'This chat continues without its tools.'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Send one message to the seeded chat, with the given failure scripted for its turn. */
async function chatWithMcpFailure(fake = makeFake({ mcpServers: [NOTES] })): Promise<void> {
  const user = userEvent.setup({ delay: null })
  fake.failWith({
    type: 'mcp_authentication_failed_error',
    message: FAILURE,
    retryStatus: 'terminal',
  })
  renderApp(fake)

  await user.type(await screen.findByLabelText('Message'), 'hello')
  await user.click(screen.getByRole('button', { name: 'Send message' }))
}

/** The notice element itself, found by the sentence it draws. */
async function mcpNotice(): Promise<HTMLElement> {
  const text = await screen.findByText(/could not be used/)
  const notice = text.closest('[data-slot="mcp-notice"]')
  if (notice === null) {
    throw new Error('the failure is on screen but not as an MCP notice')
  }
  return notice as HTMLElement
}

describe('the MCP failure notice (#303, X10; #313)', () => {
  it('names the server, says the chat carries on, and is not the red error banner', async () => {
    await chatWithMcpFailure()

    const notice = await mcpNotice()
    expect(notice).toHaveAttribute('data-server', 'notes')
    expect(notice).toHaveTextContent('The MCP server "notes" could not be used')
    expect(notice).toHaveTextContent('This chat continues without its tools.')
    // A notice, not a failure: the error banner that would say the same thing is not drawn.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0)
  })

  it('reconnects the server the message names, in a new tab', async () => {
    const fake = makeFake({ mcpServers: [NOTES] })
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window)
    await chatWithMcpFailure(fake)

    const notice = await mcpNotice()
    await userEvent.click(within(notice).getByRole('button', { name: 'Reconnect' }))

    await waitFor(() => expect(fake.mcpConnects).toEqual([{ serverId: NOTES.id, client: 'web' }]))
    expect(open).toHaveBeenCalledWith(
      `https://auth.example.com/authorize?server=${NOTES.id}&state=fake_state`,
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('takes a reader to the servers screen when the named server needs no flow', async () => {
    const plain = makeMcpServer({ name: 'notes', auth: 'headers', header_names: ['Authorization'] })
    const fake = makeFake({ mcpServers: [plain] })
    await chatWithMcpFailure(fake)

    const notice = await mcpNotice()
    await userEvent.click(within(notice).getByRole('button', { name: 'Reconnect' }))

    // A `none`/`headers` server has no OAuth flow to run: the reader is taken to where Test and
    // Edit live rather than sent to an authorization page that does not exist.
    await waitFor(() => expect(window.location.hash).toBe('#/settings'))
    expect(fake.mcpConnects).toEqual([])
  })

  it('can be dismissed, and comes back for the next failure', async () => {
    const user = userEvent.setup({ delay: null })
    const fake = makeFake({ mcpServers: [NOTES] })
    await chatWithMcpFailure(fake)

    const notice = await mcpNotice()
    await user.click(within(notice).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(document.querySelector('[data-slot="mcp-notice"]')).toBeNull())

    // The next turn's failure is a new sentence, and is shown again.
    fake.failWith({
      type: 'mcp_connection_failed_error',
      message: 'The MCP server "notes" could not be used: it is down. This chat continues.',
      retryStatus: 'terminal',
    })
    await user.type(await screen.findByLabelText('Message'), 'again')
    await user.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await mcpNotice()).toHaveTextContent('it is down')
  })
})
