import { API_VERSION_PREFIX, GetPreferencesResponseSchema } from '@openharness/protocol'
import type { GetPreferencesResponse, PutPreferencesRequest } from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The caller's own preferences (#111, epic #116 U1).
 *
 * ```
 * GET /v1/me/preferences   get -> preferences
 * PUT /v1/me/preferences   put -> preferences
 * ```
 *
 * `default_model` is the `provider/model` a new chat starts with, or `null` when the user has
 * not set one — the absence of a choice, not a 404. The routes are owner-only, like
 * `GET /v1/me`: they answer for the authenticated caller and nobody else. `put` writes the
 * complete value (there is no partial update), so `null` is how the stored default is cleared.
 * The id is validated for shape only; whether the model exists is the catalog's answer.
 */
export interface PreferencesResource {
  /**
   * Read the caller's preferences.
   *
   * A caller who has never saved any gets `{ default_model: null }`.
   *
   * @param options request options (cancellation)
   * @throws AuthenticationError when the caller has no valid session
   */
  get(options?: RequestOptions): Promise<GetPreferencesResponse>

  /**
   * Write the caller's preferences, whole.
   *
   * @param preferences the complete value to store; `default_model: null` clears the default
   * @param options request options (cancellation)
   */
  put(preferences: PutPreferencesRequest, options?: RequestOptions): Promise<GetPreferencesResponse>
}

/** Build the preferences resource over a transport. */
export function createPreferencesResource(transport: Transport): PreferencesResource {
  const path = `${API_VERSION_PREFIX}/me/preferences`

  return {
    get(options) {
      return transport.json(GetPreferencesResponseSchema, {
        method: 'GET',
        path,
        signal: options?.signal,
      })
    },

    put(preferences, options) {
      return transport.json(GetPreferencesResponseSchema, {
        method: 'PUT',
        path,
        body: preferences,
        signal: options?.signal,
      })
    },
  }
}
