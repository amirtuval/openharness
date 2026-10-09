import { describe, expect, it } from 'vitest'
import type { LocalDay } from '@openharness/protocol'

import {
  dayInRange,
  DEFAULT_TIME_ZONE,
  firstOfMonth,
  isTimeZone,
  localDayOf,
  resolveTimeZone,
  todayIn,
  usageRange,
  utcWindowOf,
} from './local-day'
import { HttpError } from './http/errors'

/**
 * The zone and day arithmetic behind `GET /v1/me/usage` (epic #245, A2; issue #247).
 *
 * The zones are the interesting part: a half-hour offset, a zone that changes offset with the
 * season, and the negative side of UTC. Each case is a pair of instants a minute apart on
 * either side of a local midnight, which is the only way to show that the day is the reader's
 * and not UTC's.
 */

describe('resolveTimeZone', () => {
  it('answers UTC when the request named none', () => {
    expect(resolveTimeZone(undefined)).toBe(DEFAULT_TIME_ZONE)
    expect(DEFAULT_TIME_ZONE).toBe('UTC')
  })

  it('passes a zone the runtime knows through unchanged', () => {
    expect(resolveTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata')
    expect(resolveTimeZone('America/New_York')).toBe('America/New_York')
    expect(resolveTimeZone('UTC')).toBe('UTC')
  })

  it('refuses a zone the runtime does not know, with the protocol’s 400', () => {
    // A zone name the runtime has never heard of. (A fixed offset like `+05:30` is a zone the
    // runtime *does* understand, so it is accepted — the rule is "a zone this process can read
    // days in", and `Intl` is the whole of it.)
    for (const tz of ['Mars/Phobos', 'Europe/Nowhere', 'Nowhere', '']) {
      let thrown: unknown
      try {
        resolveTimeZone(tz)
      } catch (error) {
        thrown = error
      }
      expect(thrown, tz).toBeInstanceOf(HttpError)
      expect((thrown as HttpError).status, tz).toBe(400)
      expect((thrown as HttpError).type, tz).toBe('invalid_request_error')
      expect(isTimeZone(tz), tz).toBe(false)
    }
  })
})

describe('localDayOf', () => {
  it('reads a UTC instant as its own day', () => {
    expect(localDayOf('2026-10-08T00:00:00Z', 'UTC')).toBe('2026-10-08')
    expect(localDayOf('2026-10-08T23:59:59Z', 'UTC')).toBe('2026-10-08')
    expect(localDayOf(new Date('2026-10-09T00:00:00Z'), 'UTC')).toBe('2026-10-09')
  })

  it('rolls over at a half-hour offset (Asia/Kolkata, UTC+05:30)', () => {
    expect(localDayOf('2026-10-08T18:29:00Z', 'Asia/Kolkata')).toBe('2026-10-08')
    expect(localDayOf('2026-10-08T18:30:00Z', 'Asia/Kolkata')).toBe('2026-10-09')
  })

  it('rolls over behind UTC too (America/New_York)', () => {
    // October: UTC-04:00, so midnight local is 04:00Z.
    expect(localDayOf('2026-10-08T03:59:00Z', 'America/New_York')).toBe('2026-10-07')
    expect(localDayOf('2026-10-08T04:00:00Z', 'America/New_York')).toBe('2026-10-08')
  })

  it('follows a zone that changes offset with the season', () => {
    // The same reading in summer (EDT, UTC-04:00) and in winter (EST, UTC-05:00): the local
    // midnight moves by an hour, and the day with it.
    expect(localDayOf('2026-07-01T03:59:00Z', 'America/New_York')).toBe('2026-06-30')
    expect(localDayOf('2026-07-01T04:00:00Z', 'America/New_York')).toBe('2026-07-01')
    expect(localDayOf('2026-12-01T04:59:00Z', 'America/New_York')).toBe('2026-11-30')
    expect(localDayOf('2026-12-01T05:00:00Z', 'America/New_York')).toBe('2026-12-01')
  })
})

describe('firstOfMonth and todayIn', () => {
  it('answers the first day of the month a day is in', () => {
    expect(firstOfMonth('2026-10-08')).toBe('2026-10-01')
    expect(firstOfMonth('2026-10-01')).toBe('2026-10-01')
    expect(firstOfMonth('2026-01-31')).toBe('2026-01-01')
  })

  it('reads today in the zone it is asked for', () => {
    const instant = new Date('2026-10-08T18:30:00Z')
    expect(todayIn('UTC', instant)).toBe('2026-10-08')
    expect(todayIn('Asia/Kolkata', instant)).toBe('2026-10-09')
  })
})

describe('usageRange', () => {
  const now = new Date('2026-10-08T12:00:00Z')

  it('defaults to the current month so far', () => {
    expect(usageRange({}, now)).toEqual({ from: '2026-10-01', to: '2026-10-08', tz: 'UTC' })
  })

  it('reads the defaults in the zone the request named', () => {
    // 19:00Z is already the 9th in Kolkata (UTC+05:30), so "this month so far" ends there.
    expect(usageRange({ tz: 'Asia/Kolkata' }, new Date('2026-10-08T19:00:00Z'))).toEqual({
      from: '2026-10-01',
      to: '2026-10-09',
      tz: 'Asia/Kolkata',
    })
  })

  it('takes the days it is given, one or both', () => {
    expect(usageRange({ from: '2026-09-01' }, now)).toEqual({
      from: '2026-09-01',
      to: '2026-10-08',
      tz: 'UTC',
    })
    expect(usageRange({ to: '2026-03-15' }, now)).toEqual({
      from: '2026-03-01',
      to: '2026-03-15',
      tz: 'UTC',
    })
    expect(usageRange({ from: '2026-01-01', to: '2026-12-31', tz: 'Europe/Berlin' }, now)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
      tz: 'Europe/Berlin',
    })
  })

  it('refuses a range that ends before it starts', () => {
    expect(() => usageRange({ from: '2026-10-08', to: '2026-10-01' }, now)).toThrow(HttpError)
  })

  it('refuses a zone it does not know, before reading any day', () => {
    expect(() => usageRange({ tz: 'Mars/Phobos' }, now)).toThrow(HttpError)
  })
})

