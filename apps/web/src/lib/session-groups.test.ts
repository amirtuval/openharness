import type { Session } from '@openharness/protocol'
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

/** A session with nothing but the field the grouping reads. */
function session(id: string, createdAt: string): Session {
  return {
    id,
    type: 'session',
    owner_id: 'user_1',
    status: 'idle',
    title: null,
    metadata: {},
    model: { id: 'openai/gpt-5.1-mini' },
    system: null,
    agent: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
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
    const today = session('a', daysBefore(NOW, 0, 9))
    const yesterday = session('b', daysBefore(NOW, 1, 23))
    const lastWeek = session('c', daysBefore(NOW, 7))
    const older = session('d', daysBefore(NOW, 30))

    expect(groupSessionsByDate([today, yesterday, lastWeek, older], NOW)).toEqual([
      { label: SESSION_GROUP_LABELS.today, sessions: [today] },
      { label: SESSION_GROUP_LABELS.yesterday, sessions: [yesterday] },
      { label: SESSION_GROUP_LABELS.week, sessions: [lastWeek] },
      { label: SESSION_GROUP_LABELS.older, sessions: [older] },
    ])
  })

  it('is calendar days, not 24-hour windows', () => {
    // Four hours apart, but either side of midnight: yesterday and today, not one bucket.
    const lateYesterday = session('late', daysBefore(NOW, 1, 23))
    const earlyToday = session('early', daysBefore(NOW, 0, 3))

    expect(
      groupSessionsByDate([earlyToday, lateYesterday], NOW).map((group) => group.label),
    ).toEqual([SESSION_GROUP_LABELS.today, SESSION_GROUP_LABELS.yesterday])
  })

  it('counts the seventh day back as the last of the week, and the eighth as older', () => {
    const seven = session('seven', daysBefore(NOW, 7))
    const eight = session('eight', daysBefore(NOW, 8))

    const groups = groupSessionsByDate([seven, eight], NOW)
    expect(groups).toEqual([
      { label: SESSION_GROUP_LABELS.week, sessions: [seven] },
      { label: SESSION_GROUP_LABELS.older, sessions: [eight] },
    ])
  })

  it('leaves out the buckets nothing landed in', () => {
    const groups = groupSessionsByDate([session('only', daysBefore(NOW, 400))], NOW)
    expect(groups.map((group) => group.label)).toEqual([SESSION_GROUP_LABELS.older])
  })

  it('keeps a session whose timestamp cannot be read, rather than losing the row', () => {
    // The sidebar is the only way to an older chat: a row that cannot be dated is still a row.
    const broken = session('broken', 'not a timestamp')
    expect(groupSessionsByDate([broken], NOW)).toEqual([
      { label: SESSION_GROUP_LABELS.older, sessions: [broken] },
    ])
  })

  it('treats a timestamp in the future as today', () => {
    // A server whose clock is ahead, or a row written while this tab was open: a fifth bucket
    // nobody named would be worse than a slightly early "today".
    const ahead = session('ahead', daysBefore(NOW, -2))
    expect(groupSessionsByDate([ahead], NOW)).toEqual([
      { label: SESSION_GROUP_LABELS.today, sessions: [ahead] },
    ])
  })

  it('keeps the sessions of one bucket in the order they came in', () => {
    const first = session('first', daysBefore(NOW, 0, 13))
    const second = session('second', daysBefore(NOW, 0, 12))
    const groups = groupSessionsByDate([first, second], NOW)
    expect(groups[0]?.sessions.map((one) => one.id)).toEqual(['first', 'second'])
  })

  it('groups nothing into nothing', () => {
    expect(groupSessionsByDate([], NOW)).toEqual([])
  })
})
