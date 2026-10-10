import type { Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  CompactSessionRequestSchema,
  EVENT_TYPES,
  type SessionCompactEvent,
  type SessionId,
  type UserId,
} from '@openharness/protocol'

import type { AppEnv } from '../types'
import { notFoundError } from '../http/errors'
import { parseBody, sessionIdParam } from '../http/request'
import type { RouteDeps } from './deps'

/**
 * `POST /v1/sessions/{session_id}/compact` — `/compact [instructions]` (epic #277, K8; #283).
 *
 * The route turns the client's ask into the one event a manual compaction is: it appends a
 * stored `session.compact` (the optional guidance and nothing else — `id`, `seq` and
 * `processed_at` are the store's), then signals the scheduler, and the brain answers it. The
 * request is not a queued user event, so it is the log — not the scheduler's pending list — that
 * decides whether one is still waiting: an owner-scoped read of the newest of the two compaction
 * events. A `session.compact` there is one nobody has answered yet, and the route returns it
 * rather than appending a second, which is what makes a repeated `/compact` **idempotent while
 * one is pending**. A `session.compaction` (or nothing at all) means the last ask was answered,
 * and a new one is appended.
 *
 * The event is the session's to write, like a `session.rewind` (#238): the client asks, the
 * server records, and nothing the caller sends can forge the rest of the log. Ownership is the
 * same scoped read every by-id route makes — another user's session is a 404 before anything is
 * appended (A4).
 *
 * When a turn is running the request is answered at its next request boundary, because the turn
 * loop reads the log there and finds it; when the session is idle the signal starts a turn of its
 * own, which answers the request and nothing else — a manual compaction never produces a model
 * reply.
 */
export function registerCompactRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const compact = `${API_VERSION_PREFIX}/sessions/:session_id/compact`

  app.post(compact, async (c) => {
    const sessionId = sessionIdParam(c, 'session_id')
    const ownerId = c.get('user').id
    // The scoped read is the ownership check: another user's session answers 404 before the
    // body is even read, exactly as every other by-id route refuses one (A4).
    if ((await deps.store.getSession(sessionId, { ownerId })) === null) {
      throw notFoundError(`no session with id ${sessionId}`)
    }
    const body = await parseBody(c, CompactSessionRequestSchema)
    const pending = await pendingCompaction(deps, sessionId, ownerId)
    if (pending !== null) {
      return c.json({ data: pending })
    }
    const [stored] = await deps.store.appendEvents(sessionId, [
      {
        type: EVENT_TYPES.sessionCompact,
        ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
      },
    ])
    if (stored === undefined) {
      throw new Error('the store did not return the session.compact it was asked to append')
    }
    // The append is durable; the signal is the latency optimization every route's is. A lost
    // one is not fatal: the next turn's boundary reads the request off the log.
    deps.scheduler.signal(sessionId, 'work')
    return c.json({ data: stored })
  })
}

/**
 * The manual compaction already waiting for an answer, or `null` when there is none.
 *
 * One owner-scoped read of the newest event of the pair: a `session.compact` there is unanswered
 * (the brain appends its `session.compaction` right after handling it), and anything else means
 * no request is pending. `types` narrows the read to the two event types, and `desc`/`limit: 1`
 * make it the newest of them — the same "newest of the pair" rule `pendingManualCompaction` in
 * the brain applies to a whole log, so the route and the brain agree about what is pending.
 */
async function pendingCompaction(
  deps: RouteDeps,
  sessionId: SessionId,
  ownerId: UserId,
): Promise<SessionCompactEvent | null> {
  const page = await deps.store.listEvents(sessionId, {
    ownerId,
    types: [EVENT_TYPES.sessionCompact, EVENT_TYPES.sessionCompaction],
    order: 'desc',
    limit: 1,
  })
  const newest = page.data[0]
  return newest !== undefined && newest.type === EVENT_TYPES.sessionCompact ? newest : null
}
