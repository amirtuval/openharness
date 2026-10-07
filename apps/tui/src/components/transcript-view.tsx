import type { TranscriptMessage } from '@openharness/client'
import { Static, Text } from 'ink'
import { Fragment } from 'react'

import { MessageView } from './message-view'
import { replyMetaLines } from './reply-meta'

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
 * **A reply whose metadata is still coming is not settled either** (issue #208, epic #201
 * X2). A reply's tokens and duration arrive with its `span.model_request_end`, which the
 * server writes *after* the reply itself, so the message settles before its metadata does —
 * and a settled message is written once and never redrawn, so a metadata line drawn under it
 * would never appear. `holdLive` is the id of the reply that is still waiting for its span
 * end (`ChatViewState.awaitingMetaId`); holding it in the live area is what lets the line
 * arrive with the message rather than after the scrollback has closed over it. The hold ends
 * when the span end lands or the turn goes idle — whichever comes first, because an idle
 * empties the transcript's pending requests — so a log that has no span events at all (a
 * session written before epic #201) still settles, one turn later.
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
  currentModel,
  holdLive,
}: {
  readonly messages: readonly TranscriptMessage[]
  /** How wide the terminal is; the tests draw at a width they can read (see `MessageView`). */
  readonly width?: number | undefined
  /** The model the session runs, for the per-reply metadata lines (issue #208). */
  readonly currentModel?: string | undefined
  /** The reply to keep live until its metadata arrives (issue #208); usually the last one. */
  readonly holdLive?: string | undefined
}) {
  const firstLive = messages.findIndex((message) => isLive(message, holdLive))
  const settled = firstLive === -1 ? messages : messages.slice(0, firstLive)
  const live = firstLive === -1 ? [] : messages.slice(firstLive)
  const metaLines = replyMetaLines(messages, currentModel)

  return (
    <>
      <Static items={[...settled]}>
        {(message, index) => (
          <Fragment key={message.id}>
            {index > 0 && <Text> </Text>}
            <MessageView message={message} width={width} metaLine={metaLines.get(message.id)} />
          </Fragment>
        )}
      </Static>
      {live.map((message, index) => (
        <Fragment key={message.id}>
          {firstLive + index > 0 && <Text> </Text>}
          <MessageView message={message} width={width} metaLine={metaLines.get(message.id)} />
        </Fragment>
      ))}
    </>
  )
}

/** Whether a message may still change on screen, and so belongs in the live area. */
function isLive(message: TranscriptMessage, holdLive: string | undefined): boolean {
  return message.pending || message.streaming || message.id === holdLive
}
