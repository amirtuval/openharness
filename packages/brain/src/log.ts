import type { SessionStore } from '@openharness/session'
import { EVENT_TYPES, isToolCallEvent, MAX_PAGE_LIMIT } from '@openharness/protocol'
import type {
  EventId,
  ModelRequestPurpose,
  ModelUsage,
  SessionId,
  SessionModelUsage,
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
 * The session's whole log, oldest first — as a reader sees it.
 *
 * Paged, because the store's `listEvents` is: a log longer than one page has to be read in
 * several reads and stitched back together. Nothing is cached between turns — the point of the
 * log is that the next turn reads it again.
 *
 * This is the store's replay read, so it leaves out what a recorded range supersedes: the
 * chunks a finished reply replaced, and everything a `session.rewind` replaced (#238). That is
 * what makes the brain's history the conversation the reader is looking at — a message an edit
 * took back is not something the model was told, and a request built from this log never asks
 * about it.
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
 * Whether the log still owes an answer: some claimed `user.message` has no reply of its own, or
 * the newest chat request left a tool step open.
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
 * A **summary** request (`purpose: 'summary'`, C2) is skipped: it answers nothing, is followed by
 * no `agent.message`, and would otherwise take over the "answer set" its own start recorded — a
 * message that arrived while the summarizer was running would read as answered.
 *
 * Since epic #303 a request can also end a step without answering anything: a step that called
 * a tool owes the next request whatever came back, so {@link awaitingToolStep} is the second
 * half of this question. A step that streamed **text and** a call is the case that makes it
 * necessary — the message looks answered, and the turn is not over.
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
      // A summary request answers nothing and is left out entirely, so it cannot redefine the
      // set the chat's own request claimed.
      answeredByRequest = event.purpose === 'summary' ? answeredByRequest : [...waiting]
    } else if (event.type === EVENT_TYPES.agentMessage) {
      waiting = waiting.filter((message) => !answeredByRequest.includes(message))
    }
  }
  return waiting.length > 0 || awaitingToolStep(events)
}

/**
 * Whether the newest chat request left a tool step open: it produced tool calls (epic #303, X2).
 *
 * A step that called a tool is not finished — the results have to go back to the model in the
 * next request — so the log owes that request until a later request has run. The test is
 * "which request came last", not "is there a call with no result": a call whose result has
 * been stored is still a step to continue, while one with no result at all is a step whose
 * execution was lost and is answered before the next request is made (X3).
 *
 * A **summary** request is not a chat request: the compaction engine's own request is not part
 * of the tool loop and must not be mistaken for the step that closed it.
 *
 * @param events the log, as {@link readLog} handed it over
 */
export function awaitingToolStep(events: readonly StoredEvent[]): boolean {
  let lastChatStart = 0
  for (const event of events) {
    if (event.type === EVENT_TYPES.modelRequestStart && event.purpose !== 'summary') {
      lastChatStart = event.seq
    }
  }
  if (lastChatStart === 0) {
    return false
  }
  // Built-in and remote calls alike (#312): a step that called any tool still owes its answers
  // to the next request.
  return events.some((event) => isToolCallEvent(event) && event.seq > lastChatStart)
}

/**
 * The log's newest model request, as the size accounting wants it (epic #277, K2; C2).
 *
 * A `span.model_request_end` reports the usage and the start it closes carries the model and the
 * purpose, so this pairs them the way {@link usageByModel} does — and, like that fold, an end
 * whose start is not in the log contributes nothing. `purpose` is present only for a request
 * that was not the chat's own (a summary request), which is what lets the size accounting refuse
 * it as a baseline.
 */
export interface LastModelRequest {
  /** The `seq` of the `span.model_request_end` — the position everything after it is "new". */
  readonly seq: number
  /** The `provider/model` the request ran — `span.model_request_start.model`, or `null`. */
  readonly model: string | null
  /** What it reported. */
  readonly usage: ModelUsage
  /** Why it was made, when it was not the chat's own request (`purpose: 'summary'`). */
  readonly purpose?: ModelRequestPurpose
}

/**
 * The newest request in the log, or `null` when it holds none.
 *
 * @param events the session's log, as {@link readLog} handed it over
 */
export function lastModelRequest(events: readonly StoredEvent[]): LastModelRequest | null {
  const starts = new Map<EventId, Pick<LastModelRequest, 'model' | 'purpose'>>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.modelRequestStart) {
      starts.set(event.id, {
        model: event.model ?? null,
        ...(event.purpose === undefined ? {} : { purpose: event.purpose }),
      })
    }
  }
  let latest: LastModelRequest | null = null
  for (const event of events) {
    if (event.type !== EVENT_TYPES.modelRequestEnd) {
      continue
    }
    const start = starts.get(event.model_request_start_id)
    if (start === undefined) {
      continue
    }
    latest = { seq: event.seq, ...start, usage: event.model_usage }
  }
  return latest
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
 *
 * @param events the log, as {@link readLog} handed it over
 * @param claimed ids the caller is about to claim in the same step — the span start the request
 *   is built for. A pending user event among them counts as processed, which is what lets the
 *   loop build the prompt *before* it appends the claim (the span start carries the truncation
 *   record the strategy produced, so the prompt has to exist first) without the claimed messages
 *   dropping out of it. Omitted, nothing is admitted and this is the post-claim view.
 */
