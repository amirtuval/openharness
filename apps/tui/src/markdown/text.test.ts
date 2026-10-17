import { describe, expect, it } from 'vitest'

import {
  padSpans,
  sanitizeSpans,
  sanitizeText,
  spanWidth,
  splitToWidth,
  textSpans,
  truncateSpans,
  wrapSpans,
  type Span,
} from './text'

/** A line's text, with the spans joined: what a test cares about is usually the words. */
function textOf(line: readonly Span[]): string {
  return line.map((span) => span.text).join('')
}

/** Every line, as plain strings. */
function linesOf(lines: readonly (readonly Span[])[]): string[] {
  return lines.map(textOf)
}

const PLAIN = (text: string): readonly Span[] => textSpans(text)
const BOLD = (text: string): readonly Span[] => textSpans(text, { bold: true })

describe('spanWidth', () => {
  it('measures what a terminal would measure', () => {
    expect(spanWidth(PLAIN('hello'))).toBe(5)
    // A double-width glyph is two columns, and the wrapper has to know it.
    expect(spanWidth(PLAIN('日本'))).toBe(4)
    expect(spanWidth([...PLAIN('日本'), ...PLAIN(' ab')])).toBe(7)
  })

  it('is zero for nothing at all', () => {
    expect(spanWidth([])).toBe(0)
  })
})

describe('wrapSpans', () => {
  it('breaks prose at spaces, and never past the width', () => {
    const lines = wrapSpans(PLAIN('the quick brown fox jumps over the lazy dog'), 12)

    expect(linesOf(lines)).toEqual(['the quick', 'brown fox', 'jumps over', 'the lazy dog'])
    for (const line of lines) expect(spanWidth(line)).toBeLessThanOrEqual(12)
  })

  it('keeps every span of a paragraph, with its style', () => {
    const lines = wrapSpans([...PLAIN('a bold '), ...BOLD('word'), ...PLAIN(' again')], 40)

    expect(linesOf(lines)).toEqual(['a bold word again'])
    expect(lines[0]?.find((span) => span.text === 'word')?.bold).toBe(true)
  })

  it('does not keep the space at the end of a line', () => {
    const lines = wrapSpans(PLAIN('one two three'), 7)

    expect(linesOf(lines)).toEqual(['one two', 'three'])
  })

  it('breaks a word that is longer than the line rather than overflowing', () => {
    const lines = wrapSpans(PLAIN('https://example.com/a/very/long/path'), 10)

    expect(linesOf(lines)).toEqual(['https://ex', 'ample.com/', 'a/very/lon', 'g/path'])
  })

  it('cuts a wide character at the boundary, never through the middle of one', () => {
    const lines = wrapSpans(PLAIN('日本語のテキスト'), 5)

    expect(linesOf(lines)).toEqual(['日本', '語の', 'テキ', 'スト'])
    for (const line of lines) expect(spanWidth(line)).toBeLessThanOrEqual(5)
  })

  it('starts a new line wherever the text has one', () => {
    const lines = wrapSpans(PLAIN('first\nsecond\n\nfourth'), 40)

    expect(linesOf(lines)).toEqual(['first', 'second', '', 'fourth'])
  })

  it('collapses runs of spaces in prose', () => {
    expect(linesOf(wrapSpans(PLAIN('a    b'), 40))).toEqual(['a b'])
  })

  it('keeps the spaces the user typed, indentation included', () => {
    const lines = wrapSpans(PLAIN('if (x) {\n    return 1\n}'), 40, 'text')

    expect(linesOf(lines)).toEqual(['if (x) {', '    return 1', '}'])
  })

  it('still wraps a long line in text mode, at the spaces it has', () => {
    const lines = wrapSpans(PLAIN('aaaa bbbb cccc dddd'), 9, 'text')

    expect(linesOf(lines)).toEqual(['aaaa bbbb', 'cccc dddd'])
  })

  it('drops a carriage return: it is not a column', () => {
    expect(linesOf(wrapSpans(PLAIN('a\r\nb'), 40))).toEqual(['a', 'b'])
  })

  it('is one empty line for an empty run', () => {
    expect(linesOf(wrapSpans([], 10))).toEqual([''])
  })

  it('fits a line exactly when the words do', () => {
    expect(linesOf(wrapSpans(PLAIN('12345 6789'), 10))).toEqual(['12345 6789'])
  })
})

describe('splitToWidth', () => {
  it('cuts on the column, keeping every character', () => {
    expect(linesOf(splitToWidth(PLAIN('abcdefg'), 3))).toEqual(['abc', 'def', 'g'])
  })

  it('never splits a double-width character in half', () => {
    expect(linesOf(splitToWidth(PLAIN('日本語'), 3))).toEqual(['日', '本', '語'])
  })

  it('keeps the styles of what it cuts', () => {
    const lines = splitToWidth([...PLAIN('ab'), ...BOLD('cd')], 3)

    expect(textOf(lines[0] ?? [])).toBe('abc')
    expect((lines[0] ?? []).at(-1)?.bold).toBe(true)
  })

  it('is one empty line for nothing', () => {
    expect(splitToWidth([], 5)).toEqual([[]])
  })
})

