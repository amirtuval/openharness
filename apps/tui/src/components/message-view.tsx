import type { MessagePart, TranscriptMessage } from '@openharness/client'
import { Text, useStdout } from 'ink'

import { markdownLines, type RenderLayout } from '../markdown/render'
import { messageBand, paint, type TerminalTheme } from '../markdown/theme'
import { spanWidth, textSpans, wrapSpans, type Line, type Span } from '../markdown/text'
import { useTerminalTheme } from './theme'

/** The block that marks where a reply currently ends, while it is still arriving. */
const STREAM_CURSOR = '▌'

/**
 * What marks a user's message when there is no band to mark it with — `NO_COLOR`, where the
 * background is gone too and something has to say that this line is a thing the user said.
 * On its own line above the message, never in front of it: a prefix is a character, and a
 * character is what a copy-paste would pick up (issue #229).
 */
const USER_MARK = '›'

/** What the terminal falls back to when it will not say how wide it is. */
const FALLBACK_COLUMNS = 80

/**
 * The column at the right edge the transcript leaves empty: the streaming cursor's.
 *
 * `<Text>` re-wraps anything wider than the terminal, so a `▌` appended to a line that already
 * fills the width — a code block's closing rule, a paragraph that wrapped to the last column —
 * is pushed onto a line of its own, and the reply's last line visibly jumps as it arrives.
 * Reserving the column keeps the cursor on the line it belongs to; nothing else is drawn
 * there, so the cost is one column of width, on every message rather than only the streaming
 * one, because a message that re-wrapped the moment it settled would jump for the same reason.
 */
const CURSOR_COLUMNS = 1

/**
 * What one part of a message draws (epic #201, X1).
 *
 * Keyed by the part's `type`, so the next phase's parts — a tool call, a question, an approval
 * — are an entry here and a compile error until they have one.
 *
 * A renderer returns *lines of spans*, not a string and not a `<Text>`: Markdown needs more
 * than a string (a heading is bold, a table is a box, a code block is a tinted panel) and
 * less than a `<Text>` (the band around a user's message is not its business). The lines come
 * back already fitted to the width the renderer was given — the width of the message itself,
 * since issue #229 took the label away — and the view bands them.
 */
export type PartRenderer = (
  part: MessagePart,
  message: TranscriptMessage,
  layout: RenderLayout,
) => Line[]

export const PART_RENDERERS: Record<MessagePart['type'], PartRenderer> = {
  /**
   * The part's own text. An agent's is Markdown (the whole point of U4); the user's is not,
   * and is drawn as it was typed — `#` in a prompt is a hash, and a prompt pasted out of an
   * editor keeps its own indentation.
   */
  text: (part, message, layout) =>
    message.role === 'agent'
      ? markdownLines(part.text, layout)
      : wrapSpans(textSpans(part.text), layout.width, 'text'),
}

/**
 * One message, laid out: what it is drawn on, and the lines inside it.
 *
 * Everything a reader could argue about — the width the text wraps to, the band a user's
 * message sits on, the mark that stands in for it under `NO_COLOR`, the padding that carries
 * the band to the terminal's edge, the cursor at the end of a streaming reply — is decided
 * here as plain data, so a test can hold it still without a terminal. {@link MessageView} is
 * the drawing of it.
 */
export interface MessageLayout {
  /**
   * What Ink paints behind every line — the name Ink's `backgroundColor` prop wants, or
   * `undefined` for no band at all (an agent's message, and every message under `NO_COLOR`).
   */
  readonly band: string | undefined
  /** The columns a banded line is padded to, so the band reaches the terminal's edge. */
  readonly columns: number
  /** The dim mark drawn on a line above the message where there is no band, or `undefined`. */
  readonly mark: string | undefined
  /** The lines, each already padded to {@link columns} when there is a band. */
  readonly lines: readonly Line[]
}

/**
 * What one message draws at `columns` wide (issue #229).
 *
 * The layout is the whole point of the pass: **everything starts at column 0.** There is no
 * `you › ` / `agent › ` label and no hanging indent under one, so selecting the transcript and
 * pasting it gives the words that were written and nothing else — the prefix and the indent
 * were the two things a copy picked up that nobody had said. What tells the two apart is a
 * *background* instead (X4): a user's message is a full-width band, and an agent's is the
 * terminal's own background, which is what the transcript has always been drawn on.
 *
 * Under `NO_COLOR` there is no band — colour is off, and the band is colour — so a user's
 * message gets a dim `›` on a line of its own above it instead. A mark and not a prefix:
 * line-anchored decoration is something a reader can leave out of a selection, where a
 * character in front of every line never is.
 *
 * A **blank line** is drawn below a user's message, and above it too when nothing above has
 * already set it off — so the band never runs into the message on either side of it. The lines
 * are the message's own rather than the transcript's, for the reason the separator has always
 * been (`transcript-view.tsx`): a message settles into `<Static>` as one write, and a blank
 * line rendered beside it would be written twice, once while it was live and again when it
 * settled. The blanks are *outside* the band; a blank line *inside* the message (a prompt with
 * a paragraph break in it) is padded to the full width and so is part of it.
 */
