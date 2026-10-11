import type { TranscriptToolCall } from '@openharness/client'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ApprovalPrompt } from './approval-prompt'

/** A waiting approval call, as the transcript holds one. */
function call(overrides: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return {
    id: 'sevt_call',
    name: 'web_fetch',
    input: { url: 'https://example.com' },
    permission: 'ask',
    source: 'builtin',
    status: 'waiting',
    position: 2,
    ...overrides,
  }
}

/**
 * The approval prompt (epic #303, X6; #310).
 *
 * What this file holds is the web's half: the four choices, the deny message, and that a click
 * sends the one event the server checks. The words themselves are the client's (tested there).
 */
describe('ApprovalPrompt (#310)', () => {
  it('offers the four choices, named as the log records them', () => {
    render(<ApprovalPrompt call={call()} busy={false} onRespond={() => {}} />)

    const prompt = screen
      .getByRole('button', { name: 'Allow once' })
      .closest('[data-slot="approval-prompt"]')
    expect(prompt).not.toBeNull()
    expect(screen.getByText('web_fetch')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow for this chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('sends an allow-once with no memory when the reader allows this call', async () => {
    const onRespond = vi.fn()
    render(<ApprovalPrompt call={call()} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))

    expect(onRespond).toHaveBeenCalledWith({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_call',
      result: 'allow',
    })
  })

  it('sends the remember extension the reader chose', async () => {
    const onRespond = vi.fn()
    render(<ApprovalPrompt call={call()} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }))
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'allow', remember: 'session' }),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(onRespond).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: 'allow', remember: 'always' }),
    )
  })

  it('takes a message with a denial, and sends a plain one when it is left empty', async () => {
    const onRespond = vi.fn()
    render(<ApprovalPrompt call={call()} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    // The first click opens the box rather than sending: a denial is often worth explaining.
    expect(onRespond).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('Why web_fetch was denied'), 'not that URL')
    await userEvent.click(screen.getByRole('button', { name: 'Deny call' }))

    expect(onRespond).toHaveBeenCalledWith({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_call',
      result: 'deny',
      deny_message: 'not that URL',
    })
  })

  it('cancels the deny box without sending anything', async () => {
    const onRespond = vi.fn()
    render(<ApprovalPrompt call={call()} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onRespond).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
  })

  it('turns every control off while a confirmation is in flight', () => {
    render(<ApprovalPrompt call={call()} busy onRespond={() => {}} />)

    for (const label of ['Allow once', 'Allow for this chat', 'Always allow', 'Deny']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled()
    }
  })

  it('prompts for a waiting remote MCP call, naming its server and its own id (#312)', async () => {
    const onRespond = vi.fn()
    const remote = call({
      id: 'sevt_mcp_call',
      name: 'notes__search',
      input: { query: 'doom' },
      source: 'mcp',
      server: 'notes',
    })
    render(<ApprovalPrompt call={remote} busy={false} onRespond={onRespond} />)

    // The prompt is the call itself, so the reader is told whose tool they are allowing — two
    // servers' `search` are different tools, and the server is what tells them apart.
    const prompt = screen.getByRole('group', { name: 'Allow notes__search (mcp: notes)?' })
    expect(prompt).toHaveAttribute('data-server', 'notes')
    expect(prompt).toHaveAttribute('data-tool', 'notes__search')
    expect(screen.getByText('notes__search (mcp: notes)')).toBeInTheDocument()

    // The decision is one confirmation naming the MCP call's event id — the id its
    // `agent.mcp_tool_result` will name — sent like any other, since a pause is a fact about
    // the log rather than about a tool.
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onRespond).toHaveBeenCalledWith({
      type: 'user.tool_confirmation',
      tool_use_id: 'sevt_mcp_call',
      result: 'allow',
    })
  })
})
