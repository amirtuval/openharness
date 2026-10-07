import type { TranscriptMessage } from '@openharness/client'
import { Static, Text } from 'ink'
import { Fragment } from 'react'

import { MessageView } from './message-view'

/**
 * The conversation: what is settled goes through Ink's `<Static>`, what is still moving
 * stays in the live area.
 *
 * This is what keeps a streamed reply from repainting the whole screen at every delta. Ink
 * writes static output once and never redraws it; the live area below is the only thing the
 * render loop touches. The split is a *prefix* — everything before the first unsettled
 * message is static, everything from it on is live — so the live area can never end up
 * above a message that is already committed to the scrollback.
 *
 * A message is settled when the brain has taken it (`pending: false`) and it is not being
 * previewed (`streaming: false`); both flags change over the life of a message, and both
 * mean the text on screen may still change.
 *
 * Messages are separated by one blank line, and the blank line is part of the *following*
 * message's static output rather than a thing of its own: a reply that streams arrives as one
 * static write, and a separator rendered separately would be written twice — once when the
 * next message was still live and again when it settled. The line is a single space and not
 * an empty `<Text>`: Ink gives a text node with nothing in it no height at all, so an empty
 * one is not a blank line, it is no line.
 */
export function TranscriptView({
  messages,
  width,
}: {
  readonly messages: readonly TranscriptMessage[]
  /** How wide the terminal is; the tests draw at a width they can read (see `MessageView`). */
  readonly width?: number | undefined
}) {
  const firstLive = messages.findIndex((message) => message.pending || message.streaming)
  const settled = firstLive === -1 ? messages : messages.slice(0, firstLive)
  const live = firstLive === -1 ? [] : messages.slice(firstLive)

  return (
    <>
      <Static items={[...settled]}>
        {(message, index) => (
          <Fragment key={message.id}>
            {index > 0 && <Text> </Text>}
            <MessageView message={message} width={width} />
          </Fragment>
        )}
      </Static>
      {live.map((message, index) => (
        <Fragment key={message.id}>
          {firstLive + index > 0 && <Text> </Text>}
          <MessageView message={message} width={width} />
        </Fragment>
      ))}
    </>
  )
}
