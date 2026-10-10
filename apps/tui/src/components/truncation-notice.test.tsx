import type { TranscriptTruncation } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from './theme'
import { TruncationNotice, truncationLine } from './truncation-notice'

/**
 * The line that says the reader's own message was shortened for the model (epic #277, K6/K10;
 * #280). `truncationLine` is the words, the component is the one colour they are drawn in.
 */

const DARK = { background: 'dark', color: true, level: 3 } as const

/** A truncation record, with the numbers the fake-shaped cases need. */
function truncation(overrides: Partial<TranscriptTruncation> = {}): TranscriptTruncation {
  return { seq: 4, tokensBefore: 900, tokensAfter: 300, recordedAt: 6, ...overrides }
}

afterEach(() => {
  cleanup()
})

describe('truncationLine (#280)', () => {
  it('says what happened, and how much was left out', () => {
    // A terminal has no tooltip: a count that only existed on hover would not exist here.
    expect(truncationLine(truncation())).toBe(
      'your message was too long for this model and was shortened (about 600 tokens left out)',
    )
  })

  it('never claims a negative omission', () => {
    // The two counts come from the strategy's own estimate; a log that disagrees with itself
    // gets the sentence without a number that could not be true.
    expect(truncationLine(truncation({ tokensBefore: 10, tokensAfter: 40 }))).toContain(
      'about 0 tokens left out',
    )
  })
})

describe('TruncationNotice (#280)', () => {
  it('draws the sentence on its own line', () => {
    const { lastFrame } = render(
      <ThemeProvider theme={DARK}>
        <TruncationNotice truncation={truncation()} />
      </ThemeProvider>,
    )

    expect(lastFrame() ?? '').toContain('was too long for this model and was shortened')
  })
})
