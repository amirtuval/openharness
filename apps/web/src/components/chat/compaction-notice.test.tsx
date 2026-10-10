import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CompactionNotice } from './compaction-notice'

/**
 * The outcome of a manual compaction, at the foot of the transcript (epic #277, K8; #283).
 *
 * `/compact` must never be a silent no-op, so the two outcomes a reader has to be told about —
 * "there was no older history", and "the summary failed" — are lines here. `summarized` is the
 * divider's business, and the words themselves are `manualCompactionNotice` in
 * `@openharness/client` (tested there); this file is about what the web draws.
 */
describe('CompactionNotice (#283)', () => {
  it('shows the brain’s sentence for a chat with nothing to summarize', () => {
    render(
      <CompactionNotice
        compaction={{
          pending: false,
          outcome: 'nothing_to_summarize',
          message: 'This chat is too short to compact.',
          seq: 4,
        }}
      />,
    )

    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('This chat is too short to compact.')
    expect(notice).toHaveAttribute('data-tone', 'info')
  })

  it('shows a failure as a failure, with the brain’s reason', () => {
    render(
      <CompactionNotice
        compaction={{ pending: false, outcome: 'failed', message: 'The model refused.', seq: 9 }}
      />,
    )

    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent('The model refused.')
    expect(notice).toHaveAttribute('data-tone', 'error')
  })

  it('falls back to the shared words when the brain sent none', () => {
    render(
      <CompactionNotice compaction={{ pending: false, outcome: 'nothing_to_summarize', seq: 4 }} />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('There was no older history to summarize.')
  })

  it('draws nothing for a summary — the divider is the outcome', () => {
    const { container } = render(
      <CompactionNotice compaction={{ pending: false, outcome: 'summarized', seq: 12 }} />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('draws nothing while the request is still pending', () => {
    const { container } = render(
      <CompactionNotice compaction={{ pending: true, outcome: null, seq: 3 }} />,
    )

    expect(container).toBeEmptyDOMElement()
  })
})
