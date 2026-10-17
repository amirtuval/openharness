import type { SessionStatus } from '@openharness/protocol'

/**
 * Whether a running turn has gone quiet for long enough to tell the reader (#378, P4).
 *
 * A crash is not always visible. When the owner of a streaming turn dies, the client keeps its
 * connection and its transcript, and nothing arrives until another instance notices the lapsed
 * lease, closes the orphaned span and re-runs the request — about a lease TTL plus a heartbeat,
 * 40 s with the deployment's defaults. Without a word from the screen that is indistinguishable
 * from a model that is thinking hard.
 *
 * The rule is deliberately **time-based and outside the transcript reducer**. The log holds no
 * wall clock, and the reducer is pure by design: replaying the same events must produce the
 * same state. So the frontends keep when the last event arrived beside the transcript (the way
 * the TUI already keeps the turn's clock) and call this function with their own `now`.
 *
 * `lastEventAt` is the arrival time of the last event **this client folded in**, not the
 * event's `processed_at`: a resumed stream's backlog may be old, and the question is whether
 * the screen has heard anything lately.
 *
 * The threshold is the server's SSE keep-alive cadence (15 s, `apps/server/src/sse.ts`). A
 * keep-alive proves the socket is alive, but it carries no session event, so it does not reset
 * this clock: the indicator says "the turn is running and nothing has arrived", which is what a
 * reader sees. A connection that is really reconnecting is a different and louder fact, and
 * `reconnecting` outranks the clock — the client's reconnect loop reports it as it happens.
 */
export const DEFAULT_STALL_MS = 15_000

/** What the screen should say about a running turn that has gone quiet. */
export type StallState =
  /** The stream is reconnecting; the client already knows why nothing is arriving. */
  | 'reconnecting'
  /** The turn is running and no event has arrived for {@link DEFAULT_STALL_MS}. */
  | 'stalled'
  /** Nothing to report: the turn is idle, or events are still arriving. */
  | 'ok'

/** What {@link stallState} reads. */
export interface StallInput {
  /** The transcript's own status. Only a running turn can stall. */
  readonly status: SessionStatus
  /**
   * When the last event was folded in, in epoch milliseconds, or `null` before the first one.
   * Frontends should set it when a stream (re)connects too: a fresh connection starts a fresh
   * quiet window.
   */
  readonly lastEventAt: number | null | undefined
  /** The caller's clock, in epoch milliseconds. */
  readonly now: number
  /** Whether the event stream is currently reconnecting. */
  readonly reconnecting?: boolean | undefined
  /** The quiet window; {@link DEFAULT_STALL_MS} when omitted. */
  readonly thresholdMs?: number | undefined
}

/**
 * What to tell the reader about a running turn, from the transcript's status and the time the
 * last event arrived.
 *
 * A turn that is not running never stalls — a pause, a task wait and a finished turn are all
 * idle and are waiting on something the log can say. A client that has not seen an event yet
 * has no baseline to measure from and says nothing either; a caller loading history sets
 * `lastEventAt` when it starts following, so a resumed session is measured from then.
 */
export function stallState(input: StallInput): StallState {
  if (input.reconnecting === true) {
    return 'reconnecting'
  }
  if (input.status !== 'running' || input.lastEventAt === null || input.lastEventAt === undefined) {
    return 'ok'
  }
  const threshold = input.thresholdMs ?? DEFAULT_STALL_MS
  return input.now - input.lastEventAt >= threshold ? 'stalled' : 'ok'
}
