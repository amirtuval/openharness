import type { TranscriptToolCall } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { Line } from '../markdown/text'
import { ThemeProvider } from './theme'
import { callReason, ToolCallView, toolCallLines } from './tool-call'

/**
 * One tool call, as the terminal draws it (epic #303, X1/X5; #308).
 *
 * `toolCallLines` is the whole decision — the mark, the name, the summary, the status and the one
 * line of reason — and the component is Ink drawing it, so the rules are asserted on the lines
 * and the frame once, for the case where the two could disagree.
 */

const DARK = { background: 'dark', color: true, level: 3 } as const
const PLAIN = { background: 'dark', color: false, level: 0 } as const

/** A call with the fields a test cares about. */
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

/** The lines joined back into what a reader sees. */
function textOf(lines: readonly Line[]): string {
  return lines.map((line) => line.map((span) => span.text).join('')).join('\n')
}

afterEach(() => {
  cleanup()
})

describe('toolCallLines (#308)', () => {
  it('draws the mark, the tool, the summary and the status on one line', () => {
    const text = textOf(toolCallLines(call(), 80, DARK))
    expect(text).toContain('web_fetch')
    expect(text).toContain('https://example.com')
    expect(text).toContain('done')
  })

  it('says "waiting for you" for a paused call, and names an MCP call', () => {
    expect(
      textOf(
        toolCallLines(call({ permission: 'ask', status: 'waiting', result: undefined }), 80, DARK),
      ),
    ).toContain('waiting for you')
    expect(textOf(toolCallLines(call({ source: 'mcp', name: 'srv_search' }), 80, DARK))).toContain(
      '(mcp)',
    )
  })

  it('adds the reason line a failed call owes the reader', () => {
    const text = textOf(
      toolCallLines(
        call({
          status: 'error',
          result: {
            content: 'Tool web_fetch timed out after 30s\n(and more detail)',
            isError: true,
          },
        }),
        80,
        DARK,
      ),
    )
    expect(text).toContain('Tool web_fetch timed out after 30s')
    // Only the first line of a long result: the transcript must not be flooded by one answer.
    expect(text).not.toContain('and more detail')
  })

  it('keeps the states readable without colour', () => {
    const text = textOf(toolCallLines(call({ status: 'done' }), 80, PLAIN))
    expect(text).toContain('web_fetch')
    expect(text).toContain('done')
  })

  it('truncates a long line rather than overflowing a narrow terminal', () => {
    const lines = toolCallLines(
      call({ input: { url: `https://example.com/${'x'.repeat(200)}` } }),
      40,
      DARK,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]?.reduce((width, span) => width + span.text.length, 0)).toBeLessThanOrEqual(39)
  })
})

describe('callReason (#308)', () => {
  it('says why a call did not finish, and nothing for an ordinary one', () => {
    expect(callReason(call())).toBeNull()
    expect(callReason(call({ status: 'error', result: { content: 'boom', isError: true } }))).toBe(
      'boom',
    )
    // A waiting call owes no second line: its status already says it, and the question is in
    // the input (#310 draws its prompt there).
    expect(callReason(call({ status: 'waiting', result: undefined, permission: 'ask' }))).toBeNull()
  })
})

describe('ToolCallView (#308)', () => {
  it('draws the same line a reader reads in the frame', () => {
    const frame = render(
      <ThemeProvider theme={DARK}>
        <ToolCallView call={call()} width={80} />
      </ThemeProvider>,
    ).lastFrame()

    expect(frame).toContain('web_fetch')
    expect(frame).toContain('done')
  })

  it('says how a call that waited on the reader came to run (#310)', () => {
    const lines = toolCallLines(
      { ...call(), permission: 'ask', status: 'done' },
      80,
      DARK,
      'Allowed for this chat',
    )
    const text = lines.map((line) => line.map((span) => span.text).join('')).join('\n')
    expect(text).toContain('done · Allowed for this chat')
  })
})
