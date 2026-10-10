import { API_VERSION_PREFIX, SessionUsageSchema, UserUsageSchema } from '@openharness/protocol'
import type { SessionUsage, UserUsage, UserUsageQuery } from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'
import { sessionPath } from './sessions'

/**
 * What a session and a user spent (epic #245, A2; issue #247).
 *
 * ```
 * GET /v1/sessions/{session_id}/usage   session -> { session_id, totals, cost, by_model }
 * GET /v1/me/usage                      me      -> { from, to, tz, totals, cost, by_model, by_day }
 * ```
 *
 * Both are reads of the log, priced on the server when they are asked for: the tokens come from
 * the `span.model_request_end` events a session stored and the money from the model catalog's
 * rates, and neither is ever stored. A total that includes a model nobody publishes a price for
 * is `null` — "—" in a frontend, never an estimate.
 *
 * A client that is following a session live rarely needs `session`: the newest `session.usage`
 * event in the log carries the same totals, and {@link sessionUsageOf} derives them from the
 * transcript for a session stored before that event existed. This resource is for the reads a
 * transcript cannot answer — a whole month across every session, grouped by day and by model.
 */
export interface UsageResource {
  /**
   * Read one session's totals — the caller's own session, or a 404.
   *
   * @param sessionId the `sesn_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` for another user's session or an unknown id
   */
  session(sessionId: string, options?: RequestOptions): Promise<SessionUsage>

  /**
   * Read the caller's own usage over a date range, by model and by day.
   *
   * `from` and `to` are inclusive local days and `tz` is the IANA zone they are read in; both
   * default to "this month so far" in `tz`, and `tz` to `UTC`. Pass the reader's own zone —
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` — so "today" is the day they are in.
   *
   * @param params the range and zone; see {@link UserUsageQuery}
   * @param options request options (cancellation)
   */
  me(params?: UserUsageQuery, options?: RequestOptions): Promise<UserUsage>
}

/** Build the usage resource over a transport. */
export function createUsageResource(transport: Transport): UsageResource {
  return {
    session(sessionId, options) {
      return transport.json(SessionUsageSchema, {
        method: 'GET',
        path: `${sessionPath(sessionId)}/usage`,
        signal: options?.signal,
      })
    },

    me(params, options) {
      return transport.json(UserUsageSchema, {
        method: 'GET',
        path: `${API_VERSION_PREFIX}/me/usage`,
        // Each parameter is left off the wire when it is not given, so the server's own
        // defaults (this month so far, UTC) are what answers a request that named none.
        query: {
          ...(params?.from === undefined ? {} : { from: params.from }),
          ...(params?.to === undefined ? {} : { to: params.to }),
          ...(params?.tz === undefined ? {} : { tz: params.tz }),
        },
        signal: options?.signal,
      })
    },
  }
}
