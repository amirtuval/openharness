import type { Session } from '@openharness/protocol'

/**
 * The chat list, split into the four date buckets a reader looks for (epic #201, U10).
 *
 * The sidebar used to be one flat list with a "3d ago" line per row: fine for a handful of
 * chats, unreadable at forty. The same list under four headings — **Today**, **Yesterday**,
 * **Previous 7 days**, **Older** — is the shape every chat app settled on, and it needs no
 * state of its own: the server already pages the list newest-first by `created_at`, which is
 * the field the cursor is built from, so the buckets are contiguous slices of what arrived and
 * nothing has to be sorted here.
 *
 * Two rules worth stating:
 *
 * - **Days are the reader's days.** The buckets are local calendar dates, not 24-hour windows:
 *   something said at 23:50 is under Yesterday at 00:10, where "20m ago" would have been a
 *   worse answer. The comparison is done on the date parts (via `Date.UTC` of the local
 *   y/m/d) so a daylight-saving day, which is 23 or 25 hours long, still counts as one.
 * - **Nothing is dropped.** A timestamp in the future — a skewed clock on a server, or a row
 *   written while this tab was open — is Today rather than a fifth bucket, and one that does
 *   not parse at all is Older rather than missing: the list in the sidebar is the only way to
 *   an older chat, so a row that cannot be dated is still a row.
 *
 * Empty buckets are left out, so "Yesterday" does not appear above nothing.
 */

/** The heading for each bucket, in the order they are rendered. */
export const SESSION_GROUP_LABELS = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Older',
} as const

/** One heading and the chats under it, newest first. */
export interface SessionGroup {
  readonly label: string
  readonly sessions: readonly Session[]
}

/**
 * Split a list of sessions into date buckets.
 *
 * @param sessions the list, newest first (the server's order)
 * @param now the "today" the buckets are measured from — a parameter so a test can pin the
 *   clock, and so every row of one render is judged against the same moment
 */
export function groupSessionsByDate(
  sessions: readonly Session[],
  now: number = Date.now(),
): readonly SessionGroup[] {
  const buckets: { label: string; sessions: Session[] }[] = [
    { label: SESSION_GROUP_LABELS.today, sessions: [] },
    { label: SESSION_GROUP_LABELS.yesterday, sessions: [] },
    { label: SESSION_GROUP_LABELS.week, sessions: [] },
    { label: SESSION_GROUP_LABELS.older, sessions: [] },
  ]

  for (const session of sessions) {
    buckets[bucketFor(session.created_at, now)]?.sessions.push(session)
  }

  return buckets.filter((bucket) => bucket.sessions.length > 0)
}

/** Which of the four buckets a timestamp belongs in. */
function bucketFor(createdAt: string, now: number): 0 | 1 | 2 | 3 {
  const daysAgo = daysBetween(Date.parse(createdAt), now)
  if (Number.isNaN(daysAgo)) {
    return 3
  }
  if (daysAgo <= 0) {
    return 0
  }
  if (daysAgo === 1) {
    return 1
  }
  return daysAgo <= 7 ? 2 : 3
}

/**
 * Whole local days from `then` to `now`, negative when `then` is in the future.
 *
 * The date *parts* are compared, not the timestamps: a stamp at 23:00 yesterday is one day
 * from a stamp at 01:00 today even though four hours apart, and the two ends of a
 * daylight-saving change are 23 or 25 hours apart and still one day.
 */
function daysBetween(then: number, now: number): number {
  const from = new Date(then)
  const to = new Date(now)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return Number.NaN
  }
  const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((toDay - fromDay) / 86_400_000)
}
