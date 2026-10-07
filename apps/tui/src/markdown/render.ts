import type {
  Blockquote,
  Code,
  Heading,
  Image,
  Link,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
  Table,
  TableCell,
  TableRow,
} from 'mdast'
import stringWidth from 'string-width'

import { highlightCode } from './highlight'
import { parseMarkdown } from './parse'
import { PALETTE, paint, type TerminalTheme } from './theme'
import {
  padSpans,
  spanWidth,
  splitToWidth,
  textSpans,
  truncateSpans,
  wrapSpans,
  type Alignment,
  type Line,
  type Span,
} from './text'

/**
 * What a part renderer is handed: the room it has, and how to draw in it.
 *
 * `width` is what is left of the terminal after the message's own label and indent — the
 * renderer is told the box, not the screen, because everything it draws has to fit inside
 * one: the hanging indent is the message view prefixing every line it gets back, and a
 * block's own nesting (a list inside a quote inside a list) is this width getting smaller.
 */
export interface RenderLayout {
  /** Columns the content may use. */
  readonly width: number
  /** The theme: named colours, `NO_COLOR`, and the code theme's background (X4). */
  readonly theme: TerminalTheme
}

/** The style an inline run inherits from the nodes around it. */
interface InlineStyle {
  readonly bold?: boolean | undefined
  readonly italic?: boolean | undefined
  readonly underline?: boolean | undefined
  readonly strikethrough?: boolean | undefined
  readonly color?: string | undefined
}

/** Columns a code block's frame spends on `│ ` — the bar and the space after it. */
const FRAME = 2

/**
 * A reply, as the lines the terminal draws.
 *
 * This is the agent's half of X1: the `text` part of a message the agent wrote goes through
 * Markdown, element by element, and comes back as lines of styled spans. The user's half does
 * not — what they typed is what is shown, unparsed (`message-view.tsx` decides that, from the
 * message's role), because `#` in a prompt is a hash and not a heading.
 *
 * Everything here is deliberately *one* pass over the tree with the width threaded down
 * through it, rather than a tree walked twice with a measuring stage between: a streaming
 * reply is re-rendered on every delta, and the cheapest renderer is one that does not exist.
 * It is also why nothing here is stateful — the same text and the same width give the same
 * lines, which is what the frame tests rely on.
 *
 * **Links are shown, not hyperlinked.** The alternative was an OSC 8 sequence around the link
 * text, which is what modern terminals understand; it is not used, for three reasons. There is
 * no way to *ask* for it: `TERM`, `COLORTERM` and friends say nothing about it, so the escape
 * would be written at terminals that render it as garbage. It is invisible to everything that
 * reads the frame — a copy-paste or a screen reader sees the escape bytes and not the link.
 * And the URL has to be printed anyway for the terminals that do not do it, so the sequence
 * would only ever be decoration on text that is already there. `text (url)` is what a reader
 * is looking at either way, and it survives being piped to a file.
 */
export function markdownLines(text: string, layout: RenderLayout): Line[] {
  return renderBlocks(parseMarkdown(text).children, layout)
}

/**
 * The blocks of a document, in order, with a blank line between them.
 *
 * `compact` is what a **tight** list item is: Markdown draws no space between the lines of an
 * item that is one, and a nested list hanging directly off the line above it is the shape a
 * reader expects — a blank line there would read as a second paragraph.
 */
function renderBlocks(
  nodes: readonly RootContent[],
  layout: RenderLayout,
  compact = false,
): Line[] {
  const lines: Line[] = []
  for (const node of nodes) {
    const rendered = block(node, layout)
    if (rendered.length === 0) continue
    if (lines.length > 0 && !compact) lines.push([])
    lines.push(...rendered)
  }
  return lines
}

