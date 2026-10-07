import { describe, expect, it } from 'vitest'

import { markdownLines, type RenderLayout } from './render'
import { spanWidth, type Span } from './text'
import type { TerminalTheme } from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true }
const PLAIN: TerminalTheme = { background: 'dark', color: false }

/** The lines of a reply, as text: what the frame would show. */
function linesOf(text: string, width = 60, theme: TerminalTheme = DARK): string[] {
  const layout: RenderLayout = { width, theme }
  return markdownLines(text, layout).map((line) => line.map((span) => span.text).join(''))
}

/** The spans of a reply, flattened, for the tests about colour. */
function spansOf(text: string, width = 60, theme: TerminalTheme = DARK): Span[] {
  return markdownLines(text, { width, theme }).flatMap((line) => [...line])
}

/**
 * The span carrying `text`, wherever it is.
 *
 * *Carrying*, not equal to: adjacent runs of the same style are one span, so `call ` and
 * `call` are the same span depending on what follows it.
 */
function spanWith(source: string, text: string, width = 60, theme: TerminalTheme = DARK): Span {
  const found = spansOf(source, width, theme).find((span) => span.text.includes(text))
  expect(found, `no span carrying ${JSON.stringify(text)}`).toBeDefined()
  return found ?? { text: '' }
}

describe('paragraphs', () => {
  it('wraps to the width it was given', () => {
    const source = 'one two three four five six seven eight'

    expect(linesOf(source, 12)).toEqual(['one two', 'three four', 'five six', 'seven eight'])
  })

  it('leaves a hard break where the text put one', () => {
    expect(linesOf('first line  \nsecond line')).toEqual(['first line', 'second line'])
  })

  it('treats a soft break — a newline in the source — as the space CommonMark says it is', () => {
    // Model replies wrap their prose, and a wrapped paragraph is one paragraph, not a stack
    // of lines.
    expect(linesOf('one two\nthree four')).toEqual(['one two three four'])
  })

  it('puts a blank line between two paragraphs, and none at the ends', () => {
    expect(linesOf('one\n\ntwo')).toEqual(['one', '', 'two'])
  })

  it('draws bold, italic and strikethrough as the styles they are', () => {
    const source = '**bold** *italic* ~~gone~~'

    expect(spanWith(source, 'bold').bold).toBe(true)
    expect(spanWith(source, 'italic').italic).toBe(true)
    expect(spanWith(source, 'gone').strikethrough).toBe(true)
  })

  it('draws inline code in the code colour, and the terminal keeps the rest colourless', () => {
    const source = 'call `runTurn()` now'

    expect(spanWith(source, 'runTurn()').color).toBe('magenta')
    expect(spanWith(source, 'call').color).toBeUndefined()
  })
})

describe('headings', () => {
  it('is bold, in the heading colour, and underlined at the top two levels', () => {
    expect(spanWith('# Title', 'Title').bold).toBe(true)
    expect(spanWith('# Title', 'Title').color).toBe('blue')
    expect(spanWith('# Title', 'Title').underline).toBe(true)
    expect(spanWith('## Title', 'Title').underline).toBe(true)
    expect(spanWith('### Title', 'Title').underline).toBe(false)
    expect(spanWith('### Title', 'Title').bold).toBe(true)
  })

  it('is set apart from the paragraph after it', () => {
    expect(linesOf('# Title\nbody')).toEqual(['Title', '', 'body'])
  })
})