describe('truncateSpans', () => {
  it('leaves a run that fits exactly as it is', () => {
    expect(textOf(truncateSpans(PLAIN('abc'), 3))).toBe('abc')
  })

  it('marks what it cut with an ellipsis, and fits the width', () => {
    const cut = truncateSpans(PLAIN('abcdefgh'), 5)

    expect(textOf(cut)).toBe('abcd…')
    expect(spanWidth(cut)).toBe(5)
  })

  it('counts wide characters in columns, not characters', () => {
    expect(textOf(truncateSpans(PLAIN('日本語テキスト'), 5))).toBe('日本…')
  })

  it('is nothing at zero columns, and an ellipsis at one', () => {
    expect(truncateSpans(PLAIN('abc'), 0)).toEqual([])
    expect(textOf(truncateSpans(PLAIN('abc'), 1))).toBe('…')
  })
})

describe('padSpans', () => {
  it('pads on the right by default', () => {
    expect(textOf(padSpans(PLAIN('ab'), 5))).toBe('ab   ')
  })

  it('pads on the left when the column is right-aligned', () => {
    expect(textOf(padSpans(PLAIN('ab'), 5, 'right'))).toBe('   ab')
  })

  it('splits the padding around a centred column', () => {
    expect(textOf(padSpans(PLAIN('ab'), 5, 'center'))).toBe(' ab  ')
  })

  it('leaves a run that is already wide enough alone', () => {
    expect(textOf(padSpans(PLAIN('abc'), 2))).toBe('abc')
  })
})

describe('sanitizeText (#368)', () => {
  // A child session's output is drawn verbatim, so a terminal escape sequence in it would
  // execute in the reader's terminal. These are the sequences that matter, spelled for real.
  it('drops an OSC 52 clipboard write whole', () => {
    expect(sanitizeText('before \u001b]52;c;cGF3bg==\u0007 after')).toBe('before  after')
  })

  it('drops an OSC 0 window title whole', () => {
    expect(sanitizeText('\u001b]0;pwned\u0007safe')).toBe('safe')
  })

  it('drops a CSI sequence — the clear screen', () => {
    expect(sanitizeText('one\u001b[2Jtwo')).toBe('onetwo')
    expect(sanitizeText('one\u001b[1;31mred\u001b[0m')).toBe('onered')
  })

  it('drops the C1 spellings, which 8-bit terminals act on too', () => {
    expect(sanitizeText('one\u009b2Jtwo')).toBe('onetwo')
    expect(sanitizeText('one\u009d0;title\u0007two')).toBe('onetwo')
  })

  it('drops a DCS sequence, terminated by ST', () => {
    expect(sanitizeText('a\u001bPq#0;2;0\u001b\\b')).toBe('ab')
  })

  it('drops the short escapes — a reset, a saved cursor, a character set', () => {
    expect(sanitizeText('a\u001bcb')).toBe('ab')
    expect(sanitizeText('a\u001b7b')).toBe('ab')
    expect(sanitizeText('a\u001b(Bb')).toBe('ab')
  })

  it('drops every C0 control and DEL, and keeps the newline and the tab', () => {
    expect(sanitizeText('a\u0000b\u0007c\u000bd\u000ce\u007ff')).toBe('abcdef')
    expect(sanitizeText('a\nb\tc')).toBe('a\nb\tc')
    // A carriage return is not a line break here: `\r\n` is normalised by the wrapper, and a
    // bare one would move the cursor over text already drawn.
    expect(sanitizeText('a\rb')).toBe('ab')
  })

  it('drops an unterminated sequence to the end of the text', () => {
    expect(sanitizeText('kept\u001b]0;half a title')).toBe('kept')
    expect(sanitizeText('kept\u001b[38;5;')).toBe('kept')
  })

  it('leaves ordinary text — including brackets and a lone ESC-less `]`', () => {
    expect(sanitizeText('a [b] c (d) e')).toBe('a [b] c (d) e')
    expect(sanitizeText('日本 · ok')).toBe('日本 · ok')
  })

  it('is what every entry point into a span does', () => {
    const hostile = 'x\u001b]52;c;AAAA\u0007y'
    expect(textOf(textSpans(hostile))).toBe('xy')
    expect(textOf(truncateSpans(textSpans(hostile), 40))).toBe('xy')
    // Built by hand, the way a component builds a card's lines: the cut and the wrapper are
    // where the text becomes a line, so they are where the sanitiser has to be.
    expect(textOf(truncateSpans([{ text: hostile }], 40))).toBe('xy')
    expect(linesOf(wrapSpans([{ text: hostile }], 40))).toEqual(['xy'])
    expect(linesOf(splitToWidth([{ text: hostile }], 40))).toEqual(['xy'])
  })

  it('measures what is left, so a line is cut by what the reader sees', () => {
    // The escape sequence is not columns: `abcdef` fits six, where measuring the raw string
    // would have counted twelve and cut three columns off the line (issue #368).
    expect(textOf(truncateSpans([{ text: 'abc\u001b[2Jdef' }], 6))).toBe('abcdef')
  })
})

describe('sanitizeSpans (#368)', () => {
  it('keeps a span it did not have to change, and rewrites the one it did', () => {
    const clean: Span = { text: 'plain', bold: true }
    const [rewritten] = sanitizeSpans([clean, { text: 'a\u0007b' }])
    expect(rewritten).toBe(clean)
    expect(sanitizeSpans([clean, { text: 'a\u0007b' }])[1]).toEqual({ text: 'ab' })
  })
})
