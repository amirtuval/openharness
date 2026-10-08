import {
  EVENT_TYPES,
  type ModelRequestEndEvent,
  type ModelRequestStartEvent,
  type SessionStatusIdleEvent,
  type Supersedes,
} from '@openharness/protocol'

import type { AppendableEvent, CompactOptions } from './store'

/**
 * What both stores do with the events they store, in one place.
 *
 * The in-memory store and the Postgres store share these rules so they cannot drift: which
 * event types are the user's, what a `supersedes` range has to look like before it is recorded
 * (a reply's chunks, or the tail a `session.rewind` restarts from, #238), which events such a
 * range covers when replay skips them or {@link SessionStore.compact} deletes them, and how a
 * compaction cutoff is read. Everything else about storing is each implementation's own; this
 * is only the part the contract speaks about.
 *
 * (The keyset cursors and argument checks the stores also share live in `inputs.ts`.)
 */

/** Whether an event type is one the user writes; those are queued until a claim takes them. */
export function isUserEventType(type: string): boolean {
  return type === EVENT_TYPES.userMessage || type === EVENT_TYPES.userInterrupt
}

/** The event types that can carry a claim on user events, and so change what is pending. */
export type ClaimsEvent = ModelRequestStartEvent | ModelRequestEndEvent | SessionStatusIdleEvent

/**
 * Whether an event is one of the three types whose `consumes` claims user events (P4).
 *
 * The same three everywhere: a `span.model_request_start` claims the messages its request
 * answers, a `span.model_request_end` claims the interrupts that cut its request short, and a
 * `session.status_idle` claims the interrupts a turn that had nothing running ended on.
 */
export function carriesConsumes(event: { readonly type: string }): event is ClaimsEvent {
  return (
    event.type === EVENT_TYPES.modelRequestStart ||
    event.type === EVENT_TYPES.modelRequestEnd ||
    event.type === EVENT_TYPES.sessionStatusIdle
  )
}

/** The event types whose stored events are stream chunks, the only kind a reply supersedes. */
export function isChunkType(type: string): boolean {
  return type === EVENT_TYPES.eventStart || type === EVENT_TYPES.eventDelta
}

/**
 * What a recorded `supersedes` range covers.
 *
 * The event that carries a range decides which kind it is, and so what may disappear:
 *
 * - `chunks` — a reply's range (D9, issue #46): the `event_start` / `event_delta` events the
 *   finished `agent.message` (or the `span.model_request_end` that closes a request which
 *   stored none) replaces. Only chunks.
 * - `rewind` — a `session.rewind` (#238): the tail of the log from the `user.message` the
 *   reader edited through the event before the rewind. Every event in it, whatever its type.
 */
export type SupersessionKind = 'chunks' | 'rewind'

/**
 * The kind a `session.rewind` records (#238).
 *
 * One constant for the value both stores write beside a rewind's range and both test for in
 * their reads: the in-memory store's rule and the Postgres store's SQL have to mean the same
 * thing, and a string spelled twice is where they would stop.
 */
export const REWIND_KIND = 'rewind'

/**
 * One recorded `supersedes` range: the shape both stores hold and read.
 *
 * The Postgres store's `event_supersessions` row and the in-memory store's record are the same
 * facts — the range, the event that carries it, and when it was written — under different
 * storage, which is what lets one {@link isSuperseded} answer for both.
 */
export interface SupersessionRecord {
  /** The first replaced `seq` — the reply's `event_start`, or the edited `user.message`. */
  readonly fromSeq: number
  /** The last replaced `seq` — the reply's final `event_delta`, or the log's end at the rewind. */
  readonly toSeq: number
  /** What the range covers; see {@link SupersessionKind}. */
  readonly kind: SupersessionKind
  /** The event that carries the range: the stored message, the span end, or the rewind. */
  readonly byEventId: string
  /** That event's own `seq`; the range always ends before it. */
  readonly bySeq: number
  /** When the store wrote the superseding event, for {@link SessionStore.compact}'s window. */
  readonly createdAtMs: number
}

/**
 * An event of a batch as the store is about to record it: the caller's event with the `id`
 * and `seq` this store gave it.
 *
 * This is the shape both stores check a batch's ranges in, before anything is written — a
 * range is about positions in the log, and the store's `seq`s are what makes it exact.
 */
export type AppendedEvent = AppendableEvent & { readonly id: string; readonly seq: number }

/**
 * The slice of an event that recording a supersession needs: its identity, its position, its
 * type, and the range it carries. A whole `StoredEvent` satisfies it; so does an append's
 * event once the `seq` the store assigned it is put on.
 *
 * A rewind brings `from_seq` instead of `supersedes` (#238): how far it reaches is the store's
 * to say — the event it is in follows the log's end, so its range stops at its own `seq` minus
 * one — and the caller only names the message the session restarts from.
 */
