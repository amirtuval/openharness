import { providerName } from '@openharness/client'
import type { ModelUsageBreakdown, UsageTotals } from '@openharness/protocol'
import type { ReactNode } from 'react'

import { useUsage } from '../../hooks/use-usage'
import { formatCost, formatCount } from '../../lib/format'
import { useClient } from '../client-provider'
import { ErrorBanner } from '../chat/error-banner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { Skeleton } from '../ui/skeleton'

/**
 * Settings → Usage (epic #245, A2; issue #247): this month, by model, by day.
 *
 * The numbers come from `GET /v1/me/usage` — a read of the caller's own log, priced when it is
 * asked for — so this card is the answer to "what have I spent", not a report anything stored.
 * It is **the caller's own usage only**: there is no operator view, and no other account is
 * reachable from here.
 *
 * Three things it does not do, each for a reason:
 *
 * - **It never estimates.** A model nobody publishes a price for shows `—`, and a total that
 *   includes one is `—` too: the tokens are real and the money is not known, and a made-up
 *   number would be worse than none.
 * - **It does not roll anything up.** Days are the reader's local days, which is what the query
 *   says; a request made at 23:30 in their zone belongs to their day, wherever the server is.
 * - **It shows no breakdown by mode** — there is only one axis here, the model, because that is
 *   the axis a price exists on.
 */
export function UsageCard() {
  const client = useClient()
  const { usage, loading, error, dismissError } = useUsage(client)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Usage</CardTitle>
        <CardDescription>
          What you have spent this month, priced at each model's list rates. Days are your own local
          days, and a model with no published price shows tokens and a dash.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error === null ? null : (
          <ErrorBanner title="Could not load your usage" message={error} onDismiss={dismissError} />
        )}

        {loading && usage === null ? (
          <div className="space-y-2" data-slot="usage-loading">
            <Skeleton className="h-4 w-40" label="Loading your usage" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-52" />
          </div>
        ) : usage === null ? null : (
          <>
            <div className="flex items-baseline gap-3" data-slot="usage-total">
              <span className="text-lg font-medium">{formatCost(usage.cost)}</span>
              <span className="text-xs text-muted-foreground">
                {formatTokensFor(usage.totals)} tokens · {monthLabel(usage.from, usage.to)}
              </span>
            </div>

            <ModelTable entries={usage.by_model} />

            <DayList days={usage.by_day} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** The per-model table: what each model cost, and how much of it there was. */
function ModelTable({ entries }: { entries: readonly ModelUsageBreakdown[] }): ReactNode {
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing has run this month.</p>
  }
  return (
    <table className="w-full text-xs" data-slot="usage-models">
      <caption className="sr-only">Usage this month, by model</caption>
      <thead>
        <tr className="text-muted-foreground">
          <th scope="col" className="pb-1 text-left font-normal">
            Model
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Requests
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Tokens
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.model} className="border-t">
            <td className="py-1 pr-2">
              <span className="block max-w-[16rem] truncate" title={entry.model}>
                {modelLabelOf(entry.model)}
              </span>
            </td>
            <td className="py-1 text-right tabular-nums">{formatCount(entry.requests)}</td>
            <td className="py-1 text-right tabular-nums">{formatTokensFor(entry.usage)}</td>
            <td className="py-1 text-right tabular-nums" data-slot="usage-model-cost">
              {formatCost(entry.cost)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The month's days, as a list of bars: one row per day something ran.
 *
 * A day with nothing on it is absent rather than zero — the server answers only the days that
 * hold requests — so the list is what happened, not a calendar with blanks in it.
 */
function DayList({
  days,
}: {
  days: readonly {
    readonly day: string
    readonly totals: UsageTotals
    readonly cost: number | null
  }[]
}): ReactNode {
  if (days.length === 0) {
    return null
  }
  const widest = Math.max(...days.map((day) => tokensOf(day.totals)), 1)

  return (
    <div className="space-y-1" data-slot="usage-days">
      <p className="text-xs text-muted-foreground">By day</p>
      {days.map((day) => (
        <div key={day.day} className="flex items-center gap-2 text-xs">
          <span className="w-16 shrink-0 tabular-nums">{day.day.slice(5)}</span>
          <span
            aria-hidden="true"
            className="h-2 rounded-xs bg-primary/40"
            // A bar is decoration: the numbers beside it are the fact, and a screen reader
            // gets them from the row's text rather than from a width nobody can hear.
            style={{
              width: `${String(Math.max(2, Math.round((tokensOf(day.totals) / widest) * 100)))}%`,
            }}
          />
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            {formatTokensFor(day.totals)} tokens · {formatCost(day.cost)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** A model id as the card names it: its provider's display name, then the id. */
function modelLabelOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  const provider = slash <= 0 ? modelId : modelId.slice(0, slash)
  return `${providerName(provider)} · ${modelId}`
}

/** The month a range covers, for the total's caption. */
function monthLabel(from: string, to: string): string {
  return from === to ? from : `${from} → ${to}`
}

/** The month's tokens: `12,480 in · 2,100 out`, with the cache counters when there are any. */
function formatTokensFor(totals: UsageTotals): string {
  const parts = [formatCount(totals.input_tokens), formatCount(totals.output_tokens)]
  const cached = totals.cache_read_input_tokens + totals.cache_creation_input_tokens
  if (cached > 0) {
    parts.push(`${formatCount(cached)} cached`)
  }
  return parts.join(' · ')
}

/** Every token in a total, cache included — what a bar's length is measured in. */
function tokensOf(totals: UsageTotals): number {
  return (
    totals.input_tokens +
    totals.output_tokens +
    totals.cache_creation_input_tokens +
    totals.cache_read_input_tokens
  )
}
