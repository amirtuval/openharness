import { EVENT_TYPES, type StoredEvent } from '@openharness/protocol'

/**
 * The manual half of context compaction: what a `/compact [instructions]` request looks like in
 * the log, and whether one is still waiting for an answer (epic #277, K8; #283).
 *
 * A manual compaction is a pair of events, not a state: the client's request is a stored
 * `session.compact`, and the brain's answer is a stored `session.compaction` written after it
 * (see {@link summarizeContext}'s caller). "Pending" is therefore a fact about the log alone —
 * the newest `session.compact` has no `session.compaction` after it — which is what makes the
 * request idempotent at the route and lets the turn loop pick it up at any request boundary,
 * idle or running, without a second piece of bookkeeping to keep in step with the log.
 *
 * This module is deliberately a read of the log and nothing else: it decides *whether* to
 * compact, never how — the engine does the work, and `turn.ts` writes the outcome.
 */

/** A manual compaction the brain has not answered yet. */
export interface PendingCompaction {
  /** The `seq` of the request — the position the outcome this answers it will follow. */
  readonly seq: number
  /** The user's guidance for the summary, or `null` when they asked for a plain compaction. */
  readonly instructions: string | null
}

/**
 * The newest manual compaction waiting for an answer, or `null` when there is none.
 *
 * The rule is one comparison: the highest-`seq` event of the pair is a `session.compact` request
 * rather than the `session.compaction` outcome that answers it. A request is consumed by the
 * outcome written after it, so two requests that raced before the brain ran collapse into one —
 * the newest one is answered, and both are then behind the outcome — which is exactly the
 * "idempotent while one is pending" the epic asks for, enforced on the log rather than on a
 * read-modify-write at the route.
 *
 * The events are the replay read ({@link readLog}), so a request a `session.rewind` superseded is
 * already gone from them: an edit that took the branch back takes the request with it.
 *
 * @param events the session's log, oldest first, as {@link readLog} handed it over
 */
export function pendingManualCompaction(events: readonly StoredEvent[]): PendingCompaction | null {
  let request: PendingCompaction | null = null
  let answeredAt = 0
  for (const event of events) {
    if (event.type === EVENT_TYPES.sessionCompact) {
      request = { seq: event.seq, instructions: event.instructions ?? null }
    } else if (event.type === EVENT_TYPES.sessionCompaction) {
      answeredAt = event.seq
    }
  }
  return request !== null && request.seq > answeredAt ? request : null
}
