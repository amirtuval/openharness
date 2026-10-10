import { summaryDescription } from '@openharness/client'
import type { TranscriptSummary } from '@openharness/client'
import { ChevronRight } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'

/**
 * The "Conversation summarized" divider (epic #277, K10; #280).
 *
 * A chat that fills its context has its older history summarized, and the summary supersedes
 * **nothing**: the history above it stays on screen, and this mark says where the model stops
 * reading verbatim. It is a rule across the column with the summary's reason, model and pass
 * count on it — "automatic", when the context reached the share the settings allow — and it
 * opens to the summary text itself, because "what did the model get told?" is the one question
 * a divider like this raises.
 *
 * Collapsed by default: it is a mark in a conversation, not a message, and a long summary
 * pushed between two turns would read as one. Radix's `Collapsible` takes the panel out of the
 * DOM while it is closed, which is what keeps a collapsed summary out of a screen reader's way
 * too.
 *
 * The wording is `summaryDescription`'s, from `@openharness/client` — the same function the
 * terminal draws its divider from, so the two say the same thing about the same log.
 */
export function SummaryDivider({ summary }: { summary: TranscriptSummary }) {
  return (
    <Collapsible data-slot="summary-divider" data-reason={summary.reason}>
      <div className="flex w-full flex-col gap-inline">
        <div className="flex w-full items-center gap-control">
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
          <CollapsibleTrigger
            data-slot="summary-divider-trigger"
            className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform [[data-state=open]_&]:rotate-90"
            />
            <span>Conversation summarized</span>
            <span data-slot="summary-description" className="text-muted-foreground/70">
              {summaryDescription(summary)}
            </span>
          </CollapsibleTrigger>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
        <CollapsibleContent>
          <p
            data-slot="summary-text"
            className="rounded-lg bg-muted/50 px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap text-muted-foreground"
          >
            {summary.summary}
          </p>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
