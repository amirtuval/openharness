import {
  EVENT_TYPES,
  MAX_PAGE_LIMIT,
  SSE_CONTENT_TYPE,
  isStoredEvent,
  type EventId,
  type SessionId,
  type StreamEvent,
  type StreamOnlyEvent,
} from '@openharness/protocol'
import type { SessionPreview, SessionStore, Unsubscribe } from '@openharness/session'

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
 * ## No gaps, no duplicates
 *
 * The two halves of the stream — what the log already holds and what happens next — are
 * assembled so that a client cannot tell where one ended and the other began:
 *
 * 1. **subscribe first.** The store buffers everything that happens from here on.
 * 2. **replay** the log from the resume position (`after_seq`, or the `last-event-id` header,
 *    or nothing at all for live-only).
 * 3. **snapshot the preview in flight**, on a connection that asked for previews: the reply
 *    already streamed is not in the log yet, and only the store still has it. See below.
 * 4. **flush the buffer**, dropping anything at or below the last `seq` the replay delivered —
 *    which is exactly the overlap between the two halves.
 *
 * The resume position is the last `seq` the client saw, so a client that reconnects having
 * seen `seq: 7` gets 8, 9, 10 … and never 7 again.
 *
 * ## The preview snapshot
 *
 * An `event_start` and its `event_delta`s are delivered to the connections attached when they
 * are published, and to nobody else: a page that reloads mid-reply, or a second tab that opens
 * on a turn already running, would otherwise start rendering at the first delta it happened to
 * catch — a reply that begins mid-word until the stored `agent.message` replaces it at the end
 * of the turn. The log cannot fix that (the message is not in it yet), so the store keeps the
 * text that was sent and {@link SessionStore.getPreview} hands it over.
 *
 * A connection that asked for `agent.message` previews gets it as exactly the frames a client
 * already reads for a live one: `event_start` announcing the id, then **one** `event_delta`
 * carrying the whole accumulated text at block index `0`. The live deltas that follow continue
 * from there, and the stored message ends the preview as it always does — under the same id,
 * so a client replaces the accumulated preview with the authoritative text.
 *
 * The delta that arrives *while* the snapshot is being read is the one hazard: it is already
 * part of the snapshot's text in some cases and new content in others, and ephemeral events
 * carry no sequence number to tell the two apart. The buffer is filtered by text instead: the
 * deltas the snapshot covers are the last ones published, so they are the ones its text ends
 * with — see `dropCovered` below.
 */

/** How long the stream may be quiet before a `: ping` comment goes out. */
export const SSE_KEEPALIVE_MS = 15_000

/** The keepalive comment; a `:` line is a comment to every SSE client. */
export const SSE_KEEPALIVE = ': ping\n\n'

/** Headers every SSE response carries. */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': SSE_CONTENT_TYPE,
  // No buffering anywhere: a proxy that caches or compresses an event stream breaks it.
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/**
 * Whether a live event belongs to the preview of `eventId`: its `event_start`, or one of its
 * `event_delta`s. Stream-only events only — a stored event is its own thing.
 */
function isPreviewOf(event: StreamEvent, eventId: EventId): event is StreamOnlyEvent {
  return (
    (event.type === EVENT_TYPES.eventStart && event.event.id === eventId) ||
    (event.type === EVENT_TYPES.eventDelta && event.event_id === eventId)
  )
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
   * Replay stored events with a greater `seq` before following live ones.
   *
   * Omitted means *live only*: the stream delivers what happens next. That is the client's
   * default, and the reason `after_seq=0` exists for "send me the whole log first".
   */
  readonly afterSeq?: number
  /** Whether this connection asked for `event_start` / `event_delta` previews. */
  readonly deltas: boolean
  /** Override the keepalive interval; tests use it to see a ping without waiting 15s. */
  readonly keepaliveMs?: number
  /** Aborting this ends the stream; the responder's own disconnect signal. */
  readonly signal?: AbortSignal
}

/**
 * The SSE body of a stream request: the replay, then everything that happens next, until the
 * client goes away.
 *
 * The returned stream is inert until something reads it — it is handed straight to a
 * `Response` — and cancelling it (which is what a client disconnect does to it) ends the
 * subscription and the keepalive timer with it.
 */
