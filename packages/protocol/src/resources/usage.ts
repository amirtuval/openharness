import { z } from 'zod'

import { LocalDaySchema } from '../common'
import { SessionIdSchema } from '../ids'
import { ModelUsageSchema } from '../events/span'

/**
 * The usage surface — `GET /v1/sessions/{session_id}/usage` and `GET /v1/me/usage`
 * (epic #245, A2; issue #247) — the shapes of what a session and a user spent.
 *
 * ```
 * GET /v1/sessions/{session_id}/usage  -> { session_id, totals, cost, by_model, searches }
 * GET /v1/me/usage?from=&to=&tz=       -> { from, to, tz, totals, cost, by_model, by_day, searches }
 * ```
 *
 * Both are **reads of the log**, and both answer in the same currency of facts:
 *
 * - **Tokens are stored, cost is computed.** Every request's counters are in its
 *   `span.model_request_end`; a price is not in the log at all. So a response is assembled when
 *   it is asked for, from the tokens the log holds and the model catalog's prices, and nothing
 *   about cost is ever written down (epic #245).
 * - **Searches are counted, and never priced** (epic #303, #305). `searches` is how many
 *   `web_search` calls the covered log holds — the operator pays the search provider, and no
 *   rate for that is in this repository — so a reader is shown a count rather than a made-up
 *   cost.
 * - **A price nobody published is named, not guessed.** A request whose model the catalog has no
 *   price for contributes its tokens and nothing to the cost; a total **sums the priced requests
 *   and counts the unpriced ones** (`unpriced_requests`), and its `cost` is `null` only when
 *   nothing in it could be priced (decided 2026-10-09). One such request no longer makes a whole
 *   session unreadable, and no part of the money is ever an estimate. `null` is what a client
 *   renders as "—".
 * - **Every route is scoped to its owner.** The session route is the caller's session or a 404
 *   (A4); the user route can only ever be the caller — there is no id in the path — so a user
 *   never sees another's usage, and there is no operator-wide view at all.
 * - **Usage is broken down by model, never by mode.** A session may switch models
 *   mid-conversation (epic #116, U3), so `by_model` is what tells the cheap requests from the
 *   expensive ones; there is no second axis.
 *
 * // extension: the shapes are openharness's own. Anthropic tracks usage per session and
 * reports it on the session object and in `session.usage` events; it has no per-user, per-range
 * usage endpoint, and its cost figures are platform-computed and stored rather than derived
 * from the reader's own vendored prices.
 */

/**
 * The token counters of a usage total: the four a `span.model_request_end` reports, summed over
 * every request the total covers.
 *
 * The protocol has one shape for these four numbers — {@link ModelUsageSchema} — and this is the
 * name a usage response reads them under, because the total of a session is not one request's
 * usage. A counter is always present and always a number: a model that reports nothing about a
 * counter reports `0` for it (the brain's `toModelUsage` is where that happens), so "unknown"
 * is never spelled as a missing count — it is the absence of a *cost* that says so.
 */
export const UsageTotalsSchema = ModelUsageSchema

export type UsageTotals = z.infer<typeof UsageTotalsSchema>

/**
 * A cost in US dollars: a non-negative number of dollars, at the list prices the model catalog
 * carries.
 *
 * `null` — on every shape below — means **unknown**, and it is the only way this package says
 * so: a model the catalog has no price for, or one whose cache rates nobody published, makes
 * the request it belongs to unpriced rather than free. Whole cents are not rounded into the wire
 * type: rounding is a presentation decision, and the reader is the one who knows how many digits
 * it wants.
 */
export const MoneySchema = z.number().nonnegative().nullable()

export type Money = z.infer<typeof MoneySchema>

/**
 * The money of a total: `cost`, the sum of the requests that could be priced, and
 * `unpriced_requests`, how many had no price (epic #245, A2; #247, decided 2026-10-09).
 *
 * Every total below carries these two fields together, so the shape is defined once here. A total
 * **sums the priced requests and counts the unpriced ones** instead of turning unknown as soon as
 * one request has no price: `cost` is the sum, or `null` when nothing in the total was priced,
 * and `unpriced_requests` names the unknown part — it is never folded into the number as an
 * estimate. A reader shows "—" for a `null` cost, and renders a count beside a number.
 */
export const TotalCostSchema = z.object({
  /** The sum of the priced requests, or `null` when nothing in the total could be priced. */
  cost: MoneySchema,
  /** How many requests in the total had no published price. */
  unpriced_requests: z.number().int().nonnegative(),
})

/**
 * One model's share of a usage answer: its totals, how many requests ran on it, and what they
 * cost.
 *
 * `requests` is a count of `span.model_request_end` events, so a reply the brain retried counts
 * twice — which is right: both attempts really ran, and both are really in the tokens.
 * `unpriced_requests` is how many of those requests had no price: they are among the `requests`
 * and their tokens are in `usage`, but no money is claimed for them.
 */
export const ModelUsageBreakdownSchema = z.object({
  /** The `provider/model` the requests named — the model that served them. */
  model: z.string().min(1),
  /** The tokens those requests reported, summed. */
  usage: UsageTotalsSchema,
  /** How many requests ran on this model. */
  requests: z.number().int().nonnegative(),
  ...TotalCostSchema.shape,
})

export type ModelUsageBreakdown = z.infer<typeof ModelUsageBreakdownSchema>

