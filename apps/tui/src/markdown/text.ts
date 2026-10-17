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
 * **The plainness is enforced, not assumed** (issue #368). It used to be an assumption the
 * module stated and nothing kept: text a **child session** produced — its description, its
 * activity line, what it said, its result — reached this layer verbatim, so a terminal escape
 * sequence in it executed in the reader's terminal. Every entry point below sanitises
 * ({@link sanitizeText}), which is what makes "a span holds no escape sequence" true of the
 * whole TUI at once rather than of the components that remembered.
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
  /**
   * The surface this run sits on — a code block's panel (#231). A span's own background, not
   * the message's: the band around a user's message is decided once for the whole message
   * (`message-view.tsx`), where a panel covers exactly the lines the renderer gives it, so it
   * has to travel with them. Absent everywhere else, which is why nothing but the code block
   * renderer sets it.
   */
  readonly background?: string | undefined
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
  const plain = sanitizeText(text)
  return plain === '' ? [] : [{ text: plain, ...style }]
}

/**
 * Strip terminal control from a string that came from somewhere the reader does not control
 * (epic #340, S9; issue #368).
 *
 * A child session's output is drawn by Ink verbatim, and a terminal executes what it prints:
 * `\x1b]52;c;<base64>\x07` writes the reader's clipboard, `\x1b]0;…\x07` retitles their window,
 * `\x1b[2J` clears the screen, and the C1 spellings of the same sequences
 * (`\x9b2J`) work wherever the terminal is in 8-bit mode. A helper that summarised a page — or
 * answered from an MCP server — is enough to carry one, so the sanitising belongs here, at the
 * single place plain text becomes spans, rather than at each component that remembered to ask.
 *
 * Three things go, and only those:
 *
 * - **every C0 control except `\n` and `\t`** — the two the wrapper needs, because a newline is
 *   a line break and a tab is layout; everything else (a bell, a backspace, `\r`) is not a
 *   character a terminal should be told to act on, and neither is `\x7f`;
 * - **every C1 control** (`\x80`–`\x9f`), for the same reason;
 * - **a whole escape sequence**, wherever one is introduced by `\x1b` or by a C1 introducer:
 *   the CSI sequences (`ESC [ … final`), the string sequences (OSC `ESC ] … BEL`/ST, and DCS,
 *   SOS, PM and APC `ESC P|X|^|_ … ST`), and the two-or-three-character escapes (an
 *   intermediate run and a final byte). Dropping only the introducer would leave a sequence's
 *   payload behind as text — `]52;c;AAAA` under a result line — which is both ugly and a lie
 *   about what the child said.
 *
 * An **unterminated** sequence — a stream that has not finished arriving — is dropped to the
 * end of the string, which is where it is going anyway: the text before it still draws, and
 * nothing after a half-written escape can be trusted to be text.
 *
 * @param text plain text from a log, a child, a tool or a model
 */
export function sanitizeText(text: string): string {
  let plain = ''
  let at = 0
  while (at < text.length) {
    const code = text.charCodeAt(at)
    if (code === ESCAPE) {
      at += 1 + escapeLength(text, at + 1)
      continue
    }
    const c1 = C1_INTRODUCERS.get(code)
    if (c1 !== undefined) {
      at += 1 + (c1 === 'csi' ? csiLength(text, at + 1) : stringLength(text, at + 1, c1 === 'osc'))
      continue
    }
    at += 1
    const character = text.charAt(at - 1)
    if (code === 0x0a || code === 0x09) {
      plain += character
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      // Dropped: a control character is not something the reader asked to read.
    } else {
      plain += character
    }
  }
  return plain
}

/** `spans` with every run of text sanitised — see {@link sanitizeText}. */
export function sanitizeSpans(spans: readonly Span[]): Span[] {
  return spans.map((span) => {
    const plain = sanitizeText(span.text)
    return plain === span.text ? span : { ...span, text: plain }
  })
}

/** `ESC`: the introducer of every escape sequence a terminal acts on. */
const ESCAPE = 0x1b

/**
 * The C1 introducers that begin a sequence rather than standing for a character of their own:
 * CSI (`\x9b`), OSC (`\x9d`), and DCS/SOS/PM/APC (`\x90`, `\x98`, `\x9e`, `\x9f`). Each is the
 * one-byte spelling of an `ESC` sequence, and each is followed by the same body.
 */
