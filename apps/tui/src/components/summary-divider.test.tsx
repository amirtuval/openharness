import type { TranscriptSummary } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { spanWidth, type Line } from '../markdown/text'
import { SummaryDivider, summaryDividerLines } from './summary-divider'
import { ThemeProvider } from './theme'

/**
 * The "conversation summarized" divider (epic #277, K10; #280).
 *
 * `summaryDividerLines` is the whole decision — the label, the rule, the wrapped summary — and
 * the component is Ink drawing it, so the rules are asserted on the lines and the frame is
 * asserted once, for the case where the two could disagree.
 */

const DARK = { background: 'dark', color: true, level: 3 } as const
const PLAIN = { background: 'dark', color: false, level: 0 } as const

/** A summary, with the divider's defaults and whatever the case overrides. */
function summary(overrides: Partial<TranscriptSummary> = {}): TranscriptSummary {
  return {
    id: 'sevt_summary',
    summary: 'They greeted each other, then discussed the markdown renderer.',
    reason: 'threshold',
    model: 'anthropic/claude-sonnet-5',
    passes: 2,
    tokensBefore: 51_200,
    position: 2,
    seq: 3,
    ...overrides,
  }
}

/** The lines of the divider, joined back into what a reader sees. */
function textOf(lines: readonly Line[]): string {
  return lines.map((line) => line.map((span) => span.text).join('')).join('\n')
}

afterEach(() => {
  cleanup()
})

describe('summaryDividerLines (#280)', () => {
  it('says why, on what model and in how many passes', () => {
    const lines = summaryDividerLines(summary(), 80, DARK)

    expect(lines[0]?.map((span) => span.text).join('')).toContain(
      'conversation summarized · automatic · anthropic/claude-sonnet-5 · 2 passes',
    )
  })

  it('names the two reasons a reader asked for', () => {
    expect(textOf(summaryDividerLines(summary({ reason: 'manual' }), 80, DARK))).toContain('manual')
    expect(textOf(summaryDividerLines(summary({ reason: 'overflow' }), 80, DARK))).toContain(
      'overflow',
    )
  })

  it('rules the label out to the width the transcript uses', () => {
    const lines = summaryDividerLines(summary(), 80, DARK)

    // The transcript reserves its last column for the streaming cursor, so the divider stops
    // one short of the terminal — exactly where the input section's rule stops.
    expect(spanWidth(lines[0] ?? [])).toBe(79)
    expect((lines[0] ?? []).every((span) => span.dim === true)).toBe(true)
  })

  it('prints the summary under the mark', () => {
    // A terminal has no disclosure control, so the divider carries what the web divider keeps
    // behind a click.
    const lines = summaryDividerLines(summary(), 80, DARK)

    expect(lines).toHaveLength(2)
    expect(textOf(lines)).toContain('discussed the markdown renderer')
    expect(lines[1]?.every((span) => span.dim === true)).toBe(true)
  })

  it('wraps the summary to the transcript’s width, and never past it', () => {
    const lines = summaryDividerLines(summary({ summary: 'x'.repeat(200) }), 40, DARK)

    // The first line is the mark, the rest are the summary: every one fits the 39 columns the
    // transcript has, and the text is all there.
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => spanWidth(line) <= 39)).toBe(true)
    expect(textOf(lines).replace(/[^x]/gu, '')).toHaveLength(200)
  })

  it('truncates rather than overflows when the label alone does not fit', () => {
    const lines = summaryDividerLines(summary(), 20, DARK)

    expect(spanWidth(lines[0] ?? [])).toBeLessThanOrEqual(19)
  })

  it('drops the colour under NO_COLOR and keeps the words', () => {
    const lines = summaryDividerLines(summary(), 80, PLAIN)

    expect(lines.every((line) => line.every((span) => span.color === undefined))).toBe(true)
    expect(textOf(lines)).toContain('conversation summarized')
  })

  it('draws the mark without a summary when the summary is empty', () => {
    const lines = summaryDividerLines(summary({ summary: '   ' }), 80, DARK)

    expect(lines).toHaveLength(1)
  })
})

describe('SummaryDivider (#280)', () => {
  it('draws the mark and the summary as separate lines of the transcript', () => {
    const { lastFrame } = render(
      <ThemeProvider theme={DARK}>
        <SummaryDivider summary={summary()} width={80} />
      </ThemeProvider>,
    )

    const frame = lastFrame() ?? ''
    expect(frame).toContain('conversation summarized')
    expect(frame).toContain('discussed the markdown renderer')
    expect(frame.split('\n')).toHaveLength(2)
  })
})
