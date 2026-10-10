import type { TranscriptManualCompaction } from '@openharness/client'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { CompactionNotice } from './compaction-notice'

/**
 * What a manual `/compact` came to, under the transcript (epic #277, K8; #283).
 *
 * The outcomes a reader has to be told about are `nothing_to_summarize` and `failed`; the words
 * are the client's (`manualCompactionNotice` in `@openharness/client`, tested there), and this
 * file is about the frame the terminal draws — including that a `summarized` run draws nothing,
 * because the divider above it is the outcome.
 */
function notice(overrides: Partial<TranscriptManualCompaction> = {}): TranscriptManualCompaction {
  return { pending: false, outcome: 'nothing_to_summarize', seq: 4, ...overrides }
}

describe('CompactionNotice (#283)', () => {
  it('prints the brain’s sentence for a chat with nothing to summarize', () => {
    const { lastFrame } = render(
      <CompactionNotice compaction={notice({ message: 'This chat is too short to compact.' })} />,
    )

    expect(lastFrame()).toContain('This chat is too short to compact.')
  })

  it('prints the shared sentence when the brain sent none', () => {
    const { lastFrame } = render(<CompactionNotice compaction={notice()} />)

    expect(lastFrame()).toContain('There was no older history to summarize.')
  })

  it('prints a failure with the brain’s reason', () => {
    const { lastFrame } = render(
      <CompactionNotice
        compaction={notice({ outcome: 'failed', message: 'The model refused.' })}
      />,
    )

    expect(lastFrame()).toContain('The model refused.')
  })

  it('prints nothing for a summary, or while the request is pending', () => {
    // The divider is a summary's outcome, and the wait is the status field's.
    expect(
      render(<CompactionNotice compaction={notice({ outcome: 'summarized' })} />).lastFrame(),
    ).toBe('')
    expect(
      render(
        <CompactionNotice compaction={notice({ pending: true, outcome: null })} />,
      ).lastFrame(),
    ).toBe('')
  })
})
