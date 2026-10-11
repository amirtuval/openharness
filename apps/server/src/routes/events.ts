import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  type EventInput,
  type ModeId,
  type SessionId,
  LAST_EVENT_ID_HEADER,
  ListEventsQuerySchema,
  SendEventsRequestSchema,
  StreamEventsQuerySchema,
  type SendEventsResponse,
  type Session,
  type StoredEvent,
  type StreamEventsQuery,
  type UserEvent,
} from '@openharness/protocol'
import type { ListEventsOptions } from '@openharness/session'

import type { AppEnv } from '../types'
import { conflictError, notFoundError } from '../http/errors'
import { parseBody, parseQuery, sessionIdParam } from '../http/request'
import { requireUsableMode } from '../modes'
import { assertConfirmations, isConfirmation, rememberAlwaysApprovals } from '../pausing'
import { SSE_HEADERS, createSessionEventStream } from '../sse'
import { nameSessionFromFirstMessage } from '../titles'
import type { RouteDeps } from './deps'
import { modeDeps, requireEventModelIds } from './sessions'
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
 *
 * The body may carry one instruction that is not the user's own event: a `session.rewind`
 * (#238), "edit and resend". It travels with the edited message in the same batch so the two
 * are one append, and it is refused with a 409 while a turn is running — see
 * {@link requireIdleSession}.
 */
export function registerEventRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const events = `${API_VERSION_PREFIX}/sessions/:session_id/events`

  app.post(events, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const ownerId = c.get('user').id
    // Another user's session is answered 404 before anything is appended: the scoped read is
    // the ownership check (A4).
    const session = await requireOwnedSession(deps, c, sessionId)
    const body = await parseBody(c, SendEventsRequestSchema)
    // A `user.message` may carry a model to switch the session to (epic #116, U3); the id is
    // checked for the model id's shape here, so a value no provider could resolve is a 400
    // before anything is appended.
    requireEventModelIds(body.events)
    // The mode the chat will be on *after* this batch: a message that carries one, or the
    // session's current mode when the batch says nothing about it (#245, M6). Continuing on an
    // unusable mode is refused here — before anything is stored — rather than silently running
    // something else.
    const modeAfter = resultingMode(session.mode, body.events)
    if (modeAfter !== null) {
      await requireUsableMode(modeDeps(deps), ownerId, modeAfter)
    }
    // A rewind restarts the session from a message the reader edited (#238). It is accepted
    // only while the session is idle, and that is checked before anything is stored: the
    // rewind and the message that follows it are one append.
    if (body.events.some((event) => event.type === EVENT_TYPES.sessionRewind)) {
      await requireIdleSession(deps, sessionId)
    }
    // A `user.tool_confirmation` answers a call that is waiting on the user (epic #303, #309).
    // The check is before anything is stored — and it is what makes the event's own promise
    // true: every confirmation in this log names a call that was really waiting, so a reader
    // never has to wonder whether one was acted on.
    const confirmations = body.events.filter(isConfirmation)
    const alwaysApproved = await assertConfirmations(deps, sessionId, ownerId, confirmations)
    // The store writes `processed_at: null` on every user event, which is what makes it
    // queued work rather than history: the brain claims it at the start of a turn. A rewind
    // it writes itself, processed as it lands — see `@openharness/session`.
    const stored = await deps.store.appendEvents(sessionId, body.events)
    // An approval remembered `always` is also the user's stored policy for that tool (#307).
    // The confirmation is this chat's record of the answer — the brain reads it back off the
    // log — and this is what makes the next chat inherit it.
    await rememberAlwaysApprovals(deps, ownerId, alwaysApproved)
    // A session is named after the first thing said in it — once, and never over a title the
    // caller supplied at creation. This is the only writer of `title` in the system.
    await nameSessionFromFirstMessage(deps.store, sessionId, body.events, ownerId)
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
      ownerId: c.get('user').id,
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
    const session = await deps.store.getSession(sessionId, { ownerId: c.get('user').id })
    if (session === null) {
      throw notFoundError(`no session with id ${sessionId}`)
    }
    const afterSeq = resumeFrom(c, query)
    // The auth session behind the connection (the guard resolved it): the stream is closed
    // when this session is revoked, and re-checks it while it is open (A2; issue #76).
    const authSession = c.get('session')
    const stream = createSessionEventStream({
      store: deps.store,
      sessionId,
      ownerId: c.get('user').id,
      deltas: wantsDeltas(query),
      ...(afterSeq === undefined ? {} : { afterSeq }),
      ...(deps.sseKeepaliveMs === undefined ? {} : { keepaliveMs: deps.sseKeepaliveMs }),
      ...(deps.sessionRecheckMs === undefined ? {} : { recheckMs: deps.sessionRecheckMs }),
      signal: c.req.raw.signal,
      trackRevocation: (close) => deps.revocations.open(authSession.id, close),
      revalidate: () => deps.revalidateSession(c.req.raw.headers),
    })
    return new Response(stream, { status: 200, headers: SSE_HEADERS })
  })
}

