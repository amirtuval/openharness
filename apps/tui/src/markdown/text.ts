import stringWidth from 'string-width'

/**
 * One styled run of a rendered line.
 *
 * The text is **plain** — no escape sequences — and the style is data rather than bytes: a
 * span is measured, wrapped and truncated here, and Ink is the only thing that turns it into
 * an SGR sequence, when it draws. That is what keeps the arithmetic honest (a colour costs no
 * columns) and the tests readable: `expect(line[0].color).toBe('blue')` says what it means,
 * where hunting for `\u001B[34m` in a frame does not.
 *
 * `color` is an Ink colour name — an ANSI **named** colour everywhere except inside a code
 * block, whose syntax theme carries its own values (epic #201, X4).
 */
export interface Span {
  readonly text: string
  readonly color?: string | undefined
  readonly bold?: boolean | undefined
  readonly italic?: boolean | undefined
  readonly underline?: boolean | undefined
  readonly strikethrough?: boolean | undefined
  readonly dim?: boolean | undefined
}

/** One rendered line: the spans it is made of, already fitted to the width it was given. */
export type Line = readonly Span[]

/**
 * How a run of text is turned into lines.
 *
 * `flow` is prose: a run of spaces is one space, and the line breaks at spaces — what
 * Markdown means by its own whitespace rules. `text` is what the user typed: the spaces are
 * the ones they typed, so indentation survives, and a line still breaks at a space when it
 * runs out of room.
 */
export type WrapMode = 'flow' | 'text'

/** The columns a run of spans occupies. */
export function spanWidth(spans: readonly Span[]): number {
  let width = 0
  for (const span of spans) width += stringWidth(span.text)
  return width
}

/** A one-span run. */
export function textSpans(text: string, style: Omit<Span, 'text'> = {}): Span[] {
  return text === '' ? [] : [{ text, ...style }]
}

/** The same span, with different text: how a run is cut at a character boundary. */
function restyle(span: Span, text: string): Span {
  return { ...span, text }
}

function sameStyle(a: Span, b: Span): boolean {
  return (
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.dim === b.dim
  )
}

/** Append a span, merging it into the previous one when the style is identical. */
function append(target: Span[], span: Span): void {
  if (span.text === '') return
  const last = target[target.length - 1]
  if (last !== undefined && sameStyle(last, span)) {
    target[target.length - 1] = { ...last, text: last.text + span.text }
    return
  }
  target.push(span)
}

/**
 * Cut `spans` into runs that each fit `width` columns, breaking between characters.
 *
 * This is the last resort — a word, a URL or a line of code with nowhere to break — so it
 * breaks anywhere rather than overflowing, and it never leaves a dangling span. A wide
 * character that cannot fit on a line of its own (a width-1 line, a double-width glyph) is
 * the one thing it lets through: cutting it in half is worse than one column of overflow.
 */
export function splitToWidth(spans: readonly Span[], width: number): Line[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: Line[] = []
  let current: Span[] = []
  let used = 0

  const flush = (): void => {
    if (current.length > 0) lines.push(current)
    current = []
    used = 0
  }

  for (const span of spans) {
    // Codepoints, not UTF-16 units: half a surrogate pair is not a character.
    for (const character of span.text) {
      const size = stringWidth(character)
      if (used > 0 && used + size > limit) flush()
      append(current, restyle(span, character))
      used += size
    }
  }
  flush()

  return lines.length === 0 ? [[]] : lines
}

/** A word, or the whitespace before it: both are spans that know how wide they are. */
interface Sized {
  readonly spans: readonly Span[]
  readonly width: number
}

/** A token: a word, the whitespace before it, or a line the text asked to end. */
type Token =
  | ({ readonly kind: 'word' } & Sized)
  | ({ readonly kind: 'space' } & Sized)
  | { readonly kind: 'break' }

/**
 * Split spans into words, the whitespace between them, and forced breaks.
 *
 * A newline in the text is a break, wherever it sits: it is what a fenced paragraph, a hard
 * break in Markdown and a line the user pasted have in common. What is left of the whitespace
 * run after it is the next line's own indentation, and in `flow` mode that (like every other
 * run of spaces) collapses to a single space.
 */
