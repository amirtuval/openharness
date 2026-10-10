import type { ContextMeter as ContextMeterValue } from '@openharness/client'

import { cn } from '../../lib/utils'

/**
 * How full the context is (epic #277, K10; #280).
 *
 * One number, its bar and the line compaction fires at — "62% of context used" against the
 * current model's budget, drawn in the chat header beside the status dot. The arithmetic is not
 * here: `contextMeter` in `@openharness/client` turns the transcript's measurement and the
 * catalog's window into {@link ContextMeterValue}, and this draws it, which is what keeps the
 * web header and the `oh` status line saying the same thing.
 *
 * The design is the meter's three states in one component:
 *
 * - **a bar**, filled to the percentage and marked with a hairline at the threshold, so "how
 *   close is it?" is answered without reading the number;
 * - **the words**, next to it — the long form where there is room and the short one (`62%`)
 *   where there is not, because the header is one line and a phone is 390px wide. The bar itself
 *   is hidden below `sm` and the number carries the state alone;
 * - **the colour**, which is what "near the threshold" looks like: the primary violet while
 *   there is room, the destructive red once the context has reached the share the chat compacts
 *   at. A colour change and not a warning banner — the meter is a gauge, and a chat that is
 *   close to compacting is still a working chat.
 *
 * The label reads `~62% of context used` right after a summary (the `~` is `contextMeter`'s):
 * the history the summary replaced is out of the prompt but nothing has measured the new one
 * yet, and the estimate is the honest answer until the next request reports its real size.
 */
export function ContextMeter({ meter }: { meter: ContextMeterValue }) {
  // The bar is a width, so an over-budget context is drawn full rather than past its track; the
  // number beside it still says 104%, which is the fact a reader needs.
  const filled = Math.max(0, Math.min(100, meter.percent))
  return (
    <span
      data-slot="context-meter"
      data-state={meter.nearThreshold ? 'near' : 'normal'}
      data-estimated={meter.estimated}
      title={`${String(meter.tokens)} of ${String(meter.budget)} tokens · compacts at ${String(
        Math.round(meter.threshold * 100),
      )}%${meter.estimated ? ' · estimated from the summary' : ''}`}
      className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="relative hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block"
      >
        <span
          data-slot="context-meter-fill"
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            meter.nearThreshold ? 'bg-destructive' : 'bg-primary',
          )}
          style={{ width: `${String(filled)}%` }}
        />
        {/* Where the chat compacts: past this mark, older history is summarized. */}
        <span
          data-slot="context-meter-threshold"
          className="absolute inset-y-0 w-px bg-border"
          style={{ left: `${String(meter.threshold * 100)}%` }}
        />
      </span>
      <span data-slot="context-meter-label">
        {/* One of the two, never both: the sentence where it fits, the number where it does not. */}
        <span className="hidden sm:inline">{meter.label}</span>
        <span className="sm:hidden">{meter.shortLabel}</span>
      </span>
    </span>
  )
}
