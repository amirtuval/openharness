import type { TranscriptMessage } from '@openharness/client'
import { Text } from 'ink'

/** The word in front of each message, and the colour the whole line takes. */
const STYLE = {
  user: { label: 'you', color: 'cyan' },
  agent: { label: 'agent', color: undefined },
} as const

/** The block that marks where a reply currently ends, while it is still arriving. */
const STREAM_CURSOR = '▌'

/**
 * One message of the transcript.
 *
 * Each line is a single `<Text>` so that the line's words stay together in the rendered
 * output: colouring a label and the text beside it separately would interleave escape
 * sequences between them, which breaks `expect(frame).toContain('you › hello')` in a test
 * and looks no different on screen.
 */
export function MessageView({ message }: { message: TranscriptMessage }) {
  const style = STYLE[message.role]
  const indent = ' '.repeat(style.label.length + 3)
  const lines = message.text.split('\n')
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