function block(node: RootContent, layout: RenderLayout): Line[] {
  switch (node.type) {
    case 'paragraph':
      return wrapSpans(inline(node.children, {}, layout), layout.width)
    case 'heading':
      return heading(node, layout)
    case 'code':
      return codeBlock(node, layout)
    case 'blockquote':
      return blockquote(node, layout)
    case 'list':
      return list(node, layout)
    case 'table':
      return table(node, layout)
    case 'thematicBreak':
      return rule(layout)
    case 'html':
      // No `rehype-raw` on either client: a message's HTML is shown, dimmed, as the text it
      // is — the same choice the web app makes, for the same reason.
      return wrapSpans(textSpans(node.value, { dim: true }), layout.width)
    case 'footnoteDefinition':
    case 'definition':
      return []
    default: {
      // Something the union does not name (a future extension): if it is text, show the
      // text; if it is a container, show what is in it. Never nothing, and never a crash.
      const fallback = node as { value?: unknown; children?: readonly RootContent[] }
      if (typeof fallback.value === 'string')
        return wrapSpans(textSpans(fallback.value), layout.width)
      return fallback.children === undefined ? [] : renderBlocks(fallback.children, layout)
    }
  }
}

/** A heading: bold, and underlined for the two levels that head a document. */
function heading(node: Heading, layout: RenderLayout): Line[] {
  return wrapSpans(
    inline(
      node.children,
      {
        bold: true,
        underline: node.depth <= 2,
        color: paint(layout.theme, PALETTE.heading),
      },
      layout,
    ),
    layout.width,
  )
}

/** A horizontal rule: the width, drawn. */
function rule(layout: RenderLayout): Line[] {
  return [
    [
      ...textSpans('─'.repeat(Math.max(1, layout.width)), {
        color: paint(layout.theme, PALETTE.chrome),
        dim: true,
      }),
    ],
  ]
}

/**
 * A fenced (or indented) code block, framed and coloured.
 *
 * ```text
 * ┌ ts ────────────────
 * │ const x = 1
 * └────────────────────
 * ```
 *
 * A frame rather than a bare indent because the code has to be *distinguishable* from the
 * prose around it, and the language label is the one thing a reader wants to know first. The
 * rule is drawn at the full width the block was given, so it lines up with the text it sits
 * between, and the frame is the terminal's own "structure" colour rather than the syntax
 * theme's — the frame belongs to the terminal, the code inside it to the language.
 *
 * Lines wider than the frame are broken at the frame's edge (`splitToWidth`): a code block is
 * the one thing that may not be word-wrapped, because the line breaks a language has are not
 * the breaks a reader wants.
 */
function codeBlock(node: Code, layout: RenderLayout): Line[] {
  const language = (node.lang ?? '').trim()
  const chrome = paint(layout.theme, PALETTE.chrome)
  const inner = Math.max(1, layout.width - FRAME)

  const body = highlightCode(node.value, language, layout.theme).flatMap((line) =>
    splitToWidth(line, inner),
  )

  return [
    [...frame(layout.width, '┌', language === '' ? 'code' : language, chrome)],
    ...body.map((line) => [...textSpans('│ ', { color: chrome }), ...line]),
    [...frame(layout.width, '└', '', chrome)],
  ]
}

/** The top or bottom of a code block's frame: `┌ ts ────…`, exactly `width` columns wide. */
function frame(width: number, corner: string, label: string, color: string | undefined): Span[] {
  const head = label === '' ? '' : ` ${label} `
  const rule = Math.max(0, width - 1 - stringWidth(head))
  return [
    { text: `${corner}${head}`, color, bold: label !== '' },
    ...textSpans('─'.repeat(rule), { color, dim: true }),
  ]
}

/** A quote: a bar down the left, and the whole thing a shade quieter. */
function blockquote(node: Blockquote, layout: RenderLayout): Line[] {
  const style = { color: paint(layout.theme, PALETTE.chrome), dim: true }
  const inner = renderBlocks(node.children, { ...layout, width: Math.max(1, layout.width - 2) })

  return inner.map((line) =>
    line.length === 0
      ? textSpans('▏', style)
      : [...textSpans('▏ ', style), ...line.map((span) => ({ ...span, dim: true }))],
  )
}

/** The bullet or number in front of a list item, including the space after it. */
function marker(item: ListItem, ordered: boolean, number: number): string {
  if (item.checked === true) return '[x] '
  if (item.checked === false) return '[ ] '
  return ordered ? `${number}. ` : '• '
}

