import {
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  SSE_CONTENT_TYPE,
  isStoredEvent,
  type SessionId,
  type StreamEvent,
  type UserId,
} from '@openharness/protocol'
import type { SessionStore, Unsubscribe } from '@openharness/session'

import {
  DEFAULT_SESSION_RECHECK_MS,
  startSessionRecheck,
  type SessionRecheck,
} from './session-watch'

/**
 * The server side of `GET /v1/sessions/{id}/events/stream`.
 *
 * The wire format is the protocol's, and the client in `packages/client` reads exactly this:
 *
 * - one message per event, `data: <the JSON StreamEvent>`;
 * - a stored event also carries `id: <seq>`, which is the resume position;
 * - a stream-only preview carries no `id`;
 * - `: ping` comment lines keep the connection alive when nothing is happening.
 *
 * ## The chunks are events now (D9)
 *
 * Since D9 (issue #46) a streamed reply is stored as it streams: `event_start` and
 * `event_delta` are ordinary events with a `seq`, so a client that reconnects mid-reply
 * resumes mid-reply, and the log itself carries what used to need a mutable side table. This
 * handler no longer reads a preview snapshot or de-duplicates buffered deltas — the chunks
 * have positions, so the replay below and the live flush are stitched by `seq` like everything
 * else.
 *
 * What stays a per-connection matter is who *wants* the chunks: a connection opts in with
 * `event_deltas[]=agent.message`, and one that did not is never sent an `event_start` or an
 * `event_delta` — live or in a replay. The filter is applied in both halves, so a resume can
 * neither show chunks to a connection that did not ask for them nor hide the events it did.
 *
 * ## No gaps, no duplicates
 *
 * The two halves of the stream — what the log already holds and what happens next — are
 * assembled so that a client cannot tell where one ended and the other began:
 *
 * 1. **subscribe first.** The store buffers everything that happens from here on.
 * 2. **replay** the log from the resume position (`after_seq`, or the `last-event-id` header,
 *    or nothing at all for live-only), skipping superseded chunks and anything this connection
 *    did not opt in to.
 * 3. **flush the buffer**, dropping anything at or below the last `seq` the replay delivered —
 *    which is exactly the overlap between the two halves, whether the replay wrote an event or
 *    filtered it out.
 *
 * The resume position is the last `seq` the client saw, so a client that reconnects having
 * seen `seq: 7` gets 8, 9, 10 … and never 7 again.
 *
 * ## Ending with the session (epic #65, A2; issue #76)
 *
 * A stream is one long request, so the `/v1` guard validates the session once and never again.
 * A connection therefore watches its own session: it joins the app's revocation registry — the
 * route wires that with `trackRevocation` — so a revocation notification (sign-out, `oh
 * logout`, an operator deleting the row, a `revoke-other-sessions`) closes it promptly, on
 * whichever instance published; and it re-checks the session every `recheckMs`, which covers
 * expiry and a missed notification. Either way the client gets a final `event: error` frame
 * ({@link SSE_SESSION_INVALID}) before the stream ends.
 */

/** How long the stream may be quiet before a `: ping` comment goes out. */
export const SSE_KEEPALIVE_MS = 15_000

/** The keepalive comment; a `:` line is a comment to every SSE client. */
export const SSE_KEEPALIVE = ': ping\n\n'

/**
 * The one sentence a stream says when the session behind it ended the connection (epic #65,
 * A2; issue #76). The AI SDK adapter's error chunk carries the same words as the SSE frame.
 */
export const SESSION_INVALID_MESSAGE = 'the session behind this stream was revoked or has expired'

/**
 * The final frame a stream ends with when the session behind it is revoked or has expired
 * (epic #65, A2; issue #76).
 *
 * The payload is the protocol's error envelope with the reason, so a client that reads SSE
 * frames can tell "your session is gone" from "the server went away" and route to sign-in
 * instead of reconnecting — and an `EventSource` client, for which `error` is the reserved
 * event name, fires its error handler. `@openharness/client` does not decode this frame (it
 * is not a `StreamEvent` and is skipped like any unknown message); it learns the same fact
 * from the 401 its own reconnect gets, which is not retryable and stops the stream loop.
 */
export const SSE_SESSION_INVALID = `event: error\ndata: ${JSON.stringify({
  type: 'error',
  error: {
    type: 'authentication_error',
    message: SESSION_INVALID_MESSAGE,
  },
})}\n\n`

/** Headers every SSE response carries. */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': SSE_CONTENT_TYPE,
  // No buffering anywhere: a proxy that caches or compresses an event stream breaks it.
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * Whether an event is a reply chunk: `event_start` or `event_delta`, stored or stream-only.
 *
 * Both forms need the connection's opt-in, which is why the test is on the type and not on the
 * envelope — a stored chunk could not otherwise be told apart from any other stored event.
 */
