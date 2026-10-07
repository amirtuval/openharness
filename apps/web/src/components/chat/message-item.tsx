import type { MessagePart, TranscriptMessage } from '@openharness/client'
import { Fragment, type ReactNode } from 'react'

import { modelLabel } from '../../lib/format'
import type { ModelNameLookup } from '../../lib/models'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Markdown } from './markdown'
import { MessageActions } from './message-actions'
import { MessageMeta } from './message-meta'

/**
 * How one part of a message is drawn (epic #201, X1).
 *
 * Keyed by the part's `type`, so the next phase's parts — a tool call, a question, an approval
 * — are an entry here and a compile error until they have one. Every entry is an inline
 * fragment: the message's own wrapper, badge and caret stay in {@link MessageItem}.
 */
type PartRenderer = (props: { part: MessagePart; message: TranscriptMessage }) => ReactNode

const PART_RENDERERS: Record<MessagePart['type'], PartRenderer> = {
  // The user's text is plain, the agent's is markdown. `message.text` is these parts joined,
  // and today every message carries exactly one — the block the server stored.
  text: ({ part, message }) =>
    message.role === 'user' ? (
      <p className="text-sm break-words whitespace-pre-wrap">{part.text}</p>
    ) : (
      <Markdown text={part.text} />
    ),
}

/**
 * One message: the user's right, the agent's left, markdown for the agent.
 *
 * The message is laid out here and its `parts` are drawn by {@link PART_RENDERERS} — a lookup
 * from the part's type to the renderer, so a message that carries more than text renders
 * without this component changing shape.
 *
 * The `data-*` attributes are the transcript's state made visible — `data-streaming` while a
 * reply is still arriving as deltas, `data-pending` for a message the brain has not reached
 * yet (a steering message waiting its turn). The tests read them; a stylesheet could too.
 *
 * A `user.message` that switched the session's model carries `modelChangedTo` (epic #116,
 * U3); the marker above the bubble is what says so — "Switched to Claude Sonnet" — so a
 * reader can see where the conversation changed engines without opening the log.
 *
 * Under the bubble is the message's **foot**: what the reply cost ({@link MessageMeta}, #212)
 * and what can be done with it ({@link MessageActions}, #212). It is one row, and it is part
 * of every message including the user's plain text — which is what keeps the transcript's
 * rhythm even and the action row from moving anything when it appears on hover.
 *
 * `group/message` is what that hover is: the row's opacity is keyed off the whole message, so
 * the actions belong to it rather than to the buttons.
 */
export function MessageItem({
  message,
  nameOf,
  previousModel,
  onEdit,
}: {
  message: TranscriptMessage
  /** The catalog lookup for the marker's display name; the id when the catalog does not know it. */
  nameOf?: ModelNameLookup | undefined
  /** The previous reply's model, so the meta line names one only when it changed (#212). */
  previousModel?: string | undefined
  /** Pre-fill the composer with this message — given for the last user message, and no other. */
  onEdit?: (() => void) | undefined
}) {
  const isUser = message.role === 'user'

  // A reply that has started streaming but has drawn nothing yet is the empty preview the
  // working row at the foot of the transcript already speaks for (#212): drawn here as well,
  // it is an empty agent bubble with a bare caret in it, saying the same thing twice with a
  // grey block. The first delta brings the message — and the caret, which is then the only
  // thing that says the reply is *still* arriving.
  if (!isUser && message.streaming && message.text.trim() === '') {
    return null
  }

  return (
    <article
      data-role={message.role}
      data-streaming={message.streaming}
      data-pending={message.pending}
      className={cn(
        'group/message flex w-full flex-col gap-0.5',
        isUser ? 'items-end' : 'items-start',
      )}
    >
      {message.modelChangedTo === undefined ? null : (
        <p data-slot="model-change" className="self-center text-xs text-muted-foreground">
          Switched to {modelLabel(message.modelChangedTo, nameOf)}
        </p>
      )}
      <div
        className={cn(
          'max-w-[85%] min-w-0 rounded-lg px-3.5 py-2.5',
          isUser ? 'bg-secondary text-secondary-foreground' : 'text-foreground',
        )}
      >
        {message.parts.map((part, index) => (
          // A part carries no id of its own: its place in the message is its identity.
          <Fragment key={index}>{PART_RENDERERS[part.type]({ part, message })}</Fragment>
        ))}
        {message.streaming ? <StreamingCaret /> : null}
      </div>
      {message.pending ? (
        <Badge variant="outline" className="text-2xs text-muted-foreground">
          queued
        </Badge>
      ) : null}
      {/* The row is always the same height, whether or not anything is in it: a message that
          has neither metadata nor actions would otherwise be a shorter message. */}
      <div
        data-slot="message-foot"
        className="flex h-6 max-w-full min-w-0 items-center gap-control"
      >
        {isUser ? null : (
          <MessageMeta message={message} previousModel={previousModel} nameOf={nameOf} />
        )}
        <MessageActions text={message.text} onEdit={onEdit} />
      </div>
    </article>
  )
}

/** The block cursor that shows a reply is still arriving. */
function StreamingCaret() {
  return (
    <>
      <span
        aria-hidden="true"
        className="mt-1 inline-block h-3.5 w-1.5 animate-pulse rounded-xs bg-foreground/60 align-text-bottom"
      />
      <span className="sr-only">The assistant is replying…</span>
    </>
  )
}