const C1_INTRODUCERS = new Map<number, 'csi' | 'osc' | 'string'>([
  [0x9b, 'csi'],
  [0x9d, 'osc'],
  [0x90, 'string'],
  [0x98, 'string'],
  [0x9e, 'string'],
  [0x9f, 'string'],
])

/**
 * How many characters a **CSI** sequence's body has, from just after its introducer.
 *
 * `ESC [ params… intermediates… final`: the parameters are `0x30`–`0x3f`, the intermediates
 * `0x20`–`0x2f`, and the one final byte `0x40`–`0x7e`. Anything else — a control character, a
 * plain letter where a parameter was expected — ends the sequence there, so a run of text does
 * not have a hole torn out of it by a stray `[`.
 */
function csiLength(text: string, start: number): number {
  let at = start
  while (at < text.length) {
    const code = text.charCodeAt(at)
    if (code >= 0x40 && code <= 0x7e) {
      return at - start + 1
    }
    if (code >= 0x20 && code <= 0x3f) {
      at += 1
      continue
    }
    return at - start
  }
  return at - start
}

/**
 * How many characters a **string** sequence's body has, from just after its introducer.
 *
 * OSC ends at `BEL` or at `ST`; DCS, SOS, PM and APC end at `ST` only. `ST` is `ESC \` or its
 * one-byte C1 spelling `\x9c`. An `ESC` that is not an `ST` ends the body instead of being
 * consumed, so the next sequence is read as its own rather than swallowed by a malformed one.
 */
function stringLength(text: string, start: number, bellTerminates: boolean): number {
  let at = start
  while (at < text.length) {
    const code = text.charCodeAt(at)
    if (bellTerminates && code === 0x07) {
      return at - start + 1
    }
    if (code === 0x9c) {
      return at - start + 1
    }
    if (code === ESCAPE) {
      return text.charCodeAt(at + 1) === 0x5c ? at - start + 2 : at - start
    }
    at += 1
  }
  return at - start
}

/**
 * How many characters the escape sequence introduced at `start` consumes, `ESC` included.
 *
 * The bodies are `{@link csiLength}` and `{@link stringLength}`; everything else is an `ESC`
 * with an optional run of intermediates (`0x20`–`0x2f`) and one final byte
 * (`0x30`–`0x7e`) — `ESC c` (reset), `ESC 7` (save cursor), `ESC ( B` (a character set).
 */
function escapeLength(text: string, start: number): number {
  const first = text.charCodeAt(start)
  if (Number.isNaN(first)) {
    // A lone `ESC` at the end of the text: there is no sequence to drop but the introducer.
    return 0
  }
  if (first === 0x5b) return csiLength(text, start + 1) + 1
  if (first === 0x5d) return stringLength(text, start + 1, true) + 1
  if (first === 0x50 || first === 0x58 || first === 0x5e || first === 0x5f) {
    return stringLength(text, start + 1, false) + 1
  }
  let at = start
  while (at < text.length && text.charCodeAt(at) >= 0x20 && text.charCodeAt(at) <= 0x2f) {
    at += 1
  }
  if (at < text.length) {
    const final = text.charCodeAt(at)
    if (final >= 0x30 && final <= 0x7e) {
      at += 1
    }
  }
  return at - start
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
    a.dim === b.dim &&
    a.background === b.background
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

  // Sanitised before anything is measured: the width arithmetic below is about what the reader
  // sees, and an escape sequence is not columns (issue #368).
  const clean = sanitizeSpans(spans)

  const flush = (): void => {
    if (current.length > 0) lines.push(current)
    current = []
    used = 0
  }

  for (const span of clean) {
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

  for (const token of tokenize(sanitizeSpans(spans), mode)) {
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
  // Sanitised before it is measured — the cut is about what the reader sees, and an escape
  // sequence would otherwise eat its own width and mis-cut the line (issue #368).
  const clean = sanitizeSpans(spans)
  if (spanWidth(clean) <= limit) return [...clean]
  if (limit === 0) return []
  if (limit === 1) return [{ text: '…' }]

  const cut: Span[] = []
  let used = 0
  for (const span of clean) {
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
