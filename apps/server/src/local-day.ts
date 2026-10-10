import type { LocalDay } from '@openharness/protocol'

import { invalidRequest } from './http/errors'

/**
 * Local calendar days (epic #245, A2; issue #247).
 *
 * "What did I spend today" means the reader's today, not UTC's — so the usage route takes the
 * caller's IANA zone, and every request timestamp is grouped by the day it fell on *there*.
 * This module is the whole of that arithmetic: which zone a request names, which day an instant
 * belongs to, and what a range means.
 *
 * Two decisions are worth knowing before reading it:
 *
 * - **The days are computed, never stored.** Nothing is rolled up: the log holds instants, and
 *   the day an instant belongs to depends on the zone it is read in, so grouping happens on the
 *   read that asked for it. Two readers in two zones get two answers from one log, which is the
 *   correct answer for both.
 * - **`Intl`, not SQL.** Postgres could group with `AT TIME ZONE`, but the reading would then
 *   be a different one per store — the in-memory store has no SQL at all — and the zone
 *   database would be the database server's rather than the runtime's. Node's `Intl` carries
 *   the same IANA data (`Asia/Kolkata` and its half-hour offset included), answers the same
 *   question in every implementation, and is the same source the frontends read their own zone
 *   from. The grouping is exact either way; only the engine differs.
 */

/** The zone a request's days are read in when it names none: UTC, the protocol's default. */
export const DEFAULT_TIME_ZONE = 'UTC'

/**
 * The zone a request asked for, or {@link DEFAULT_TIME_ZONE} — refusing one that is not an IANA
 * zone name.
 *
 * A zone the runtime does not know is a **400 `invalid_request_error`**, not a silent UTC:
 * answering a caller's "what did I spend in October" in another zone's October would be wrong
 * in a way they could not see.
 *
 * @param tz the `tz` query parameter, or `undefined` when the request carried none
 * @throws HttpError the protocol's 400 when the zone is not one the runtime knows
 */
export function resolveTimeZone(tz: string | undefined): string {
  if (tz === undefined) {
    return DEFAULT_TIME_ZONE
  }
  if (!isTimeZone(tz)) {
    throw invalidRequest(
      `tz must be an IANA time zone name such as "Europe/Berlin", got ${JSON.stringify(tz)}`,
    )
  }
  return tz
}

/** Whether the runtime knows this zone. `Intl` throws for anything that is not a name it has. */
export function isTimeZone(tz: string): boolean {
  try {
    formatterFor(tz)
    return true
  } catch {
    return false
  }
}

/**
 * The local day an instant falls on, as `YYYY-MM-DD` in `tz`.
 *
 * @param instant an instant: a `Date`, or anything `new Date()` reads (a `processed_at`)
 * @param tz an IANA zone name, as {@link resolveTimeZone} answered
 */
