import { EVENT_TYPES, totalCost, usageCost } from '@openharness/protocol'
import type {
  LocalDay,
  ModelCost,
  ModelUsage,
  ModelUsageBreakdown,
  UsageTotals,
  UserUsageQuery,
} from '@openharness/protocol'

import { ApiError } from '../errors'
import type { FakeBrain } from './fake-brain'

/**
 * The usage reads the fake answers (#247), in the shapes the server's routes answer.
 *
 * The fake restates the server's arithmetic rather than sharing it — the client cannot depend
 * on the server — and the rules it restates are the ones a UI can see:
 *
 * - **a request is a pair of spans**, the `span.model_request_start` that named the model and
 *   the `span.model_request_end` that reported its tokens, read through the replay read so a
 *   branch a rewind replaced is not counted;
 * - **cost is computed from the catalog's rates** when the read asks for it, never stored, and
 *   is `null` — "—" — when a model's price is unknown, never an estimate;
 * - **days are the reader's days**: the per-user read groups each request by the day it fell on
 *   in the zone the caller named.
 *
 * `titles.ts` is the same kind of module: the server's rule, restated for the fake so a screen
 * tested against it meets what the server would do.
 */

/** A model's list price by `provider/model` id: the catalog's `cost`, or `null` when it has none. */
export type ModelPriceLookup = (modelId: string) => ModelCost | null

/** One model request a log records: the model that served it, what it spent, when it finished. */
export interface RecordedRequest {
  /** `null` for a span start that named no model — a log from before the field existed. */
  readonly model: string | null
  readonly usage: ModelUsage
  readonly at: Date
}

/** The requests one fake session's log holds, paired start-with-end. */
export function fakeRequestsOf(brain: FakeBrain): RecordedRequest[] {
  const events = brain.pageEvents({
    types: [EVENT_TYPES.modelRequestStart, EVENT_TYPES.modelRequestEnd],
  }).data
  const modelOf = new Map<string, string>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.modelRequestStart && event.model !== undefined) {
      modelOf.set(event.id, event.model)
    }
  }
  return events.flatMap((event) =>
    event.type === EVENT_TYPES.modelRequestEnd
      ? [
          {
            model: modelOf.get(event.model_request_start_id) ?? null,
            usage: event.model_usage,
            at: new Date(event.processed_at),
          },
        ]
      : [],
  )
}

/**
 * The totals, the cost and the per-model split of a set of requests.
 *
 * The same assembly the server's usage reader does: a request whose model the log does not name
 * is in the totals and in no breakdown, and one whose model nobody prices makes the totals'
 * cost unknown.
 */
export function fakeUsage(
  requests: readonly RecordedRequest[],
  prices: ModelPriceLookup,
): { totals: UsageTotals; cost: number | null; by_model: ModelUsageBreakdown[] } {
  const totals = emptyUsage()
  const byModel = new Map<
    string,
    { usage: ModelUsage; requests: number; costs: (number | null)[] }
  >()
  const costs: (number | null)[] = []
  for (const request of requests) {
    addUsage(totals, request.usage)
    const cost = usageCost(request.usage, request.model === null ? null : prices(request.model))
    costs.push(cost)
    if (request.model === null) {
      continue
    }
    const entry = byModel.get(request.model) ?? { usage: emptyUsage(), requests: 0, costs: [] }
    addUsage(entry.usage, request.usage)
    entry.requests += 1
    entry.costs.push(cost)
    byModel.set(request.model, entry)
  }
  return {
    totals,
    cost: totalCost(costs),
    by_model: [...byModel]
      .map(([model, entry]) => ({
        model,
        usage: entry.usage,
        requests: entry.requests,
        cost: totalCost(entry.costs),
      }))
      .sort((a, b) => tokensOf(b.usage) - tokensOf(a.usage) || (a.model < b.model ? -1 : 1)),
  }
}

/**
 * The range a fake `usage.me` answers: the days it was given, the zone, and the server's
 * defaults — this month so far in `tz`, and `UTC` when nothing was named.
 *
 * A zone the runtime does not know is the 400 `invalid_request_error` the server answers,
 * which is what the fake does too: a screen that shows a bad zone's message is testable here.
 */
export function fakeUsageRange(
  params: UserUsageQuery | undefined,
  now: Date = new Date(),
): { from: LocalDay; to: LocalDay; tz: string } {
  const tz = params?.tz ?? 'UTC'
  if (!isTimeZone(tz)) {
    throw invalidRequest(`tz must be an IANA time zone name, got ${JSON.stringify(tz)}`)
  }
  const to = params?.to ?? fakeLocalDay(now, tz)
  const from = params?.from ?? `${to.slice(0, 7)}-01`
  if (from > to) {
    throw invalidRequest(`from must not be after to, got from ${from} and to ${to}`)
  }
  return { from, to, tz }
}

/** The day an instant falls on in `tz`, as `YYYY-MM-DD`. */
export function fakeLocalDay(instant: Date, tz: string): LocalDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const partOf = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${partOf('year')}-${partOf('month')}-${partOf('day')}`
}

/** Whether the runtime knows this zone. */
function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The four counters at zero. */
function emptyUsage(): ModelUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
}

/** One usage report added into another, counter by counter. */
function addUsage(into: ModelUsage, next: ModelUsage): void {
  into.input_tokens += next.input_tokens
  into.output_tokens += next.output_tokens
  into.cache_creation_input_tokens += next.cache_creation_input_tokens
  into.cache_read_input_tokens += next.cache_read_input_tokens
}

/** The one number a breakdown is ordered by. */
function tokensOf(usage: ModelUsage): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens
  )
}

/** The protocol's 400 envelope, as the fake throws one. */
function invalidRequest(message: string): ApiError {
  return new ApiError(400, message, { type: 'invalid_request_error' })
}
