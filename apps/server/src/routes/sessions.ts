import type { Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  CreateSessionRequestSchema,
  EVENT_TYPES,
  ListSessionsQuerySchema,
  type EventInput,
} from '@openharness/protocol'
import type { CreateSessionOptions, ListSessionsOptions } from '@openharness/session'

import type { AppEnv } from '../types'
import { invalidRequest, notFoundError } from '../http/errors'
import { parseBody, parseQuery, sessionIdParam } from '../http/request'
import { isModelId } from '../model-id'
import { requireUsableMode, type ModeDeps } from '../modes'
import { nameSessionFromFirstMessage } from '../titles'
import type { RouteDeps } from './deps'
import { signalKinds } from './signals'

/**
 * The session endpoints.
 *
 * A session is the header of an event log: creating one snapshots the agent it will run, and
 * every later change to that agent applies to new sessions only. A session may also be created
 * from a model alone (epic #92, #94): `model` and `system` are then the configuration it runs,
 * and `agent` is `null`. Creating a session never calls a provider and never needs a stored
 * credential — a missing key is reported when a turn runs (`missing_provider_credential`).
 */
export function registerSessionRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const sessions = `${API_VERSION_PREFIX}/sessions`

  app.post(sessions, async (c) => {
    const body = await parseBody(c, CreateSessionRequestSchema)
    // The protocol's refinement already refused a request naming neither an agent nor a model
    // (a 400). The inline model id is checked here: the factory's `provider/model` shape, with
    // non-empty parts — a value no provider could ever resolve is a request, not a session
    // (issue #94). The format lives outside the protocol's `ModelConfigSchema` until the
    // catalog wave is done; this is the one route that acts on it today.
    if (body.model !== undefined) {
      requireModelId(body.model.id)
    }
    // `initial_events` go through the same rules as events posted afterwards, a model switch
    // included: a `user.message` carrying one sets what the session runs (#111), so its id is
    // checked here the way `POST …/events` checks it.
    requireEventModelIds(body.initial_events ?? [])
    const ownerId = c.get('user').id
    // A mode stands in for a model (#245, M6): resolving it is what decides the session's
    // header model, and an unusable one is refused here — before a session is created —
    // rather than silently replaced (a 422 `mode_unavailable_error`).
    const mode =
      body.mode === undefined ? null : await requireUsableMode(modeDeps(deps), ownerId, body.mode)
    const options: CreateSessionOptions = {
      // Every session belongs to the caller (epic #65, A4), and the agent it snapshots has
      // to be theirs too: `createSession` answers `AgentNotFoundError` — a 404 — for an
      // agent somebody else owns.
      ownerId,
      // The request's inline model and system: with an agent they override what the agent
      // contributes, and without one they are what the session runs (#93). Either way the
      // session stores the *effective* configuration, so the brain never reads the agent.
      // A mode wins over an inline model: the chat follows the mode, and the model stored is
      // what the mode resolves to now.
      ...(mode === null
        ? body.model === undefined
          ? {}
          : { model: body.model }
        : { model: { id: mode.model } }),
      ...(mode === null ? {} : { mode: mode.mode.id }),
      ...(body.system === undefined ? {} : { system: body.system }),
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      ...(body.initial_events === undefined ? {} : { initial_events: body.initial_events }),
    }
    // `createSession` answers `AgentNotFoundError` for an unknown agent, which the app maps
    // to a 404 in the protocol's envelope. The agent is optional since #93 — a model-first
    // session passes `null` — and the store resolves the effective model/system (#94).
    const session = await deps.store.createSession(body.agent ?? null, options)
    // A session created with a message is named after it, exactly as one that has its first
    // message posted afterwards — unless the request carried a title of its own, which wins.
    const named = await nameSessionFromFirstMessage(
      deps.store,
      session.id,
      body.initial_events ?? [],
      ownerId,
    )
    // `initial_events` are the session's first queued events — the protocol says they are
    // stored "before it starts running" — so a session created with a message runs it, and one
    // created with an interrupt has it claimed, exactly as `POST …/events` would.
    for (const kind of signalKinds(body.initial_events ?? [])) {
      deps.scheduler.signal(session.id, kind)
    }
    return c.json(named ?? session, 201)
  })

  app.get(sessions, async (c) => {
    const query = parseQuery(c, ListSessionsQuerySchema)
    // The wire spells the filter `agent_id`; the store takes it as `agentId`.
    const options: ListSessionsOptions = {
      ownerId: c.get('user').id,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.agent_id === undefined ? {} : { agentId: query.agent_id }),
    }
    return c.json(await deps.store.listSessions(options))
  })

  app.get(`${sessions}/:session_id`, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const session = await deps.store.getSession(sessionId, { ownerId: c.get('user').id })
    if (session === null) {
      throw notFoundError(`no session with id ${sessionId}`)
    }
    return c.json(session)
  })

  /**
   * `DELETE /v1/sessions/{session_id}` — hard delete (epic #116, U5). `204`, owner-scoped:
   * another user's session is the 404 an id nothing has gets, so nothing leaks (A4).
   *
   * In order, so the one promise it makes — nothing lands in the log after it returns — holds:
   *
   * 1. the scoped read is the ownership check;
   * 2. the scheduler stops the turn in flight and waits for its pass to finish writing
   *    (`SessionScheduler.stopSession`; on another instance that is a partition signal);
   * 3. `store.deleteSession` removes the session and every row keyed by it in one transaction,
   *    and notifies the session's subscribers — every open stream for it gets a final
   *    `session.deleted` and closes, on whichever instance it runs.
   *
   * A `false` from `deleteSession` means somebody deleted it first (or it never existed): the
   * same 404, since there is nothing left to delete.
   */
  app.delete(`${sessions}/:session_id`, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const ownerId = c.get('user').id
    if ((await deps.store.getSession(sessionId, { ownerId })) === null) {
      throw notFoundError(`no session with id ${sessionId}`)
    }
    await deps.scheduler.stopSession(sessionId)
    if (!(await deps.store.deleteSession(sessionId, { ownerId }))) {
      throw notFoundError(`no session with id ${sessionId}`)
    }
    return c.body(null, 204)
  })
}

/**
 * Refuse an id that does not have the `provider/model` shape the model factory takes (issue
 * #94; epic #116 U1/U3), as the protocol's `invalid_request_error` 400.
 */
export function requireModelId(id: string): void {
  if (!isModelId(id)) {
    throw invalidRequest(
      `model.id must be a "provider/model" id with non-empty parts, got ${JSON.stringify(id)}`,
    )
  }
}

/**
 * What resolving and refusing a mode needs (#245, M6): the modes and preferences on the store,
 * and the caller's own credentials — which is what decides whether a mode's model can be used.
 */
export function modeDeps(deps: RouteDeps): ModeDeps {
  return { store: deps.store, credentials: deps.credentialRoutes.credentials }
}

/** Refuse a `model` on any `user.message` among these events; see {@link requireModelId}. */
export function requireEventModelIds(events: readonly EventInput[]): void {
  for (const event of events) {
    if (event.type === EVENT_TYPES.userMessage && event.model !== undefined) {
      requireModelId(event.model.id)
    }
  }
}
