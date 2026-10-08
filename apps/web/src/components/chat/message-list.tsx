import type { TranscriptMessage } from '@openharness/client'
import { ArrowDown, MessagesSquare } from 'lucide-react'

import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import type { ModelNameLookup } from '../../lib/models'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { MessageItem } from './message-item'
import { previousReplyModels } from './message-meta'
import { WorkingRow, type WorkingState } from './working-row'

/**
 * The conversation.
 *
 * New content keeps the view pinned to the bottom — unless the reader has scrolled up, in
 * which case nothing moves and a "jump to latest" button appears instead. Deltas and new
 * messages both count as content: the hook watches the message count and the length of the
 * text being streamed.
 *
 * The two states a conversation is briefly in are drawn rather than described (epic #201,
 * U10): history that has not arrived is a few skeleton bubbles in the shape of the messages
 * they will become, an empty chat is a designed invitation, and a turn in flight is the
 * {@link WorkingRow} at the foot — in the same scroll column, so it moves with the transcript
 * and stays where the reply is about to appear.
 *
 * It is also the one component that can answer the question a single message cannot (#212):
 * what the reply *before* this one ran on, so the meta line names a model only when it changed.
 * That is read off the list here and handed down, rather than carried out of the map.
 *
 * Edit and resend (#238) is offered on **every** message the reader wrote, not just the last:
 * sending one rewinds the session to it, so the edit is what the conversation continues from.
 */
export function MessageList({
  messages,
  loading,
  nameOf,
  working = null,
  onEdit,
  editDisabled = false,
}: {
  messages: readonly TranscriptMessage[]
  loading: boolean
  /** The catalog lookup for a model-change marker's display name. */
  nameOf?: ModelNameLookup | undefined
  /** The state row at the foot of the transcript, or `null` for none ({@link workingState}). */
  working?: WorkingState | null
  /** Rewrite a message the reader wrote (#238): its text goes back in the composer, and
   *  sending it rewinds the session to that message. */
  onEdit?: ((message: TranscriptMessage) => void) | undefined
  /** Whether rewriting is unavailable right now — the agent is working (#238). */
  editDisabled?: boolean
}) {
  const last = messages.at(-1)
  const { ref, onScroll, isStuck, scrollToLatest } = useStickToBottom(
    `${messages.length}:${last?.text.length ?? 0}`,
  )

  // What each reply's meta line compares its model against (#212). The list is the only place
  // that has the neighbouring replies, so it is computed here rather than guessed at in the
  // item; {@link previousReplyModels} keeps the rule itself out of this component.
  const previousModels = previousReplyModels(messages)

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        className="h-full overflow-y-auto px-4 py-6"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-block">
          {messages.length === 0 ? (
            loading ? (
              <TranscriptSkeleton />
            ) : (
              <EmptyConversation />
            )
          ) : (
            messages.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                nameOf={nameOf}
                previousModel={previousModels[index]}
                editDisabled={editDisabled}
                onEdit={
                  message.role === 'user' && onEdit !== undefined
                    ? () => {
                        onEdit(message)
                      }
                    : undefined
                }
              />
            ))
          )}
          {working === null ? null : <WorkingRow state={working} />}
        </div>
      </div>

      {isStuck ? null : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={scrollToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-popover"
        >
          <ArrowDown aria-hidden="true" />
          Jump to latest
        </Button>
      )}
    </div>
  )
}

/**
 * The history that has not arrived yet, in the shape it will arrive in.
 *
 * Alternating alignment and a short/long pair of widths, so the placeholder reads as a
 * conversation rather than as four bars. One label for the group — a screen reader should hear
 * "Loading the conversation" once, not once per bubble.
 */
function TranscriptSkeleton() {
  return (
    <div data-slot="transcript-skeleton" className="flex flex-col gap-block">
      <Skeleton label="Loading the conversation" className="h-16 w-3/5 self-end rounded-2xl" />
      <Skeleton className="h-32 w-11/12 rounded-2xl" />
      <Skeleton className="h-12 w-1/3 self-end rounded-2xl" />
    </div>
  )
}

/** A chat with nothing in it yet: one line, and an invitation rather than an instruction. */
function EmptyConversation() {
  return (
    <div className="flex flex-col items-center gap-inline py-12 text-center">
      <MessagesSquare aria-hidden="true" className="size-5 text-muted-foreground/70" />
      <p className="text-sm text-muted-foreground">Say something to start the conversation.</p>
    </div>
  )
}
