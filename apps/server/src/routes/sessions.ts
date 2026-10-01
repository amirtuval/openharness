import type { Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  CreateSessionRequestSchema,
  ListSessionsQuerySchema,
} from '@openharness/protocol'
import type { CreateSessionOptions, ListSessionsOptions } from '@openharness/session'

import type { AppEnv } from '../types'
import { notFoundError } from '../http/errors'
import { parseBody, parseQuery, sessionIdParam } from '../http/request'
import { nameSessionFromFirstMessage } from '../titles'
import type { RouteDeps } from './deps'
import { signalKinds } from './signals'

/**
 * The session endpoints.
 *
 * A session is the header of an event log: creating one snapshots the agent it will run, and
 * every later change to that agent applies to new sessions only.
 */
export function registerSessionRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const sessions = `${API_VERSION_PREFIX}/sessions`

  app.post(sessions, async (c) => {
    const body = await parseBody(c, CreateSessionRequestSchema)
    const options: CreateSessionOptions = {
      // Every session belongs to the caller (epic #65, A4), and the agent it snapshots has
      // to be theirs too: `createSession` answers `AgentNotFoundError` — a 404 — for an
      // agent somebody else owns.
      ownerId: c.get('user').id,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.metadata === undefined ? {} : { metadata: body.metadata }),
      ...(body.initial_events === undefined ? {} : { initial_events: body.initial_events }),
    }
    // `createSession` answers `AgentNotFoundError` for an unknown agent, which the app maps
    // to a 404 in the protocol's envelope.
    const session = await deps.store.createSession(body.agent, options)
    // A session created with a message is named after it, exactly as one that has its first
    // message posted afterwards — unless the request carried a title of its own, which wins.
    const named = await nameSessionFromFirstMessage(
      deps.store,
      session.id,
      body.initial_events ?? [],
      options.ownerId,
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
}