function tokenize(spans: readonly Span[], mode: WrapMode): Token[] {
  const tokens: Token[] = []
  let space: Span[] = []
  let spaceWidth = 0

  // The run of spaces is flushed when the word after it arrives — and it keeps its *own*
  // style, not that word's: the space between a plain word and a bold one is plain.
  const flushSpace = (): void => {
    if (space.length === 0) return
    if (mode === 'flow') {
      tokens.push({ kind: 'space', spans: [{ ...space[0]!, text: ' ' }], width: 1 })
    } else {
      tokens.push({ kind: 'space', spans: space, width: spaceWidth })
    }
    space = []
    spaceWidth = 0
  }

  for (const source of spans) {
    // `\r` is a carriage return a terminal, a paste or a Windows editor left behind; it is
    // not a column, and a line break is spelled `\n` here and everywhere downstream.
    const text = source.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
    for (const piece of text.split(/(\s+)/u)) {
      if (piece === '') continue

      if (!/^\s+$/u.test(piece)) {
        flushSpace()
        tokens.push({ kind: 'word', spans: [restyle(source, piece)], width: stringWidth(piece) })
        continue
      }

      let rest = piece
      for (;;) {
        const newline = rest.indexOf('\n')
        if (newline === -1) {
          if (rest !== '') {
            append(space, restyle(source, rest))
            spaceWidth += stringWidth(rest)
          }
          break
        }
        if (newline > 0) {
          append(space, restyle(source, rest.slice(0, newline)))
          spaceWidth += stringWidth(rest.slice(0, newline))
        }
        flushSpace()
        tokens.push({ kind: 'break' })
        rest = rest.slice(newline + 1)
      }
    }
  }

  flushSpace()

  return tokens
}

/**
 * Wrap spans to `width` columns, preserving every span's style.
 *
 * This is the wrapping the message view needs: the caller hands in the width of the message —
 * all of it, since issue #229 took the label away — and draws the lines it gets back from
 * column 0, which is what makes a settled reply copy-paste clean.
 *
 * An empty run is one empty line, so a message part with nothing in it still draws.
 */
export function wrapSpans(spans: readonly Span[], width: number, mode: WrapMode = 'flow'): Line[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: Line[] = []
  let current: Span[] = []
  let used = 0
  let pending: Extract<Token, { kind: 'space' }> | undefined

  const flush = (): void => {
    lines.push(current)
    current = []
    used = 0
    pending = undefined
  }

  for (const token of tokenize(spans, mode)) {
    if (token.kind === 'break') {
      // A break with nothing before it, at the very start, is not a blank line: it is how
      // the text began.
      if (current.length > 0 || lines.length > 0) flush()
      continue
    }

    if (token.kind === 'space') {
      // Whitespace opens a line only in `text` mode, where it is the indentation the user
      // typed; in prose it is a separator for the word that follows.
      if (used === 0) {
        if (mode === 'text' && token.width < limit) {
          for (const span of token.spans) append(current, span)
          used = token.width
        }
        continue
      }
      pending = token
      continue
    }

    const gap = pending === undefined ? 0 : pending.width
    if (used > 0 && used + gap + token.width > limit) flush()

    if (used === 0 && token.width > limit) {
      // A word longer than the line: break it rather than overflow, and carry its tail on
      // as the line in progress.
      const pieces = splitToWidth(token.spans, limit)
      for (const piece of pieces.slice(0, -1)) lines.push(piece)
      const tail = pieces[pieces.length - 1] ?? []
      current = [...tail]
      used = spanWidth(tail)
      pending = undefined
      continue
    }

    if (pending !== undefined && used > 0) {
      for (const span of pending.spans) append(current, span)
      used += pending.width
    }
    for (const span of token.spans) append(current, span)
    used += token.width
    pending = undefined
  }

  flush()

  return lines
}

/**
 * `spans` cut to `width` columns, with an ellipsis where the rest went.
 *
 * Used by the table renderer: a column that has to give up room gives up its tail, visibly,
 * rather than quietly dropping it or wrapping the row out of shape.
 */
export function truncateSpans(spans: readonly Span[], width: number): Span[] {
  const limit = Math.max(0, Math.floor(width))
  if (spanWidth(spans) <= limit) return [...spans]
  if (limit === 0) return []
  if (limit === 1) return [{ text: '…' }]

  const cut: Span[] = []
  let used = 0
  for (const span of spans) {
    for (const character of span.text) {
      const size = stringWidth(character)
      if (used + size > limit - 1) break
      append(cut, restyle(span, character))
      used += size
    }
    if (used + 1 >= limit) break
  }
  // The ellipsis carries no colour of its own: it is not part of what was said.
  append(cut, { text: '…' })
  return cut
}

/** One of the four GFM table alignments (the default, `null`, is left). */
export type Alignment = 'left' | 'right' | 'center' | null | undefined

/** `spans` padded out to exactly `width` columns. */
export function padSpans(spans: readonly Span[], width: number, align: Alignment = 'left'): Span[] {
  const missing = Math.max(0, Math.floor(width) - spanWidth(spans))
  if (missing === 0) return [...spans]
  if (align === 'right') return [{ text: ' '.repeat(missing) }, ...spans]
  if (align === 'center') {
    const before = Math.floor(missing / 2)
    return [{ text: ' '.repeat(before) }, ...spans, { text: ' '.repeat(missing - before) }]
  }
  return [...spans, { text: ' '.repeat(missing) }]
}