function isChunk(event: StreamEvent): boolean {
  return event.type === EVENT_TYPES.eventStart || event.type === EVENT_TYPES.eventDelta
}

/** One event as the bytes of an SSE message; streams are written in UTF-8. */
export function encodeSseMessage(event: StreamEvent): string {
  const data = JSON.stringify(event)
  // A stored event's `id` is its `seq`: that is what `last-event-id` carries back to us.
  return isStoredEvent(event) ? `id: ${event.seq}\ndata: ${data}\n\n` : `data: ${data}\n\n`
}

/** What {@link createSessionEventStream} is built from. */
export interface SessionEventStreamOptions {
  /** The log to replay from and follow. */
  readonly store: SessionStore
  /** The session to follow. It must exist; the route checks that before it gets here. */
  readonly sessionId: SessionId
  /**
   * The session's owner: the route resolved it (a session that is not the caller's answered
   * 404 before this stream was built), and the replay read carries it so the scope follows
   * the connection rather than being forgotten by the page loop (A4).
   */
  readonly ownerId: UserId
  /**
   * Replay stored events with a greater `seq` before following live ones.
   *
   * Omitted means *live only*: the stream delivers what happens next. That is the client's
   * default, and the reason `after_seq=0` exists for "send me the whole log first".
   */
  readonly afterSeq?: number
  /** Whether this connection asked for `event_start` / `event_delta` chunks. */
  readonly deltas: boolean
  /** Override the keepalive interval; tests use it to see a ping without waiting 15s. */
  readonly keepaliveMs?: number
  /** Aborting this ends the stream; the responder's own disconnect signal. */
  readonly signal?: AbortSignal
  /**
   * Register this stream's close hook with the app's revocation registry (epic #65, A2; issue
   * #76) — the route passes `(close) => revocations.open(session.id, close)`. When the auth
   * session behind the connection is revoked, the registry calls the hook and the stream ends
   * with {@link SSE_SESSION_INVALID}.
   *
   * Omitted means the connection is not closed by a revocation, which is what a unit test of
   * the stream itself wants.
   */
  readonly trackRevocation?: (close: () => void) => Unsubscribe
  /**
   * Re-validate the auth session — it exists, and it has not expired — while the stream is
   * open (epic #65, A2; issue #76). The backstop for an expired session and for a revocation
   * notification that was missed; `false` ends the stream with {@link SSE_SESSION_INVALID}.
   */
  readonly revalidate?: () => Promise<boolean>
  /** How often {@link SessionEventStreamOptions.revalidate} runs; see the default constant. */
  readonly recheckMs?: number
}

/**
 * Why a stream ended, when it ends.
 *
 * `disconnect` is the client's own doing — an abort or a cancel — and needs no goodbye.
 * `invalid_session` is a revocation or an expiry (epic #65, A2; issue #76): the client gets
 * {@link SSE_SESSION_INVALID} before the connection closes, so it can route to sign-in.
 */
type EndReason = 'disconnect' | 'invalid_session'

/**
 * The SSE body of a stream request: the replay, then everything that happens next, until the
 * client goes away — or until the auth session behind the connection does (epic #65, A2; issue
 * #76, see {@link SessionEventStreamOptions.trackRevocation} and
 * {@link SessionEventStreamOptions.revalidate}).
 *
 * The returned stream is inert until something reads it — it is handed straight to a
 * `Response` — and cancelling it (which is what a client disconnect does to it) ends the
 * subscription, the keepalive timer and the re-check with it.
 */
