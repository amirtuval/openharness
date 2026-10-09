import { describe, expect, it } from 'vitest'

import { currentMonthRange, formatDay, localDay, localTimeZone } from './usage'

/**
 * The reader's days (epic #245, A2; issue #247): the range the Usage card asks for, and the
 * day an instant belongs to. The server does the grouping; this is the half that has to agree
 * with it about which zone the days are in.
 */

describe('localDay', () => {
  it('reads an instant as the day it falls on in the zone', () => {
    expect(localDay(new Date('2026-10-08T12:00:00Z'), 'UTC')).toBe('2026-10-08')
    // 19:00Z is already the 9th in Kolkata (UTC+05:30).
    expect(localDay(new Date('2026-10-08T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-09')
    // …and 03:00Z is still the 7th in New York (UTC-04:00 in October).
    expect(localDay(new Date('2026-10-08T03:00:00Z'), 'America/New_York')).toBe('2026-10-07')
  })
})

describe('currentMonthRange', () => {
  it('is the month so far, in the zone it is given', () => {
    expect(currentMonthRange(new Date('2026-10-08T12:00:00Z'), 'UTC')).toEqual({
      from: '2026-10-01',
      to: '2026-10-08',
      tz: 'UTC',
    })
    // Kolkata is already into November at 19:00Z on the 31st of October: that reader's "this
    // month" is November, one day old — not October, which is what the server's own day would
    // have said.
    expect(currentMonthRange(new Date('2026-10-31T19:00:00Z'), 'Asia/Kolkata')).toEqual({
      from: '2026-11-01',
      to: '2026-11-01',
      tz: 'Asia/Kolkata',
    })
  })

  it('falls back to the runtime’s zone', () => {
    const range = currentMonthRange(new Date('2026-10-08T12:00:00Z'))
    expect(range.tz).toBe(localTimeZone())
    expect(range.from).toBe('2026-10-01')
  })
})

describe('formatDay', () => {
  it('reads a day the way a reader does, with the year only when it is not this one', () => {
    const now = new Date('2026-10-08T12:00:00Z')
    expect(formatDay('2026-10-08', now)).toBe('Oct 8')
    expect(formatDay('2026-01-31', now)).toBe('Jan 31')
    expect(formatDay('2025-12-31', now)).toBe('Dec 31, 2025')
  })

  it('hands back what it cannot read rather than a wrong day', () => {
    expect(formatDay('not-a-day')).toBe('not-a-day')
  })
})
