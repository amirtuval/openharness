import { formatToolInput, toolCallSummary, toolStatusLabel } from '@openharness/client'
import type { TranscriptToolCall, ToolCallStatus } from '@openharness/client'
import {
  Ban,
  Check,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  Loader2,
  Pause,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

/**
 * One tool call, as a compact line the reader can expand (epic #303, X1/X5; issue #308).
 *
 * The model's calls are events of their own, not text it wrote, so each is one row in the
 * conversation: the tool's name, what it was asked (a URL, a query, a task count — from the
 * shared `toolCallSummary`), and its state — "running", "waiting for you", "done", "failed",
 * "denied", "interrupted" or "execution lost". The full input and whatever the call answered are
 * behind the disclosure, because they are the parts nobody reads twice.
 *
 * It is built to be extended by the next two issues, which is why it takes what it needs as
 * props rather than reaching for a store:
 *
 * - **#310 (the approval prompt)** passes `action` — a slot at the end of the row, outside the
 *   disclosure trigger so its buttons are not nested in one — for a `waiting` call. That is why
 *   the status is the client's derived `ToolCallStatus` and not a shape of this component's own.
 * - **A remote MCP call (#312)** needs no change here: it carries `source: 'mcp'` — which the row
 *   draws as its own badge — and the server it came from, which the badge names in a `title` and
 *   the row carries as `data-server`. The tool's name is already the model-facing
 *   `<server>__<tool>` spelling, so the row says which server without a second word of chrome.
 *
 * The words come from `@openharness/client` (`toolStatusLabel`, `toolCallSummary`), so `oh`
 * draws the same line for the same call.
 */
export function ToolCallLine({
  call,
  action,
}: {
  call: TranscriptToolCall
  /** A control the caller owns for a waiting call (#310): drawn at the end of the row. */
  action?: ReactNode
}) {
  const summary = toolCallSummary(call)
  const status = toolStatusLabel(call.status)
  const busy = call.status === 'running' || call.status === 'waiting'

  return (
    <Collapsible
      data-slot="tool-call"
      data-tool={call.name}
      data-status={call.status}
      {...(call.server === undefined ? {} : { 'data-server': call.server })}
      className="group/tool"
    >
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
          call.status === 'waiting' ? 'border-coral/40 bg-coral/5' : 'bg-muted/40',
        )}
      >
        <ToolStatusIcon status={call.status} />
        <span className="shrink-0 font-mono font-medium">{call.name}</span>
        {call.source === 'mcp' ? (
          <Badge variant="outline" className="text-2xs" title={call.server}>
            MCP
          </Badge>
        ) : null}
        {summary === null ? (
          <span className="min-w-0 flex-1" />
        ) : (
          <span data-slot="tool-summary" className="min-w-0 flex-1 truncate text-muted-foreground">
            {summary}
          </span>
        )}
        <span
          data-slot="tool-status"
          className={cn(
            'shrink-0',
            call.status === 'waiting' && 'text-coral-ink',
            (call.status === 'error' || call.status === 'denied') && 'text-destructive',
            !busy && call.status !== 'error' && call.status !== 'denied' && 'text-muted-foreground',
          )}
        >
          {status}
        </span>
        {action === undefined ? null : <span className="shrink-0">{action}</span>}
        <CollapsibleTrigger
          aria-label={`Details for the ${call.name} call`}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 transition-transform [[data-state=open]_&]:rotate-90"
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-1 space-y-2 rounded-lg bg-muted/30 px-2.5 py-2 text-xs">
          <ToolDetail label="Input" value={formatToolInput(call.input)} slot="tool-input" />
          {call.result === undefined ? null : (
            <ToolDetail
              label="Result"
              value={call.result.content}
              slot="tool-result"
              error={call.result.isError}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One labelled block of a call's detail: the JSON input, or what the call answered. */
function ToolDetail({
  label,
  value,
  slot,
  error = false,
}: {
  label: string
  value: string
  slot: string
  error?: boolean
}) {
  return (
    <div className="space-y-1">
      <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <pre
        data-slot={slot}
        className={cn(
          'max-h-64 overflow-auto rounded-md px-2 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap',
          error ? 'bg-destructive/5 text-destructive' : 'bg-background/60',
        )}
      >
        {value}
      </pre>
    </div>
  )
}

/** The mark a status is drawn with, so a state is visible before it is read. */
function ToolStatusIcon({ status }: { status: ToolCallStatus }) {
  const className = 'size-3.5 shrink-0'
  switch (status) {
    case 'running':
      return <Loader2 aria-hidden="true" className={cn(className, 'animate-spin text-coral')} />
    case 'waiting':
      return <Pause aria-hidden="true" className={cn(className, 'text-coral')} />
    case 'done':
      return <Check aria-hidden="true" className={cn(className, 'text-muted-foreground')} />
    case 'error':
      return <CircleAlert aria-hidden="true" className={cn(className, 'text-destructive')} />
    case 'denied':
      return <Ban aria-hidden="true" className={cn(className, 'text-destructive')} />
    case 'interrupted':
      return <CircleSlash aria-hidden="true" className={cn(className, 'text-muted-foreground')} />
    case 'lost':
      return <Wrench aria-hidden="true" className={cn(className, 'text-muted-foreground')} />
  }
}
