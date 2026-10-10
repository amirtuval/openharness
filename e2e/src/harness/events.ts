import { type Client } from '@openharness/client'
import {
  EVENT_TYPES,
  isStoredEvent,
  type AgentMessageEvent,
  type ModelRequestEndEvent,
  type ModelRequestStartEvent,
  type StoredEvent,
  type StoredEventDelta,
  type StreamEvent,
  type UserMessageEvent,
} from '@openharness/protocol'

import { DEFAULT_WAIT_MS, waitFor } from './wait'

/**
 * Reading a session: its log, its live stream, and the waits that connect the two.
 *
 * The assertions an e2e test makes are about *events*, so this module is the vocabulary they
 * are written in: "the log", "the stored events of this stream", "the preview deltas of the
 * reply the stream announced", "idle". Everything here goes through `@openharness/client` —
 * the same SDK the web app and the TUI use — so a test that passes is a statement about the
 * server *and* the client, not about a test-only scraping of the wire.
 */

/** The session's whole log, page after page, in `seq` order. */
export async function readLog(client: Client, sessionId: string): Promise<StoredEvent[]> {
  const log: StoredEvent[] = []
  for await (const event of client.sessions.events.iterate(sessionId)) {
    log.push(event)
  }
  return log
}

/**
 * Wait until the last turn — after `afterSeq`, when one is given — has ended.
 *
 * "Ended" is read from the **log**, not from the session resource: the status events bracket
 * a turn, so the last one being `session.status_idle` is the fact itself.
 *
 * `afterSeq` is for a caller that has just queued a message, and passing it is what makes the
 * wait trustworthy: between `POST …/events` and the brain writing `session.status_running` a
 * session is briefly indistinguishable from an idle one, and a wait that does not say which
 * turn it means can return before that turn has even started. With `afterSeq` set to the
 * message's own `seq`, the wait is for a turn that begins after it — and it also works across
 * a restart, where the turn was opened by a process that has since died: nothing is idle
 * until whichever process recovers it writes the end of the turn.
 */
export async function waitForTurnEnd(
  client: Client,
  sessionId: string,
  options: { readonly afterSeq?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
  const afterSeq = options.afterSeq ?? 0
  let lastStatus: string | undefined
  await waitFor(
    `the turn after seq ${String(afterSeq)} to end`,
    async () => {
      const statuses = await statusEventsAfter(client, sessionId, afterSeq)
      lastStatus = statuses.at(-1)?.type
      return lastStatus === EVENT_TYPES.sessionStatusIdle ? true : undefined
    },
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
      describe: () =>
        lastStatus === undefined
          ? `no status event after seq ${String(afterSeq)}`
          : `the last status event is ${lastStatus}`,
    },
  )
}

/** The turn-bracketing status events after `afterSeq`, oldest first. */
async function statusEventsAfter(
  client: Client,
  sessionId: string,
  afterSeq: number,
): Promise<StoredEvent[]> {
  const response = await client.sessions.events.list(sessionId, {
    types: [
      EVENT_TYPES.sessionStatusRunning,
      EVENT_TYPES.sessionStatusIdle,
      EVENT_TYPES.sessionStatusRescheduled,
    ],
    after_seq: afterSeq,
    limit: 100,
  })
  return response.data
}

/**
 * Wait until the log holds a `span.model_request_start` after `afterSeq`, and return it.
 *
 * The span start is the brain's record that a request was opened, and the model it names is
 * the one that request runs: a request's model is resolved *before* its span start is appended
 * (U3), so once one is in the log, a switch appended after it can only reach the request after
 * it. That makes this the fact a test that steers a reply "mid-stream" has to see before it
 * sends its steering message: until the span start is there, the switch is still an edit the
 * request in flight would pick up, and the two-models-in-one-turn premise would never exist.
 *
 * `afterSeq` is therefore required, and every caller names the turn it means — the `seq` of
 * the message that turn answers. It used to default to `0`, "the log's first span start",
 * which in a session that has already run a turn is a request that finished long ago: a test
 * that meant "the turn I just started" was answered at once and went on to race the brain it
 * meant to wait for (#261).
 */
export async function waitForModelRequestStart(
  client: Client,
  sessionId: string,
  options: { readonly afterSeq: number; readonly timeoutMs?: number },
): Promise<ModelRequestStartEvent> {
  const afterSeq = options.afterSeq
  return await waitFor(
    `a model request to start after seq ${String(afterSeq)}`,
    async () => {
      const response = await client.sessions.events.list(sessionId, {
        types: [EVENT_TYPES.modelRequestStart],
        after_seq: afterSeq,
        limit: 100,
      })
      return response.data.find(
        (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
      )
    },
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
      describe: () => `no span.model_request_start after seq ${String(afterSeq)}`,
    },
  )
}

/** The text of a stored message event: its text blocks, joined. */
export function textOf(event: AgentMessageEvent | UserMessageEvent): string {
  return event.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

/** Every `span.model_request_end` in a log, in order. */
export function modelRequestEnds(log: readonly StoredEvent[]): ModelRequestEndEvent[] {
  return log.filter(
    (event): event is ModelRequestEndEvent => event.type === EVENT_TYPES.modelRequestEnd,
  )
}

/**
 * Whether the log ends with a turn nothing closed.
 *
 * The status events bracket a turn, so the last one decides: `running` (or `rescheduled`, a
 * turn that is waiting out a backoff) with no `idle` after it means a brain opened a turn and
 * never finished it — because it is still working, or because it died.
 */
export function hasOpenTurn(log: readonly StoredEvent[]): boolean {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event === undefined) {
      continue
    }
    if (event.type === EVENT_TYPES.sessionStatusIdle) {
      return false
    }
    if (
      event.type === EVENT_TYPES.sessionStatusRunning ||
      event.type === EVENT_TYPES.sessionStatusRescheduled
    ) {
      return true
    }
  }
  return false
}

