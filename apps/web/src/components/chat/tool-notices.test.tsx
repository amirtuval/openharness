import { TOOLS_UNSUPPORTED_NOTICE } from '@openharness/client'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ToolNotices } from './tool-notices'

/**
 * The four tool notices (epic #303, X2/X5/X9; #308).
 *
 * The words are the client's (tested there); this file is that each one draws, that the
 * step-limit notice is a notice rather than an error, and that nothing renders when there is
 * nothing to say.
 */
describe('ToolNotices (#308)', () => {
  it('draws nothing at all when there is nothing to say', () => {
    const { container } = render(<ToolNotices />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the step limit as a notice, with the brain’s sentence', () => {
    render(<ToolNotices stepLimit="This turn reached its limit of 50 model requests." />)

    const notice = screen.getByText('This turn reached its limit of 50 model requests.')
    expect(notice.closest('[data-slot="step-limit-notice"]')).toHaveAttribute(
      'data-tone',
      'warning',
    )
  })

  it('says a model cannot use tools', () => {
    render(<ToolNotices unsupported />)
    expect(screen.getByText(TOOLS_UNSUPPORTED_NOTICE)).toBeInTheDocument()
  })

  it('shows what a request shortened and what it cleared', () => {
    render(<ToolNotices truncated="One tool result was shortened." cleared="Two were cleared." />)

    expect(screen.getByText('One tool result was shortened.')).toBeInTheDocument()
    expect(screen.getByText('Two were cleared.')).toBeInTheDocument()
  })
})
