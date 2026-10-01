import { z } from 'zod'

import { ListOrderSchema, PageLimitSchema } from '../common'
import { NextPageSchema, PageCursorStringSchema, type NextPage } from '../pagination'
import { AfterSeqSchema, STORED_EVENT_TYPES } from './common'
import { DeltaTypeSchema } from './stream'
import { UserEventInputSchema, UserEventSchema, type UserEvent } from './user'
import { StoredEventSchema, type StoredEvent } from './union'

/**
 * The three event endpoints:
 *
 * - `POST /v1/sessions/{session_id}/events` — append user events
 * - `GET  /v1/sessions/{session_id}/events` — read the log
 * - `GET  /v1/sessions/{session_id}/events/stream` — follow it live
 *
 * Array-valued query parameters use the same wire spelling as Anthropic's API: the key is
 * repeated with a `[]` suffix, `types[]=user.message&types[]=agent.message`. The schemas
 * below model the collected array; turning a URL into it is the server's job.
 */

/** Default `order`: oldest event first, the order the log was written in. */
export const DEFAULT_EVENT_ORDER = 'asc'

/** An event type that may be passed to the `types[]` filter. */
export const StoredEventTypeSchema = z.enum(STORED_EVENT_TYPES)

/**
 * Body of `POST /v1/sessions/{session_id}/events`.
 *
 * Only user events are accepted — the server owns everything else in the log.
 */
export const SendEventsRequestSchema = z.object({
  events: z.array(UserEventInputSchema).min(1),
})

export type SendEventsRequest = z.infer<typeof SendEventsRequestSchema>

/**
 * Response of `POST /v1/sessions/{session_id}/events`: the events as they were stored, with
 * their `id` and `seq` assigned. Their `processed_at` is `null` until the brain reaches them.
 */
export const SendEventsResponseSchema = z.object({
  data: z.array(UserEventSchema),
})

/**
 * The response of `POST …/events`, deep-readonly.
 *
 * Hand-written rather than `z.infer`-ed: a stored event is deep-readonly (D9, issue #46), and
 * a schema's inferred type cannot be. The schema above is still what validates the wire; this
 * is the type a caller gets, so mutating a returned event is a compile error.
 */
export interface SendEventsResponse {
  readonly data: UserEvent[]
}

/** Query parameters of `GET /v1/sessions/{session_id}/events`. */
export const ListEventsQuerySchema = z.object({
  /** Maximum results per page. Defaults to `DEFAULT_PAGE_LIMIT`, capped at `MAX_PAGE_LIMIT`. */
  limit: PageLimitSchema.optional(),
  /** `asc` (default, oldest first) or `desc`. */
  order: ListOrderSchema.optional(),
  /** Cursor from a previous response's `next_page`: a `seq` position, the last event returned. */
  page: PageCursorStringSchema.optional(),
  /** The wire key is `types[]`. Only these event types are returned; omit for all of them. */
  types: z.array(StoredEventTypeSchema).optional(),
  /**
   * // extension: return only events with `seq > after_seq`.
   *
   * Cheaper and exact where `page` is only a resume hint: `after_seq=0` reads the session
   * from the start, and `after_seq=<last seen seq>` re-reads nothing.
   */
  after_seq: AfterSeqSchema.optional(),
})

export type ListEventsQuery = z.infer<typeof ListEventsQuerySchema>

/** Response of `GET /v1/sessions/{session_id}/events`: the Anthropic list envelope. */
export const ListEventsResponseSchema = z.object({
  data: z.array(StoredEventSchema),
  next_page: NextPageSchema,
})

/**
 * The response of `GET …/events`, deep-readonly.
 *
 * Hand-written for the reason {@link SendEventsResponse} is: `data` carries the log, and a
 * stored event is deep-readonly, so the read a caller replays from is the immutable one.
 */
export interface ListEventsResponse {
  readonly data: StoredEvent[]
  readonly next_page: NextPage
}

/** Largest number of `event_deltas[]` values a stream request may carry, per Anthropic. */
export const MAX_EVENT_DELTAS = 100

/** Query parameters of `GET /v1/sessions/{session_id}/events/stream`. */
export const StreamEventsQuerySchema = z.object({
  /**
   * Opt in to the chunks of a reply (`event_start` / `event_delta`), per connection. The wire
   * key is `event_deltas[]`; repeating it opts in to several event types. Omit it for a plain
   * stream of stored events.
   */
  event_deltas: z.array(DeltaTypeSchema).max(MAX_EVENT_DELTAS).optional(),
  /**
   * // extension: replay stored events with `seq > after_seq` before streaming live ones.
   *
   * The same parameter as on the list endpoint, so a client that reconnects after
   * `last-event-id` and one that passes `after_seq` explicitly converge on the same position.
   */
  after_seq: AfterSeqSchema.optional(),
})

export type StreamEventsQuery = z.infer<typeof StreamEventsQuerySchema>
