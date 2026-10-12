import { TOOLS_UNSUPPORTED_NOTICE } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeProvider } from './theme'
import { toolNoticeLines, ToolNoticesView } from './tool-notices'

/**
 * The four tool notices, as the terminal draws them (epic #303, X2/X5/X9; #308).
 *
 * `toolNoticeLines` holds the words and their tones; the component is Ink drawing them.
 */

const DARK = { background: 'dark', color: true, level: 3 } as const
const PLAIN = { background: 'dark', color: false, level: 0 } as const

afterEach(() => {
  cleanup()
})

describe('toolNoticeLines (#308)', () => {
  it('says nothing when there is nothing to say', () => {
    expect(toolNoticeLines(DARK, {})).toEqual([])
  })

  it('draws the step limit and the two result notices', () => {
    const lines = toolNoticeLines(DARK, {
      stepLimit: 'This turn reached its limit of 50 model requests.',
      truncated: 'One tool result was shortened.',
      cleared: 'Two older tool results were cleared.',
    })

    expect(lines.map((line) => line.text)).toEqual([
      'This turn reached its limit of 50 model requests.',
      'One tool result was shortened.',
      'Two older tool results were cleared.',
    ])
    // The step limit is the palette's amber; clearing is chrome.
    expect(lines[0]?.color).toBe('yellow')
    expect(lines[2]?.dim).toBe(true)
  })

  it('says a model cannot use tools', () => {
    expect(toolNoticeLines(DARK, { unsupported: true }).map((line) => line.text)).toEqual([
      TOOLS_UNSUPPORTED_NOTICE,
    ])
  })

  it('keeps the words without colour', () => {
    const lines = toolNoticeLines(PLAIN, { stepLimit: 'ended' })
    expect(lines[0]?.text).toBe('ended')
    expect(lines[0]?.color).toBeUndefined()
  })
})

describe('ToolNoticesView (#308)', () => {
  it('draws the lines a reader reads in the frame', () => {
    const frame = render(
      <ThemeProvider theme={DARK}>
        <ToolNoticesView stepLimit="This turn reached its limit of 50 model requests." />
      </ThemeProvider>,
    ).lastFrame()

    expect(frame).toContain('This turn reached its limit of 50 model requests.')
  })

  it('draws nothing at all when there is nothing to say', () => {
    const frame = render(
      <ThemeProvider theme={DARK}>
        <ToolNoticesView />
      </ThemeProvider>,
    ).lastFrame()

    expect(frame?.trim() ?? '').toBe('')
  })
})
