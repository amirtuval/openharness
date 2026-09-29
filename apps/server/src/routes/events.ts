import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  LAST_EVENT_ID_HEADER,
  ListEventsQuerySchema,
  SendEventsRequestSchema,
  StreamEventsQuerySchema,
  type SendEventsResponse,
  type StoredEvent,
  type StreamEventsQuery,
  type UserEvent,
} from '@openharness/protocol'
import type { ListEventsOptions } from '@openharness/session'

import type { AppEnv } from '../types'
import { notFoundError } from '../http/errors'
import { parseBody, parseQuery, sessionIdParam } from '../http/request'
import { SSE_HEADERS, createSessionEventStream } from '../sse'
import { nameSessionFromFirstMessage } from '../titles'
import type { RouteDeps } from './deps'
import { signalKinds } from './signals'

/** The `event_deltas[]` value that opts a connection into `agent.message` previews. */
const DELTA_EVENT_TYPE = EVENT_TYPES.agentMessage

/** The name of the array-valued query parameter that opts into previews. */
const EVENT_DELTAS_PARAM = 'event_deltas'

/**
 * The three event endpoints: append, read, follow.
 *
 * `POST` is the only way a user's input enters the system, and it does two things in a fixed
 * order — store the events, then tell the scheduler. The store call is what makes the event
 * durable; the signal is only a latency optimization, and the scheduler recovers from a lost
 * one through `findSessionsNeedingWork` (see `@openharness/session`).
 */
export function registerEventRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const events = `${API_VERSION_PREFIX}/sessions/:session_id/events`

  app.post(events, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const body = await parseBody(c, SendEventsRequestSchema)
    // The store writes `processed_at: null` on every user event, which is what makes it
    // queued work rather than history: the brain claims it at the start of a turn.
    const stored = await deps.store.appendEvents(sessionId, body.events)
    // A session is named after the first thing said in it — once, and never over a title the
    // caller supplied at creation. This is the only writer of `title` in the system.
    await nameSessionFromFirstMessage(deps.store, sessionId, body.events)
    const response: SendEventsResponse = { data: stored.filter(isUserEvent) }
    // Only now — after the append is committed — does anything get asked to run. An interrupt
    // goes first: cutting the turn in flight short is what lets the message queued behind it
    // start a new one.
    for (const kind of signalKinds(body.events)) {
      deps.scheduler.signal(sessionId, kind)
    }
    return c.json(response)
  })

  app.get(events, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const query = parseQuery(c, ListEventsQuerySchema, ['types'])
    const options: ListEventsOptions = {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.order === undefined ? {} : { order: query.order }),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.types === undefined ? {} : { types: query.types }),
      ...(query.after_seq === undefined ? {} : { afterSeq: query.after_seq }),
    }
    return c.json(await deps.store.listEvents(sessionId, options))
  })

  app.get(`${events}/stream`, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const query = parseQuery(c, StreamEventsQuerySchema, [EVENT_DELTAS_PARAM])
    const session = await deps.store.getSession(sessionId)
    if (session === null) {
      throw notFoundError(`no session with id ${sessionId}`)
    }
    const afterSeq = resumeFrom(c, query)
    const stream = createSessionEventStream({
      store: deps.store,
      sessionId,
      deltas: wantsDeltas(query),
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(deps.sseKeepaliveMs === undefined ? {} : { keepaliveMs: deps.sseKeepaliveMs }),
      signal: c.req.raw.signal,
    })
    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  })
}

/** Whether this connection asked for `event_start` / `event_delta` previews. */
function wantsDeltas(query: StreamEventsQuery): boolean {
  return query.event_deltas?.includes(DELTA_EVENT_TYPE) === true
}

/**
 * Where the replay starts: `after_seq` when the query says so, otherwise the `last-event-id`
 * header a reconnecting client sends back, otherwise nowhere at all.
 *
 * "Nowhere at all" is *live only* — the connection delivers what happens next, not the
 * history — which is what both the stream query schema and `packages/client` document as the
 * default. A header that is not a position this server handed out (a `sevt_` event id, say)
 * is ignored rather than refused: a resume that cannot be honored exactly is better served
 * live than with an error.
 */
function resumeFrom(c: Context<AppEnv>, query: StreamEventsQuery): number | undefined {
  if (query.after_seq !== undefined) {
    return query.after_seq
  }
  const header = c.req.header(LAST_EVENT_ID_HEADER)
  if (header === undefined) {
    return undefined
  }
  const trimmed = header.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

/** Whether a stored event is one of the user's; `POST …/events` only ever writes those. */
function isUserEvent(event: StoredEvent): event is UserEvent {
  return event.type === EVENT_TYPES.userMessage || event.type === EVENT_TYPES.userInterrupt
}
