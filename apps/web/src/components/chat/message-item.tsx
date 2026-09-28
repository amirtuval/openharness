import type { TranscriptMessage } from '@openharness/client'

import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Markdown } from './markdown'

/**
 * One message: the user's right, the agent's left, markdown for the agent.
 *
 * The `data-*` attributes are the transcript's state made visible — `data-streaming` while a
 * reply is still arriving as deltas, `data-pending` for a message the brain has not reached
 * yet (a steering message waiting its turn). The tests read them; a stylesheet could too.
 */
export function MessageItem({ message }: { message: TranscriptMessage }) {
  const isUser = message.role === 'user'

  return (
    <article
      data-role={message.role}
      data-streaming={message.streaming}
      data-pending={message.pending}
      className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}
    >
      <div
        className={cn(
          'max-w-[85%] min-w-0 rounded-lg px-3.5 py-2.5',
          isUser ? 'bg-secondary text-secondary-foreground' : 'text-foreground',
        )}
      >
        {isUser ? (
          <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
        ) : (
          <Markdown text={message.text} />
        )}
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
