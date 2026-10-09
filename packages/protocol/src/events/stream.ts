import { z } from 'zod'

import { TextBlockSchema } from '../content'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { EVENT_TYPES, EventSeqSchema, ProcessedAtSchema } from './common'

/**
 * The chunk events: `event_start` and `event_delta`.
 *
 * A connection opts in per event type with the `event_deltas[]` query parameter on
 * `GET /v1/sessions/{session_id}/events/stream`. Since D9 (issue #46) a streamed reply is
 * stored chunk by chunk: these are ordinary stored events — `id`, `seq`, `processed_at` — so a
 * reply in flight is part of the log, resumable by `seq` like anything else, and the event
 * that finishes the reply supersedes the range it spanned.
 *
 * There is one form, and it is the stored one. The pre-D9 stream-only preview — the same
 * event names with no envelope, published to live connections and never stored — was removed
 * in phase P4, when there were no writers left that produced it; the stored schemas below are
 * what `StoredEventSchema` carries, and `seq` is still the field that tells a log event apart
 * from anything a pre-D9 server might still send (see `isStoredEvent()` in `union.ts`).
 *
 * The chunk announces the id of the event it previews, and the identifiers always line up:
 * `event_start.event.id`, every `event_delta.event_id` and the finished event's `id` are the
 * same `sevt_` value.
 *
 * The wire format is deliberately *not* the Messages API streaming format — the delta type is
 * `content_delta`, not `content_block_delta`, and there are no per-block start/stop events.
 */

/**
 * The event types whose chunks a connection may ask to receive (`event_deltas[]`).
 *
 * Anthropic also accepts `agent.thinking`, which it emits as `event_start` only;
 * openharness has no `agent.thinking` event, so `agent.message` is the whole v1 set.
 */
export const DeltaTypeSchema = z.enum([EVENT_TYPES.agentMessage])

export type DeltaType = z.infer<typeof DeltaTypeSchema>

/**
 * Incremental content for a previewed event.
 *
 * `index` is the index of the content block being extended, so a multi-block message
 * accumulates into one buffer per `(event_id, index)` pair. Concatenating a reply's deltas in
 * arrival order yields a prefix of `content[index].text` in the stored event — a prefix rather
 * than the whole text, because deltas may be shed under load.
 *
 * Anthropic marks `index` optional and its own accumulator reads a missing index as `0`, so
 * this schema defaults it: `{ delta: { type: 'content_delta', content: … } }` parses to
 * `index: 0` rather than failing. Parsed deltas always carry the field.
 */
export const ContentDeltaSchema = z.object({
  type: z.literal('content_delta'),
  index: z.number().int().nonnegative().default(0),
  content: TextBlockSchema,
})

export type ContentDelta = z.infer<typeof ContentDeltaSchema>

/**
 * A reply started streaming: the first chunk of the range the finished event supersedes.
 *
 * Stored since D9 (issue #46): the event carries the usual envelope and is appended by the
 * brain as the reply starts. The message it previews is stored later under `event.id`, and
 * either that message — or the `span.model_request_end` that closes a request which stored
 * none — carries a `supersedes` range over this event and the deltas that follow it.
 */
export const StoredEventStartSchema = z.object({
  type: z.literal(EVENT_TYPES.eventStart),
  id: EventIdSchema,
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  event: z.object({
    type: DeltaTypeSchema,
    id: EventIdSchema,
  }),
})

/** A stored `event_start`, deep-readonly (D9, issue #46). */
export type StoredEventStart = DeepReadonly<z.infer<typeof StoredEventStartSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link StoredEventStart}. */
export type ImmutableStoredEventStart = StoredEventStart

/**
 * One streamed fragment of a reply, as a log entry: an `event_delta` with the stored envelope.
 *
 * `event_id` names the reply being written; the deltas of one reply are the consecutive
 * `seq`s after its `event_start`, and the finished event's `supersedes` range covers them.
 */
export const StoredEventDeltaSchema = z.object({
  type: z.literal(EVENT_TYPES.eventDelta),
  id: EventIdSchema,
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
  event_id: EventIdSchema,
  delta: ContentDeltaSchema,
})

/** A stored `event_delta`, deep-readonly (D9, issue #46). */
export type StoredEventDelta = DeepReadonly<z.infer<typeof StoredEventDeltaSchema>>

/** @deprecated The plain name is deep-readonly now (D9, issue #46); use {@link StoredEventDelta}. */
export type ImmutableStoredEventDelta = StoredEventDelta
