import type { Hono } from 'hono'
import { API_VERSION_PREFIX, UserUsageQuerySchema } from '@openharness/protocol'

import type { AppEnv } from '../types'
import { parseQuery, sessionIdParam } from '../http/request'
import { usageRange } from '../local-day'
import type { RouteDeps } from './deps'

/**
 * What a session and a user spent (epic #245, A2; issue #247).
 *
 * Two reads, both assembled from the session log on the spot — the tokens come from the
 * `span.model_request_end` events the log holds and the money from the model catalog's prices,
 * so nothing here writes anything and nothing about cost is ever stored.
 *
 * ```
 * GET /v1/sessions/{session_id}/usage -> SessionUsage
 * GET /v1/me/usage?from=&to=&tz=      -> UserUsage
 * ```
 *
 * **Ownership** is the whole of the access control: the session route takes the caller's owner
 * through the store's scoped read, so another user's session is the 404 an unknown id gets, and
 * the user route has no id in its path at all — it is always the caller, and there is no
 * operator-wide view (epic #245: "users see only their own usage").
 *
 * **Time zones** are the user's, not the server's: `tz` names an IANA zone, the days in the
 * response are local days in it, and {@link usageRange} fills in the defaults (this month so
 * far, UTC when nothing is named). A zone the runtime does not know is the 400
 * `invalid_request_error` every bad query gets — never a silent UTC, which would answer a
 * question nobody asked.
 */
export function registerUsageRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  app.get(`${API_VERSION_PREFIX}/sessions/:session_id/usage`, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    // A session that is not the caller's answers SessionNotFoundError, which `app.onError` maps
    // to the 404 (A4) — the same answer an id nothing has gets.
    return c.json(await deps.usage.session(sessionId, { ownerId: c.get('user').id }))
  })

  app.get(`${API_VERSION_PREFIX}/me/usage`, async (c) => {
    const query = parseQuery(c, UserUsageQuerySchema)
    return c.json(await deps.usage.user(c.get('user').id, usageRange(query)))
  })
}