describe('lists', () => {
  it('bullets an unordered list', () => {
    expect(linesOf('- one\n- two')).toEqual(['• one', '• two'])
  })

  it('numbers an ordered list from where it says, and keeps counting', () => {
    expect(linesOf('3. three\n4. four')).toEqual(['3. three', '4. four'])
  })

  it('indents a nested list under the item it belongs to', () => {
    expect(linesOf('- one\n  - deep\n- two')).toEqual(['• one', '  • deep', '• two'])
  })

  it('hangs a wrapped item under its own marker', () => {
    const lines = linesOf('- a fairly long item that has to wrap somewhere', 20)

    // The marker costs two of the twenty columns, and the item wraps to the eighteen left.
    expect(lines).toEqual(['• a fairly long item', '  that has to wrap', '  somewhere'])
  })

  it('ticks the boxes of a task list', () => {
    expect(linesOf('- [x] done\n- [ ] not')).toEqual(['[x] done', '[ ] not'])
  })

  it('spaces a loose list out, and leaves a tight one alone', () => {
    expect(linesOf('- one\n- two')).toEqual(['• one', '• two'])
    expect(linesOf('- one\n\n- two')).toEqual(['• one', '', '• two'])
  })
})

describe('blockquotes', () => {
  it('puts a bar down the left, and draws the quote dimmer', () => {
    const source = '> quoted words'

    expect(linesOf(source)).toEqual(['▏ quoted words'])
    expect(spanWith(source, 'quoted words').dim).toBe(true)
    expect(spanWith(source, '▏ ').dim).toBe(true)
  })

  it('wraps inside the bar, not through it', () => {
    expect(linesOf('> a quote long enough to wrap', 14)).toEqual([
      '▏ a quote long',
      '▏ enough to',
      '▏ wrap',
    ])
  })
})

describe('links', () => {
  it('shows the text and the URL after it', () => {
    expect(linesOf('[the docs](https://example.com/docs)')).toEqual([
      'the docs (https://example.com/docs)',
    ])
    expect(spanWith('see [the docs](https://example.com/docs)', 'the docs').color).toBe('blue')
    expect(spanWith('see [the docs](https://example.com/docs)', 'the docs').underline).toBe(true)
    expect(spanWith('see [x](https://y)', ' (https://y)').dim).toBe(true)
  })

  it('shows a bare URL once, since it is its own text', () => {
    expect(linesOf('see https://example.com/docs now')).toEqual([
      'see https://example.com/docs now',
    ])
  })

  it('shows an image as its alt text and its URL', () => {
    expect(linesOf('![a diagram](https://example.com/d.png)')).toEqual([
      'a diagram (https://example.com/d.png)',
    ])
  })
})

describe('tables', () => {
  const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 33 | 4 |'

  it('draws a box with a header row', () => {
    expect(linesOf(TABLE)).toEqual([
      '┌────┬───┐',
      '│ a  │ b │',
      '├────┼───┤',
      '│ 1  │ 2 │',
      '│ 33 │ 4 │',
      '└────┴───┘',
    ])
  })

  it('draws the header in bold', () => {
    expect(spanWith(TABLE, 'a').bold).toBe(true)
    expect(spanWith(TABLE, '33').bold).toBeUndefined()
  })

  it('aligns a column the way the delimiter row asked', () => {
    const aligned = '| left | right | centre |\n| :--- | ---: | :---: |\n| a | b | c |'

    expect(linesOf(aligned)).toEqual([
      '┌──────┬───────┬────────┐',
      '│ left │ right │ centre │',
      '├──────┼───────┼────────┤',
      '│ a    │     b │   c    │',
      '└──────┴───────┴────────┘',
    ])
  })

  it('narrows the widest columns and cuts the cell tails to fit the terminal', () => {
    const wide =
      '| provider | model | notes |\n| --- | --- | --- |\n| anthropic | claude-opus-5-5 | the careful one |'
    const lines = linesOf(wide, 40)

    expect(lines).toHaveLength(5)
    for (const line of lines) expect(spanWidth([{ text: line }])).toBeLessThanOrEqual(40)
    // The heading cells still fit; it is the long note that is cut, visibly.
    expect(lines[1]).not.toContain('…')
    expect(lines[3]).toContain('…')
    expect(lines[3]?.startsWith('│ anthropic')).toBe(true)
  })

  it('drops the box entirely when there is no room for one', () => {
    const lines = linesOf(TABLE, 8)

    expect(lines).toEqual(['a │ b', '1 │ 2', '33 │ 4'])
  })

  it('draws one row per line of the source, however wide the cells', () => {
    const rows = '| a | b |\n| --- | --- |\n| one | two |'

    expect(linesOf(rows)).toEqual([
      '┌─────┬─────┐',
      '│ a   │ b   │',
      '├─────┼─────┤',
      '│ one │ two │',
      '└─────┴─────┘',
    ])
  })
})

