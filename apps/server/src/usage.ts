import { EVENT_TYPES, MAX_PAGE_LIMIT, totalCost, usageCost } from '@openharness/protocol'
import type {
  LocalDay,
  ModelCost,
  ModelUsage,
  ModelUsageBreakdown,
  SessionId,
  SessionUsage,
  StoredEvent,
  UserId,
  UserUsage,
} from '@openharness/protocol'
import type { OwnerScope, SessionStore } from '@openharness/session'

import type { ModelRegistry } from './catalog/registry'
import { dayInRange, localDayOf, utcWindowOf, type UsageRange } from './local-day'

/**
 * Usage and cost, read from the log (epic #245, A2; issue #247).
 *
 * Every model request in a session's log is bracketed by a `span.model_request_start` — which
 * names the model that served it — and a `span.model_request_end`, which reports the tokens.
 * Those two events are the whole input: this module pairs them, prices each request with the
 * model catalog's rates, and answers what a session or a user spent.
 *
 * Three rules, and they are the epic's:
 *
 * - **Cost is computed when it is read.** Nothing here writes anything: a price is not in the
 *   log, so the money is derived on the read that asked for it, from tokens that are. A model
 *   nobody publishes a price for contributes its tokens and no cost, and the total it is part of
 *   **sums the priced requests and counts the unpriced ones** (`unpriced_requests`, decided
 *   2026-10-09) rather than turning unknown — never an estimate (`usageCost`/`totalCost` in the
 *   protocol are the arithmetic; this module is the reader). A total is `null` only when nothing
 *   in it could be priced.
 * - **A rewind is not billed.** The reads go through the store's replay read, which skips what a
 *   recorded range supersedes, so a branch a reader edited away is not in anybody's totals —
 *   group, the same rule the brain's context and a client's transcript follow.
 * - **Days are the reader's days.** The per-user read groups each request by the local day it
 *   fell on in the zone the caller named ({@link localDayOf}); nothing is rolled up or stored.
 *
 * The reads are scoped: the per-session read takes the caller's owner (another user's session is
 * a `SessionNotFoundError`, the route's 404), and the per-user read can only ever be the caller,
 * because there is no id in its path. There is no operator-wide view.
 */

/**
 * A model's list price, by `provider/model` id — the one thing this module needs that the log
 * cannot tell it.
 *
 * `null` means "no price known", which is a real answer and not a failure: the model's requests
 * keep their tokens and report no cost.
 */
export type ModelPriceLookup = (modelId: string) => ModelCost | null

/**
 * The prices of the bundled models.dev snapshot, looked up by `provider/model` id.
 *
 * The registry carries a price per model (see `catalog/registry.ts`), and each provider's list
 * is indexed once and kept: a usage read looks a model up per request, and the registry would
 * otherwise scan a provider's models for every one of them.
 *
 * A model no provider of the registry knows — a free-text id, an id for a provider this build
 * has no snapshot for — has no price, which is what makes its requests cost `null`.
 */
export function registryPrices(registry: ModelRegistry): ModelPriceLookup {
  const byProvider = new Map<string, ReadonlyMap<string, ModelCost>>()
  return (modelId) => {
    const slash = modelId.indexOf('/')
    if (slash <= 0 || slash === modelId.length - 1) {
      return null
    }
    const provider = modelId.slice(0, slash)
    let index = byProvider.get(provider)
    if (index === undefined) {
      index = new Map(
        registry
          .models(provider)
          .flatMap((model) => (model.cost === undefined ? [] : [[model.id, model.cost] as const])),
      )
      byProvider.set(provider, index)
    }
    // The registry keys its models by the raw id: everything after the provider's slash.
    return index.get(modelId.slice(slash + 1)) ?? null
  }
}

/** One model request the log recorded: what it ran on, what it spent, and when it finished. */
interface RecordedRequest {
  /**
   * The `provider/model` the request's span start named — the model it was made with.
   *
   * `null` for a span start stored before the field existed: the tokens are real but they cannot
   * be attributed to a model, so they are in no breakdown and are priced by nothing.
   */
  readonly model: string | null
  /** What the request reported. */
  readonly usage: ModelUsage
  /** When it finished: the span end's `processed_at`, which is what a day groups by. */
  readonly at: Date
}

/** The usage surface the routes answer with: two reads, both owner-scoped. */
export interface UsageReader {
  /**
   * What one session spent, over its whole log: the totals, their cost, and the per-model split.
   *
   * @throws SessionNotFoundError when the session does not exist, or belongs to another owner
   */
  session(sessionId: SessionId, options: OwnerScope): Promise<SessionUsage>

  /** What one user spent between two local days, by model and by day. */
  user(userId: UserId, range: UsageRange): Promise<UserUsage>
}

/** What {@link createUsageReader} needs. */
export interface UsageReaderOptions {
  /** The durable log both reads go through. */
  readonly store: SessionStore
  /** Where a model's price comes from; {@link registryPrices} over the bundled snapshot. */
  readonly prices: ModelPriceLookup
}

