import { describe, expect, it } from 'vitest'

import {
  padSpans,
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