/**
 * A list, nested or not.
 *
 * Nesting is indentation and nothing else: an item's blocks are rendered at the width left
 * over after the marker, and then every line of them is pushed along by the marker's width —
 * the marker on the first line, spaces on the rest. A list inside an item therefore indents
 * *under* the item, at whatever depth it was written, without this function knowing how deep
 * it is.
 */
function list(node: List, layout: RenderLayout): Line[] {
  const lines: Line[] = []
  let number = node.start ?? 1

  node.children.forEach((item, index) => {
    // A loose list is spaced out, a tight one is not — the difference Markdown itself draws
    // between items that are paragraphs and items that are lines.
    if (index > 0 && node.spread) lines.push([])

    const bullet = marker(item, node.ordered === true, number)
    number += 1
    const width = stringWidth(bullet)
    const inner = renderBlocks(
      item.children,
      { ...layout, width: Math.max(1, layout.width - width) },
      !node.spread,
    )

    inner.forEach((line, lineIndex) => {
      if (line.length === 0) {
        lines.push([])
        return
      }
      const prefix =
        lineIndex === 0
          ? textSpans(bullet, { color: paint(layout.theme, PALETTE.chrome) })
          : textSpans(' '.repeat(width))
      lines.push([...prefix, ...line])
    })
  })

  return lines
}

/**
 * A table, box-drawn — and truncated rather than wrapped when it does not fit.
 *
 * A wrapped row is a table a reader can no longer read: the columns stop lining up and the
 * cells of one row run into the next. So columns are narrowed from the widest inwards until
 * the table fits the terminal, and a cell that loses room loses its *tail*, marked with an
 * ellipsis, so it is visible that something was cut. A terminal too narrow for even that
 * (three columns come to five of border) gets the rows as plain text, one under another:
 * unreadable as a table, still readable.
 */
function table(node: Table, layout: RenderLayout): Line[] {
  const rows = node.children
  const header = rows[0]
  if (header === undefined) return []

  const columns = header.children.length
  if (columns === 0) return []

  const cellSpans = (row: TableRow, index: number, bold: boolean): Span[] => {
    const cell = row.children[index]
    if (cell === undefined) return []
    return flatten(inline(cell.children, bold ? { bold: true } : {}, layout))
  }

  const natural = Array.from({ length: columns }, (_, index) =>
    Math.max(...rows.map((row) => spanWidth(cellSpans(row, index, false)))),
  )

  const budget = layout.width - (3 * columns + 1)
  if (budget < columns) return crowdedTable(rows, layout)

  const widths = shrink(natural, budget)
  const chrome = paint(layout.theme, PALETTE.chrome)
  const bar = (text: string): Span => ({ text, color: chrome, dim: true })

  const borders = (left: string, join: string, right: string): Line => [
    bar(left + widths.map((width) => '─'.repeat(width + 2)).join(join) + right),
  ]

  const row = (source: TableRow, bold: boolean): Line => {
    const spans: Span[] = [bar('│')]
    for (let index = 0; index < columns; index += 1) {
      const width = widths[index] ?? 1
      const cell = truncateSpans(cellSpans(source, index, bold), width)
      spans.push(
        { text: ' ' },
        ...padSpans(cell, width, alignment(node.align?.[index])),
        { text: ' ' },
        bar('│'),
      )
    }
    return spans
  }

  return [
    borders('┌', '┬', '┐'),
    row(header, true),
    borders('├', '┼', '┤'),
    ...rows.slice(1).map((line) => row(line, false)),
    borders('└', '┴', '┘'),
  ]
}

/** A table column's alignment, as the padding helper wants it (absent means left). */
function alignment(value: string | null | undefined): Alignment {
  return value === 'left' || value === 'right' || value === 'center' ? value : null
}

/** Every column narrowed to fit `budget`, widest first, never below one column. */
function shrink(natural: readonly number[], budget: number): number[] {
  const widths = [...natural]
  let total = widths.reduce((sum, width) => sum + width, 0)

  while (total > budget) {
    let widest = -1
    for (let index = 0; index < widths.length; index += 1) {
      const width = widths[index] ?? 0
      if (width > (widths[widest] ?? 0)) widest = index
    }
    if (widest === -1 || (widths[widest] ?? 0) <= 1) {
      // Every column is down to one column and it still does not fit: nothing left to give.
      break
    }
    widths[widest] = (widths[widest] ?? 0) - 1
    total -= 1
  }

  return widths
}

