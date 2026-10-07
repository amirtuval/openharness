import type { MessagePart, TranscriptMessage } from '@openharness/client'
import { Text, useStdout } from 'ink'
import stringWidth from 'string-width'

import { markdownLines, type RenderLayout } from '../markdown/render'
import { PALETTE, paint, type TerminalTheme } from '../markdown/theme'
import { textSpans, wrapSpans, type Line, type Span } from '../markdown/text'
import { useTerminalTheme } from './theme'

/** The word in front of each message, and the colour the label takes. */
const STYLE = {
  user: { label: 'you', color: PALETTE.user },
  agent: { label: 'agent', color: PALETTE.agent },
} as const

/** The block that marks where a reply currently ends, while it is still arriving. */
const STREAM_CURSOR = '▌'

/** What the terminal falls back to when it will not say how wide it is. */
const FALLBACK_COLUMNS = 80

/**
 * What one part of a message draws (epic #201, X1).
 *
 * Keyed by the part's `type`, so the next phase's parts — a tool call, a question, an approval
 * — are an entry here and a compile error until they have one.
 *
 * A renderer returns *lines of spans*, not a string and not a `<Text>`: Markdown needs more
 * than a string (a heading is bold, a table is a box, a code block is a frame) and less than a
 * `<Text>` (the message's own label, indent and cursor are not its business). The lines come
 * back already fitted to the width the renderer was given, so the view can put the same prefix
 * — the label, or the indent under it — in front of every one of them, which is how a wrapped
 * line stays under the text it belongs to.
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
 * One message of the transcript.
 *
 * The message is laid out here — the `agent › ` label, the indent under it, the block cursor
 * while a reply streams, the `(queued)` note — and its `parts` are drawn by
 * {@link PART_RENDERERS}, a lookup from the part's type to the renderer, so a message that
 * carries more than text renders without this component changing shape.
 *
 * The width is the terminal's, read here rather than handed down, because that is what makes
 * `<Static>` behave the way X2 asks: a settled message is drawn once, at the width the
 * terminal had *then*, and Ink never replays it — so a resize re-wraps the reply being
 * streamed and leaves the scrollback alone, which is exactly the old output not reflowing.
 *
 * Each line is one `<Text>` whose children are the spans: nested `<Text>` nodes are one line
 * of output, where sibling ones in a column would be two. That is what `expect(frame).toContain
 * ('you › hello')` in the tests is resting on — the label and the text beside it have to
 * arrive as one line, whatever colours the two of them are in.
 *
 * @param props.width how wide the terminal is, when the caller knows better than Ink does —
 * the test seam the frame tests use to draw a message at a width a test can read.
 * @param props.metaLine what the reply cost, as the one dim line under a settled agent
 * message (issue #208). Formatted by `reply-meta.ts`, which is where the rules about
 * durations and tokens live; it is drawn here because the indent under the `agent › ` label
 * is this component's business, and because the line has to be written in the same `<Static>`
 * pass as the message it belongs to.
 */
export function MessageView({
  message,
  width,
  metaLine,
}: {
  message: TranscriptMessage
  width?: number
  metaLine?: string | undefined
}) {
  const theme = useTerminalTheme()
  const { stdout } = useStdout()
  const style = STYLE[message.role]

  const columns = width ?? stdout.columns ?? FALLBACK_COLUMNS
  const prefix = `${style.label} › `
  const prefixWidth = stringWidth(prefix)
  const indent = ' '.repeat(prefixWidth)
  // The user's own words are the one thing drawn in the label's colour: an agent's reply
  // takes its colours from what it is made of, and its label is what says who is talking.
  const body = message.role === 'user' ? style.color : undefined

  const layout: RenderLayout = { width: Math.max(1, columns - prefixWidth), theme }
  const lines = message.parts.flatMap((part) => PART_RENDERERS[part.type](part, message, layout))
  const last = lines.length - 1

  return (
    <>
      {lines.map((line, index) => {
        // A blank line between two blocks still carries the prefix: Ink gives a text node
        // with nothing in it no height, so a line with no spans of *any* kind is a line that
        // is not there — the blank line between two paragraphs would close up. The indent is
        // the smallest thing that keeps it, and is what an empty line was drawn as before
        // this view had spans at all.
        const spans: readonly Span[] = [
          {
            text: index === 0 ? prefix : indent,
            color: paint(theme, style.color),
            // The label is bold; the indent under it is spaces, and bolding those is an
            // escape sequence that draws nothing at all.
            bold: index === 0,
          },
          ...line,
          ...(index === last ? trailing(message, theme, style.color) : []),
        ]

        return (
          // A message's lines have no identity of their own; their order is the identity.
          <Text key={index}>
            {spans.map((span, position) => (
              // Same here: a span has no identity, its position in the line is it.
              <Text key={position} {...textProps(span, theme, message.pending, body)}>
                {span.text}
              </Text>
            ))}
          </Text>
        )
      })}
      {metaLine !== undefined && (
        // Under the reply, and under the same indent as its text, so the metadata reads as
        // belonging to the message above it rather than as a line of its own. Dim: it is a
        // footnote about the reply, not something the model said.
        <Text dimColor>{`${indent}${metaLine}`}</Text>
      )}
    </>
  )
}

/** The two marks a message still on the move carries at its end. */
function trailing(message: TranscriptMessage, theme: TerminalTheme, color: string): Span[] {
  const spans: Span[] = []
  if (message.streaming) spans.push({ text: STREAM_CURSOR, color: paint(theme, color) })
  if (message.pending) spans.push({ text: ' (queued)', dim: true })
  return spans
}

/**
 * A span, as Ink's `<Text>` props.
 *
 * The two theme decisions land here: a colour is dropped entirely when `NO_COLOR` asked for
 * none (`color` false), and a body span with no colour of its own takes the message's — which
 * is how a user's line is all one colour while an agent's is not.
 */
function textProps(
  span: Span,
  theme: TerminalTheme,
  pending: boolean,
  body: string | undefined,
): {
  color?: string | undefined
  bold?: boolean | undefined
  italic?: boolean | undefined
  underline?: boolean | undefined
  strikethrough?: boolean | undefined
  dimColor?: boolean | undefined
} {
  return {
    color: theme.color ? (span.color ?? body) : undefined,
    bold: span.bold,
    italic: span.italic,
    underline: span.underline,
    strikethrough: span.strikethrough,
    // A queued message is dimmed whole; a span that asked to be dim keeps it either way.
    dimColor: span.dim ?? pending,
  }
}
