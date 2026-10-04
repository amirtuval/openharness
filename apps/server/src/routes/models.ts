import type { Hono } from 'hono'
import { API_VERSION_PREFIX, ListModelsQuerySchema } from '@openharness/protocol'

import { CatalogRefreshLimitedError } from '../catalog/catalog'
import { rateLimitError } from '../http/errors'
import { parseQuery } from '../http/request'
import type { AppEnv } from '../types'
import type { RouteDeps } from './deps'

/**
 * `GET /v1/models` — the model catalogue (epic #92; issue #90).
 *
 * ```
 * GET /v1/models[?refresh=true]   -> { data: model entry[], providers: provider status[] }
 * ```
 *
 * The route is thin on purpose: authentication and the owner are the guard's (`app.ts`), the
 * query is the protocol's `ListModelsQuerySchema`, and everything else — which providers,
 * which key, caching, the registry join, the fallback — is {@link RouteDeps.catalog}. It
 * answers the caller's own models and nothing else: the owner comes from `c.get('user')`, so
 * one user's keys are never used for another's request (A4).
 *
 * `refresh=true` bypasses the cache and re-fetches every provider the caller has a key for;
 * like every cache bypass it is a live call to those providers, so it is rate-limited to once
 * a minute per user, and a refresh inside that window is the protocol's 429 —
 * `rate_limit_error`, the same type the clients already handle. A refresh that is not
 * rate-limited but fails at the providers is not an error at all: each failed provider is
 * answered from the registry as a `fallback` (C3), in the same 200 response.
 */
export function registerModelRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  app.get(`${API_VERSION_PREFIX}/models`, async (c) => {
    const query = parseQuery(c, ListModelsQuerySchema)
    try {
      const response = await deps.catalog.list(c.get('user').id, {
        refresh: query.refresh === true,
      })
      return c.json(response)
    } catch (error) {
      if (error instanceof CatalogRefreshLimitedError) {
        throw rateLimitError(error.message)
      }
      throw error
    }
  })
}
