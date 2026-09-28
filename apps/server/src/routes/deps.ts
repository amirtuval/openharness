import type { SessionStore } from '@openharness/session'

import type { SessionScheduler } from '../scheduler'

/**
 * What every route needs: the log, and the thing that runs the brains working on it.
 *
 * Routes never run a turn themselves. They append and they {@link SessionScheduler.signal},
 * which is the seam that lets a single-instance server and a multi-instance one (#11) share
 * the same handlers.
 */
export interface RouteDeps {
  /** The durable session log. */
  readonly store: SessionStore
  /** Who runs a session's brain when the API says it needs one. */
  readonly scheduler: SessionScheduler
  /** The SSE keepalive interval; tests shorten it. */
  readonly sseKeepaliveMs?: number
}
