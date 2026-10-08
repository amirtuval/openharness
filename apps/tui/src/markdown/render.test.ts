import { describe, expect, it } from 'vitest'

import { markdownLines, type RenderLayout } from './render'
import { spanWidth, type Span } from './text'
import type { TerminalTheme } from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true, level: 3 }
const PLAIN: TerminalTheme = { background: 'dark', color: false, level: 0 }
/** A terminal with sixteeen colours and no tints at all: the code block's fallback (#231). */
const NAMED: TerminalTheme = { background: 'dark', color: true, level: 1 }

/**
 * The lines of a reply, as text — with the trailing panel padding trimmed off.
 *
 * A code block's lines carry the panel out to the block's width in spaces (#231), which is a
 * surface rather than content; the tests that care about it read the line's *width*, and every
 * other test wants to read the words.
 */
function linesOf(text: string, width = 60, theme: TerminalTheme = DARK): string[] {
  const layout: RenderLayout = { width, theme }
  return markdownLines(text, layout).map((line) =>
    line
      .map((span) => span.text)
      .join('')
      .trimEnd(),
  )
}

/** The lines of a reply, whole: padding, tint and all. */
function rawLinesOf(text: string, width = 60, theme: TerminalTheme = DARK): Span[][] {
  return markdownLines(text, { width, theme }).map((line) => [...line])
}

/** The spans of a reply, flattened, for the tests about colour. */
function spansOf(text: string, width = 60, theme: TerminalTheme = DARK): Span[] {
  return markdownLines(text, { width, theme }).flatMap((line) => [...line])
}

/**
 * A code block's label as the panel draws it: dim, against the **right** edge of the block's
 * `width` columns, so nothing is in front of the code below it (#231).
 */
function label(name: string, width: number): string {
  return name.padStart(width)
}

/** A code panel's padding line: blank, `width` columns wide, on the tint. */
function padding(width: number): string {
  return ' '.repeat(width)
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
  it('sets the label at the right edge of the block, above the code (#231)', () => {
    const lines = linesOf('```ts\nconst x = 1\n```', 20)

    expect(lines).toEqual([label('ts', 20), 'const x = 1', padding(20).trimEnd()])
  })

  it('calls a fence with no language code', () => {
    expect(linesOf('```\nplain\n```', 16)).toEqual([label('code', 16), 'plain', ''])
  })

  it('draws the code at column 0, with no gutter in front of it (#229)', () => {
    // The point of the pass: select these lines and paste them and the code is what comes
    // back — the `│ ` bar that used to open every line came with it.
    const lines = linesOf('```rust\nfn main() {\n    println!("hi");\n}\n```', 40)

    expect(lines.slice(1, -1)).toEqual(['fn main() {', '    println!("hi");', '}'])
  })

  it('colours the code by the language, and tints the panel with the terminal (#231)', () => {
    const source = '```ts\nconst x = 1\n```'
    const lines = rawLinesOf(source, 20)

    expect(spanWith(source, 'const').color).toBe('#ff7b72')

    // The surface, not the words: the label is the last run on the line above the code, dim
    // and on the tint, and the padding line under the code is the tint and nothing else.
    expect(lines[0]?.at(-1)).toMatchObject({ text: 'ts', dim: true, background: '#1f2026' })
    expect(lines[2]?.every((span) => span.background === '#1f2026')).toBe(true)
  })

  it('pads every line of the panel out to the block, so the tint is a surface', () => {
    // A panel only as wide as its longest line would be a ragged highlight; the padding is
    // what makes it a surface, and the code keeps column 0 on the way (#231).
    const lines = rawLinesOf('```ts\nconst x = 1\n```', 20)

    expect(lines).toHaveLength(3)
    for (const line of lines) expect(spanWidth(line)).toBe(20)
    // The code keeps column 0, and only the padding is added after it.
    expect(lines[1]?.map((span) => span.text).join('')).toBe('const x = 1'.padEnd(20))
    expect(lines[1]?.[0]?.text).toBe('const')
    expect(lines[1]?.at(-1)).toMatchObject({ background: '#1f2026' })
  })

  it('breaks a line too wide for the block rather than wrapping it as prose', () => {
    const lines = linesOf('```ts\nconst longName = 1234567890\n```', 20)

    // Twenty columns to the block: the line is cut at the column, not at the space.
    expect(lines).toHaveLength(4)
    expect(lines[1]).toBe('const longName = 123')
    expect(lines[2]).toBe('4567890')
  })

  it('draws a fence that has not been closed yet as the block it is going to be', () => {
    // What a streaming reply looks like mid-block: the fence is open, so `remark` reads
    // everything to the end of the text as code — and the block is laid out exactly as the
    // closed one will be, so nothing jumps when the fence lands (#229).
    const body = '```python\ndef f(x):\n    return x'
    const open = linesOf(`Here:\n\n${body}`, 40)
    const closed = linesOf(`Here:\n\n${body}\n\`\`\``, 40)

    expect(open).toEqual(closed)
    expect(open).toEqual(['Here:', '', label('python', 40), 'def f(x):', '    return x', ''])
  })

  it('shows a fence in a language it does not know, uncut', () => {
    expect(linesOf('```unknownlang\nanything at all\n```', 40)).toContain('anything at all')
  })

  describe('with no tint to draw the panel with (#231)', () => {
    it('falls back to a dim label line above and a blank line after', () => {
      const lines = linesOf('```ts\nconst x = 1\n```', 20, NAMED)
      const raw = rawLinesOf('```ts\nconst x = 1\n```', 20, NAMED)

      // The same three lines the panel has (a fence that closes must not jump into or out of
      // this shape), the same code at column 0 — the surface is the only thing gone.
      expect(lines).toEqual(['ts', 'const x = 1', ''])
      expect(linesOf('```ts\nconst x = 1\n```', 20, PLAIN)).toEqual(lines)
      // The label is the terminal's own "structure" colour here, as it was before the panel.
      expect(raw[0]?.[0]).toMatchObject({ text: 'ts', dim: true, color: 'gray' })
      expect(raw.every((line) => line.every((span) => span.background === undefined))).toBe(true)
      expect(raw[2]).toEqual([])
    })
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
    // Prose is untouched by it: the same words, the same wrapping, in no colour at all. A code
    // block is the one place the *frame* is colour — the panel's tint and the label's edge of
    // it disappear with the rest (see the fallback below) — and a heading, a list item and a
    // quote are laid out identically.
    const prose = '# Title\n\n- one\n\n> quote\n\n[a](https://b)'

    expect(linesOf(prose, 40, PLAIN)).toEqual(linesOf(prose, 40, DARK))
    expect(spansOf(prose, 40, PLAIN).every((span) => span.color === undefined)).toBe(true)
    expect(spansOf(prose, 40, DARK).some((span) => span.color !== undefined)).toBe(true)

    // The code, too: the same lines, the same words, the label at column 0 instead of on the
    // panel's right edge, and no tint anywhere.
    const code = '```ts\nconst x = 1\n```'

    expect(linesOf(code, 40, PLAIN)).toEqual(['ts', 'const x = 1', ''])
    expect(linesOf(code, 40, PLAIN)).toEqual(linesOf(code, 40, NAMED))
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
