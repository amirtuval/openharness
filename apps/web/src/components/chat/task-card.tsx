import {
  taskActivityLabel,
  taskCardStatus,
  type ModelPriceLookup,
  type TaskCard,
  type TaskCardStatus,
} from '@openharness/client'
import type { TotalCost } from '@openharness/protocol'
import { Check, ChevronRight, CircleAlert, CircleSlash, Loader2, Pause, Square } from 'lucide-react'

import { useTaskActivity } from '../../hooks/use-task-activity'
import { formatCostTotal, formatCount } from '../../lib/format'
import { taskIsLive, taskMessageLabel, taskTokens, taskTypeLabel } from '../../lib/tasks'
import { chatHash } from '../../lib/router'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

/**
 * One background task, as the card its parent's conversation draws (epic #340, decision S9;
 * issue #346).
 *
 * A chat can hand work to a helper, and the parent's log is the whole of the card: the task's
 * type and description, its status, what the parent and the child said to each other, and what it
 * last produced (all of it `selectTasks`, folded from `session.task_started`, `task_status` and
 * `task_notification`, plus the `agent_message` calls between them). The one thing the parent's
 * log cannot say is what the child is doing **right now** — a task does not report progress — so
 * that line, and the tokens and money beside it, come from the child's own stream
 * ({@link useTaskActivity}).
 *
 * The card is drawn where the `agent` call that started the task was: the call is not a tool line
 * (`isTaskToolName`), so the card takes its place, and `MessageList` merges the two lists by
 * position. That is why this component is not a `TranscriptEntry` — the client's union is shared
 * with `oh`, which draws the same cards its own way.
 *
 * Two controls, and both are the reader's:
 *
 * - **Open** follows the child to its own chat (`#/s/<child>`), which is a full chat with the
 *   normal composer — the reader can steer, interrupt and continue a helper (S1's
 *   "non-interactive" is about the *model* asking, not about the reader being locked out). It is
 *   offered only when the task has a child session, which a subagent does and a later kind may
 *   not.
 * - **Stop** interrupts the child. `agent_stop` is the model's tool, not the reader's, so the
 *   only route a person has is the `user.interrupt` the child's own Stop sends — see the note on
 *   {@link TaskCardViewProps.onStop}.
 */
export function TaskCard({
  card,
  prices,
  stopping = false,
  onStop,
}: {
  card: TaskCard
  /** The catalog's prices, for the money the child's tokens cost (#247). */
  prices?: ModelPriceLookup | undefined
  /** Whether this card's Stop is in flight. */
  stopping?: boolean
  /** Interrupt this task's child session. Omitted, no Stop is drawn. */
  onStop?: ((card: TaskCard) => void) | undefined
}) {
  const status = taskCardStatus(card.status, false)
  const live = useTaskActivity(card.childSessionId, {
    // A finished task is not followed: it has no activity to draw, and a card nobody can act on
    // holding a stream open is what the watcher's reference count exists to avoid.
    enabled: taskIsLive(status),
    ...(prices === undefined ? {} : { prices }),
  })
  const waiting = taskIsLive(status) && live.waiting
  return (
    <TaskCardView
      card={card}
      waiting={waiting}
      line={taskIsLive(status) ? taskActivityLabel(live.activity) : null}
      tokens={live.usage === null ? null : taskTokens(live.usage)}
      cost={live.cost}
      stopping={stopping}
      {...(onStop === undefined ? {} : { onStop })}
    />
  )
}

/** What the presentational card takes — every fact already derived. */
export interface TaskCardViewProps {
  card: TaskCard
  /** Whether the child's own log says it is paused in an `agent_wait` ({@link taskCardStatus}). */
  waiting?: boolean
  /** The child's live activity, as `taskActivityLabel` spells it, or `null`. */
  line?: string | null
  /** What the child has spent in tokens, or `null` while its log reports none. */
  tokens?: number | null
  /** What those tokens cost, or `null` with no catalog to price by. */
  cost?: TotalCost | null
  /** This card's Stop is in flight. */
  stopping?: boolean
  /**
   * Interrupt the task's child session.
   *
   * The only route a reader has: `agent_stop` is a tool the *model* calls, and nothing in the API
   * lets a client write a `session.task_status`. So the reader's Stop is the child's own
   * `user.interrupt`, which ends the child's turn the way an interrupt ends any other.
   */
  onStop?: ((card: TaskCard) => void) | undefined
}

/**
 * The card's markup, with every fact passed in.
 *
 * Separated from {@link TaskCard} for the same reason `working-row.tsx` separates its rule from
 * its clock: the five states, the inline conversation and the folded result are a rendering
 * question, testable without a client, a stream or a child session.
 */
