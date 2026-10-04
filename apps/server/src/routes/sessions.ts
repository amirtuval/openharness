import type { Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  CreateSessionRequestSchema,
  ListSessionsQuerySchema,
} from '@openharness/protocol'
import type { CreateSessionOptions, ListSessionsOptions } from '@openharness/session'

import type { AppEnv } from '../types'
import { invalidRequest, notFoundError } from '../http/errors'
import { parseBody, parseQuery, sessionIdParam } from '../http/request'
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
    // (a 400). The inline model id is checked here: the router's `provider/model` shape, with
    // non-empty parts — a value no provider could ever resolve is a request, not a session
    // (issue #94). The format lives outside the protocol's `ModelConfigSchema` until the
    // catalog wave is done; this is the one route that acts on it today.
    if (body.model !== undefined && !isModelId(body.model.id)) {
      throw invalidRequest(
        `model.id must be a "provider/model" id with non-empty parts, got ${JSON.stringify(body.model.id)}`,
      )
    }
    const options: CreateSessionOptions = {
      // Every session belongs to the caller (epic #65, A4), and the agent it snapshots has
      // to be theirs too: `createSession` answers `AgentNotFoundError` — a 404 — for an
      // agent somebody else owns.
      ownerId: c.get('user').id,
      // The request's inline model and system: with an agent they override what the agent
      // contributes, and without one they are what the session runs (#93). Either way the
      // session stores the *effective* configuration, so the brain never reads the agent.
      ...(body.model === undefined ? {} : { model: body.model }),
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

/**
 * Whether an inline model id has the `provider/model` shape the router takes (issue #94):
 * two or more slash-separated parts, none empty. `openai/gpt-4.1-mini` and
 * `openrouter/meta-llama/llama-3` pass; `gpt-4.1-mini`, `/gpt-4.1-mini`, `openai/` and
 * `openai//gpt-4.1-mini` do not — none of them names a provider and a model.
 *
 * Deliberately a shape check and not a catalogue lookup: the router accepts models the
 * catalogue does not know yet (C5), so anything that could resolve stays allowed.
 */
function isModelId(id: string): boolean {
  const parts = id.split('/')
  return parts.length >= 2 && parts.every((part) => part.length > 0)
}
