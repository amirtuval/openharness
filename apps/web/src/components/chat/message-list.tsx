import type {
  ModelPriceLookup,
  PendingCall,
  TranscriptConfirmation,
  TranscriptEntry,
  TranscriptManualCompaction,
  TranscriptMessage,
  TranscriptSummary,
  TranscriptToolCall,
  TranscriptTruncation,
} from '@openharness/client'
import {
  approvalConfirmations,
  confirmationSummary,
  pendingCalls,
  transcriptEntries,
} from '@openharness/client'
import type { UserToolConfirmationEventInput } from '@openharness/protocol'
import { ArrowDown, MessagesSquare, ShieldQuestion } from 'lucide-react'

import { useStickToBottom } from '../../hooks/use-stick-to-bottom'
import type { ModelNameLookup } from '../../lib/models'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import { ApprovalPrompt } from './approval-prompt'
import { AskUserForm } from './ask-user-form'
import { CompactionNotice } from './compaction-notice'
import { MessageItem } from './message-item'
import { previousReplyModels } from './message-meta'
import { SummaryDivider } from './summary-divider'
import { ToolCallLine } from './tool-call'
import { ToolNotices } from './tool-notices'
import { TruncationNotice } from './truncation-notice'
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
 * **The transcript is messages *and* summary dividers** (epic #277, K10; #280). A divider is a
 * mark in the conversation, not a message: it draws where the history it covers ends, and the
 * history above it stays exactly where it was. The order comes from `transcriptEntries` in
 * `@openharness/client`, so the web and the terminal put the divider in the same place. Two
 * other compaction states sit at the foot, where the newest message is: the truncation notice
 * — the reader's own message was shortened for the model, and what a manual compaction came
 * to (#283) — above the working row.
 *
 * Edit and resend (#238) is offered on **every** message the reader wrote, not just the last:
 * sending one rewinds the session to it, so the edit is what the conversation continues from.
 */
export function MessageList({
  messages,
  summaries = [],
  toolCalls = [],
  truncation = null,
  compaction = null,
  stepLimit = null,
  toolsUnsupported = false,
  truncatedResults = null,
  clearedResults = null,
  confirmations = [],
  answering = [],
  onRespond,
  loading,
  nameOf,
  costOf,
  working = null,
  onEdit,
  editDisabled = false,
  replacingFrom,
}: {
  messages: readonly TranscriptMessage[]
  /** The summary dividers still in the conversation, in order (epic #277; #280). */
  summaries?: readonly TranscriptSummary[]
  /** The tool calls in the conversation, in order (epic #303, X5; #308). */
  toolCalls?: readonly TranscriptToolCall[]
  /** The newest item a request had to shorten, or `null` (epic #277, K6; #280). */
  truncation?: TranscriptTruncation | null
  /**
   * The manual compaction the log last asked for, or `null` (epic #277, K8; #283): the notice a
   * `nothing_to_summarize` or `failed` outcome is owed.
   */
  compaction?: TranscriptManualCompaction | null
  /** The step-limit notice, or `null` (epic #303, X2; #308). */
  stepLimit?: string | null
  /** Whether the chat's model cannot call tools at all (epic #303, X2; #308). */
  toolsUnsupported?: boolean
  /** What a request shortened a tool result to, or `null` (epic #303, X9; #306; #308). */
  truncatedResults?: string | null
  /** What a request cleared, or `null` (epic #303, X9; #306; #308). */
  clearedResults?: string | null
  /** The reader's decisions about calls that waited on them (epic #303, X6; #309; #310). */
  confirmations?: readonly TranscriptConfirmation[]
  /** The call ids whose confirmation is in flight (epic #303, #310). */
  answering?: readonly string[]
  /**
   * Answer a call that is waiting on the reader (epic #303, #310). Omitted, no prompt is drawn
   * — which is what a read-only view of a conversation (a test, a share) wants.
   */
  onRespond?: ((events: readonly UserToolConfirmationEventInput[]) => void) | undefined
  loading: boolean
  /** The catalog lookup for a model-change marker's display name. */
  nameOf?: ModelNameLookup | undefined
  /** The catalog's prices, for each reply's cost (#247). */
  costOf?: ModelPriceLookup | undefined
  /** The state row at the foot of the transcript, or `null` for none ({@link workingState}). */
  working?: WorkingState | null
  /** Rewrite a message the reader wrote (#238): its text goes back in the composer, and
   *  sending it rewinds the session to that message. */
  onEdit?: ((message: TranscriptMessage) => void) | undefined
  /** Whether rewriting is unavailable right now — the session is not idle (#238). */
  editDisabled?: boolean
  /**
   * The `position` of the message being rewritten (#238), when one is: every message **after**
   * it is about to be replaced — sending the edit rewinds the session to that message — and is
   * drawn as on its way out. The edited message itself stays as it is; its words are in the
   * composer, not gone.
   */
  replacingFrom?: number | undefined
}) {
  const last = messages.at(-1)
  const { ref, onScroll, isStuck, scrollToLatest } = useStickToBottom(
    // The truncation notice is at the foot too (epic #277, K10; #280), and it can arrive on a
    // turn that adds no message at all (a request whose newest item did not change): it counts
    // as content, so a reader who is already at the bottom is shown it rather than being left
    // with it below the fold.
    `${messages.length}:${last?.text.length ?? 0}:${String(toolCalls.length)}:${
      truncation === null ? '' : 'truncated'
    }:${compaction?.outcome ?? ''}`,
  )

  // What each reply's meta line compares its model against (#212). The list is the only place
  // that has the neighbouring replies, so it is computed here rather than guessed at in the
  // item; {@link previousReplyModels} keeps the rule itself out of this component. It is keyed
  // by message, because the entries below are interleaved with the dividers.
  const previous = previousReplyModels(messages)

  // The calls waiting on the reader (epic #303, X6; #310), and the decisions the log already
  // holds for them. A call with a confirmation of its own has been answered and the turn is on
  // its way — that is what makes the prompt survive a reload in the state a live tab shows, and
  // it is also what a bulk answer has to leave alone.
  const pending = pendingCalls(toolCalls)
  const answered = new Set(confirmations.map((confirmation) => confirmation.toolUseId))
  const open = pending.filter((entry) => !answered.has(entry.call.id))
  const openApprovals = open.filter((entry) => entry.kind === 'approval')
  const deciding = new Set(answering)
  const answer = (events: readonly UserToolConfirmationEventInput[]): void => {
    onRespond?.(events)
  }
  /**
   * The prompt one waiting call owes, drawn **under** its own line (epic #303, #310).
   *
   * The call's line is already the tool, with its input behind the disclosure, so the prompt
   * belongs to it rather than to a panel of its own: what is being answered is right above.
   * `null` while the reader is not the one who can answer — a read-only view, or a call whose
   * confirmation is already in the log.
   */
  const promptFor = (call: TranscriptToolCall): React.ReactNode => {
    const entry = open.find((candidate) => candidate.call.id === call.id)
    if (entry === undefined || onRespond === undefined) {
      return null
    }
    return (
      <PendingPrompt
        entry={entry}
        busy={deciding.has(call.id)}
        onRespond={(input) => answer([input])}
      />
    )
  }
  /**
   * The decision a call was answered with, as the row's trailing control (epic #303, #310).
   *
   * The `user.tool_confirmation` is the log's record, so an approved call says **how** it was
   * allowed — "Allowed for this chat", "Always allowed" — where its own result cannot; a
   * denial and an answered question are silent here, because the result the brain wrote
   * already says them.
   */
  const decisionAction = (call: TranscriptToolCall): React.ReactNode => {
    if (deciding.has(call.id)) {
      return (
        <span data-slot="answering" className="text-2xs text-muted-foreground">
          Answering…
        </span>
      )
    }
    const decision = confirmations.find((candidate) => candidate.toolUseId === call.id)
    if (decision === undefined) {
      return undefined
    }
    const summary = confirmationSummary(decision)
    return summary === null ? undefined : (
      <Badge data-slot="tool-decision" variant="outline" className="text-2xs">
        {summary}
      </Badge>
    )
  }
  const previousModels = new Map<string, string | undefined>(
    messages.map((message, index) => [message.id, previous[index]] as [string, string | undefined]),
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
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-block">
          {/* "Empty" is nothing to say **and** nothing done: a call is an entry of its own
              (epic #303, #308), so a transcript that holds one is a conversation whatever the
              messages say — and a transcript that holds neither is the invitation. */}
          {messages.length === 0 && toolCalls.length === 0 ? (
            loading ? (
              <TranscriptSkeleton />
            ) : (
              <EmptyConversation />
            )
          ) : (
            groupToolCalls(transcriptEntries(messages, summaries, toolCalls)).map((entry) =>
              entry.kind === 'group' ? (
                // Several calls in a row are one step's work (epic #303, X5): they are drawn as a
                // tidy block rather than as three full-width lines with gaps between them. The
                // grouping is a rendering decision — the log still holds one call per event.
                <div
                  key={`tools:${String(entry.calls[0]?.position ?? 0)}`}
                  data-slot="tool-group"
                  role="group"
                  aria-label="Tool calls"
                  className="flex w-full flex-col gap-1 rounded-lg border border-dashed px-2 py-1.5"
                >
                  {entry.calls.map((call) => (
                    <div key={call.id} className="flex min-w-0 flex-col">
                      <ToolCallLine call={call} action={decisionAction(call)} />
                      {promptFor(call)}
                    </div>
                  ))}
                </div>
              ) : entry.kind === 'summary' ? (
                <SummaryDivider key={entry.summary.id} summary={entry.summary} />
              ) : entry.kind === 'tool' ? (
                <div key={entry.call.id} className="flex min-w-0 flex-col">
                  <ToolCallLine call={entry.call} action={decisionAction(entry.call)} />
                  {promptFor(entry.call)}
                </div>
              ) : (
                <MessageItem
                  key={entry.message.id}
                  message={entry.message}
                  nameOf={nameOf}
                  costOf={costOf}
                  previousModel={previousModels.get(entry.message.id)}
                  editDisabled={editDisabled}
                  replacing={replacingFrom !== undefined && entry.message.position > replacingFrom}
                  onEdit={
                    entry.message.role === 'user' && onEdit !== undefined
                      ? () => {
                          onEdit(entry.message)
                        }
                      : undefined
                  }
                />
              ),
            )
          )}
          {/* Several approvals at once are answerable together (epic #303, #310) — one event per
              call, in one batch — while a single one is left to its own prompt: a bar over a
              lone call would be a second copy of the same buttons. */}
          {openApprovals.length > 1 && onRespond !== undefined ? (
            <div
              data-slot="pending-bulk"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-2.5 py-2 text-xs"
            >
              <ShieldQuestion aria-hidden="true" className="size-3.5 shrink-0 text-coral-ink" />
              <span className="min-w-0 text-muted-foreground">
                {openApprovals.length} calls are waiting on you.
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {/* "Allow all" is the **once** approval for each call: answering several at once
                    must not hand out a remembered permission nobody asked for, so the two
                    remembered choices stay every call's own decision. */}
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  disabled={answering.length > 0}
                  onClick={() =>
                    answer(
                      approvalConfirmations(
                        openApprovals.map((entry) => entry.call),
                        'allow-once',
                      ),
                    )
                  }
                >
                  Allow all
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="text-destructive"
                  disabled={answering.length > 0}
                  onClick={() =>
                    answer(
                      approvalConfirmations(
                        openApprovals.map((entry) => entry.call),
                        'deny',
                      ),
                    )
                  }
                >
                  Deny all
                </Button>
              </div>
            </div>
          ) : null}
          {compaction === null ? null : <CompactionNotice compaction={compaction} />}
          <ToolNotices
            stepLimit={stepLimit}
            unsupported={toolsUnsupported}
            truncated={truncatedResults}
            cleared={clearedResults}
          />
          {truncation === null ? null : <TruncationNotice truncation={truncation} />}
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

/**
 * The prompt one waiting call owes (epic #303, X6; #310): an approval's four choices, or an
 * `ask_user` call's questions.
 *
 * An `ask_user` call whose input is not a well-formed set of questions draws nothing: the brain
 * answers such a call with an `is_error` result rather than pausing on it, so a form here would
 * be a question nobody could have asked.
 */
function PendingPrompt({
  entry,
  busy,
  onRespond,
}: {
  entry: PendingCall
  busy: boolean
  onRespond: (input: UserToolConfirmationEventInput) => void
}) {
  if (entry.kind === 'approval') {
    return <ApprovalPrompt call={entry.call} busy={busy} onRespond={onRespond} />
  }
  if (entry.questions.length === 0) {
    return null
  }
  return (
    <AskUserForm call={entry.call} questions={entry.questions} busy={busy} onRespond={onRespond} />
  )
}

/** One row of the transcript as this component draws it: an entry, or a run of tool calls. */
type RenderEntry =
  TranscriptEntry | { readonly kind: 'group'; readonly calls: readonly TranscriptToolCall[] }

/**
 * Collapse runs of consecutive tool calls into one group (epic #303, X5; issue #308).
 *
 * A step that calls four tools is four events in the log — one line each, in position order —
 * but it reads as one piece of work, so consecutive calls are drawn inside a single block. A run
 * of one is left as the bare line it already is: a box around a single call is noise. The
 * grouping is a rendering decision and nothing else — the order, the ids and the statuses come
 * from the entries the client merged, and a message or a divider between two calls starts a
 * fresh group.
 */
function groupToolCalls(entries: readonly TranscriptEntry[]): readonly RenderEntry[] {
  const grouped: RenderEntry[] = []
  let run: TranscriptToolCall[] = []
  const flush = (): void => {
    if (run.length === 1) {
      grouped.push({ kind: 'tool', call: run[0] as TranscriptToolCall })
    } else if (run.length > 1) {
      grouped.push({ kind: 'group', calls: run })
    }
    run = []
  }
  for (const entry of entries) {
    if (entry.kind === 'tool') {
      run.push(entry.call)
      continue
    }
    flush()
    grouped.push(entry)
  }
  flush()
  return grouped
}
