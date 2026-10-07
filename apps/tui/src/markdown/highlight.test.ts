import { describe, expect, it } from 'vitest'

import { HIGHLIGHTED_LANGUAGES, highlightCode } from './highlight'
import type { Line, Span } from './text'
import type { TerminalTheme } from './theme'

const DARK: TerminalTheme = { background: 'dark', color: true }
const PLAIN: TerminalTheme = { background: 'dark', color: false }

/** A line's text, with the spans joined. */
function textOf(line: Line): string {
  return line.map((span) => span.text).join('')
}

/** The whole block, as one string again — what the colouring must not change. */
function sourceOf(lines: readonly Line[]): string {
  return lines.map(textOf).join('\n')
}

/** Every span of the block, flattened. */
function spansOf(lines: readonly Line[]): Span[] {
  return lines.flatMap((line) => [...line])
}

describe('highlightCode', () => {
  it('colours a language it knows, token by token', () => {
    const lines = highlightCode('const x: string = "a" // hi', 'typescript', DARK)
    const spans = spansOf(lines)

    expect(sourceOf(lines)).toBe('const x: string = "a" // hi')
    expect(spans.find((span) => span.text === 'const')?.color).toBe('#ff7b72')
    expect(spans.find((span) => span.text === '"a"')?.color).toBe('#a5d6ff')
    expect(spans.find((span) => span.text === '// hi')?.color).toBe('#8b949e')
  })

  it('registers the languages a chat reply plausibly carries, and their aliases', () => {
    expect(HIGHLIGHTED_LANGUAGES).toContain('typescript')
    expect(HIGHLIGHTED_LANGUAGES).toContain('python')
    // A fence most often names the alias: `ts`, `py`, `sh`, `yml`.
    expect(sourceOf(highlightCode('def f():', 'py', DARK))).toBe('def f():')
    expect(
      spansOf(highlightCode('def f():', 'py', DARK)).some((span) => span.color !== undefined),
    ).toBe(true)
  })

  it('colours nested spans by the innermost scope, and never leaves markup behind', () => {
    // Highlighting a type inside a parameter list is nested spans, which is where a
    // pairwise matcher loses the plot and prints `<span class="…">` as text.
    const lines = highlightCode('function f(x: Session): void {}', 'typescript', DARK)
    const spans = spansOf(lines)

    expect(sourceOf(lines)).toBe('function f(x: Session): void {}')
    expect(spans.every((span) => !span.text.includes('<'))).toBe(true)
    expect(spans.find((span) => span.text === 'Session')?.color).toBe('#d2a8ff')
  })

  it('shows code in a language it does not know as plain text', () => {
    const lines = highlightCode('x <- 1', 'brainfuck', DARK)

    expect(sourceOf(lines)).toBe('x <- 1')
    expect(spansOf(lines).every((span) => span.color === undefined)).toBe(true)
  })

  it('shows a fence with no language as plain text', () => {
    const lines = highlightCode('some output', undefined, DARK)

    expect(sourceOf(lines)).toBe('some output')
    expect(spansOf(lines).every((span) => span.color === undefined)).toBe(true)
  })

  it('keeps a language label that is more than a name', () => {
    // A fence's info string carries options — `ts title="x.ts"` — and the first word is
    // still the language.
    const lines = highlightCode('const x = 1', 'ts title="x.ts"', DARK)

    expect(spansOf(lines).some((span) => span.color === '#ff7b72')).toBe(true)
  })

  it('turns the entities back into the characters that were written', () => {
    const lines = highlightCode('const s = "<a href=\'x\'>&amp;</a>"', 'typescript', DARK)

    expect(sourceOf(lines)).toBe('const s = "<a href=\'x\'>&amp;</a>"')
  })

  it('gives back the lines of the block, one per line of source', () => {
    const lines = highlightCode('const a = 1\n\nconst b = 2', 'typescript', DARK)

    expect(lines.map(textOf)).toEqual(['const a = 1', '', 'const b = 2'])
  })

  it('colourless under NO_COLOR, and otherwise unchanged', () => {
    const lines = highlightCode('const x = 1 // hi', 'typescript', PLAIN)

    expect(sourceOf(lines)).toBe('const x = 1 // hi')
    expect(spansOf(lines).every((span) => span.color === undefined)).toBe(true)
  })

  it('highlights half a snippet without failing: what streaming sees', () => {
    const lines = highlightCode('export function f(x: Ses', 'typescript', DARK)

    expect(sourceOf(lines)).toBe('export function f(x: Ses')
    expect(spansOf(lines).some((span) => span.color !== undefined)).toBe(true)
  })

  it('is one empty line for an empty block', () => {
    expect(highlightCode('', 'typescript', DARK)).toEqual([[]])
  })
})