/** Build the reader the usage routes answer with. */
export function createUsageReader(options: UsageReaderOptions): UsageReader {
  const { store, prices } = options

  /** The two span event types a usage read needs and nothing else. */
  const spans = [EVENT_TYPES.modelRequestStart, EVENT_TYPES.modelRequestEnd]

  /** Every request a log holds, in `seq` order, paired start-with-end. */
  const requestsOf = (events: readonly StoredEvent[]): RecordedRequest[] => {
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

  /** A page-walk over one session's span events, through the caller's own scope. */
  const readSession = async (
    sessionId: SessionId,
    options: OwnerScope,
  ): Promise<RecordedRequest[]> => {
    const requests: RecordedRequest[] = []
    let page: string | undefined
    for (;;) {
      const response = await store.listEvents(sessionId, {
        ...options,
        order: 'asc',
        types: spans,
        limit: MAX_PAGE_LIMIT,
        ...(page === undefined ? {} : { page }),
      })
      requests.push(...requestsOf(response.data))
      if (response.next_page === null) {
        return requests
      }
      page = response.next_page
    }
  }

  return {
    async session(sessionId, options) {
      return { session_id: sessionId, ...assemble(await readSession(sessionId, options), prices) }
    },

    async user(userId, range) {
      // One read for the whole range: the store answers the caller's own model requests in the
      // UTC window the range's local days span, so a month of heavy use is a window rather
      // than every session read page by page. The days are grouped here — the window is UTC,
      // and which day a request fell on is the reader's zone.
      const requests = await store.listModelRequests({
        ownerId: userId,
        ...utcWindowOf(range),
      })
      const byDay = new Map<LocalDay, RecordedRequest[]>()
      const inRange: RecordedRequest[] = []

      for (const request of requests) {
        const at = new Date(request.processed_at)
        const day = localDayOf(at, range.tz)
        if (!dayInRange(day, range)) {
          continue
        }
        const recorded: RecordedRequest = { model: request.model, usage: request.usage, at }
        inRange.push(recorded)
        // Appended into the day's own list rather than a fresh one per request: a day of heavy
        // use is one array, and the copy a spread would make per request is quadratic in it.
        const sameDay = byDay.get(day)
        if (sameDay === undefined) {
          byDay.set(day, [recorded])
        } else {
          sameDay.push(recorded)
        }
      }

      return {
        from: range.from,
        to: range.to,
        tz: range.tz,
        ...assemble(inRange, prices),
        by_day: [...byDay]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([day, requests]) => {
            const { totals, cost, unpriced_requests } = assemble(requests, prices)
            return { day, totals, cost, unpriced_requests }
          }),
      }
    },
  }
}

/**
 * The totals, their money and the per-model split of a set of requests.
 *
 * The total **sums the priced requests and counts the unpriced ones** (#247, decided 2026-10-09):
 * a model nobody publishes a price for contributes its tokens and no cost, and the total names how
 * many requests were left out rather than turning `null` on the first of them. A request whose
 * model the log does not name is in the totals and in no breakdown entry — it really was spent,
 * and there is no model to attribute it to — and is counted among the unpriced ones, so an
 * unattributable request is not silently free.
 */
function assemble(
  requests: readonly RecordedRequest[],
  prices: ModelPriceLookup,
): Omit<SessionUsage, 'session_id'> {
  const totals = emptyUsage()
  const byModel = new Map<string, ModelTotals>()
  const costs: (number | null)[] = []

  for (const request of requests) {
    addTo(totals, request.usage)
    // One price lookup per request, shared by the total and the breakdown: a request whose model
    // nobody prices is unpriced in both, and is never looked up twice for a different answer.
    const cost = usageCost(request.usage, request.model === null ? null : prices(request.model))
    costs.push(cost)
    if (request.model === null) {
      continue
    }
    const entry = byModel.get(request.model) ?? { usage: emptyUsage(), requests: 0, costs: [] }
    addTo(entry.usage, request.usage)
    entry.requests += 1
    entry.costs.push(cost)
    byModel.set(request.model, entry)
  }

  const total = totalCost(costs)
  return {
    totals,
    cost: total.cost,
    unpriced_requests: total.unpriced_requests,
    by_model: [...byModel]
      .map(([model, entry]): ModelUsageBreakdown => {
        const modelCost = totalCost(entry.costs)
        return {
          model,
          usage: entry.usage,
          requests: entry.requests,
          cost: modelCost.cost,
          unpriced_requests: modelCost.unpriced_requests,
        }
      })
      // Biggest first by tokens, then by id: the order is about the tokens, so it stays the
      // same whatever the prices turn out to be.
      .sort((a, b) => tokensOf(b.usage) - tokensOf(a.usage) || (a.model < b.model ? -1 : 1)),
  }
}

/** One model's running share while the responses are assembled. */
interface ModelTotals {
  readonly usage: ModelUsage
  requests: number
  readonly costs: (number | null)[]
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

/** A usage report added into an accumulator, counter by counter. */
function addTo(total: ModelUsage, next: ModelUsage): void {
  total.input_tokens += next.input_tokens
  total.output_tokens += next.output_tokens
  total.cache_creation_input_tokens += next.cache_creation_input_tokens
  total.cache_read_input_tokens += next.cache_read_input_tokens
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