export function contextView(
  events: readonly StoredEvent[],
  claimed?: ReadonlySet<EventId>,
): StoredEvent[] {
  return events.filter(
    (event) =>
      (event.type !== EVENT_TYPES.userMessage && event.type !== EVENT_TYPES.userInterrupt) ||
      event.processed_at !== null ||
      claimed?.has(event.id) === true,
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

/**
 * The session's usage so far, folded from its log: every request's tokens summed, one entry per
 * model (epic #245, A2; issue #247).
 *
 * A `span.model_request_end` reports the tokens but not the model — that is on the
 * `span.model_request_start` it closes — so the fold pairs them by `model_request_start_id` and
 * attributes each request to the model that served it. Models appear in the order their first
 * request did, which is the order a reader of the log would name them in. Each entry also carries
 * how many requests ran on its model (#247), which is what a reader of the running totals needs to
 * count how many of them a catalog with no price for that model leaves unpriced.
 *
 * The fold is over what {@link readLog} returned, which is the whole log **as a reader sees it**:
 * a branch a `session.rewind` replaced is not in it, so the requests it contained are not in the
 * totals — the same rule the rest of the brain follows about an edit. Compaction changes
 * nothing: it deletes what replay already skips.
 *
 * A span end whose start is not in the log (a log trimmed below it, a client's partial view)
 * contributes its tokens to no model and so to no total; that is the honest reading, since the
 * totals are what a writer of this event would have written, and every start a brain writes is
 * in the log it just read.
 *
 * @param events the session's log, as {@link readLog} handed it over
 */
export function usageByModel(events: readonly StoredEvent[]): SessionModelUsage[] {
  const modelOf = new Map<EventId, string>()
  for (const event of events) {
    if (event.type === EVENT_TYPES.modelRequestStart && event.model !== undefined) {
      modelOf.set(event.id, event.model)
    }
  }

  const totals = new Map<string, ModelUsage>()
  const requests = new Map<string, number>()
  for (const event of events) {
    if (event.type !== EVENT_TYPES.modelRequestEnd) {
      continue
    }
    const model = modelOf.get(event.model_request_start_id)
    if (model === undefined) {
      continue
    }
    totals.set(model, addUsage(totals.get(model), event.model_usage))
    // A count of span ends, so a retried reply counts twice — both attempts really ran, and both
    // are really in the tokens (the same reading the usage routes' breakdown takes).
    requests.set(model, (requests.get(model) ?? 0) + 1)
  }

  return [...totals].map(([model, usage]) => ({
    model,
    usage,
    requests: requests.get(model) ?? 0,
  }))
}

/**
 * {@link usageByModel}'s fold after one more request.
 *
 * The loop writes the running totals right after a request that reported usage, and the log it
 * folded them from was read *before* that request's span end — so the new request is added here
 * rather than re-read. The model joins the list where its first request would have, at the end,
 * which keeps `models` in the order the requests happened.
 *
 * @param models the session's tokens per model, as {@link usageByModel} folded them
 * @param model the model the request ran on
 * @param usage what it reported
 */
export function withRequestUsage(
  models: readonly SessionModelUsage[],
  model: string,
  usage: ModelUsage,
): SessionModelUsage[] {
  const known = models.some((entry) => entry.model === model)
  if (!known) {
    return [...models.map(copyUsage), { model, usage: { ...usage }, requests: 1 }]
  }
  return models.map((entry) =>
    entry.model === model
      ? { model, usage: addUsage(entry.usage, usage), requests: entry.requests + 1 }
      : copyUsage(entry),
  )
}

/** A usage entry the caller may keep, so the fold never hands out what it holds. */
function copyUsage(entry: SessionModelUsage): SessionModelUsage {
  return { model: entry.model, usage: { ...entry.usage }, requests: entry.requests }
}

/** Two usage reports added up counter by counter. */
function addUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  return {
    input_tokens: (current?.input_tokens ?? 0) + next.input_tokens,
    output_tokens: (current?.output_tokens ?? 0) + next.output_tokens,
    cache_creation_input_tokens:
      (current?.cache_creation_input_tokens ?? 0) + next.cache_creation_input_tokens,
    cache_read_input_tokens: (current?.cache_read_input_tokens ?? 0) + next.cache_read_input_tokens,
  }
}
