import { EVENT_TYPES, type Supersedes } from '@openharness/protocol'

import type { CompactOptions } from './store'

/**
 * What both stores do with the events they store, in one place.
 *
 * The in-memory store and the Postgres store share these rules so they cannot drift: which
 * event types are the user's, what a `supersedes` range has to look like before it is recorded,
 * which events such a range covers when replay skips them or {@link SessionStore.compact}
 * deletes them, and how a compaction cutoff is read. Everything else about storing is each
 * implementation's own; this is only the part the contract speaks about.
 *
 * (The keyset cursors and argument checks the stores also share live in `inputs.ts`.)
 */

/** Whether an event type is one the user writes; those are queued until a claim takes them. */
export function isUserEventType(type: string): boolean {
  return type === EVENT_TYPES.userMessage || type === EVENT_TYPES.userInterrupt
}

/** The event types whose stored events are stream chunks, the only kind a reply supersedes. */
export function isChunkType(type: string): boolean {
  return type === EVENT_TYPES.eventStart || type === EVENT_TYPES.eventDelta
}

/**
 * One recorded `supersedes` range: the shape both stores hold and read.
 *
 * The Postgres store's `event_supersessions` row and the in-memory store's record are the same
 * facts — the range, the event that carries it, and when it was written — under different
 * storage, which is what lets one `isSupersededChunk` answer for both.
 */
export interface SupersessionRecord {
  /** The first replaced `seq` — the reply's `event_start`. */
  readonly fromSeq: number
  /** The last replaced `seq` — the reply's final `event_delta`. */
  readonly toSeq: number
  /** The event that carries the range: the stored message, or the span end. */
  readonly byEventId: string
  /** That event's own `seq`; the range always ends before it. */
  readonly bySeq: number
  /** When the store wrote the superseding event, for {@link SessionStore.compact}'s window. */
  readonly createdAtMs: number
}

/**
 * The slice of an event that recording a supersession needs: its identity, its position, and
 * the range it carries. A whole `StoredEvent` satisfies it; so does an append's event once the
 * `seq` the store assigned it is put on.
 */
export interface SupersedingEvent {
  readonly id: string
  readonly seq: number
  /** The chunk range this event replaces; see `SupersedesSchema` in the protocol. */
  readonly supersedes?: Supersedes | undefined
}

/**
 * The supersession records a batch carries, after checking each range against its own event.
 *
 * A range has to lie within the session that appends it and end before the superseding event's
 * own `seq`: `from_seq` is a positive position in this log, `to_seq` is at or after it and
 * strictly before the event that replaces the range. The seqs are the store's, assigned before
 * this runs, so the check is exact — a range that names a position at or after the superseding
 * event would be a claim about the future. Anything else is a caller bug and a `RangeError`,
 * and the append that carried it is refused whole.
 *
 * Both stores run this from their append path, so a range the in-memory store refuses the
 * Postgres store refuses too — and each then records what came back, insert-only.
 */
export function supersessionsOf(
  events: readonly SupersedingEvent[],
  now: number,
): SupersessionRecord[] {
  const records: SupersessionRecord[] = []
  for (const event of events) {
    const range = event.supersedes
    if (range === undefined) {
      continue
    }
    const { from_seq: fromSeq, to_seq: toSeq } = range
    if (
      !Number.isInteger(fromSeq) ||
      !Number.isInteger(toSeq) ||
      fromSeq < 1 ||
      toSeq < fromSeq ||
      toSeq >= event.seq
    ) {
      throw new RangeError(
        `the supersedes range ${fromSeq}..${toSeq} of ${event.id} is not before its own seq ${event.seq}`,
      )
    }
    records.push({ fromSeq, toSeq, byEventId: event.id, bySeq: event.seq, createdAtMs: now })
  }
  return records
}

/**
 * Whether an event is a chunk a recorded supersession covers: an `event_start` / `event_delta`
 * whose `seq` lies inside a recorded range.
 *
 * This is the test replay applies — the range and the chunk's `seq` decide, not who recorded
 * it — and compaction uses the same one beside its age window. Only chunks are ever skipped or
 * deleted: a range is recorded as the span of a reply's chunks, and nothing else may disappear.
 */
export function isSupersededChunk(
  event: { readonly type: string; readonly seq: number },
  ranges: readonly SupersessionRecord[] | undefined,
): boolean {
  if (ranges === undefined || ranges.length === 0 || !isChunkType(event.type)) {
    return false
  }
  return ranges.some((range) => event.seq >= range.fromSeq && event.seq <= range.toSeq)
}

/** The instant {@link SessionStore.compact} was given, as milliseconds, or a `RangeError`. */
export function cutoffOf(options: CompactOptions): number {
  const cutoff = options.olderThan instanceof Date ? options.olderThan.getTime() : options.olderThan
  if (typeof cutoff !== 'number' || !Number.isFinite(cutoff)) {
    throw new RangeError(
      `olderThan must be a Date or a finite number of milliseconds, got ${String(options.olderThan)}`,
    )
  }
  return cutoff
}
