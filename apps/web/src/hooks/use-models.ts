import { ApiError, type Client } from '@openharness/client'
import type { ModelEntry, ProviderCatalogStatus } from '@openharness/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'
import { describeError } from '../lib/errors'
import { useSettings } from './use-settings'

/** Why a refresh did not happen, when it did not. */
export type RefreshOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      /** `rate_limit` is the 429 the server answers a refresh inside its one-minute window. */
      readonly kind: 'rate_limit' | 'error'
      readonly message: string
    }

/** The model catalog the shell reads: the list, and bypassing the server's cache. */
export interface ModelsView {
  /** The chat models the caller's keys can use, as the server sorted them. */
  readonly models: readonly ModelEntry[]
  /** One status per provider the caller has a credential for (C5). */
  readonly providers: readonly ProviderCatalogStatus[]
  /** The first load is still in flight. */
  readonly loading: boolean
  /** A failed load, as shown inline. */
  readonly error: string | null
  /** A refresh is in flight. */
  readonly refreshing: boolean
  /**
   * Re-fetch with `refresh: true`, bypassing the server's per-user cache (C4).
   *
   * On success the list is replaced in place, so every surface reading this view — the
   * picker, the sidebar's labels — sees the new catalog. A 429 (refreshed too recently) is
   * answered as `rate_limit`, not as an error state: the caller shows a note and keeps the
   * list it already had.
   */
  readonly refresh: () => Promise<RefreshOutcome>
  /**
   * Read the catalog again, the plain way.
   *
   * This is what a **credential change** asks for (#209): saving a key changes what the caller
   * can run, and the shell has to see it before the picker can offer it. It is deliberately not
   * {@link refresh}: a refresh bypasses the server's cache and is rate-limited to once a
   * minute, while saving a key already invalidates that provider's cache entry server-side
   * (C4), so an ordinary read is both fresh where it matters and unbounded.
   */
  readonly reload: () => Promise<void>
  /** Clear the load error. */
  readonly dismissError: () => void
}

/**
 * The catalog, loaded once for the whole shell.
 *
 * `GET /v1/models` is fed by the caller's own credentials and cached server-side for an hour,
 * so one read per app load is the whole cost; the picker and the session labels share this
 * one copy rather than asking separately.
 */
export function useModels(client: Client): ModelsView {
  const [models, setModels] = useState<readonly ModelEntry[]>([])
  const [providers, setProviders] = useState<readonly ProviderCatalogStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // An answer that arrives after the hook unmounted — or after a settings save rebuilt the
  // client, which re-runs the effect below — must not be applied.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // A failure of our own is described with the server the client is pointed at, so a request
  // that never arrived can say where it did not arrive.
  const { serverUrl } = useSettings()

  const apply = useCallback(
    (response: {
      data: readonly ModelEntry[]
      providers: readonly ProviderCatalogStatus[]
    }): void => {
      if (!mounted.current) {
        return
      }
      setModels(response.data)
      setProviders(response.providers)
      setError(null)
    },
    [],
  )

  /** One ordinary read of the catalog: the mount's, and every {@link reload}. */
  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const response = await client.models.list(
          undefined,
          signal === undefined ? undefined : { signal },
        )
        apply(response)
      } catch (caught) {
        if (signal?.aborted === true) {
          return
        }
        if (!noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
      }
    },
    [client, serverUrl, apply],
  )

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) {
        setLoading(false)
      }
    })
    return () => controller.abort()
  }, [load])

  const reload = useCallback(async (): Promise<void> => {
    await load()
  }, [load])

  const refresh = useCallback(async (): Promise<RefreshOutcome> => {
    setRefreshing(true)
    try {
      const response = await client.models.list({ refresh: true })
      apply(response)
      return { ok: true }
    } catch (caught) {
      // A 401 here is still a signed-out session: hand it to the shell first.
      noteAuthenticationError(client, caught)
      if (caught instanceof ApiError && caught.type === 'rate_limit_error') {
        // Graceful by contract: a 429 means "come back later", not "something broke" — the
        // list on screen is still the one the server last sent.
        return { ok: false, kind: 'rate_limit', message: caught.message }
      }
      return { ok: false, kind: 'error', message: describeError(caught, { serverUrl }) }
    } finally {
      if (mounted.current) {
        setRefreshing(false)
      }
    }
  }, [client, serverUrl, apply])

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { models, providers, loading, error, refreshing, refresh, reload, dismissError }
}
