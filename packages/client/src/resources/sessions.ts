import {
  API_VERSION_PREFIX,
  ListEventsResponseSchema,
  ListSessionsResponseSchema,
  SendEventsResponseSchema,
  SessionSchema,
} from '@openharness/protocol'
import type {
  CreateSessionRequest,
  EventInput,
  ListEventsQuery,
  ListEventsResponse,
  ListSessionsQuery,
  ListSessionsResponse,
  SendEventsResponse,
  Session,
  StoredEvent,
  StreamEvent,
} from '@openharness/protocol'

import type { RequestOptions } from '../client'
import { followSessionEvents } from '../events/stream'
import type { StreamOptions } from '../events/stream'
import type { Transport } from '../http'
import { isEventList } from '../internal/events'

/**
 * The session endpoints, and the events that belong to a session.
 *
 * ```
 * POST   /v1/sessions                        create  -> session
 * GET    /v1/sessions                        list    -> { data: session[], next_page }
 * GET    /v1/sessions/{id}                   get     -> session
 * DELETE /v1/sessions/{id}                   delete  -> (204, no body)
 * POST   /v1/sessions/{id}/events            send    -> { data: user event[] }
 * GET    /v1/sessions/{id}/events            list    -> { data: stored event[], next_page }
 * GET    /v1/sessions/{id}/events/stream     stream  -> a live event stream
 * ```
 *
 * A session is a durable, append-only event log; the resource is its header. The log is the
 * conversation, so the interesting methods are on {@link SessionEventsResource}.
 *
 * A session is created from an agent, a model, or both (epic #92, issue #93): chatting does
 * not require an agent, and an agent — when one is given — is the preset the session
 * snapshots. Whatever it was created from, the returned session carries the configuration it
 * runs in `model` and `system`, always set.
 */
export interface SessionsResource {
  /**
   * Create a session, from a model, an agent, or both.
   *
   * ```ts
   * // Model-first: pick a model and chat. `system` is optional (`null` by default).
   * await client.sessions.create({ model: { id: 'openai/gpt-4.1-mini' } })
   *
   * // From an agent preset, optionally overriding its model or system prompt.
   * await client.sessions.create({ agent: agent.id, system: 'You are terse.' })
   * ```
   *
   * At least one of `agent` and `model` is required — the protocol's request schema is where
   * that rule lives — and an explicit `model`/`system` overrides what the agent contributes.
   *
   * @param body the model and/or agent to run the session with, and optionally a title,
   *   metadata and initial events
   * @param options request options (cancellation)
   */
  create(body: CreateSessionRequest, options?: RequestOptions): Promise<Session>

  /**
   * Read one session.
   *
   * @param sessionId the `sesn_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such session
   */
  get(sessionId: string, options?: RequestOptions): Promise<Session>

  /**
   * Read one page of sessions, newest first.
   *
   * @param params `limit`, `page` and the `agent_id` filter
   * @param options request options (cancellation)
   */
  list(params?: ListSessionsQuery, options?: RequestOptions): Promise<ListSessionsResponse>

  /**
   * Delete a session and its whole log.
   *
   * The wire answers `204` with no body, so there is nothing to return. Owner-scoped: another
   * user's session is answered as if it did not exist, which is also what an unknown or
   * already-deleted id gets (`not_found_error`). A stream that was following the session
   * receives one final `session.deleted` event and ends.
   *
   * @param sessionId the `sesn_` id
   * @param options request options (cancellation)
   */
  delete(sessionId: string, options?: RequestOptions): Promise<void>

  /** The session's event log: read it, append to it, follow it. */
  readonly events: SessionEventsResource
}

/** A session's event log, on the wire. */
export interface SessionEventsResource {
  /**
   * Append events to a session's log.
   *
   * The user's own events — `user.message` and `user.interrupt` — and one instruction more:
   * a `session.rewind` naming the message the conversation should restart from (#238). The
   * server assigns a user event's `id`, `seq` and `processed_at` and the response carries
   * those as stored; a rewind's event is the server's, and comes back on the log or the
   * stream like any other session event.
   *
   * Sending a rewind and the message that replaces the one it took back in **one** call is
   * what makes the two atomic: they are one append, so there is no moment where the session
   * is rewound but the message is missing. {@link Client.sendMessage}'s `rewindTo` is that
   * call for the common case of "edit and resend".
   *
   * @param sessionId the `sesn_` id
   * @param events one event, or several to append in order
   * @param options request options (cancellation)
   */
  send(
    sessionId: string,
    events: EventInput | readonly EventInput[],
    options?: RequestOptions,
  ): Promise<SendEventsResponse>