describe('code blocks', () => {
  it('labels the frame with the language and draws the code inside it', () => {
    const lines = linesOf('```ts\nconst x = 1\n```', 20)

    expect(lines).toEqual(['┌ ts ───────────────', '│ const x = 1', '└───────────────────'])
  })

  it('calls a fence with no language code', () => {
    expect(linesOf('```\nplain\n```', 16)).toEqual([
      '┌ code ─────────',
      '│ plain',
      '└───────────────',
    ])
  })

  it('colours the code by the language, and the frame by the terminal', () => {
    const source = '```ts\nconst x = 1\n```'

    expect(spanWith(source, 'const').color).toBe('#ff7b72')
    expect(spanWith(source, '┌ ts ').color).toBe('gray')
  })

  it('breaks a line too long for the frame rather than wrapping it as prose', () => {
    const lines = linesOf('```ts\nconst longName = 1234567890\n```', 20)

    // Eighteen columns inside the frame: the line is cut at the column, not at the space.
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe('│ const longName = 1')
    expect(lines[2]).toBe('│ 234567890')
  })

  it('draws a fence that has not been closed yet as a code block in progress', () => {
    // What a streaming reply looks like mid-block: there is no closing fence, and it is
    // still a code block.
    const lines = linesOf('Here:\n\n```python\ndef f(x):\n    return x', 40)

    expect(lines.at(-1)).toBe('└───────────────────────────────────────')
    expect(lines).toContain('│ def f(x):')
    expect(lines).toContain('│     return x')
  })

  it('shows a fence in a language it does not know, uncut', () => {
    expect(linesOf('```unknownlang\nanything at all\n```', 40)).toContain('│ anything at all')
  })
})

describe('rules and raw html', () => {
  it('draws a thematic break across the width', () => {
    expect(linesOf('one\n\n---\n\ntwo', 10)).toEqual(['one', '', '──────────', '', 'two'])
  })

  it('shows raw html as the text it is, dimmed', () => {
    // No `rehype-raw` on either client: the tags are shown, not obeyed — and dimmed, so they
    // read as something that was written rather than something that happened.
    expect(linesOf('<b>bold</b>')).toEqual(['<b>bold</b>'])
    expect(spanWith('<b>bold</b>', '<b>').dim).toBe(true)
  })
})

describe('NO_COLOR', () => {
  it('drops every colour and keeps every line', () => {
    const source = '# Title\n\n- one\n\n> quote\n\n```ts\nconst x = 1\n```\n\n[a](https://b)'
    const coloured = linesOf(source, 40, DARK)
    const plain = linesOf(source, 40, PLAIN)

    expect(plain).toEqual(coloured)
    expect(spansOf(source, 40, PLAIN).every((span) => span.color === undefined)).toBe(true)
    expect(spansOf(source, 40, DARK).some((span) => span.color !== undefined)).toBe(true)
  })
})

describe('the widths a terminal really has', () => {
  it('never draws a line wider than the box it was given', () => {
    const source = [
      '# A heading that is long enough to need wrapping',
      '',
      '- a list item that is long enough to need wrapping as well',
      '',
      '> a quote that is long enough to need wrapping too',
      '',
      '| a | b | c |',
      '| --- | --- | --- |',
      '| a long cell | another long cell | a third one |',
      '',
      '```ts',
      'const x = "a string long enough to need breaking somewhere"',
      '```',
    ].join('\n')

    for (const width of [20, 33, 40, 80]) {
      for (const line of markdownLines(source, { width, theme: DARK })) {
        expect(spanWidth(line), `a ${width}-column line overflowed`).toBeLessThanOrEqual(width)
      }
    }
  })
})
