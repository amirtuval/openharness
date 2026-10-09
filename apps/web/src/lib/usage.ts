import type { LocalDay, UserUsageQuery } from '@openharness/protocol'

/**
 * The days the Usage card reads (epic #245, A2; issue #247).
 *
 * The server groups usage by **the reader's** local days, so the range this answers is written
 * in the reader's own zone: the zone comes from `Intl` (`resolvedOptions().timeZone` — the IANA
 * name the browser is configured with), the days are formatted in it, and both travel on the
 * request. Two readers either side of midnight ask about different days, which is what "this
 * month" means to each of them.
 *
 * `UTC` is the fallback for a runtime that will not name a zone: the server's own default, and
 * the honest answer when nobody knows where the reader is.
 */

/** The reader's IANA zone, as the browser reports it. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * This month so far: the first of the month through today, in the reader's zone.
 *
 * @param now the instant "today" is read from; defaults to now
 * @param tz the zone; defaults to {@link localTimeZone}
 */
export function currentMonthRange(
  now: Date = new Date(),
  tz: string = localTimeZone(),
): UserUsageQuery {
  const today = localDay(now, tz)
  return { from: `${today.slice(0, 7)}-01`, to: today, tz }
}

/** The day an instant falls on in `tz`, as `YYYY-MM-DD` — the server's own reading, in the app. */
export function localDay(instant: Date, tz: string): LocalDay {
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

/**
 * A day as a reader reads it: `Oct 8` — with the year only when it is not this one.
 *
 * @param day the local day, `YYYY-MM-DD`
 * @param now the instant "this year" is decided from; defaults to now
 */
export function formatDay(day: string, now: Date = new Date()): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number)
  if (year === undefined || month === undefined || dayOfMonth === undefined) {
    return day
  }
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(dayOfMonth)) {
    return day
  }
  const date = new Date(Date.UTC(year, month - 1, dayOfMonth))
  const monthName = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const thisYear = now.getUTCFullYear()
  return year === thisYear
    ? `${monthName} ${String(dayOfMonth)}`
    : `${monthName} ${String(dayOfMonth)}, ${String(year)}`
}
