import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  StreamEventSchema,
  isStoredEvent,
} from '@openharness/protocol'
import type { StreamEvent } from '@openharness/protocol'

import { ApiError, ResponseValidationError } from '../errors'
import type { DebugHook, Transport } from '../http'
import { sleep } from '../internal/async'
import { parseSseStream } from './sse'

/**
 * Following a session's event stream.
 *
 * The stream is the live half of the session log: stored events arrive as they are written,
 * and — if the connection asked for them — the chunks of a reply arrive while its
 * `agent.message` is still being generated. A chunk comes in one of two forms, and `seq` tells
 * them apart: the stored form (D9) is an `event_start` / `event_delta` with an `id` and a
 * `seq`, delivered like any other stored event — so a client that drops mid-reply resumes
 * mid-reply — and the stream-only preview has no envelope, is never replayed, and is a
 * display aid for the connection that asked for it.
 *
 * A stream is long-lived and the network is not, so this is a reconnect loop rather than a
 * single request. What makes it safe is the `seq` on every stored event:
 *
 * 1. the client remembers the last `seq` it delivered;
 * 2. when the connection drops it reconnects with `last-event-id: <seq>` *and*
 *    `after_seq=<seq>`, so the server resumes exactly there — the client does not have to
 *    care which one the server honors;
 * 3. anything at or below that `seq` is dropped before it reaches the caller.
 *
 * Reconnects back off exponentially (with jitter), so a server that is down is not hammered.
 * Previews are never replayed — they were a display aid, and the stored `agent.message` that
 * replaces a preview arrives either way — so a preview in flight when the connection dies is
 * simply cut short; the transcript reducer handles that by keeping the partial preview until
 * the stored event replaces it.
 */

/** How long to wait before the first reconnect; doubles per attempt. */
const BASE_RECONNECT_DELAY_MS = 500

/** The ceiling for the reconnect delay. */
const MAX_RECONNECT_DELAY_MS = 15_000

/** How much of the delay is jitter, either way, as a fraction. */
const JITTER_FRACTION = 0.25

/** What a caller can say about the stream it wants. */
export interface StreamOptions {
  /**
   * Ask for `event_start` / `event_delta` previews of `agent.message`.
   *
   * Off by default: previews cost the server work on every connection, and a client that
   * only renders stored events does not need them.
   */
  deltas?: boolean
  /**
   * Where to start. Only stored events with a `seq` greater than this are delivered.
   *
   * Omitted means "from now on": the stream delivers what happens next, not the history.
   * Load history with `sessions.events.list` — the transcript takes those events too — and
   * pass its last `seq` here to continue from it. Pass `0` to replay the whole log.
   */
  afterSeq?: number
  /** Stop iterating when this aborts; the iteration ends quietly rather than throwing. */
  signal?: AbortSignal
}

/**
 * Follow a session's event stream, reconnecting as needed.
 *
 * The generator returns when `signal` aborts, and throws only for an answer that retrying
 * cannot fix — an {@link ApiError} that is not retryable (a bad key, an unknown session) or a
 * {@link ResponseValidationError}. Everything else (a dropped connection, a `5xx`, a `429`)
 * is retried with backoff.
 *
 * @param transport the request layer
 * @param sessionId the session to follow
 * @param options see {@link StreamOptions}
 */
export async function* followSessionEvents(
  transport: Transport,
  sessionId: string,
  options: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const signal = options.signal
  let lastSeq = options.afterSeq
  let attempt = 0

  while (!isAborted(signal)) {
    try {
      const body = await transport.openEventStream({
        method: 'GET',
        path: `${API_VERSION_PREFIX}/sessions/${sessionId}/events/stream`,
        query: {
          ...(options.deltas === true ? { 'event_deltas[]': EVENT_TYPES.agentMessage } : {}),
          ...(lastSeq === undefined ? {} : { after_seq: lastSeq }),
        },
        ...(signal === undefined ? {} : { signal }),
        ...(lastSeq === undefined ? {} : { lastEventId: lastSeq }),
      })
      // Only a request that reached the stream resets the backoff: a server that accepts and
      // drops immediately is still worth slowing down for.
      attempt = 0
      for await (const message of parseSseStream(body)) {
        if (isAborted(signal)) {
          // The caller has stopped listening; the events still buffered are no longer wanted.
          return
        }
        const event = decodeStreamEvent(message.data, transport.debug)
        if (event === null) {
          continue
        }
        if (isStoredEvent(event)) {
          if (lastSeq !== undefined && event.seq <= lastSeq) {
            // Already delivered — the server replayed from a point at or before where the
            // client got to. Dropping it is what keeps a resume free of duplicates.
            continue
          }
          lastSeq = event.seq
        }
        yield event
      }
      transport.debug('the event stream ended; reconnecting')
    } catch (error) {
      if (isAborted(signal)) {
        return
      }
      if (!isRetryable(error)) {
        throw error
      }
      transport.debug('the event stream disconnected; reconnecting', error)
    }
    await sleep(reconnectDelayMs(attempt), signal)
    attempt += 1
  }
}

/**
 * Whether the caller has already aborted.
 *
 * A named function on purpose: TypeScript would otherwise carry its narrowing of
 * `signal?.aborted` across the `await`s in the loop below, and consider the abort checks after
 * them unreachable — but an abort happens exactly while the loop is suspended.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * The wait before reconnect attempt `attempt` (0-based): exponential from
 * {@link BASE_RECONNECT_DELAY_MS} up to {@link MAX_RECONNECT_DELAY_MS}, plus or minus
 * {@link JITTER_FRACTION} so that every client of a restarted server does not come back at
 * the same instant.
 *
 * @param attempt how many consecutive reconnects have failed
 */
export function reconnectDelayMs(attempt: number): number {
  const exponential = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS)
  const jitter = exponential * JITTER_FRACTION * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(exponential + jitter))
}

/**
 * Whether reconnecting can help: `fetch` failures (the request never got an answer) and the
 * retryable HTTP statuses. Anything else is the server saying no, and retrying it forever
 * would only hide the problem.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.retryable
  }
  return !(error instanceof ResponseValidationError)
}

/**
 * Parse one `data:` payload into a stream event.
 *
 * A payload this client cannot parse is dropped, not thrown: the event vocabulary is closed
 * and grows, so an older client talking to a newer server will see event types it has never
 * heard of. Dropping them keeps the rest of the stream usable, and the debug hook is where a
 * caller finds out.
 *
 * @param data the message's `data` field
 * @param debug hook for the skipped event
 */
function decodeStreamEvent(data: string, debug: DebugHook): StreamEvent | null {
  let value: unknown
  try {
    value = JSON.parse(data) as unknown
  } catch {
    debug('skipping an event stream message that is not JSON', data)
    return null
  }
  const parsed = StreamEventSchema.safeParse(value)
  if (!parsed.success) {
    const type = eventTypeOf(value)
    debug(`skipping the stream event "${type}": this client does not know it`, value)
    return null
  }
  return parsed.data
}

/** The `type` of a decoded payload, for the debug message; `unknown` when there is none. */
function eventTypeOf(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const type: unknown = (value as { type?: unknown }).type
    if (typeof type === 'string') {
      return type
    }
  }
  return 'unknown'
}
