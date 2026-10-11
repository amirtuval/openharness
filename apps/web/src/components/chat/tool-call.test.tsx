import type { TranscriptToolCall } from '@openharness/client'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ToolCallLine } from './tool-call'

/** A call with the fields a test cares about, and sensible defaults for the rest. */
function call(overrides: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return {
    id: 'sevt_1',
    name: 'web_fetch',
    input: { url: 'https://example.com' },
    permission: 'allow',
    source: 'builtin',
    status: 'done',
    position: 2,
    result: { content: 'The page says hello.', isError: false },
    ...overrides,
  }
}

/**
 * One tool call as a line (epic #303, X1/X5; #308).
 *
 * The words come from `@openharness/client` (tested there); this file is what the web draws:
 * the compact row, the disclosure, the MCP badge, and the slot #310's approval prompt fills.
 */
describe('ToolCallLine (#308)', () => {
  it('draws the tool, its summary and its status on one compact row', () => {
    render(<ToolCallLine call={call()} />)

    const row = screen.getByText('web_fetch').closest('[data-slot="tool-call"]')
    expect(row).not.toBeNull()
    expect(row).toHaveAttribute('data-tool', 'web_fetch')
    expect(row).toHaveAttribute('data-status', 'done')
    expect(screen.getByText('https://example.com')).toBeInTheDocument()
    expect(screen.getByText('done')).toBeInTheDocument()
  })

  it('says "waiting for you" for a paused call, and hosts an action the caller owns', () => {
    render(
      <ToolCallLine
        call={call({ permission: 'ask', status: 'waiting', result: undefined })}
        action={<button type="button">Approve</button>}
      />,
    )

    const row = screen.getByText('web_fetch').closest('[data-slot="tool-call"]') as HTMLElement
    expect(row).toHaveAttribute('data-status', 'waiting')
    expect(screen.getByText('waiting for you')).toBeInTheDocument()
    // #310's control sits in the row, outside the disclosure trigger, so its buttons are not
    // nested inside one.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('badges an MCP call, so a remote server is told apart from a built-in', () => {
    render(
      <ToolCallLine call={call({ name: 'srv_search', source: 'mcp', input: { query: 'x' } })} />,
    )
    expect(screen.getByText('MCP')).toBeInTheDocument()
  })

  it('opens to the full input and the result, and starts collapsed', async () => {
    const user = userEvent.setup()
    render(<ToolCallLine call={call()} />)

    expect(screen.queryByText('Input')).toBeNull()

    await user.click(screen.getByRole('button', { name: /details for the web_fetch call/i }))

    expect(screen.getByText('Input')).toBeInTheDocument()
    expect(screen.getByText(/"url": "https:\/\/example.com"/)).toBeInTheDocument()
    expect(screen.getByText('The page says hello.')).toBeInTheDocument()
  })

  it('draws an error result as an error, and a call with no result without a Result block', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <ToolCallLine
        call={call({
          status: 'error',
          result: { content: 'Tool web_fetch timed out', isError: true },
        })}
      />,
    )

    await user.click(screen.getByRole('button', { name: /details/i }))
    expect(screen.getByText('Tool web_fetch timed out')).toBeInTheDocument()
    unmount()

    render(<ToolCallLine call={call({ status: 'running', result: undefined })} />)
    await user.click(screen.getByRole('button', { name: /details/i }))
    expect(screen.queryByText('Result')).toBeNull()
  })
})
