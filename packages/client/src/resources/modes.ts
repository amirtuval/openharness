import { API_VERSION_PREFIX, ListModesResponseSchema, ModeSchema } from '@openharness/protocol'
import type {
  CreateModeRequest,
  ListModesResponse,
  Mode,
  UpdateModeRequest,
} from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The caller's own modes (epic #245, M6): named presets a chat can follow.
 *
 * ```
 * POST   /v1/me/modes        create  -> mode
 * GET    /v1/me/modes        list    -> { data: mode[] }
 * GET    /v1/me/modes/{id}   get     -> mode
 * POST   /v1/me/modes/{id}   update  -> mode
 * DELETE /v1/me/modes/{id}   delete  -> 204
 * ```
 *
 * A mode is per user — its routes live under `/v1/me`, its owner is the authenticated caller,
 * and another user's mode is a 404 — and it bundles a model, a reasoning effort and a
 * system-prompt addition behind a unique name. Its `model` is a `provider/model` id or the
 * `MODE_DEFAULT_MODEL` sentinel ("my default model"), which follows the caller's
 * `default_model`. The list has no pagination: a user holds at most `MAX_MODES_PER_USER`
 * modes, so a picker can show them all at once.
 */
export interface ModesResource {
  /**
   * Create a mode.
   *
   * @param body the mode's fields; `model` is a `provider/model` id or `MODE_DEFAULT_MODEL`
   * @param options request options (cancellation)
   * @throws ApiError with `conflict_error` (409) for a name the caller already has, or when
   * they already hold `MAX_MODES_PER_USER` modes
   */
  create(body: CreateModeRequest, options?: RequestOptions): Promise<Mode>

  /**
   * Read one mode.
   *
   * @param modeId the `mode_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such mode, or it is another user's
   */
  get(modeId: string, options?: RequestOptions): Promise<Mode>

  /**
   * List the caller's modes, oldest first.
   *
   * @param options request options (cancellation)
   */
  list(options?: RequestOptions): Promise<ListModesResponse>

  /**
   * Update a mode. Omitted fields keep their value; `null` clears a nullable one.
   *
   * @param modeId the `mode_` id
   * @param body the fields to change
   * @param options request options (cancellation)
   * @throws ApiError with `conflict_error` (409) when a rename collides with another mode
   */
  update(modeId: string, body: UpdateModeRequest, options?: RequestOptions): Promise<Mode>

  /**
   * Delete a mode. The chats that followed it continue on the model they last ran.
   *
   * @param modeId the `mode_` id
   * @param options request options (cancellation)
   * @throws ApiError with `not_found_error` when there is no such mode, or it is another user's
   */
  delete(modeId: string, options?: RequestOptions): Promise<void>
}

/** Build the modes resource over a transport. */
export function createModesResource(transport: Transport): ModesResource {
  const path = `${API_VERSION_PREFIX}/me/modes`

  return {
    create(body, options) {
      return transport.json(ModeSchema, {
        method: 'POST',
        path,
        body,
        signal: options?.signal,
      })
    },

    get(modeId, options) {
      return transport.json(ModeSchema, {
        method: 'GET',
        path: `${path}/${modeId}`,
        signal: options?.signal,
      })
    },

    list(options) {
      return transport.json(ListModesResponseSchema, {
        method: 'GET',
        path,
        signal: options?.signal,
      })
    },

    update(modeId, body, options) {
      return transport.json(ModeSchema, {
        method: 'POST',
        path: `${path}/${modeId}`,
        body,
        signal: options?.signal,
      })
    },

    delete(modeId, options) {
      return transport.noContent({
        method: 'DELETE',
        path: `${path}/${modeId}`,
        signal: options?.signal,
      })
    },
  }
}
