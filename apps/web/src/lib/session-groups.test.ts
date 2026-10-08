import type { Session } from '@openharness/protocol'
import { makeSession } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import { groupSessionsByDate, SESSION_GROUP_LABELS } from './session-groups'

/**
 * The chat list's date buckets (epic #201, U10).
 *
 * Every case pins the clock: `now` is a parameter of the function, so "Today" means the day
 * this test says it is rather than the day it happens to run — a suite that passed in the
 * morning and failed at midnight would be worse than no suite.
 *
 * The timestamps are built from local date parts (`new Date(2026, 2, 15, …)`), because the
 * buckets are local calendar days: building them from a UTC string would make the assertions
 * depend on the machine's timezone, which is exactly what the rule is about.
 */

/**
 * A session dated when the case needs it.
 *
 * Built from the protocol's own `makeSession`, so the id is a real branded `sesn_` one: the
 * grouping reads nothing but `created_at`, and a hand-written literal would be a session shape
 * this package does not actually have.
 */
function session(createdAt: string): Session {
  return makeSession({ created_at: createdAt, updated_at: createdAt })
}

/** A timestamp `daysAgo` local days before `now`, at the hour given. */
function daysBefore(now: number, daysAgo: number, hour = 12): string {
  const date = new Date(now)
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}

const NOW = new Date(2026, 2, 15, 14, 30, 0).getTime() // 15 March 2026, 14:30 local

describe('groupSessionsByDate', () => {
  it('puts each session in its own bucket, in the order they were listed', () => {
    const today = session(daysBefore(NOW, 0, 9))
    const yesterday = session(daysBefore(NOW, 1, 23))
    const lastWeek = session(daysBefore(NOW, 7))
    const older = session(daysBefore(NOW, 30))

    expect(groupSessionsByDate([today, yesterday, lastWeek, older], NOW)).toEqual([
      { label: SESSION_GROUP_LABELS.today, sessions: [today] },
      { label: SESSION_GROUP_LABELS.yesterday, sessions: [yesterday] },
      { label: SESSION_GROUP_LABELS.week, sessions: [lastWeek] },
      { label: SESSION_GROUP_LABELS.older, sessions: [older] },
    ])
  })

  it('is calendar days, not 24-hour windows', () => {
    // Four hours apart, but either side of midnight: yesterday and today, not one bucket.
    const lateYesterday = session(daysBefore(NOW, 1, 23))
    const earlyToday = session(daysBefore(NOW, 0, 3))

    expect(
      groupSessionsByDate([earlyToday, lateYesterday], NOW).map((group) => group.label),
    ).toEqual([SESSION_GROUP_LABELS.today, SESSION_GROUP_LABELS.yesterday])
  })

  it('counts the seventh day back as the last of the week, and the eighth as older', () => {
    const seven = session(daysBefore(NOW, 7))
    const eight = session(daysBefore(NOW, 8))

    const groups = groupSessionsByDate([seven, eight], NOW)
    expect(groups).toEqual([
      { label: SESSION_GROUP_LABELS.week, sessions: [seven] },
      { label: SESSION_GROUP_LABELS.older, sessions: [eight] },
    ])
  })

  it('leaves out the buckets nothing landed in', () => {
    const groups = groupSessionsByDate([session(daysBefore(NOW, 400))], NOW)
    expect(groups.map((group) => group.label)).toEqual([SESSION_GROUP_LABELS.older])
  })

  it('keeps a session whose timestamp cannot be read, rather than losing the row', () => {
    // The sidebar is the only way to an older chat: a row that cannot be dated is still a row.
    const broken = session('not a timestamp')
    expect(groupSessionsByDate([broken], NOW)).toEqual([
      { label: SESSION_GROUP_LABELS.older, sessions: [broken] },
    ])
  })

  it('treats a timestamp in the future as today', () => {
    // A server whose clock is ahead, or a row written while this tab was open: a fifth bucket
    // nobody named would be worse than a slightly early "today".
    const ahead = session(daysBefore(NOW, -2))
    expect(groupSessionsByDate([ahead], NOW)).toEqual([
      { label: SESSION_GROUP_LABELS.today, sessions: [ahead] },
    ])
  })

  it('keeps the sessions of one bucket in the order they came in', () => {
    const first = session(daysBefore(NOW, 0, 13))
    const second = session(daysBefore(NOW, 0, 12))
    const groups = groupSessionsByDate([first, second], NOW)
    expect(groups[0]?.sessions.map((one) => one.id)).toEqual([first.id, second.id])
  })

  it('groups nothing into nothing', () => {
    expect(groupSessionsByDate([], NOW)).toEqual([])
  })
})
