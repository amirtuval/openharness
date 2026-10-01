import { z } from 'zod'

import { TextBlockSchema } from '../content'
import { EventIdSchema } from '../ids'
import type { DeepReadonly } from '../readonly'
import { EVENT_TYPES, EventSeqSchema, ProcessedAtSchema } from './common'

/**
 * Preview events: `event_start` and `event_delta`, in the two forms they take.
 *
 * A connection opts in per event type with the `event_deltas[]` query parameter on
 * `GET /v1/sessions/{session_id}/events/stream`. A preview is a best-effort display aid: the
 * stored event is the record, and a client that ignores previews still receives a complete,
 * correct stream.
 *
 * Since D9 (issue #46) a streamed reply is stored chunk by chunk, so `event_start` and
 * `event_delta` are **stored events** with the usual envelope — `id`, `seq`, `processed_at` —
 * and {@link StoredEventStartSchema} / {@link StoredEventDeltaSchema} below are that form.
 * The original stream-only form — no envelope of its own, published to live connections while
 * the reply streams — is {@link EventStartSchema} / {@link EventDeltaSchema}, kept unchanged
 * for the servers, stores and clients that still publish and read it; the pair is removed in
 * phase P4.
 *
 * A reader tells the two apart by `seq`: the stored form has one, the preview does not (see
 * `isStoredEvent()` in `union.ts`, and `STREAM_ONLY_EVENT_TYPES` in `common.ts`). The stored
 * form is a superset of the preview — parsing a stored chunk with the stream-only schema
 * succeeds and drops the envelope — so a reader that does not care which form it holds can
 * always read `event` / `event_id` / `delta`.
 *
 * In both forms the only identifier a chunk announces is the id of the event it previews, and
 * the identifiers always line up: `event_start.event.id`, every `event_delta.event_id` and the
 * stored event's `id` are the same `sevt_` value.
 *
 * The wire format is deliberately *not* the Messages API streaming format — the delta type is
 * `content_delta`, not `content_block_delta`, and there are no per-block start/stop events.
 */

/**
 * The event types a connection may ask to preview.
 *
 * Anthropic also accepts `agent.thinking`, which it emits as `event_start` only;
 * openharness has no `agent.thinking` event, so `agent.message` is the whole v1 set.
 */
export const DeltaTypeSchema = z.enum([EVENT_TYPES.agentMessage])

export type DeltaType = z.infer<typeof DeltaTypeSchema>

/**
 * A previewed event has started generating.
 *
 * `event` announces the upcoming event's type and `id`; for `agent.message`, deltas follow.
 */
export const EventStartSchema = z.object({
  type: z.literal(EVENT_TYPES.eventStart),
  event: z.object({
    type: DeltaTypeSchema,
    id: EventIdSchema,
  }),
})

export type EventStart = z.infer<typeof EventStartSchema>

/**
 * Incremental content for a previewed event.
 *
 * `index` is the index of the content block being extended, so a multi-block message
 * accumulates into one buffer per `(event_id, index)` pair. Concatenating a preview's deltas
 * in arrival order yields a prefix of `content[index].text` in the stored event — a prefix
 * rather than the whole text, because deltas may be shed under load.
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

/** Incremental content for the previewed event named by `event_id`. */
export const EventDeltaSchema = z.object({
  type: z.literal(EVENT_TYPES.eventDelta),
  event_id: EventIdSchema,
  delta: ContentDeltaSchema,
})

export type EventDelta = z.infer<typeof EventDeltaSchema>

/**
 * The stored form of an `event_start` (D9): the preview's fields plus the stored envelope.
 *
 * Appended by the brain as a reply starts streaming (phase P3). The message it previews is
 * stored later under `event.id`, and either that `agent.message` — or the
 * `span.model_request_end` that closes the request without one — carries a `supersedes` range
 * over this event and the deltas that follow it.
 */
export const StoredEventStartSchema = EventStartSchema.extend({
  id: EventIdSchema,
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
})

export type StoredEventStart = z.infer<typeof StoredEventStartSchema>

/** {@link StoredEventStart}, deep-readonly: the shape a store returns (D9). */
export type ImmutableStoredEventStart = DeepReadonly<StoredEventStart>

/** The stored form of an `event_delta` (D9): one streamed fragment, as a log entry. */
export const StoredEventDeltaSchema = EventDeltaSchema.extend({
  id: EventIdSchema,
  seq: EventSeqSchema,
  processed_at: ProcessedAtSchema,
})

export type StoredEventDelta = z.infer<typeof StoredEventDeltaSchema>

/** {@link StoredEventDelta}, deep-readonly: the shape a store returns (D9). */
export type ImmutableStoredEventDelta = DeepReadonly<StoredEventDelta>

/**
 * Any stream-only event: the preview pair as a live connection receives it, with no envelope.
 *
 * Not to be confused with {@link StoredEventStartSchema} / {@link StoredEventDeltaSchema} —
 * since D9 those are the *stored* forms of the same two event names, and they are what
 * `StoredEventSchema` carries. This union is unchanged from before D9 and is removed in P4.
 */
export const StreamOnlyEventSchema = z.discriminatedUnion('type', [
  EventStartSchema,
  EventDeltaSchema,
])

export type StreamOnlyEvent = z.infer<typeof StreamOnlyEventSchema>
