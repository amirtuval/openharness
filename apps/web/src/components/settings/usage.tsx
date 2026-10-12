import { providerName } from '@openharness/client'
import type { ModelUsageBreakdown, UsageTotals } from '@openharness/protocol'
import type { ReactNode } from 'react'

import { useUsage } from '../../hooks/use-usage'
import { formatCount, formatCostTotal, unpricedExplanation } from '../../lib/format'
import { formatDay } from '../../lib/usage'
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
 * - **It never estimates.** A total **sums the requests it can price and counts the rest**
 *   (`$1.23 + 4 unpriced`, #247 decided 2026-10-09): the known part is the money and the unknown
 *   part is named, never made up. Only a total with nothing priced at all is `—`.
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
              <span
                className="text-lg font-medium"
                title={
                  usage.unpriced_requests === 0
                    ? undefined
                    : unpricedExplanation(usage.unpriced_requests)
                }
              >
                {formatCostTotal(usage)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatTokensFor(usage.totals)} tokens · {monthLabel(usage.from, usage.to)}
              </span>
            </div>

            {/* Searches are counted, never priced (epic #303, X5): the operator pays the search
                provider and no rate for that is in the repository, so this is a count beside the
                money rather than part of it. It is shown only when the month had one. */}
            {usage.searches === 0 ? null : (
              <p className="text-xs text-muted-foreground" data-slot="usage-searches">
                {formatCount(usage.searches)} {usage.searches === 1 ? 'web search' : 'web searches'}{' '}
                this month.
              </p>
            )}

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
          {/* The model is the column that gives up room first: its id is the long value, and
              everything else is a number a reader compares down the column. */}
          <th scope="col" className="w-full pb-1 text-left font-normal">
            Model
          </th>
          <th scope="col" className="pb-1 pl-2 text-right font-normal">
            Req
          </th>
          <th scope="col" className="pb-1 pl-2 text-right font-normal">
            In
          </th>
          <th scope="col" className="pb-1 pl-2 text-right font-normal">
            Out
          </th>
          <th scope="col" className="pb-1 pl-2 text-right font-normal">
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.model} className="border-t">
            <td className="max-w-0 w-full py-1 pr-2">
              <span className="block truncate" title={entry.model}>
                {modelLabelOf(entry.model)}
              </span>
            </td>
            <td className="py-1 pl-2 text-right tabular-nums">{formatCount(entry.requests)}</td>
            <td className="py-1 pl-2 text-right tabular-nums">
              {formatCount(entry.usage.input_tokens)}
            </td>
            <td className="py-1 pl-2 text-right tabular-nums">
              {formatCount(entry.usage.output_tokens)}
            </td>
            <td
              className="py-1 pl-2 text-right tabular-nums"
              data-slot="usage-model-cost"
              title={
                entry.unpriced_requests === 0
                  ? undefined
                  : unpricedExplanation(entry.unpriced_requests)
              }
            >
              {formatCostTotal(entry)}
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
    readonly unpriced_requests: number
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
          <span className="w-16 shrink-0 tabular-nums">{formatDay(day.day)}</span>
          <span
            aria-hidden="true"
            className="h-2 rounded-xs bg-primary/40"
            // A bar is decoration: the numbers beside it are the fact, and a screen reader
            // gets them from the row's text rather than from a width nobody can hear.
            style={{
              width: `${String(Math.max(2, Math.round((tokensOf(day.totals) / widest) * 100)))}%`,
            }}
          />
          <span
            className="ml-auto shrink-0 tabular-nums text-muted-foreground"
            title={
              day.unpriced_requests === 0 ? undefined : unpricedExplanation(day.unpriced_requests)
            }
          >
            {formatTokensFor(day.totals)} tokens · {formatCostTotal(day)}
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
