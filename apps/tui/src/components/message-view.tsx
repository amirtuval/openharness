import type { MessagePart, TranscriptMessage } from '@openharness/client'
import { Text } from 'ink'

/** The word in front of each message, and the colour the whole line takes. */
const STYLE = {
  user: { label: 'you', color: 'cyan' },
  agent: { label: 'agent', color: undefined },
} as const

/** The block that marks where a reply currently ends, while it is still arriving. */
const STREAM_CURSOR = '▌'

/**
 * What one part of a message contributes to the line (epic #201, X1).
 *
 * Keyed by the part's `type`, so the next phase's parts — a tool call, a question, an approval
 * — are an entry here and a compile error until they have one. A renderer returns the *text*
 * its part draws, not a `<Text>`: the message's line layout, its label, its indent and its
 * cursor belong to {@link MessageView}, and splitting one line into several `<Text>` nodes is
 * what the note below warns against.
 */
type PartRenderer = (part: MessagePart, message: TranscriptMessage) => string

const PART_RENDERERS: Record<MessagePart['type'], PartRenderer> = {
  // The part's own text, verbatim. `message.text` is these joined, and today every message
  // carries exactly one — the block the server stored.
  text: (part) => part.text,
}

/**
 * One message of the transcript.
 *
 * The message is laid out here and its `parts` are drawn by {@link PART_RENDERERS} — a lookup
 * from the part's type to the renderer, so a message that carries more than text renders
 * without this component changing shape.
 *
 * Each line is a single `<Text>` so that the line's words stay together in the rendered
 * output: colouring a label and the text beside it separately would interleave escape
 * sequences between them, which breaks `expect(frame).toContain('you › hello')` in a test
 * and looks no different on screen.
 */
export function MessageView({ message }: { message: TranscriptMessage }) {
  const style = STYLE[message.role]
  const indent = ' '.repeat(style.label.length + 3)
  const text = message.parts.map((part) => PART_RENDERERS[part.type](part, message)).join('')
  const lines = text.split('\n')
  const last = lines.length - 1

  return (
    <>
      {lines.map((line, index) => {
        const prefix = index === 0 ? `${style.label} › ` : indent
        const cursor = message.streaming && index === last ? STREAM_CURSOR : ''
        const queued = message.pending && index === last ? ' (queued)' : ''

        return (
          // A message's lines have no identity of their own; their order is the identity.
          <Text key={index} color={style.color} dimColor={message.pending}>
            {`${prefix}${line}${cursor}${queued}`}
          </Text>
        )
      })}
    </>
  )
}