export function messageLayout(
  message: TranscriptMessage,
  columns: number,
  theme: TerminalTheme,
): MessageLayout {
  const trail = trailing(message)
  // The cursor (or a `(queued)` note) goes on the last line, so the *content* has to leave the
  // room for it — otherwise the mark is what the terminal wraps.
  const reserved = Math.max(CURSOR_COLUMNS, spanWidth(trail))
  const layout: RenderLayout = { width: Math.max(1, columns - reserved), theme }
  const body = message.parts.flatMap((part) => PART_RENDERERS[part.type](part, message, layout))
  const band = message.role === 'user' ? messageBand(theme) : undefined

  const lines = body.map((line, index) => {
    const spans: Span[] = [...line, ...(index === body.length - 1 ? trail : [])]
    // A line with nothing in it is not a line at all to Ink — a text node with no children
    // has no height — so a blank line between two blocks is drawn as one space. Ink trims
    // what trails off the end of a line, so a space renders as the blank line it is.
    const drawn = spans.length === 0 ? [{ text: ' ' }] : spans
    return band === undefined ? drawn : [...drawn, ...bandPadding(drawn, columns)]
  })

  return {
    band,
    columns,
    mark: band === undefined && message.role === 'user' ? USER_MARK : undefined,
    lines,
  }
}

/** The spaces that carry a banded line out to the terminal's edge. */
function bandPadding(spans: readonly Span[], columns: number): Span[] {
  const missing = Math.max(0, columns - spanWidth(spans))
  return missing === 0 ? [] : [{ text: ' '.repeat(missing) }]
}

/**
 * One message of the transcript, at column 0.
 *
 * The width is the terminal's, read here rather than handed down, because that is what makes
 * `<Static>` behave the way X2 asks: a settled message is drawn once, at the width the
 * terminal had *then*, and Ink never replays it — so a resize re-wraps the reply being
 * streamed and leaves the scrollback alone, which is exactly the old output not reflowing.
 *
 * Each line is one `<Text>` whose children are the spans: nested `<Text>` nodes are one line
 * of output, where sibling ones in a column would be two. The band is on the spans rather
 * than on the line around them, so it is painted across the padding as well — Ink trims the
 * trailing whitespace off a line, and a background that ended at the last word would be a
 * ragged band.
 *
 * @param props.width how wide the terminal is, when the caller knows better than Ink does —
 * the test seam the frame tests use to draw a message at a width a test can read.
 * @param props.metaLine what the reply cost, as the one dim line under a settled agent
 * message (issue #208). Formatted by `reply-meta.ts`, which is where the rules about
 * durations and tokens live.
 * @param props.blankAbove whether this message is the one that draws the blank line above it.
 * The transcript draws that line itself between two messages that are not user messages, so it
 * is only ever asked for by a user's message — and not by one whose predecessor was a user's
 * message too, whose band already ends in a blank line of its own.
 */
export function MessageView({
  message,
  width,
  metaLine,
  blankAbove,
}: {
  message: TranscriptMessage
  width?: number
  metaLine?: string | undefined
  blankAbove?: boolean | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()

  const columns = width ?? stdout.columns ?? FALLBACK_COLUMNS
  const { band, mark, lines } = messageLayout(message, columns, theme)
  const user = message.role === 'user'

  return (
    <>
      {user && blankAbove === true && <Text> </Text>}
      {mark !== undefined && <Text dimColor>{mark}</Text>}
      {lines.map((line, index) => (
        // A message's lines have no identity of their own; their order is the identity.
        <Text key={index}>
          {line.map((span, position) => (
            // Same here: a span has no identity, its position in the line is it.
            <Text key={position} {...textProps(span, theme, band, message.pending)}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
      {metaLine !== undefined && (
        // Under the reply and at column 0 with it, so the metadata reads as belonging to the
        // message above rather than as a line of its own — and so a copy of the reply keeps
        // the reply's own words and not a footnote about them. Dim: it is what the reply
        // cost, not something the model said.
        <Text dimColor>{metaLine}</Text>
      )}
      {user && <Text> </Text>}
    </>
  )
}

/** The two marks a message still on the move carries at its end. */
function trailing(message: TranscriptMessage): Span[] {
  const spans: Span[] = []
  if (message.streaming) spans.push({ text: STREAM_CURSOR })
  if (message.pending) spans.push({ text: ' (queued)', dim: true })
  return spans
}

/**
 * A span, as Ink's `<Text>` props.
 *
 * The two theme decisions land here: a colour is dropped entirely when `NO_COLOR` asked for
 * none (`color` false), and a background is painted span by span, which is what carries it over
 * the padding Ink would otherwise trim away.
 *
 * A background is either the message's own band — a user's message, decided once for the whole
 * message — or the span's, which is how a code block's panel travels with the lines it covers
 * (#231). The two never meet: a user's message is not Markdown, so its parts carry no panel.
 */
function textProps(
  span: Span,
  theme: TerminalTheme,
  band: string | undefined,
  pending: boolean,
): {
  color?: string | undefined
  backgroundColor?: string | undefined
  bold?: boolean | undefined
  italic?: boolean | undefined
  underline?: boolean | undefined
  strikethrough?: boolean | undefined
  dimColor?: boolean | undefined
} {
  return {
    color: paint(theme, span.color),
    backgroundColor: span.background ?? band,
    bold: span.bold,
    italic: span.italic,
    underline: span.underline,
    strikethrough: span.strikethrough,
    // A queued message is dimmed whole; a span that asked to be dim keeps it either way.
    dimColor: span.dim ?? pending,
  }
}
