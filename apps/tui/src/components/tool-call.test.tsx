import type { TranscriptToolCall } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { Line } from '../markdown/text'
import { ThemeProvider } from './theme'
import {
  callReason,
  callResultLine,
  DETAIL_RESULT_MAX_LINES,
  formatBytes,
  ToolCallView,
  toolCallLines,
} from './tool-call'

/**
 * One tool call, as the terminal draws it (epic #303, X1/X5; #308).
 *
 * `toolCallLines` is the whole decision — the mark, the name, the summary, the status, and the
 * one result line under it (or, under Ctrl+O, the whole input) — and the component is Ink
 * drawing it, so the rules are asserted on the lines and the frame once, for the case where the
 * two could disagree.
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
    const lines = toolCallLines(call(), 80, DARK)
    expect(textOf(lines.slice(0, 1))).toContain('web_fetch')
    expect(textOf(lines.slice(0, 1))).toContain('https://example.com')
    expect(textOf(lines.slice(0, 1))).toContain('done')
  })

  it('draws what a call came to on one indented line under it', () => {
    const lines = toolCallLines(call(), 80, DARK)
    expect(textOf(lines.slice(1, 2))).toBe('  ⎿ fetched 20 B')
  })

  it('draws the pages a search found under its result line (#335)', () => {
    const lines = toolCallLines(
      call({
        name: 'web_search',
        input: { query: 'openharness architecture' },
        source: 'provider',
        sources: [
          {
            url: 'https://example.test/architecture',
            title: 'The architecture',
            cited_text: 'three ideas carry the design',
          },
          { url: 'https://example.test/bare' },
        ],
      }),
      80,
      PLAIN,
    )

    // A terminal has no link to open, so the URL is the source: the title and the address on a
    // line of its own, and the cited passage indented under it — under the count of pages the
    // search answered with.
    expect(textOf(lines.slice(0, 2))).toContain('⎿ 2 results')
    expect(lines).toHaveLength(5)
    expect(textOf(lines)).toContain('The architecture — https://example.test/architecture')
    expect(textOf(lines)).toContain('three ideas carry the design')
    expect(textOf(lines)).toContain('https://example.test/bare')
    // The status still ends the call's own line, whatever follows it.
    expect(textOf(lines.slice(0, 1))).toContain('done')
  })

  it('says "waiting for you" for a paused call, and names an MCP call and its server', () => {
    expect(
      textOf(
        toolCallLines(call({ permission: 'ask', status: 'waiting', result: undefined }), 80, DARK),
      ),
    ).toContain('waiting for you')
    expect(textOf(toolCallLines(call({ source: 'mcp', name: 'srv_search' }), 80, DARK))).toContain(
      '(mcp)',
    )
    // A remote call names the server it came from when the log says which one (#312): two
    // servers' `search` differ by exactly this and nothing else on the line.
    expect(
      textOf(
        toolCallLines(call({ source: 'mcp', name: 'notes__search', server: 'notes' }), 80, DARK),
      ),
    ).toContain('(mcp: notes)')
  })

  it('owes no result line while a call has produced nothing', () => {
    const lines = toolCallLines(
      call({ status: 'running', result: undefined, permission: 'allow' }),
      80,
      DARK,
    )
    expect(lines).toHaveLength(1)
  })

  it('keeps the states readable without colour', () => {
    const text = textOf(toolCallLines(call({ status: 'done' }), 80, PLAIN))
    expect(text).toContain('web_fetch')
    expect(text).toContain('done')
    expect(text).toContain('⎿')
  })

  it('truncates a long line rather than overflowing a narrow terminal', () => {
    const lines = toolCallLines(
      call({ input: { url: `https://example.com/${'x'.repeat(200)}` } }),
      40,
      DARK,
    )
    for (const line of lines) {
      expect(line.reduce((width, span) => width + span.text.length, 0)).toBeLessThanOrEqual(39)
    }
  })
})

describe('callResultLine (#308)', () => {
  it('summarizes a fetch by what it read', () => {
    expect(callResultLine(call())).toBe('fetched 20 B')
    expect(
      callResultLine(call({ result: { content: 'x'.repeat(12 * 1024), isError: false } })),
    ).toBe('fetched 12 KB')
  })

  it('counts the pages a search found', () => {
    expect(
      callResultLine(
        call({
          name: 'web_search',
          sources: [{ url: 'https://example.test/a' }],
          result: { content: 'ok', isError: false },
        }),
      ),
    ).toBe('1 result')
    expect(
      callResultLine(
        call({ name: 'web_search', sources: [], result: { content: 'ok', isError: false } }),
      ),
    ).toBe('0 results')
  })

  it('says a denied call was denied, and whose words refused it', () => {
    expect(
      callResultLine(
        call({
          status: 'denied',
          result: { content: 'Permission to use web_fetch has been denied.', isError: true },
        }),
      ),
    ).toBe('denied: Permission to use web_fetch has been denied.')
  })

  it('gives a failure the first line of its result, and only that', () => {
    const line = callResultLine(
      call({
        status: 'error',
        result: { content: 'Tool web_fetch timed out after 30s\n(and more detail)', isError: true },
      }),
    )
    expect(line).toBe('Tool web_fetch timed out after 30s')
  })

  it('counts a task list the same way its own line does', () => {
    expect(
      callResultLine(
        call({ name: 'todo_write', input: { todos: [{ content: 'a', status: 'pending' }] } }),
      ),
    ).toBe('1 task')
  })

  it('falls back to how much came back, for a tool it knows nothing about', () => {
    expect(callResultLine(call({ name: 'echo', result: { content: 'hi', isError: false } }))).toBe(
      '1 line',
    )
    expect(
      callResultLine(call({ name: 'echo', result: { content: 'one\ntwo', isError: false } })),
    ).toBe('2 lines')
    expect(callResultLine(call({ name: 'echo', result: { content: '', isError: false } }))).toBe(
      '0 lines',
    )
  })

  it('rounds a size the way a reader reads one', () => {
    expect(formatBytes(20)).toBe('20 B')
    expect(formatBytes(12 * 1024)).toBe('12 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3 MB')
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

describe('the detail view (#308)', () => {
  it('opens the whole input and the head of the result', () => {
    const lines = toolCallLines(
      call({ input: { url: 'https://example.com', depth: 2 } }),
      80,
      PLAIN,
      null,
      true,
    )
    const text = textOf(lines)
    // The input, pretty-printed, which is the one thing the compact line exists to hide.
    expect(text).toContain('"url": "https://example.com"')
    expect(text).toContain('"depth": 2')
    // And what came back, under it.
    expect(text).toContain('The page says hello.')
  })

  it('caps a long result and counts what it left out', () => {
    const content = Array.from({ length: DETAIL_RESULT_MAX_LINES + 3 }, (_, i) => `row ${i}`).join(
      '\n',
    )
    const lines = toolCallLines(
      call({ result: { content, isError: false } }),
      80,
      PLAIN,
      null,
      true,
    )
    const text = textOf(lines)
    expect(text).toContain('row 0')
    expect(text).not.toContain(`row ${DETAIL_RESULT_MAX_LINES}`)
    expect(text).toContain('… 3 more lines')
  })

  it('says nothing extra while the toggle is off', () => {
    const text = textOf(
      toolCallLines(call({ input: { url: 'https://example.com', depth: 2 } }), 80, PLAIN),
    )
    expect(text).not.toContain('"url"')
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
    expect(frame).toContain('⎿')
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