export function TaskCardView({
  card,
  waiting = false,
  line = null,
  tokens = null,
  cost = null,
  stopping = false,
  onStop,
}: TaskCardViewProps) {
  const status = taskCardStatus(card.status, waiting)
  const live = taskIsLive(status)
  const name = taskTypeLabel(card.type)
  const spending = tokens !== null || cost !== null
  return (
    <Collapsible
      data-slot="task-card"
      data-task={card.id}
      data-status={status}
      {...(card.type === null ? {} : { 'data-type': card.type })}
      className="rounded-xl border bg-muted/30"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <TaskStatusMark status={status} />
        <Badge variant="outline" data-slot="task-type" className="font-mono text-2xs">
          {name}
        </Badge>
        <span data-slot="task-description" className="min-w-0 flex-1 truncate text-sm">
          {card.description}
        </span>
        <span
          data-slot="task-status"
          className={cn(
            'shrink-0 text-2xs',
            status === 'running' && 'text-muted-foreground',
            status === 'waiting' && 'text-coral-ink',
            status === 'done' && 'text-muted-foreground',
            (status === 'failed' || status === 'stopped') && 'text-destructive',
          )}
        >
          {status}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {card.childSessionId === null ? null : (
            <Button asChild variant="outline" size="xs">
              <a href={chatHash(card.childSessionId)} data-slot="task-open">
                Open
              </a>
            </Button>
          )}
          {onStop === undefined || !live ? null : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-slot="task-stop"
              // The task is named, because a conversation may hold several cards and "Stop" alone
              // would be a page of identical buttons to a screen reader and a test alike.
              aria-label={`Stop ${name} ${card.id}`}
              disabled={stopping}
              onClick={() => onStop(card)}
            >
              <Square aria-hidden="true" />
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </div>
      </div>

      {/* The live line, the tokens and the money (S9). It is drawn only while the task is
          working: a finished card's outcome is the result below, and "writing…" next to "done"
          would be a contradiction. */}
      {!live || (line === null && !spending) ? null : (
        <div
          data-slot="task-activity"
          className="flex min-w-0 items-center gap-2 border-t px-3 py-1.5 text-2xs text-muted-foreground"
        >
          {line === null ? null : (
            <span data-slot="task-activity-line" className="min-w-0 flex-1 truncate font-mono">
              {line}
            </span>
          )}
          {tokens === null ? null : (
            <span data-slot="task-tokens" className="shrink-0">
              {formatCount(tokens)} tokens
            </span>
          )}
          {cost === null ? null : (
            <span data-slot="task-cost" className="shrink-0">
              {formatCostTotal(cost)}
            </span>
          )}
        </div>
      )}

      {/* What the two of them said to each other, in the order it happened (S9): the parent's
          `agent_message` as `→ researcher: …` and the child's note as `researcher →: …`. */}
      {card.messages.length === 0 ? null : (
        <ul data-slot="task-messages" className="space-y-0.5 border-t px-3 py-1.5">
          {card.messages.map((message) => (
            <li
              key={`${String(message.seq)}:${message.from}`}
              className="flex min-w-0 gap-1.5 text-2xs"
            >
              <span className="shrink-0 font-mono text-muted-foreground">
                {taskMessageLabel(message, card.type)}
              </span>
              <span className="min-w-0 flex-1 text-muted-foreground">{message.text}</span>
            </li>
          ))}
        </ul>
      )}

      {/* The result folds into the card (S9): the newest turn the task finished with, behind the
          same disclosure the tool calls use. A failure is drawn as what it is. */}
      {card.result === null ? null : (
        <div className="border-t px-3 py-1.5">
          <CollapsibleTrigger
            data-slot="task-result-trigger"
            className="group/result flex w-full items-center gap-1.5 text-2xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 transition-transform group-data-[state=open]/result:rotate-90"
            />
            {card.result.kind === 'failed' ? 'Failed — what it said' : 'Result'}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre
              data-slot="task-result"
              className={cn(
                'mt-1 max-h-64 overflow-auto rounded-md px-2 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap',
                card.result.kind === 'failed'
                  ? 'bg-destructive/5 text-destructive'
                  : 'bg-background/60',
              )}
            >
              {card.result.text}
            </pre>
          </CollapsibleContent>
        </div>
      )}
    </Collapsible>
  )
}

/**
 * The mark a status is drawn with, so a state is visible before it is read.
 *
 * The same vocabulary the tool line uses (`ToolStatusIcon` in `tool-call.tsx`): a spinner while
 * something is running, a pause mark for a task waiting on its own helpers, a tick for one that
 * finished, and the two failure colours. Both are stated in the status text beside it; the mark
 * is only the glance.
 */
function TaskStatusMark({ status }: { readonly status: TaskCardStatus }) {
  const className = 'size-3.5 shrink-0'
  switch (status) {
    case 'running':
      return <Loader2 aria-hidden="true" className={cn(className, 'animate-spin text-coral')} />
    case 'waiting':
      return <Pause aria-hidden="true" className={cn(className, 'text-coral')} />
    case 'done':
      return <Check aria-hidden="true" className={cn(className, 'text-muted-foreground')} />
    case 'failed':
      return <CircleAlert aria-hidden="true" className={cn(className, 'text-destructive')} />
    case 'stopped':
      return <CircleSlash aria-hidden="true" className={cn(className, 'text-muted-foreground')} />
  }
}
