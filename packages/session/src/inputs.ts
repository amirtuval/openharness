import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  decodePageCursor,
  type KeyCursor,
  type SeqCursor,
} from '@openharness/protocol'

/**
 * The checks every store applies to a caller's arguments before it touches its own state.
 *
 * Both stores — the in-memory fake and the Postgres one — clamp a `limit`, decode an opaque
 * `page` cursor and reject a lease ttl the same way, so a client sees the same answer
 * whichever store it is talking to. What stays with each store is the *order* of the lists
 * and how a keyset cursor is compared: in memory that is an array comparison, in Postgres an
 * `ORDER BY` and a row comparison (the `C` collation is what makes the two agree).
 */

/** The page size to use: `limit` clamped into `[1, MAX_PAGE_LIMIT]`, or the protocol default. */
export function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PAGE_LIMIT
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT)
}

/** Decode the `page` of an events list, which is a `seq` position. */
export function decodeSeqPage(page: string): SeqCursor {
  const cursor = decodePageCursor(page)
  if (cursor.kind !== 'seq') {
    throw new RangeError(`listEvents takes a seq cursor, but got a ${cursor.kind} cursor`)
  }
  return cursor
}

/** Decode the `page` of an agent or session list, which is a keyset position. */
export function decodeKeyPage(page: string): KeyCursor {
  const cursor = decodePageCursor(page)
  if (cursor.kind !== 'key') {
    throw new RangeError(`this list takes a key cursor, but got a ${cursor.kind} cursor`)
  }
  return cursor
}

/** A lease only lasts a positive amount of time; anything else is a caller bug, not a lease. */
export function assertTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`ttlMs must be a positive, finite number of milliseconds, got ${ttlMs}`)
  }
}