export function createSessionEventStream(
  options: SessionEventStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const keepaliveMs = options.keepaliveMs ?? SSE_KEEPALIVE_MS
  const { store, sessionId, deltas } = options

  /** Events that arrived while the replay was still running; flushed once it is done. */
  const buffered: StreamEvent[] = []
  let wake: (() => void) | null = null
  let unsubscribe: Unsubscribe | null = null
  let closed = false

  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    const off = unsubscribe
    unsubscribe = null
    off?.()
    const resume = wake
    wake = null
    resume?.()
  }

  if (options.signal?.aborted === true) {
    // The client was already gone when the response was built; `abort` will not fire again.
    close()
  } else {
    options.signal?.addEventListener('abort', close, { once: true })
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
      // 1. Subscribe before anything is read, so nothing that happens during the replay is
      //    missed. The store may deliver asynchronously; the buffer is what makes that safe.
      unsubscribe = await store.subscribe(sessionId, (event) => {
        buffered.push(event)
        const resume = wake
        wake = null
        resume?.()
      })
      if (closed) {
        unsubscribe()
        unsubscribe = null
        controller.close()
        return
      }

      let lastSeq = options.afterSeq ?? 0
      let replaying = options.afterSeq !== undefined

      /**
       * The `id` of every `agent.message` this connection was sent. That is the only event a
       * preview can be for (`event_start.event.type` has one member), so it is what the
       * snapshot below checks before handing out a preview the client may already have.
       */
      const deliveredMessages = new Set<EventId>()

      /** Write one event out, unless this connection did not ask for its kind. */
      const write = (event: StreamEvent): boolean => {
        if (!deltas && !isStoredEvent(event)) {
          return false
        }
        if (event.type === EVENT_TYPES.agentMessage) {
          deliveredMessages.add(event.id)
        }
        controller.enqueue(encoder.encode(encodeSseMessage(event)))
        return true
      }

      /** 2. Replay the log, page by page, from the resume position. */
      const replay = async (): Promise<void> => {
        while (replaying) {
          const page = await store.listEvents(sessionId, {
            afterSeq: lastSeq,
            limit: MAX_PAGE_LIMIT,
            order: 'asc',
          })
          for (const event of page.data) {
            lastSeq = Math.max(lastSeq, event.seq)
            write(event)
          }
          replaying = page.next_page !== null && page.data.length > 0
        }
      }

      /**
       * 3. What the log cannot carry: the `agent.message` being streamed right now, whose
       *    text exists only in the deltas already published and in the store's snapshot of
       *    them. Delivered as the `event_start` and the single accumulated `event_delta` a
       *    client that missed the beginning needs.
       */
      const snapshot = async (): Promise<void> => {
        if (!deltas) {
          return
        }
        const preview = await store.getPreview(sessionId)
        if (preview === null || deliveredMessages.has(preview.eventId)) {
          // Nothing in flight, or the stored message it previews was in the replay: either
          // way the client is not missing anything the snapshot could give it.
          return
        }
        write({
          type: EVENT_TYPES.eventStart,
          event: { type: EVENT_TYPES.agentMessage, id: preview.eventId },
        })
        write({
          type: EVENT_TYPES.eventDelta,
          event_id: preview.eventId,
          delta: { type: 'content_delta', index: 0, content: { type: 'text', text: preview.text } },
        })
        dropCovered(preview)
      }

      /**
       * Take out of the buffer what the snapshot just delivered.
       *
       * Deltas that arrived while the replay and the snapshot were running are still buffered,
       * and the ones already counted in the snapshot's text would be applied a second time by a
       * client — the reply would double in the middle. No ephemeral event carries a sequence
       * number to compare with, so the text is what is compared: the deltas published before
       * the snapshot was read are the preview's *last* ones (everything earlier was published
       * before this connection subscribed, so the buffer never saw it), which is what makes
       * them the ones the snapshot's text **ends** with. A buffered delta that keeps that tail
       * going is already in the snapshot and goes; the first one that does not is new content,
       * and so is everything after it. A buffered `event_start` for the same id goes too — the
       * snapshot just sent one, and a second would make a client start its accumulator over,
       * throwing the snapshot away.
       */
      const dropCovered = (preview: SessionPreview): void => {
        const kept: StreamEvent[] = []
        let covered = ''
        let reachedNewContent = false
        for (const event of buffered) {
          if (!isPreviewOf(event, preview.eventId) || reachedNewContent) {
            kept.push(event)
            continue
          }
          if (event.type === EVENT_TYPES.eventStart) {
            continue
          }
          const next = covered + event.delta.content.text
          if (next.length <= preview.text.length && preview.text.endsWith(next)) {
            covered = next
            continue
          }
          reachedNewContent = true
          kept.push(event)
        }
        buffered.length = 0
        buffered.push(...kept)
      }

      /** 4. Everything buffered so far, minus what the replay already delivered. */
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
        await snapshot()
        flush()
        // 4. Follow the session until the client goes away.
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
      close()
      try {
        controller.close()
      } catch {
        // The consumer already went away; there is nothing left to close.
      }
    },

    cancel() {
      // The client disconnected: stop following the session and let the keepalive go.
      close()
    },
  })
}
