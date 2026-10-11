import { API_VERSION_PREFIX, ListToolSettingsResponseSchema } from '@openharness/protocol'
import type {
  ListToolSettingsQuery,
  ListToolSettingsResponse,
  PutToolSettingsRequest,
} from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The caller's own tool settings (epic #303, X4; #307; the screen is #308).
 *
 * ```
 * GET /v1/me/tools            list the effective settings -> { data: entry[] }
 * PUT /v1/me/tools            merge per-tool choices     -> { data: entry[] }
 * ```
 *
 * A per-user choice about which of the build's tools a chat may use, and under which permission
 * (`allow`, `ask` or `deny`). The read is the **effective** answer a chat would get: a mode's
 * on/off override applied over the user's own choices when `mode_id` names one, a tool's own
 * declared permission where the user chose none, and `available: false` for a tool this
 * deployment does not register — a `web_search` with no operator key, say — listed rather than
 * hidden so a settings screen can say why it is not working.
 *
 * The write **merges** per tool, exactly as `PUT /v1/me/preferences` merges its fields: a tool
 * the body names replaces that tool's whole setting, and every other tool keeps what is stored.
 * Both routes are owner-only and per-user (under `/v1/me`), and answer the list — the same shape
 * the read does — so a screen updates in place from either.
 */
export interface ToolsResource {
  /**
   * Read the effective tool settings, one entry per tool.
   *
   * @param params `mode_id` answers the read as a chat on that mode would see it
   * @param options request options (cancellation)
   */
  list(params?: ListToolSettingsQuery, options?: RequestOptions): Promise<ListToolSettingsResponse>

  /**
   * Merge per-tool choices over what is stored, and read the result back.
   *
   * @param body the tools to change; a tool left out keeps its stored setting
   * @param options request options (cancellation)
   */
  put(body: PutToolSettingsRequest, options?: RequestOptions): Promise<ListToolSettingsResponse>
}

/** Build the tools resource over a transport. */
export function createToolsResource(transport: Transport): ToolsResource {
  const path = `${API_VERSION_PREFIX}/me/tools`

  return {
    list(params, options) {
      return transport.json(ListToolSettingsResponseSchema, {
        method: 'GET',
        path,
        query: { mode_id: params?.mode_id },
        signal: options?.signal,
      })
    },

    put(body, options) {
      return transport.json(ListToolSettingsResponseSchema, {
        method: 'PUT',
        path,
        body,
        signal: options?.signal,
      })
    },
  }
}
