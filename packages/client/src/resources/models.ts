import { API_VERSION_PREFIX, ListModelsResponseSchema } from '@openharness/protocol'
import type { ListModelsQuery, ListModelsResponse } from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The model catalog (epic #92, wave 1): `GET /v1/models`, the list the agent form offers.
 *
 * ```
 * GET /v1/models   list -> { data: model entry[], providers: provider status[] }
 * ```
 *
 * The catalog holds the chat models the caller's own provider credentials can use, sorted by
 * provider then name, with one provider status per provider they have a key for: `ok` when
 * the provider's own list answered, `fallback` when it failed or timed out and the registry's
 * chat models stood in. The server caches the answer in memory per user and provider for an
 * hour; `refresh: true` bypasses the cache and re-fetches.
 */
export interface ModelsResource {
  /**
   * List the models the caller's keys can use, sorted by provider then name.
   *
   * @param params `refresh: true` bypasses the server's cache and re-fetches (C4)
   * @param options request options (cancellation)
   * @throws ApiError with `rate_limit_error` (429) when refreshed more than once a minute
   */
  list(params?: ListModelsQuery, options?: RequestOptions): Promise<ListModelsResponse>
}

/** Build the models resource over a transport. */
export function createModelsResource(transport: Transport): ModelsResource {
  return {
    list(params, options) {
      return transport.json(ListModelsResponseSchema, {
        method: 'GET',
        path: `${API_VERSION_PREFIX}/models`,
        // `refresh=true` is the only spelling that means anything to the server (C4); the
        // parameter is left off otherwise, which is what a cached read sends.
        query: params?.refresh === true ? { refresh: true } : undefined,
        signal: options?.signal,
      })
    },
  }
}