/**
 * Refuse a rewind while the session is not idle (#238): 409 `conflict_error`.
 *
 * A turn in flight owns the branch the reader is editing — the span it has open, the chunks it
 * is streaming and the reply it is about to store are all inside the range a rewind would
 * replace — so rewinding now would leave the brain appending into a log that no longer holds
 * what it is answering. The refusal is the route's; the store refuses a brain that wins the
 * race anyway, because a claim on a superseded message is not a claim the log accepts, so the
 * turn ends at its next write rather than writing into the range.
 *
 * `unfinished` counts as busy: a turn is open with nothing in flight (a brain that died), and
 * the next brain to pick the partition up will close the inherited span and run the turn.
 */
async function requireIdleSession(deps: RouteDeps, sessionId: SessionId): Promise<void> {
  const turn = await deps.store.getTurnState(sessionId)
  if (turn.state !== 'idle') {
    throw conflictError(
      `session ${sessionId} is ${turn.state}: a rewind needs an idle session, because the turn in flight owns the message being edited`,
    )
  }
}

/**
 * The session if it is the caller's, or the 404 another user's session always gets (A4).
 *
 * `appendEvents` is not owner-scoped — the brain's writes must not be — so the read here is
 * what refuses a foreign session before anything is stored.
 */
async function requireOwnedSession(
  deps: RouteDeps,
  c: Context<AppEnv>,
  sessionId: SessionId,
): Promise<Session> {
  const session = await deps.store.getSession(sessionId, { ownerId: c.get('user').id })
  if (session === null) {
    throw notFoundError(`no session with id ${sessionId}`)
  }
  return session
}

/**
 * The mode a batch leaves the session on (#245, M6): the last `user.message` in it that spoke
 * about the mode — a `mode` sets or clears it, and a `model` with no `mode` clears it — or the
 * session's current mode when the batch says nothing.
 *
 * The store projects the same rule onto the session in the append's transaction; this is the
 * read of *what that will be*, so the refusal can happen before the append rather than the
 * chat running a request on a mode whose model is gone.
 */
function resultingMode(current: ModeId | null, events: readonly EventInput[]): ModeId | null {
  let mode = current
  for (const event of events) {
    if (event.type !== EVENT_TYPES.userMessage) {
      continue
    }
    if (event.model !== undefined && event.mode === undefined) {
      mode = null
    }
    if (event.mode !== undefined) {
      mode = event.mode
    }
  }
  return mode
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

/**
 * Whether a stored event is one of the user's.
 *
 * The response of `POST …/events` carries these and nothing else, so a `session.rewind` the
 * request carried — an event the server writes on the caller's behalf (#238) — is not in it.
 */
function isUserEvent(event: StoredEvent): event is UserEvent {
  return event.type === EVENT_TYPES.userMessage || event.type === EVENT_TYPES.userInterrupt
}