  /**
   * Read one page of the log.
   *
   * @param sessionId the `sesn_` id
   * @param params `limit`, `order`, `page`, the `types[]` filter and `after_seq`
   * @param options request options (cancellation)
   */
  list(
    sessionId: string,
    params?: ListEventsQuery,
    options?: RequestOptions,
  ): Promise<ListEventsResponse>

  /**
   * Walk the whole log, a page at a time.
   *
   * For "read the session" — a reload, a transcript rebuild — rather than for a first page.
   * The cursor is carried over untouched, so this sees a consistent view even while events
   * are being appended (the log's `seq` cursor is a position, not an offset).
   *
   * @param sessionId the `sesn_` id
   * @param params as {@link list}; `page` lets the walk start later in the log
   * @param options request options (cancellation)
   */
  iterate(
    sessionId: string,
    params?: ListEventsQuery,
    options?: RequestOptions,
  ): AsyncIterable<StoredEvent>

  /**
   * Follow the log live, reconnecting as needed.
   *
   * The iterable never ends on its own: the session can always run again, and a dropped
   * connection is reconnected after a backoff with `last-event-id` set, so no stored event is
   * delivered twice or skipped. It ends when `options.signal` aborts.
   *
   * @param sessionId the `sesn_` id
   * @param options whether to ask for previews, where to start, and cancellation
   */
  stream(sessionId: string, options?: StreamOptions): AsyncIterable<StreamEvent>
}

/** Build the sessions resource over a transport. */
export function createSessionsResource(transport: Transport): SessionsResource {
  const path = `${API_VERSION_PREFIX}/sessions`

  return {
    create(body, options) {
      return transport.json(SessionSchema, {
        method: 'POST',
        path,
        body,
        signal: options?.signal,
      })
    },

    get(sessionId, options) {
      return transport.json(SessionSchema, {
        method: 'GET',
        path: sessionPath(sessionId),
        signal: options?.signal,
      })
    },

    list(params, options) {
      return transport.json(ListSessionsResponseSchema, {
        method: 'GET',
        path,
        query: { limit: params?.limit, page: params?.page, agent_id: params?.agent_id },
        signal: options?.signal,
      })
    },

    delete(sessionId, options) {
      return transport.noContent({
        method: 'DELETE',
        path: sessionPath(sessionId),
        signal: options?.signal,
      })
    },

    events: createSessionEventsResource(transport),
  }
}

/**
 * The path of a session resource: `GET` here to read it, `DELETE` here to remove it.
 *
 * @param sessionId the `sesn_` id
 */
export function sessionPath(sessionId: string): string {
  return `${API_VERSION_PREFIX}/sessions/${sessionId}`
}

/**
 * The path of a session's event log: `POST` here to append, `GET` here to read.
 *
 * Exported for the helpers on the client, which send user events directly rather than through
 * {@link SessionEventsResource.send} so that they can return the stored event itself.
 *
 * @param sessionId the `sesn_` id
 */
export function sessionEventsPath(sessionId: string): string {
  return `${sessionPath(sessionId)}/events`
}

/** Build the events sub-resource over a transport. */
function createSessionEventsResource(transport: Transport): SessionEventsResource {
  const eventsPath = sessionEventsPath

  const list = (
    sessionId: string,
    params?: ListEventsQuery,
    options?: RequestOptions,
  ): Promise<ListEventsResponse> =>
    transport.json(ListEventsResponseSchema, {
      method: 'GET',
      path: eventsPath(sessionId),
      query: {
        limit: params?.limit,
        order: params?.order,
        page: params?.page,
        'types[]': params?.types,
        after_seq: params?.after_seq,
      },
      signal: options?.signal,
    })

  return {
    send(sessionId, events, options) {
      return transport.json(SendEventsResponseSchema, {
        method: 'POST',
        path: eventsPath(sessionId),
        body: { events: isEventList(events) ? events : [events] },
        signal: options?.signal,
      })
    },

    list,

    async *iterate(sessionId, params, options) {
      // A server that answers with a cursor it has already been given would page forever, so
      // a cursor seen before ends the walk instead of repeating a page.
      const requested = new Set<string>()
      let page = params?.page
      if (page !== undefined) {
        requested.add(page)
      }
      for (;;) {
        const response = await list(sessionId, { ...params, page }, options)
        const next = response.next_page
        if (next !== null && requested.has(next)) {
          return
        }
        yield* response.data
        if (next === null) {
          return
        }
        requested.add(next)
        page = next
      }
    },

    stream(sessionId, options) {
      return followSessionEvents(transport, sessionId, options ?? {})
    },
  }
}