export function localDayOf(instant: string | Date, tz: string): LocalDay {
  const parts = formatterFor(tz).formatToParts(
    typeof instant === 'string' ? new Date(instant) : instant,
  )
  const partOf = (type: 'year' | 'month' | 'day'): string =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${partOf('year')}-${partOf('month')}-${partOf('day')}`
}

/**
 * Today in `tz`.
 *
 * @param tz an IANA zone name
 * @param now the instant to read; defaults to this process's clock
 */
export function todayIn(tz: string, now: Date = new Date()): LocalDay {
  return localDayOf(now, tz)
}

/**
 * The first day of the month `day` is in: the start of the range a Settings screen opens on.
 *
 * @param day a local day, `YYYY-MM-DD`
 */
export function firstOfMonth(day: LocalDay): LocalDay {
  return `${day.slice(0, 7)}-01`
}

/**
 * The days a usage request covers, and the zone they are read in.
 *
 * `from` and `to` are inclusive local days in `tz`; the route fills in the defaults (the current
 * month so far) before calling anything that reads a log.
 */
export interface UsageRange {
  /** The first day to include, inclusive. */
  readonly from: LocalDay
  /** The last day to include, inclusive. */
  readonly to: LocalDay
  /** The IANA zone the days are read in. */
  readonly tz: string
}

/**
 * The range a request asked for: its days, its zone, and the defaults it left out.
 *
 * `from` defaults to the first of the month `to` falls in and `to` to today — "this month" — so
 * a request with no parameters at all still answers something a reader asked for. A `from`
 * after `to` is a 400: an empty range is a range no client meant to ask for.
 *
 * @param query the parsed `from`/`to`/`tz` query parameters
 * @param now the instant "today" is read from; defaults to this process's clock
 * @throws HttpError the protocol's 400 for a zone the runtime does not know, or `from > to`
 */
export function usageRange(
  query: { readonly from?: LocalDay; readonly to?: LocalDay; readonly tz?: string },
  now: Date = new Date(),
): UsageRange {
  const tz = resolveTimeZone(query.tz)
  const to = query.to ?? todayIn(tz, now)
  const from = query.from ?? firstOfMonth(to)
  if (from > to) {
    throw invalidRequest(`from must not be after to, got from ${from} and to ${to}`)
  }
  return { from, to, tz }
}

/**
 * Whether a day falls inside a range.
 *
 * The comparison is a string one, and it is exact: `YYYY-MM-DD` sorts lexicographically in date
 * order, which is the point of the shape.
 */
export function dayInRange(day: LocalDay, range: UsageRange): boolean {
  return day >= range.from && day <= range.to
}

/**
 * The UTC instants a range's local days span: local midnight of `from`, to local midnight of
 * the day after `to`.
 *
 * Reading a user's usage is one store query over a window of instants (`listModelRequests`,
 * A2/#247), so the local days the caller asked for have to become a window before the log is
 * read. The window is exactly the instants whose local day falls inside the range: nothing
 * outside it is read — which is what keeps a month of another year out of the answer — and
 * nothing inside it is missed. The upper bound is the midnight **after** `to` because the
 * window is half-open: an instant at exactly that midnight is already the next day.
 *
 * A local day is not always 24 hours — a DST transition makes it 23 or 25 — so a bound is a
 * day's first instant as the runtime's zone data has it ({@link startOfLocalDay}), not
 * midnight plus a fixed offset. That is also why a time zone whose transition lands at
 * midnight answers the instant its day actually starts at.
 */
export function utcWindowOf(range: UsageRange): { from: Date; to: Date } {
  return {
    from: startOfLocalDay(range.from, range.tz),
    to: startOfLocalDay(dayAfter(range.to), range.tz),
  }
}

/**
 * The first instant that falls on `day` in `tz` — the instant that local day starts at.
 *
 * Found by bisection rather than by arithmetic: `day`'s start is bracketed by a day either side
 * of its UTC midnight — no zone is more than 14 hours from UTC, and no day is longer than 25
 * hours, so the bracket contains it — and narrowed with {@link localDayOf}, the one place this
 * module says which day an instant is on. Asking the same question of two instants and keeping
 * the answer is what makes this exact in a zone where the day starts before or after midnight,
 * or where it is 23 or 25 hours long: there is nothing to get wrong about an offset.
 */
function startOfLocalDay(day: LocalDay, tz: string): Date {
  const utcMidnight = Date.parse(`${day}T00:00:00.000Z`)
  // The invariant the loop holds: `low` is on a day before `day`, `high` is on `day` or after.
  // A zoned day never runs backwards as the instant moves forward, so this step is monotone —
  // the predicate is false once and true from then on, and the bisection finds the boundary.
  let low = utcMidnight - DAY_MS
  let high = utcMidnight + DAY_MS
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2)
    if (localDayOf(new Date(middle), tz) < day) {
      low = middle
    } else {
      high = middle
    }
  }
  return new Date(high)
}

/** The local day after `day`: calendar arithmetic, so no zone is involved and DST cannot move it. */
function dayAfter(day: LocalDay): LocalDay {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10)
}

/** One day in milliseconds. */
const DAY_MS = 86_400_000

/**
 * One formatter per zone, built once: `Intl.DateTimeFormat` construction is the expensive half
 * of formatting, and a usage read formats one instant per request.
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz)
  if (cached !== undefined) {
    return cached
  }
  // `en-CA` is only the fallback spelling; the parts are read by name below, so the locale
  // never decides the answer. `undefined` reads the runtime's zone, which `isTimeZone` uses.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  formatters.set(tz, formatter)
  return formatter
}
