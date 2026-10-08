import type { TranscriptMessage } from '@openharness/client'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { RenderLayout } from '../markdown/render'
import { spanWidth } from '../markdown/text'
import type { TerminalTheme } from '../markdown/theme'
import { messageLayout, MessageView, PART_RENDERERS } from './message-view'
import { ThemeProvider } from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true, level: 3 }
const LIGHT: TerminalTheme = { background: 'light', color: true, level: 3 }
const PLAIN: TerminalTheme = { background: 'dark', color: false, level: 0 }
/** A terminal with sixteen colours and no tints at all: the code block's fallback (#231). */
const NAMED: TerminalTheme = { background: 'dark', color: true, level: 1 }

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

/**
 * Render a message and answer the frame it drew, as the terminal would show it.
 *
 * `blankAbove` is what the transcript passes when nothing above the message has set it off;
 * it only changes the frame of a user's message, which draws the blank line above its band.
 */
function frameOf(
  subject: TranscriptMessage,
  width: number,
  theme: TerminalTheme = DARK,
  blankAbove = false,
): string {
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <MessageView message={subject} width={width} blankAbove={blankAbove} />
    </ThemeProvider>,
  )
  return lastFrame() ?? ''
}

/** The lines of a frame. */
function lines(frame: string): string[] {
  return frame.split('\n')
}

/** The lines a message lays out, as the text they would draw. */
function layoutText(subject: TranscriptMessage, columns: number, theme: TerminalTheme = DARK) {
  return messageLayout(subject, columns, theme).lines.map((line) =>
    line.map((span) => span.text).join(''),
  )
}

/**
 * A code block's label as the panel draws it: the name against the **right** edge of the
 * block's `width` columns, which is what keeps the code's own column clean (#231).
 */
function label(name: string, width: number): string {
  return name.padStart(width)
}

afterEach(() => {
  cleanup()
})