export function createSessionEventStream(
  options: SessionEventStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const keepaliveMs = options.keepaliveMs ?? SSE_KEEPALIVE_MS
  const recheckMs = options.recheckMs ?? DEFAULT_SESSION_RECHECK_MS
  const { store, sessionId, deltas } = options

  /** Events that arrived while the replay was still running; flushed once it is done. */
  const buffered: StreamEvent[] = []
  let wake: (() => void) | null = null
  let unsubscribe: Unsubscribe | null = null
  let untrackRevocation: Unsubscribe | null = null
  let recheck: SessionRecheck | null = null
  let endReason: EndReason | null = null
  let closed = false

  const close = (reason: EndReason = 'invalid_session'): void => {
    if (closed) {
      return
    }
    closed = true
    if (endReason === null) {
      endReason = reason
    }
    const untrack = untrackRevocation
    untrackRevocation = null
    untrack?.()
    const ticking = recheck
    recheck = null
    ticking?.stop()
    const off = unsubscribe
    unsubscribe = null
    off?.()
    const resume = wake
    wake = null
    resume?.()
  }

  /**
   * End the response: close everything, say goodbye if the session ended it, and end the
   * body. Idempotent, and safe on every exit path — a client that went away gets nothing,
   * because there is nobody left to tell.
   */
  const finalize = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
    close()
    if (endReason === 'invalid_session') {
      // The goodbye (epic #65, A2; issue #76): why the connection is ending, before it ends.
      try {
        controller.enqueue(encoder.encode(SSE_SESSION_INVALID))
      } catch {
        // The consumer already went away; there is nobody left to tell.
      }
    }
    try {
      controller.close()
    } catch {
      // The consumer already went away; there is nothing left to close.
    }
  }

  if (options.signal?.aborted === true) {
    // The client was already gone when the response was built; `abort` will not fire again.
    close('disconnect')
  } else {
    options.signal?.addEventListener('abort', () => close('disconnect'), { once: true })
  }

  /** Wait for an event, a close, or the keepalive interval — whichever comes first. */
  const nextWake = (): Promise<'signal' | 'timeout'> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null
        resolve('timeout')
      }, keepaliveMs)
      timer.unref()
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve('signal')
      }
    })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // 0. Join the revocation registry first (epic #65, A2; issue #76), before the subscribe
      //    below: a session revoked while the connection was still being set up must close it
      //    too, and registering late would leave that revocation to the re-check.
      if (!closed) {
        untrackRevocation = options.trackRevocation?.(close) ?? null
        if (closed) {
          // `close` ran while the registration was in flight and saw nothing to untrack.
          const untrack = untrackRevocation
          untrackRevocation = null
          untrack?.()
        }
      }
      if (closed) {
        finalize(controller)
        return
      }
      if (options.revalidate !== undefined) {
        // The backstop: expiry, and any revocation notification that was missed. `close`
        // stamps the reason, and the response's end is where the final frame goes out.
        recheck = startSessionRecheck({
          intervalMs: recheckMs,
          revalidate: options.revalidate,
          onInvalid: () => close('invalid_session'),
        })
      }

      // 1. Subscribe before anything is read, so nothing that happens during the replay is
      //    missed. The store may deliver asynchronously; the buffer is what makes that safe.
      try {
        unsubscribe = await store.subscribe(sessionId, (event) => {
          buffered.push(event)
          const resume = wake
          wake = null
          resume?.()
        })
      } catch (error) {
        // The stream is erroring out; the reason is the caller's. Clean up and surface it.
        close('disconnect')
        throw error
      }
      if (closed) {
        unsubscribe()
        unsubscribe = null
        finalize(controller)
        return
      }

      let lastSeq = options.afterSeq ?? 0
      let replaying = options.afterSeq !== undefined

      /** Write one event out, unless this connection did not ask for its kind. */
      const write = (event: StreamEvent): boolean => {
        if (!deltas && isChunk(event)) {
          return false
        }
        controller.enqueue(encoder.encode(encodeSseMessage(event)))
        return true
      }

      /**
       * 2. Replay the log, page by page, from the resume position.
       *
       * `listEvents` is the replay read: it skips superseded chunks, so a reply that has been
       * stored whole — or one whose superseded chunks have since been compacted away — replays
       * as the message alone. The chunks of a reply still in flight are not superseded, so they
       * come back here like any other event: that is what a client resuming mid-reply needs.
       */
      const replay = async (): Promise<void> => {
        while (replaying) {
          const page = await store.listEvents(sessionId, {
            ownerId: options.ownerId,
            afterSeq: lastSeq,
            limit: MAX_PAGE_LIMIT,
            order: 'asc',
          })
          for (const event of page.data) {
            // The position advances whether or not the event is written: a filtered chunk is
            // still part of what this replay covered, and the flush below must not re-deliver
            // the events around it.
            lastSeq = Math.max(lastSeq, event.seq)
            write(event)
          }
          replaying = page.next_page !== null && page.data.length > 0
        }
      }

      /** 3. Everything buffered so far, minus what the replay already delivered. */
      const flush = (): boolean => {
        let delivered = false
        while (buffered.length > 0) {
          const event = buffered.shift()
          if (event === undefined) {
            break
          }
          if (isStoredEvent(event)) {
            if (event.seq <= lastSeq) {
              continue
            }
            lastSeq = event.seq
          }
          delivered = write(event) || delivered
        }
        return delivered
      }

      try {
        await replay()
        flush()
        // 4. Follow the session until the client goes away — or the session behind it does.
        while (!closed) {
          const reason = await nextWake()
          if (closed) {
            break
          }
          const delivered = flush()
          if (!delivered && reason === 'timeout') {
            controller.enqueue(encoder.encode(SSE_KEEPALIVE))
          }
        }
      } catch (error) {
        if (!closed) {
          controller.error(error)
        }
        close()
        return
      }
      finalize(controller)
    },

    cancel() {
      // The client disconnected: stop following the session, the keepalive and the re-check.
      close('disconnect')
    },
  })
}