/** A table with no room for a table: the rows, as text, separated by a bar. */
function crowdedTable(rows: readonly TableRow[], layout: RenderLayout): Line[] {
  return rows.flatMap((row) =>
    wrapSpans(
      row.children.flatMap((cell: TableCell, index) => [
        ...(index === 0 ? [] : textSpans(' │ ')),
        ...inline(cell.children, {}, layout),
      ]),
      layout.width,
    ),
  )
}

/** Spans with their newlines turned into spaces: one table cell is one line, always. */
function flatten(spans: readonly Span[]): Span[] {
  return spans.map((span) => ({ ...span, text: span.text.replaceAll('\n', ' ') }))
}

/** The text of a run of spans, for the one comparison that needs it (a bare link). */
function spansText(spans: readonly Span[]): string {
  return spans.map((span) => span.text).join('')
}

/** The phrasing nodes of a block, in order, in the style they inherit. */
function inline(
  nodes: readonly PhrasingContent[],
  style: InlineStyle,
  layout: RenderLayout,
): Span[] {
  return nodes.flatMap((node) => inlineNode(node, style, layout))
}

function inlineNode(node: PhrasingContent, style: InlineStyle, layout: RenderLayout): Span[] {
  switch (node.type) {
    case 'text':
      // A **soft** break — a newline in the source that is not a hard one — is a space:
      // CommonMark says so, and every model that wraps its prose writes them. Only a `break`
      // node ends a line, which is what the visible `\n` below is for.
      return textSpans(node.value.replaceAll('\n', ' '), style)
    case 'strong':
      return inline(node.children, { ...style, bold: true }, layout)
    case 'emphasis':
      return inline(node.children, { ...style, italic: true }, layout)
    case 'delete':
      return inline(node.children, { ...style, strikethrough: true }, layout)
    case 'inlineCode':
      return textSpans(node.value, { ...style, color: paint(layout.theme, PALETTE.code) })
    case 'break':
      // A hard break is a newline in the text: the wrapper is what knows a line ends there.
      return [{ text: '\n' }]
    case 'link':
      return link(node, style, layout)
    case 'image':
      return image(node, style, layout)
    case 'html':
      return textSpans(node.value, { dim: true })
    case 'footnoteReference':
      return textSpans(`[^${node.label ?? node.identifier}]`, {
        dim: true,
        color: paint(layout.theme, PALETTE.chrome),
      })
    default: {
      const fallback = node as { value?: unknown; children?: readonly PhrasingContent[] }
      if (typeof fallback.value === 'string') return textSpans(fallback.value, style)
      return fallback.children === undefined ? [] : inline(fallback.children, style, layout)
    }
  }
}

/**
 * A link: its text, and the URL after it.
 *
 * A link whose text *is* its URL — which is what an autolinked bare URL parses to — is shown
 * once. Printing `https://example.com/a (https://example.com/a)` is the sort of thing that
 * makes a terminal client feel unfinished.
 */
function link(node: Link, style: InlineStyle, layout: RenderLayout): Span[] {
  const text = inline(
    node.children,
    { ...style, color: paint(layout.theme, PALETTE.link), underline: true },
    layout,
  )
  if (spansText(text) === node.url) return text
  return [
    ...text,
    ...textSpans(` (${node.url})`, { dim: true, color: paint(layout.theme, PALETTE.chrome) }),
  ]
}

/** An image: its alt text where there is one, and always its URL. */
function image(node: Image, style: InlineStyle, layout: RenderLayout): Span[] {
  const alt = node.alt ?? ''
  return [
    ...textSpans(alt === '' ? 'image' : alt, {
      ...style,
      italic: true,
      color: paint(layout.theme, PALETTE.link),
    }),
    ...textSpans(` (${node.url})`, { dim: true, color: paint(layout.theme, PALETTE.chrome) }),
  ]
}
