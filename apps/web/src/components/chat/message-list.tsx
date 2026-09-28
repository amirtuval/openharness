import type { TranscriptMessage } from '@openharness/client'
import { ArrowDown } from 'lucide-react'

import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import { Button } from '../ui/button'
import { MessageItem } from './message-item'

/**
 * The conversation.
 *
 * New content keeps the view pinned to the bottom — unless the reader has scrolled up, in
 * which case nothing moves and a "jump to latest" button appears instead. Deltas and new
 * messages both count as content: the hook watches the message count and the length of the
 * text being streamed.
 */
export function MessageList({
  messages,
  loading,
}: {
  messages: readonly TranscriptMessage[]
  loading: boolean
}) {
  const last = messages.at(-1)
  const { ref, onScroll, isStuck, scrollToLatest } = useStickToBottom(
    `${messages.length}:${last?.text.length ?? 0}`,
  )

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        className="h-full overflow-y-auto px-4 py-6"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {messages.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {loading ? 'Loading the conversation…' : 'Say something to start the conversation.'}
            </p>
          ) : (
            messages.map((message) => <MessageItem key={message.id} message={message} />)
          )}
        </div>
      </div>

      {isStuck ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={scrollToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-md"
        >
          <ArrowDown aria-hidden="true" />
          Jump to latest
        </Button>
      )}
    </div>
  )
}
