import type { TranscriptMessage } from '@openharness/client'
import { Static } from 'ink'

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
 */
export function TranscriptView({ messages }: { messages: readonly TranscriptMessage[] }) {
  const firstLive = messages.findIndex((message) => message.pending || message.streaming)
  const settled = firstLive === -1 ? messages : messages.slice(0, firstLive)
  const live = firstLive === -1 ? [] : messages.slice(firstLive)

  return (
    <>
      <Static items={[...settled]}>
        {(message) => <MessageView key={message.id} message={message} />}
      </Static>
      {live.map((message) => (
        <MessageView key={message.id} message={message} />
      ))}
    </>
  )
}
