import type { SessionStore } from '@openharness/session'
import { EVENT_TYPES, MAX_PAGE_LIMIT } from '@openharness/protocol'
import type {
  SessionId,
  StoredEvent,
  StoredEventDelta,
  StoredEventStart,
  StoredEventType,
  Supersedes,
  UserEvent,
  UserInterruptEvent,
  UserMessageEvent,
} from '@openharness/protocol'

/**
 * Reading the session log, and the questions the turn loop asks of it.
 *
 * The brain is stateless: everything it does in a turn it decides from these reads, which is
 * what makes a crash mid-turn recoverable and a second brain on the partition possible at all.
 */

/**
 * The session's whole log, oldest first.
 *
 * Paged, because the store's `listEvents` is: a log longer than one page has to be read in
 * several reads and stitched back together. Nothing is cached between turns — the point of the
 * log is that the next turn reads it again.
 *
 * @throws SessionNotFoundError when the session does not exist
 */
export async function readLog(store: SessionStore, sessionId: SessionId): Promise<StoredEvent[]> {
  const events: StoredEvent[] = []
  let afterSeq = 0
  for (;;) {
    // The brain's replay read, deliberately unscoped: a turn acts for a session, not for a
    // user (epic #65, A4). The named method is what keeps a route from reaching it.
    const page = await store.listEventsUnscoped(sessionId, {
      order: 'asc',
      afterSeq,
      limit: MAX_PAGE_LIMIT,
    })
    events.push(...page.data)
    const last = page.data[page.data.length - 1]
    if (page.next_page === null || last === undefined) {
      return events
    }
    afterSeq = last.seq
  }
}

/**
 * The type of the log's last status event, or `undefined` when it has none.
 *
 * This is what tells a recovering brain whether it inherited a `session.status_rescheduled`
 * — the write that says "this turn is alive, it is waiting to be resumed" — from a plain
 * `session.status_running` it must not repeat. See `getTurnState`.
 */
export function lastStatusEventType(events: readonly StoredEvent[]): StoredEventType | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      event !== undefined &&
      (event.type === EVENT_TYPES.sessionStatusRunning ||
        event.type === EVENT_TYPES.sessionStatusIdle ||
        event.type === EVENT_TYPES.sessionStatusRescheduled)
    ) {
      return event.type
    }
  }
  return undefined
}

/**
 * Whether the log still owes an answer: some claimed `user.message` has no reply of its own.
 *
 * A model request answers the messages that are waiting when it starts — the ones the loop has
 * claimed, and not one that arrives while it is streaming (see {@link contextView}) — and each
 * reply closes exactly those. So the walk is: every claimed message queues up, a
 * `span.model_request_start` takes what is queued as the set that request answers, and its
 * `agent.message` closes the set.
 *
 * Comparing a message to the *next* reply instead would answer a steering message twice: the
 * reply to the request it arrived during comes after it in the log, and it belongs to the
 * request before it. This is the loop's guard against that, and it is what a recovering brain
 * consults before asking for a reply the log already holds.
 *
 * @param events the log, as {@link contextView} hands it over
 */
export function needsModelRequest(events: readonly StoredEvent[]): boolean {
  let waiting: StoredEvent[] = []
  let answeredByRequest: readonly StoredEvent[] = []
  for (const event of events) {
    if (event.type === EVENT_TYPES.userMessage) {
      waiting.push(event)
    } else if (event.type === EVENT_TYPES.modelRequestStart) {
      // A copy: a message that arrives while this request streams must not join its answer set.
      answeredByRequest = [...waiting]
    } else if (event.type === EVENT_TYPES.agentMessage) {
      waiting = waiting.filter((message) => !answeredByRequest.includes(message))
    }
  }
  return waiting.length > 0
}

/**
 * The log as one model request sees it: everything except the user events that are still
 * waiting to be claimed.
 *
 * A turn claims the pending user events at the start of every model request (see `runTurn`),
 * and this is the other half of that: what the request answers is the log *after* the claim, so
 * a message the user sends while the request is already in flight stays out of it. Without that,
 * the steering message would be answered twice — once by the request in flight, and once by the
 * request the loop runs for it afterwards.
 */
export function contextView(events: readonly StoredEvent[]): StoredEvent[] {
  return events.filter(
    (event) =>
      (event.type !== EVENT_TYPES.userMessage && event.type !== EVENT_TYPES.userInterrupt) ||
      event.processed_at !== null,
  )
}

/** Whether a queued event is a `user.message`. */
export function isUserMessage(event: UserEvent): event is UserMessageEvent {
  return event.type === EVENT_TYPES.userMessage
}

/** Whether a queued event is a `user.interrupt`. */
export function isUserInterrupt(event: UserEvent): event is UserInterruptEvent {
  return event.type === EVENT_TYPES.userInterrupt
}

/** Whether a stored event is one of a reply's chunks: an `event_start` or an `event_delta`. */
export function isStoredChunk(event: StoredEvent): event is StoredEventStart | StoredEventDelta {
  return event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta
}

/**
 * The chunk range a request left behind: the stored chunks after `afterSeq`, from the first
 * one's `seq` to the last one's — or `null` when there is none.
 *
 * This is how a brain that is closing a request it did not run finds what that request
 * streamed: the chunks it stored lie after its `span.model_request_start` and nothing has
 * superseded them, so the span end it is about to write carries this range and replay skips
 * them. A log read through {@link readLog} already leaves superseded chunks out, so what this
 * sees is exactly the range still in flight.
 *
 * @param events the log, as {@link readLog} handed it over
 * @param afterSeq the `seq` of the span start whose chunks are wanted
 */
export function chunkRangeAfter(
  events: readonly StoredEvent[],
  afterSeq: number,
): Supersedes | null {
  let from: number | null = null
  let to: number | null = null
  for (const event of events) {
    if (event.seq <= afterSeq || !isStoredChunk(event)) {
      continue
    }
    from ??= event.seq
    to = event.seq
  }
  return from === null || to === null ? null : { from_seq: from, to_seq: to }
}