describe('dayInRange', () => {
  it('includes both ends', () => {
    const range = { from: '2026-10-01', to: '2026-10-08', tz: 'UTC' } as const
    expect(dayInRange('2026-10-01', range)).toBe(true)
    expect(dayInRange('2026-10-08', range)).toBe(true)
    expect(dayInRange('2026-10-05', range)).toBe(true)
    expect(dayInRange('2026-09-30', range)).toBe(false)
    expect(dayInRange('2026-10-09', range)).toBe(false)
  })
})

describe('utcWindowOf', () => {
  /** The instants a range spans, as the ISO strings a failure is readable in. */
  function windowOf(from: LocalDay, to: LocalDay, tz: string): { from: string; to: string } {
    const window = utcWindowOf({ from, to, tz })
    return { from: window.from.toISOString(), to: window.to.toISOString() }
  }

  it('spans the local days it was given, in UTC', () => {
    // A month: from the first day's midnight through the last day's end — the midnight of the
    // day after it, since the upper bound is exclusive.
    expect(windowOf('2026-10-01', '2026-10-31', 'UTC')).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    })
    expect(windowOf('2026-10-08', '2026-10-08', 'UTC')).toEqual({
      from: '2026-10-08T00:00:00.000Z',
      to: '2026-10-09T00:00:00.000Z',
    })
  })

  it('moves the bounds with the zone, half-hour offsets included', () => {
    // Midnight in Kolkata (UTC+05:30) is 18:30 the evening before, in UTC.
    expect(windowOf('2026-10-08', '2026-10-08', 'Asia/Kolkata')).toEqual({
      from: '2026-10-07T18:30:00.000Z',
      to: '2026-10-08T18:30:00.000Z',
    })
    expect(windowOf('2026-10-08', '2026-10-08', 'America/New_York')).toEqual({
      from: '2026-10-08T04:00:00.000Z',
      to: '2026-10-09T04:00:00.000Z',
    })
  })

  it('is DST-correct: the day the clocks go forward is 23 hours long', () => {
    // 2026-03-08 in New York: midnight is EST (UTC-05:00, 05:00Z) and the next midnight is EDT
    // (UTC-04:00, 04:00Z), so the window is 23 hours — not the 24 a fixed offset would give.
    expect(windowOf('2026-03-08', '2026-03-08', 'America/New_York')).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    })
    // And the day the clocks go back is 25: midnight EDT (04:00Z) to midnight EST (05:00Z).
    expect(windowOf('2026-11-01', '2026-11-01', 'America/New_York')).toEqual({
      from: '2026-11-01T04:00:00.000Z',
      to: '2026-11-02T05:00:00.000Z',
    })
  })

  it('keeps the offset it started with across a transition, not the one it ends on', () => {
    // March in New York changes offset inside the range: the lower bound is EST and the upper
    // is EDT, which is exactly what a fixed per-day 24 hours would get wrong.
    expect(windowOf('2026-03-01', '2026-03-31', 'America/New_York')).toEqual({
      from: '2026-03-01T05:00:00.000Z',
      to: '2026-04-01T04:00:00.000Z',
    })
  })

  it('answers a zone whose day does not begin at midnight', () => {
    // Cuba moves its clocks at 00:00 on 2026-03-08, so that day has no midnight at all: the
    // first instant that is the 8th there is 01:00 local, 05:00Z.
    expect(windowOf('2026-03-08', '2026-03-08', 'America/Havana')).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    })
  })

  it('brackets exactly the instants whose local day is in the range', () => {
    // The property the read depends on, over zones with a half-hour offset, both directions
    // from UTC, and a DST transition inside the window.
    const zones = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Australia/Sydney']
    for (const tz of zones) {
      const range = { from: '2026-03-01', to: '2026-03-10', tz } as const
      const { from, to } = utcWindowOf(range)
      // The lower bound is the range's first day, and the instant before it is not.
      expect(localDayOf(from, tz), tz).toBe(range.from)
      expect(localDayOf(new Date(from.getTime() - 1), tz), tz).toBe('2026-02-28')
      // The upper bound is the day after the range's last day, and the instant before it is
      // the last day — the whole of `to` is inside the window.
      expect(localDayOf(to, tz), tz).toBe('2026-03-11')
      expect(localDayOf(new Date(to.getTime() - 1), tz), tz).toBe(range.to)
      // Nothing is read outside the days asked for: every hour of the window is one of them.
      for (let at = from.getTime(); at < to.getTime(); at += 3_600_000) {
        expect(dayInRange(localDayOf(new Date(at), tz), range), `${tz} at ${at}`).toBe(true)
      }
    }
  })
})
