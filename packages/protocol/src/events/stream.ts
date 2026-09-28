import { z } from 'zod'

import { TextBlockSchema } from '../content'
import { EventIdSchema } from '../ids'
import { EVENT_TYPES } from './common'

/**
 * Stream-only preview events.
 *
 * A connection opts in per event type with the `event_deltas[]` query parameter on
 * `GET /v1/sessions/{session_id}/events/stream`. Previews are a best-effort display aid: the
 * buffers event is the record, and a client that ignores previews still receives a complete,
 * correct stream.
 *
 * Unlike stored events these carry no `id`, no `seq` and no `processed_at` of their own. The
 * only identifier they carry is the id of the event they preview, and the identifier always
 * lines up: `event_start.event.id`, every `event_delta.event_id` and the stored event's `id`
 * are the same `sevt_` value.
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

/** Any stream-only event. */
export const StreamOnlyEventSchema = z.discriminatedUnion('type', [
  EventStartSchema,
  EventDeltaSchema,
])

export type StreamOnlyEvent = z.infer<typeof StreamOnlyEventSchema>
