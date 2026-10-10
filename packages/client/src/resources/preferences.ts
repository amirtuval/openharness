import { API_VERSION_PREFIX, GetPreferencesResponseSchema } from '@openharness/protocol'
import type { GetPreferencesResponse, PutPreferencesRequest } from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The caller's own preferences (#111, epic #116 U1; the compaction controls: epic #277 C3, #282).
 *
 * ```
 * GET /v1/me/preferences   get -> preferences
 * PUT /v1/me/preferences   put -> preferences
 * ```
 *
 * `default_model` is the `provider/model` a new chat starts with, or `null` when the user has
 * not set one — the absence of a choice, not a 404 — and `theme` is the web app's colour
 * scheme (`system`, `light`, `dim` or `dark`). The three compaction controls are the epic #277
 * settings: `compaction_threshold` (the share of the chat model's budget at which older history
 * is summarized, `null` for the server's own), `summary_model` (`same-as-chat`, or a
 * `provider/model` id) and `summary_max_passes` (`null` for the engine's own). The response
 * carries a `defaults` object saying what each `null` means, so a settings screen can render
 * "0.7 (server default)" without knowing the deployment. The routes are owner-only, like
 * `GET /v1/me`: they answer for the authenticated caller and nobody else. `put` merges: the
 * fields it is given are stored, the ones it leaves out keep their stored value, and
 * `default_model: null` clears the stored default. The ids are validated for shape only;
 * whether a model exists is the catalog's answer.
 */
export interface PreferencesResource {
  /**
   * Read the caller's preferences.
   *
   * A caller who has never saved any gets the defaults and no choices — `default_model: null`,
   * `theme: 'system'`, every compaction control "follow the default".
   *
   * @param options request options (cancellation)
   * @throws AuthenticationError when the caller has no valid session
   */
  get(options?: RequestOptions): Promise<GetPreferencesResponse>

  /**
   * Write the caller's preferences: the fields given, over what is stored.
   *
   * @param preferences the fields to change; `default_model: null` clears the default, and a
   * field left out keeps its stored value
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
