import type { TranscriptMessage } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { RenderLayout } from '../markdown/render'
import type { TerminalTheme } from '../markdown/theme'
import { MessageView, PART_RENDERERS } from './message-view'
import { ThemeProvider } from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true }
const PLAIN: TerminalTheme = { background: 'dark', color: false }

/** A message as the transcript hands one over: one text part, settled, not streaming. */
function message(
  text: string,
  role: 'user' | 'agent' = 'agent',
  overrides: Partial<TranscriptMessage> = {},
): TranscriptMessage {
  return {
    id: 'sevt_1',
    role,
    text,
    parts: [{ type: 'text', text }],
    pending: false,
    streaming: false,
    position: 1,
    ...overrides,
  }
}

/** Render a message and answer the frame it drew, as the terminal would show it. */
function frameOf(subject: TranscriptMessage, width: number, theme: TerminalTheme = DARK): string {
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <MessageView message={subject} width={width} />
    </ThemeProvider>,
  )
  return lastFrame() ?? ''
}

/** The lines of a frame. */
function lines(frame: string): string[] {
  return frame.split('\n')
}

afterEach(() => {
  cleanup()
})

describe('MessageView', () => {
  it('labels the first line with who is talking, and indents the rest', () => {
    // A user's own newline is a line break; the same text from an agent would be one
    // paragraph, because Markdown says a soft break is a space.
    const frame = frameOf(message('first\nsecond', 'user'), 40, DARK)

    expect(lines(frame)).toEqual(['you › first', '      second'])
  })

  it('hangs a wrapped line under the text it belongs to, not under the label', () => {
    const frame = frameOf(message('one two three four five six seven eight nine ten'), 24, DARK)

    expect(lines(frame)).toEqual([
      'agent › one two three',
      '        four five six',
      '        seven eight nine',
      '        ten',
    ])
    // Eight columns of label on the first line, eight of indent on the others: the text
    // starts at the same column on every one of them.
    for (const line of lines(frame).slice(1)) expect(line.startsWith('        ')).toBe(true)
  })

  it('wraps a user message the same way, and shows it as it was typed', () => {
    const frame = frameOf(message('a prompt that is long enough to wrap somewhere', 'user'), 24)

    expect(lines(frame)).toEqual([
      'you › a prompt that is',
      '      long enough to',
      '      wrap somewhere',
    ])
  })

  it('does not render a user message as markdown: what they typed is what is shown', () => {
    const frame = frameOf(message('# not a heading\n\n| not | a table |', 'user'), 40)

    // A blank line between two blocks is drawn as nothing at all: it is the indent, and Ink
    // trims what trails off the end of a line.
    expect(lines(frame)).toEqual(['you › # not a heading', '', '      | not | a table |'])
  })

  it('renders an agent message as markdown, element by element', () => {
    const frame = frameOf(
      message(
        [
          '# Heading',
          '',
          'Some **bold** words.',
          '',
          '- one',
          '  - nested',
          '',
          '> quoted',
          '',
          '```ts',
          'const x = 1',
          '```',
        ].join('\n'),
        'agent',
      ),
      40,
    )

    expect(lines(frame)).toEqual([
      'agent › Heading',
      '',
      '        Some bold words.',
      '',
      '        • one',
      '          • nested',
      '',
      '        ▏ quoted',
      '',
      '        ┌ ts ───────────────────────────',
      '        │ const x = 1',
      '        └───────────────────────────────',
    ])
  })

  it('draws a table inside the room the message has', () => {
    const frame = frameOf(message('| a | b |\n| --- | --- |\n| 1 | 2 |', 'agent'), 28)

    expect(lines(frame)).toEqual([
      'agent › ┌───┬───┐',
      '        │ a │ b │',
      '        ├───┼───┤',
      '        │ 1 │ 2 │',
      '        └───┴───┘',
    ])
  })

  it('is a code block in progress when the fence has not been closed yet', () => {
    const frame = frameOf(message('Here:\n\n```python\ndef f(x):', 'agent'), 30)

    expect(lines(frame)).toEqual([
      'agent › Here:',
      '',
      '        ┌ python ─────────────',
      '        │ def f(x):',
      '        └─────────────────────',
    ])
  })

  it('wraps wide characters by their columns, not their count', () => {
    const frame = frameOf(message('日本語のテキストです', 'agent'), 24)

    // Sixteen columns of content, so eight double-width characters, and the ninth wraps.
    expect(lines(frame)).toEqual(['agent › 日本語のテキスト', '        です'])
  })

  it('keeps the streaming cursor on the last line, and the queued note after it', () => {
    expect(lines(frameOf(message('hello', 'agent', { streaming: true }), 40))).toEqual([
      'agent › hello▌',
    ])
    expect(lines(frameOf(message('hello', 'user', { pending: true }), 40))).toEqual([
      'you › hello (queued)',
    ])
  })

  it('draws the same words under NO_COLOR, in no colour at all', () => {
    const reply = '# Heading\n\nsome `code` and a [link](https://x)\n\n```ts\nconst x = 1\n```'
    const colourless = frameOf(message(reply), 40, PLAIN)

    // The frame says the same thing: NO_COLOR is about colour, not about content.
    expect(colourless).toBe(frameOf(message(reply), 40, DARK))

    // And the renderer behind it names no colour, where the coloured theme names several.
    const layout = (theme: TerminalTheme): RenderLayout => ({ width: 32, theme })
    const part = { type: 'text', text: reply } as const
    const spans = (theme: TerminalTheme) =>
      PART_RENDERERS.text(part, message(reply), layout(theme)).flatMap((line) => [...line])

    expect(spans(PLAIN).every((span) => span.color === undefined)).toBe(true)
    expect(spans(DARK).some((span) => span.color !== undefined)).toBe(true)
  })

  it('draws a colourless message with the same text as a coloured one', () => {
    const frame = frameOf(message('- one\n- two'), 40, PLAIN)

    expect(lines(frame)).toEqual(['agent › • one', '        • two'])
  })

  it('hangs the metadata line under the reply, indented with its text (#208)', () => {
    const { lastFrame } = render(
      <ThemeProvider theme={DARK}>
        <MessageView message={message('hello there')} width={40} metaLine="4.2s · 1.3k tokens" />
      </ThemeProvider>,
    )

    // The same eight columns of indent as the reply's own wrapped lines, so the metadata
    // reads as belonging to the message above it.
    expect(lines(lastFrame() ?? '')).toEqual(['agent › hello there', '        4.2s · 1.3k tokens'])
  })

  it('has no metadata line to draw when the caller has none (#208)', () => {
    expect(lines(frameOf(message('hello there'), 40))).toEqual(['agent › hello there'])
  })

  it('lays the message out at the width it is given', () => {
    const reply = 'one two three four five six'

    expect(lines(frameOf(message(reply), 30))).toEqual([
      'agent › one two three four',
      '        five six',
    ])
    expect(lines(frameOf(message(reply), 16))).toEqual([
      'agent › one two',
      '        three',
      '        four',
      '        five six',
    ])
  })
})