export interface SupersedingEvent {
  readonly id: string
  readonly seq: number
  readonly type: string
  /** The chunk range this event replaces; see `SupersedesSchema` in the protocol. */
  readonly supersedes?: Supersedes | undefined
  /** A rewind's `from_seq`: the `user.message` the session restarts from (#238). */
  readonly from_seq?: number | undefined
}

/** The range an event records, or `undefined` when it records none. */
function rangeOf(
  event: SupersedingEvent,
):
  | { readonly fromSeq: number; readonly toSeq: number; readonly kind: SupersessionKind }
  | undefined {
  if (event.type === EVENT_TYPES.sessionRewind) {
    // A rewind reaches from the edited message through the end of the log, and the event
    // itself is written right behind that end: its own `seq` minus one is where the range
    // stops. `from_seq` is the caller's; everything else is the store's.
    return {
      fromSeq: event.from_seq ?? Number.NaN,
      toSeq: event.seq - 1,
      kind: REWIND_KIND,
    }
  }
  const range = event.supersedes
  if (range === undefined) {
    return undefined
  }
  return { fromSeq: range.from_seq, toSeq: range.to_seq, kind: 'chunks' }
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
    const range = rangeOf(event)
    if (range === undefined) {
      continue
    }
    const { fromSeq, toSeq, kind } = range
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
    records.push({ fromSeq, toSeq, kind, byEventId: event.id, bySeq: event.seq, createdAtMs: now })
  }
  return records
}

/**
 * What the log says about one `seq`, for {@link assertRewinds}: the event's type, and whether
 * a recorded range already covers it.
 *
 * The two stores answer this their own way — the in-memory store from its own record, the
 * Postgres store from one query — and the rule below is written once against the answer.
 */
export interface RewindTarget {
  readonly type: string
  readonly superseded: boolean
}

/**
 * Check the rewind ranges a batch carries against the log, before any of it is recorded.
 *
 * A rewind's `from_seq` has to name a `user.message` of this session that no recorded range
 * already covers: a session restarts from a message a reader can still see, and a message an
 * earlier range replaced is not one — the tail it would start in is already gone. It cannot
 * name an event after the rewind either, which is what {@link supersessionsOf} refuses beside
 * this. Anything else is a caller bug and a `RangeError`, and the append is refused whole —
 * nothing stored, nothing claimed, no range recorded.
 *
 * The `seq`s are the store's, assigned before this runs, so the check is exact. `target` is
 * the log's own answer about a `seq`; only the store has the log, so it is the store's to
 * give — but the rule itself is written here and nowhere else, which is what keeps the two
 * implementations from drifting.
 *
 * @param events the batch, with the `seq` the store assigned each event already on it
 * @param target what the log says about a `seq`, or `undefined` when it holds no event there
 */
export function assertRewinds(
  events: readonly SupersedingEvent[],
  target: (seq: number) => RewindTarget | undefined,
): void {
  for (const event of events) {
    if (event.type !== EVENT_TYPES.sessionRewind) {
      continue
    }
    const fromSeq = event.from_seq
    if (!isEventSeq(fromSeq)) {
      throw new RangeError(
        `the rewind of ${String(event.id)} starts at seq ${String(fromSeq)}, which is not a position in this log`,
      )
    }
    const named = target(fromSeq)
    if (named === undefined || named.type !== EVENT_TYPES.userMessage) {
      throw new RangeError(
        `the rewind of ${String(event.id)} starts at seq ${fromSeq}, which is not a user.message of this session`,
      )
    }
    if (named.superseded) {
      throw new RangeError(
        `the rewind of ${String(event.id)} starts at seq ${fromSeq}, a message an earlier range already replaced`,
      )
    }
  }
}

/**
 * Whether an event is superseded: its `seq` lies inside a recorded range that covers its type.
 *
 * This is the one place that answers the question, and everything that must not see a
 * superseded event asks it here — replay and the transcript, the pending list, the work scan,
 * claim validation, and compaction beside its age window. Who recorded the range does not
 * matter; the range's {@link SupersessionKind} and the event's `seq` and `type` do: a reply's
 * range covers its chunks, and only chunks, while a rewind's covers every event in the tail it
 * restarts.
 */
export function isSuperseded(
  event: { readonly type: string; readonly seq: number },
  ranges: readonly SupersessionRecord[] | undefined,
): boolean {
  if (ranges === undefined || ranges.length === 0) {
    return false
  }
  return ranges.some(
    (range) =>
      event.seq >= range.fromSeq &&
      event.seq <= range.toSeq &&
      (range.kind === 'rewind' || isChunkType(event.type)),
  )
}

/**
 * Whether a value is a usable `seq`: a positive integer.
 *
 * What `EventSeqSchema` says on the wire, checked here for a value the store is about to
 * write: a range that names something else is a caller bug and a `RangeError`, not an event
 * the log would have to reject later.
 */
export function isEventSeq(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
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
