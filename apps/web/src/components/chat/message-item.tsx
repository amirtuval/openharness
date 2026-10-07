import type { MessagePart, TranscriptMessage } from '@openharness/client'
import { Fragment, type ReactNode } from 'react'

import { modelLabel } from '../../lib/format'
import type { ModelNameLookup } from '../../lib/models'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Markdown } from './markdown'

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
 */
export function MessageItem({
  message,
  nameOf,
}: {
  message: TranscriptMessage
  /** The catalog lookup for the marker's display name; the id when the catalog does not know it. */
  nameOf?: ModelNameLookup | undefined
}) {
  const isUser = message.role === 'user'

  return (
    <article
      data-role={message.role}
      data-streaming={message.streaming}
      data-pending={message.pending}
      className={cn('flex w-full flex-col gap-1', isUser ? 'items-end' : 'items-start')}
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
        <Badge variant="outline" className="text-[0.65rem] text-muted-foreground">
          queued
        </Badge>
      ) : null}
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