/** Every `agent.message` in a log, in order. */
export function agentMessages(log: readonly StoredEvent[]): AgentMessageEvent[] {
  return log.filter((event): event is AgentMessageEvent => event.type === EVENT_TYPES.agentMessage)
}

/** Every `user.message` in a log, in order. */
export function userMessages(log: readonly StoredEvent[]): UserMessageEvent[] {
  return log.filter((event): event is UserMessageEvent => event.type === EVENT_TYPES.userMessage)
}

/** The `seq` of every stored event in a stream, in arrival order. */
export function storedSeqs(events: readonly StreamEvent[]): number[] {
  return events.filter(isStoredEvent).map((event) => event.seq)
}

/** The event types of a log, in order — what an assertion about a turn's shape reads. */
export function typesOf(events: readonly StoredEvent[]): string[] {
  return events.map((event) => event.type)
}

/** Whether a stream event is a stored `session.status_idle`. */
export function isStoredIdle(event: StreamEvent): boolean {
  return isStoredEvent(event) && event.type === EVENT_TYPES.sessionStatusIdle
}

/** Whether a stream event is a chunk delta of an agent message. */
export function isPreviewDelta(event: StreamEvent): boolean {
  return event.type === EVENT_TYPES.eventDelta
}

/** The id of the `agent.message` a stream's chunks announce, if it announced one. */
export function previewedEventId(events: readonly StreamEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === EVENT_TYPES.eventStart) {
      return event.event.id
    }
  }
  return undefined
}

/** The text a stream's `event_delta`s carried for one chunked event id. */
export function deltaText(events: readonly StreamEvent[], eventId: string): string {
  return events
    .filter(
      (event): event is StoredEventDelta =>
        event.type === EVENT_TYPES.eventDelta && event.event_id === eventId,
    )
    .map((event) => event.delta.content.text)
    .join('')
}

/** A live stream, read in the background while a test drives the session. */
export interface StreamCollector {
  /** Everything received so far, in arrival order. */
  readonly events: readonly StreamEvent[]
  /** The stored events among them. */
  readonly stored: readonly StoredEvent[]
  /** What ended the stream, when something did; `undefined` while it is running. */
  readonly error: unknown
  /**
   * Whether the iteration has ended — the server closed the stream, or {@link stop} did.
   *
   * A stream that ends because the session behind it was deleted ends *quietly*: the last
   * event is the `session.deleted` goodbye, there is no error, and the only way to tell "it
   * closed" from "it is idle" is this flag.
   */
  readonly closed: boolean
  /** Resolve once `predicate` holds over what has arrived so far. */
  waitFor(
    predicate: (events: readonly StreamEvent[]) => boolean,
    what: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<void>
  /** Stop reading — aborting the request — and wait for the iteration to end. */
  stop(): Promise<void>
}

/**
 * Follow a session from `afterSeq` in the background.
 *
 * The stream is the live half of the log, and `deltas: true` also asks for the previews that
 * make a reply visible while it is still being written. A collector is the shape a test
 * needs: read while the test acts ("wait for the first delta, then interrupt"), and stop when
 * the test is done with it.
 *
 * `afterSeq` is passed to the client, which sends it as `after_seq` and resumes from there —
 * `0` replays the log from the beginning, and leaving it out is a live-only stream.
 */
export function collectStream(
  client: Client,
  sessionId: string,
  options: { readonly deltas?: boolean; readonly afterSeq?: number } = {},
): StreamCollector {
  const controller = new AbortController()
  const events: StreamEvent[] = []
  let error: unknown
  let stopped = false
  let closed = false

  const reading = (async () => {
    try {
      const stream = client.sessions.events.stream(sessionId, {
        ...options,
        signal: controller.signal,
      })
      for await (const event of stream) {
        events.push(event)
      }
    } catch (thrown: unknown) {
      // A stream only throws what reconnecting cannot fix; an abort is how `stop()` ends it
      // and is not a failure.
      if (!stopped) {
        error = thrown
      }
    } finally {
      closed = true
    }
  })()

  return {
    get events(): readonly StreamEvent[] {
      return events
    },
    get stored(): readonly StoredEvent[] {
      return events.filter(isStoredEvent)
    },
    get error(): unknown {
      return error
    },
    get closed(): boolean {
      return closed
    },
    waitFor: async (predicate, what, options = {}) => {
      await waitFor(
        what,
        () => {
          if (error !== undefined) {
            // The client only throws what reconnecting cannot fix; anything that is not an
            // `Error` (a string, an abort reason) is wrapped so the failure keeps its cause.
            throw error instanceof Error
              ? error
              : new Error('the event stream failed', { cause: error })
          }
          return predicate(events) ? true : undefined
        },
        {
          timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
          describe: () => describeEvents(events),
        },
      )
    },
    stop: async () => {
      stopped = true
      controller.abort()
      await reading
    },
  }
}

/** A one-line-per-event summary, for a failure that has to explain what did arrive. */
export function describeEvents(events: readonly StreamEvent[]): string {
  if (events.length === 0) {
    return 'no events'
  }
  return events
    .map((event) => {
      // Every stream event is a stored one since P4 — except the stream-only `session.deleted`
      // (#111), which carries no `seq` — so the prefix is optional.
      const prefix = isStoredEvent(event) ? `${String(event.seq)} ` : ''
      const label = `${prefix}${event.type}`
      if (event.type === EVENT_TYPES.eventStart) {
        return `${label} ${event.event.id}`
      }
      if (event.type === EVENT_TYPES.eventDelta) {
        return `${label} ${event.event_id}`
      }
      return label
    })
    .join('; ')
}