/**
 * How many searches an answer covers (epic #303, #305).
 *
 * A count and not a price: the deployment pays the search provider, the operator's plan is not
 * in this repository, and inventing a rate for one would be exactly the estimate the usage
 * surface refuses to make (epic #245). So a search is counted — the number of `web_search`
 * calls the log holds — and no money is claimed for it.
 *
 * It is a sibling of the token totals rather than a member of them, because tokens and searches
 * are not the same kind of thing: `totals` is a `ModelUsage` of four counters, and a reader that
 * summed a search count into one would be adding apples to oranges.
 */
export const UsageSearchesSchema = z.number().int().nonnegative()

export type UsageSearches = z.infer<typeof UsageSearchesSchema>

/**
 * Response of `GET /v1/sessions/{session_id}/usage`: everything one session spent.
 *
 * Owner-scoped: another user's session is the 404 an unknown id gets (A4). The route reads the
 * session's whole log — skipping what a rewind replaced, so a branch the reader took back is not
 * billed — and answers the totals over all of it, with the per-model split beside them.
 *
 * A session whose log holds no `span.model_request_end` at all (a chat with no reply yet)
 * answers zeroed totals, an empty `by_model` and a `null` cost: nothing was spent, and nothing
 * was priced either. `searches` is `0` in that case too — a count, which has no unknown.
 */
export const SessionUsageSchema = z.object({
  /** The session these totals are for. */
  session_id: SessionIdSchema,
  /** Every request the session made, summed. */
  totals: UsageTotalsSchema,
  /** What `totals` cost, and how many of the session's requests had no price. */
  ...TotalCostSchema.shape,
  /** The same totals per model, biggest first. */
  by_model: z.array(ModelUsageBreakdownSchema),
  /** How many `web_search` calls this session made; see {@link UsageSearchesSchema}. */
  searches: UsageSearchesSchema,
})

export type SessionUsage = z.infer<typeof SessionUsageSchema>

/**
 * One local day's usage (issue #247).
 *
 * `day` is a calendar day in the zone the request named: the request timestamps are grouped by
 * the day they fell on *there*, which is the only reading of "today" a reader recognises. A day
 * with no request is **absent** from `by_day` rather than present as a zero — the same rule the
 * rest of this protocol follows about unknown and empty.
 */
export const DailyUsageSchema = z.object({
  /** The local day, `YYYY-MM-DD`, in the response's `tz`. */
  day: LocalDaySchema,
  /** What was spent in it. */
  totals: UsageTotalsSchema,
  /** What `totals` cost that day, and how many of its requests had no price. */
  ...TotalCostSchema.shape,
  /** How many `web_search` calls that day made. */
  searches: UsageSearchesSchema,
})

export type DailyUsage = z.infer<typeof DailyUsageSchema>

/**
 * Response of `GET /v1/me/usage`: what the caller spent between two local days, by model and by
 * day.
 *
 * The range is inclusive on both ends and is read in `tz` — the caller's own zone, which the web
 * app reads from `Intl.DateTimeFormat().resolvedOptions().timeZone` and `oh` the same way in
 * Node. `tz` is echoed back because a day means different instants in different zones: a
 * response says which reading of "the 3rd" it answered.
 *
 * `by_model` is the range as a whole; `by_day` is the same requests cut by local day, so the two
 * answer different questions and neither is derived from the other on the wire (a client that
 * shows a chart of the days needs the days, and one that shows the expensive models needs the
 * models). Both are ordered — models by total tokens descending (then by id, so the order is
 * total whatever the prices turn out to be), days ascending — so a client renders them as they
 * arrive.
 */
export const UserUsageSchema = z.object({
  /** The first local day the totals cover, inclusive. */
  from: LocalDaySchema,
  /** The last local day the totals cover, inclusive. */
  to: LocalDaySchema,
  /** The IANA zone the days were read in, e.g. `Asia/Kolkata`; `UTC` when the caller named none. */
  tz: z.string().min(1),
  /** Every request in the range, summed. */
  totals: UsageTotalsSchema,
  /** What `totals` cost, and how many requests in the range had no price. */
  ...TotalCostSchema.shape,
  /** The range's totals per model, biggest first. */
  by_model: z.array(ModelUsageBreakdownSchema),
  /** The range's totals per local day, ascending; days with no request are absent. */
  by_day: z.array(DailyUsageSchema),
  /** How many `web_search` calls the range made; see {@link UsageSearchesSchema}. */
  searches: UsageSearchesSchema,
})

export type UserUsage = z.infer<typeof UserUsageSchema>

/**
 * Query parameters of `GET /v1/me/usage`.
 *
 * `from` and `to` default to the **current month so far** in `tz` (the first of the month
 * through today, both inclusive) — the range the Settings screen opens on. `tz` defaults to
 * `UTC`, and a zone the server does not recognise is a 400 `invalid_request_error` rather than
 * a silently different answer. A `from` after `to` is a 400 too.
 */
export const UserUsageQuerySchema = z.object({
  /** The first day to include; defaults to the first of the current month in `tz`. */
  from: LocalDaySchema.optional(),
  /** The last day to include; defaults to today in `tz`. */
  to: LocalDaySchema.optional(),
  /** An IANA time zone, e.g. `Europe/Berlin`; defaults to `UTC`. */
  tz: z.string().min(1).optional(),
})

export type UserUsageQuery = z.infer<typeof UserUsageQuerySchema>