describe('MessageView', () => {
  it('draws every line of a message at column 0, with no label and no indent (#229)', () => {
    const frame = frameOf(message('one two three four five six seven eight'), 20)

    // The width is the message's own — there is no label taking eight columns out of it — and
    // the last column is left for the streaming cursor, so the text wraps at nineteen.
    expect(lines(frame)).toEqual(['one two three four', 'five six seven', 'eight'])
    expect(frame).not.toContain('agent ›')
  })

  it('keeps the lines the author wrote, at the column they wrote them', () => {
    // A user's own newline is a line break; the same text from an agent would be one
    // paragraph, because Markdown says a soft break is a space. Two spaces of indentation in
    // a pasted prompt are the two spaces that were pasted.
    const frame = frameOf(message('first\n  second', 'user'), 40, DARK, true)

    expect(lines(frame)).toEqual(['', 'first', '  second', ''])
  })

  it('does not render a user message as markdown: what they typed is what is shown', () => {
    const frame = frameOf(message('# not a heading\n\n| not | a table |', 'user'), 40, DARK, true)

    // The blank line between the two blocks is padded out to the band's width, so the band is
    // one block; with colour off it reads as the blank line it is.
    expect(lines(frame)).toEqual(['', '# not a heading', '', '| not | a table |', ''])
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

    // Lists keep their bullets and quotes keep their bar: those are content, not gutters. The
    // heading, the prose and the code are all at column 0; the label is on the panel's top
    // line, right-aligned and dim, and the panel's bottom line is tinted padding (#231).
    expect(lines(frame)).toEqual([
      'Heading',
      '',
      'Some bold words.',
      '',
      '• one',
      '  • nested',
      '',
      '▏ quoted',
      '',
      label('ts', 39),
      'const x = 1',
      '',
    ])
  })

  it('draws a table inside the room the message has', () => {
    const frame = frameOf(message('| a | b |\n| --- | --- |\n| 1 | 2 |', 'agent'), 28)

    expect(lines(frame)).toEqual(['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘'])
  })

  it('is a code block in progress when the fence has not been closed yet', () => {
    const frame = frameOf(message('Here:\n\n```python\ndef f(x):', 'agent'), 30)

    expect(lines(frame)).toEqual(['Here:', '', label('python', 29), 'def f(x):', ''])
  })

  it('does not jump when the fence closes (#229)', () => {
    // The reply arrives in chunks and the closing fence lands last. `remark` reads an
    // unterminated fence as a code block to the end of the text, so the block is already
    // there — and it has to be the *same* block, or the reply visibly jumps the instant the
    // fence closes.
    const body = '```rust\nfn main() {\n    println!("hi");'
    const open = lines(frameOf(message(`Here:\n\n${body}`, 'agent'), 30))
    const closed = lines(frameOf(message(`Here:\n\n${body}\n\`\`\``, 'agent'), 30))

    expect(open).toEqual(closed)
  })

  it('keeps the block closed while it streams: the label and the padding never move', () => {
    // What a streaming block looks like frame by frame: only the body grows. The label line
    // is at the top and the panel's padding at the bottom from the first frame to the last, so
    // there is nothing to appear and nothing to misalign.
    const chunks = ['```rust\nfn main() {', '\n    println!("hi");', '\n}']
    const frames = chunks.map((_, index) =>
      lines(frameOf(message(chunks.slice(0, index + 1).join(''), 'agent'), 30)),
    )

    for (const frame of frames) {
      expect(frame[0]).toBe(label('rust', 29))
      // The bottom line of the panel: tinted padding, which is what a frame with no colour in
      // it draws as an empty line.
      expect(frame.at(-1)).toBe('')
    }
    // And that line really is the panel's padding — the full width of the block, which the
    // frame's trim hides and the layout does not (#231).
    expect(layoutText(message(chunks.join(''), 'agent'), 30).at(-1)).toHaveLength(29)
    expect(frames.at(-1)).toEqual([
      label('rust', 29),
      'fn main() {',
      '    println!("hi");',
      '}',
      '',
    ])
  })

  it('emits the code verbatim, with no gutter in front of it (#229)', () => {
    const frame = frameOf(message('```rust\nfn main() {\n    println!("hi");\n}\n```'), 30)

    // Select these three lines and paste them and the program is what comes back.
    expect(lines(frame).slice(1, -1)).toEqual(['fn main() {', '    println!("hi");', '}'])
  })

  it('wraps wide characters by their columns, not their count', () => {
    const frame = frameOf(message('日本語のテキストです', 'agent'), 20)

    // Nineteen columns of content: nine double-width characters fit, and the tenth goes to
    // the next line whole rather than straddling the edge.
    expect(lines(frame)).toEqual(['日本語のテキストで', 'す'])
  })

  it('keeps the streaming cursor on the last line, and the queued note after it', () => {
    expect(lines(frameOf(message('hello', 'agent', { streaming: true }), 40))).toEqual(['hello▌'])
    expect(lines(frameOf(message('hello', 'user', { pending: true }), 40, DARK, true))).toEqual([
      '',
      'hello (queued)',
      '',
    ])
  })

  it('draws the same words under NO_COLOR, in no colour at all', () => {
    const reply = '# Heading\n\nsome `code` and a [link](https://x)'
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

  it('draws a code block without a tint under NO_COLOR, and keeps every line of it (#231)', () => {
    const reply = '```ts\nconst x = 1\n```'

    // The panel is colour, so without colour there is no panel: the label moves to column 0
    // and the tint is gone. What is not gone is the shape — three lines, the code at column 0,
    // the same words a coloured terminal shows.
    expect(lines(frameOf(message(reply), 40, PLAIN))).toEqual(['ts', 'const x = 1', ''])
    expect(lines(frameOf(message(reply), 40, NAMED))).toEqual(['ts', 'const x = 1', ''])

    // With a tint to draw it with, the label is at the block's right edge instead, and the
    // code line is the only one a reader reads (#231).
    expect(lines(frameOf(message(reply), 40, DARK))).toEqual([label('ts', 39), 'const x = 1', ''])
  })

  it('draws a colourless message with the same text as a coloured one', () => {
    expect(lines(frameOf(message('- one\n- two'), 40, PLAIN))).toEqual(['• one', '• two'])
  })

  it('puts the metadata line under the reply, at column 0 with it (#208, #229)', () => {
    const { lastFrame } = render(
      <ThemeProvider theme={DARK}>
        <MessageView message={message('hello there')} width={40} metaLine="4.2s · 1.3k tokens" />
      </ThemeProvider>,
    )

    expect(lines(lastFrame() ?? '')).toEqual(['hello there', '4.2s · 1.3k tokens'])
  })

  it('has no metadata line to draw when the caller has none (#208)', () => {
    expect(lines(frameOf(message('hello there'), 40))).toEqual(['hello there'])
  })

  it('lays the message out at the width it is given, the cursor column aside', () => {
    const reply = 'one two three four five six'

    expect(lines(frameOf(message(reply), 30))).toEqual(['one two three four five six'])
    expect(lines(frameOf(message(reply), 16))).toEqual(['one two three', 'four five six'])
  })
})

describe('the band a user message is drawn on (#229)', () => {
  it('is a full-width background on a user message, and none on an agent reply', () => {
    const user = messageLayout(message('hi there', 'user'), 20, DARK)

    expect(user.band).toBe('#2a2b33')
    expect(user.mark).toBeUndefined()
    // Every line, the last of them included, reaches the terminal's edge.
    for (const line of user.lines) expect(spanWidth(line)).toBe(20)

    const agent = messageLayout(message('hi there', 'agent'), 20, DARK)

    expect(agent.band).toBeUndefined()
    expect(layoutText(message('hi there', 'agent'), 20)).toEqual(['hi there'])
  })

  it('takes its shade from the terminal it is in, in as much colour as it has (#231)', () => {
    // A 24-bit terminal gets the derived tint, a 256-colour one the nearest gray of the ramp,
    // and a sixteen-colour one the named colour it always had — the argument is in `theme.ts`.
    expect(messageLayout(message('hi', 'user'), 20, LIGHT).band).toBe('#ececf2')
    expect(messageLayout(message('hi', 'user'), 20, DARK).band).toBe('#2a2b33')
    expect(messageLayout(message('hi', 'user'), 20, { ...DARK, level: 2 }).band).toBe(
      'ansi256(236)',
    )
    expect(messageLayout(message('hi', 'user'), 20, NAMED).band).toBe('blackBright')
  })

  it('is the whole band, not just the words on it', () => {
    // A line of text shorter than the terminal is padded out to it, so the band is a band and
    // not a ragged highlight around the words.
    expect(layoutText(message('hi', 'user'), 20)).toEqual(['hi'.padEnd(20, ' ')])
  })

  it('is set off from its neighbours by a blank line above and below', () => {
    expect(lines(frameOf(message('hi', 'user'), 20, DARK, true))).toEqual(['', 'hi', ''])
    // The first message of a conversation has nothing above it to be set off from.
    expect(lines(frameOf(message('hi', 'user'), 20, DARK, false))).toEqual(['hi', ''])
  })

  it('gives way to a dim mark above the message when there is no colour (#229)', () => {
    const layout = messageLayout(message('hi there', 'user'), 20, PLAIN)

    expect(layout.band).toBeUndefined()
    // A mark on a line of its own, never a prefix: what is in front of a line is what a copy
    // of that line picks up.
    expect(layout.mark).toBe('›')
    expect(layoutText(message('hi there', 'user'), 20, PLAIN)).toEqual(['hi there'])
    expect(lines(frameOf(message('hi', 'user'), 20, PLAIN, true))).toEqual(['', '›', 'hi', ''])
  })

  it('leaves an agent reply unmarked either way', () => {
    expect(messageLayout(message('hi', 'agent'), 20, PLAIN).mark).toBeUndefined()
    expect(messageLayout(message('hi', 'agent'), 20, DARK).mark).toBeUndefined()
  })
})

describe('copy-safety (#229)', () => {
  it('opens no line of a reply with a label, an indent or a space of its own', () => {
    const reply = [
      '# Heading',
      '',
      'A paragraph long enough that it has to wrap somewhere in the middle of it.',
      '',
      '```ts',
      'const x = 1',
      '```',
    ].join('\n')
    const frame = frameOf(message(reply), 24)
    const drawn = lines(frame).filter((text) => text !== '')

    // The code panel's label is the one line that is not content: it is the language's name,
    // dim, against the block's right edge, and it is the one thing here that can be left out
    // of a selection whole rather than character by character (#231). Everything else — the
    // heading, the prose, the code — opens at column 0.
    const content = drawn.filter((text) => text !== label('ts', 23))

    for (const line of content) {
      expect(line.startsWith(' '), `indented: ${JSON.stringify(line)}`).toBe(false)
      expect(line).not.toContain('agent ›')
    }
    expect(drawn).toContain(label('ts', 23))
  })

  it('copies an agent reply exactly, in colour and without it', () => {
    // The thing people actually copy is a reply, and a reply is never padded: what leaves the
    // terminal is the words, with no colour on them to travel with them (X4, #229).
    const reply = 'one two three four five six seven'
    const text = (theme: TerminalTheme): string[] => layoutText(message(reply, 'agent'), 20, theme)

    expect(text(PLAIN)).toEqual(text(DARK))
    expect(text(DARK)).toEqual(['one two three four', 'five six seven'])
  })
})
