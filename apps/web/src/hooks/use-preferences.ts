import type { Client } from '@openharness/client'
import type { GetPreferencesResponse } from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { noteAuthenticationError } from '../lib/auth-store'
import { describeError } from '../lib/errors'
import { useSettings } from './use-settings'

/** Why a save did not happen. */
export type SavePreferencesResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string }

/** The caller's preferences (epic #116, U1): the default model, and saving it. */
export interface PreferencesView {
  /** The preferences, once the server has answered. */
  readonly preferences: GetPreferencesResponse | null
  /** The first read is still in flight. */
  readonly loading: boolean
  /** A failed read or write, as shown inline. */
  readonly error: string | null
  /** A `put` is in flight. */
  readonly saving: boolean
  /**
   * Write the default model, whole: a `provider/model` id, or `null` to clear it.
   *
   * On success the stored answer replaces what the view holds, so a picker reading this view
   * shows what the server accepted — including a default the server chose itself.
   */
  readonly save: (defaultModel: string | null) => Promise<SavePreferencesResult>
  /**
   * Read the stored preferences again.
   *
   * For the one case where the **server** changed them under us: saving a provider key makes it
   * pick a default model for an account that had none (epic #116, U4), and the first-run screen
   * says which model that was (#209). A picker that just wrote through {@link save} already
   * holds the server's answer.
   */
  readonly reload: () => Promise<void>
  /** Clear the error. */
  readonly dismissError: () => void
}

/**
 * `GET`/`PUT /v1/me/preferences` for a screen.
 *
 * Read once per mount, like the other resource hooks: preferences change only through this
 * app (Settings) or `oh`, and a stale copy costs nothing — the next screen mount reads
 * again. The default is the server's answer either way, so there is no local fallback here.
 */
export function usePreferences(client: Client): PreferencesView {
  const [preferences, setPreferences] = useState<GetPreferencesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // A failure of our own is described with the server the client is pointed at, so a request
  // that never arrived can say where it did not arrive.
  const { serverUrl } = useSettings()

  /** One read: the mount's, and every {@link reload}. */
  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const loaded = await client.preferences.get(signal === undefined ? undefined : { signal })
        setPreferences(loaded)
        setError(null)
      } catch (caught) {
        if (signal?.aborted === true) {
          return
        }
        if (!noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
      }
    },
    [client, serverUrl],
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

  const save = useCallback(
    async (defaultModel: string | null): Promise<SavePreferencesResult> => {
      setSaving(true)
      try {
        const saved = await client.preferences.put({ default_model: defaultModel })
        setPreferences(saved)
        setError(null)
        return { ok: true }
      } catch (caught) {
        // A 401 still signs the app out — the shell takes it from here — but the caller
        // wants an answer either way, so the message is returned as well as noted.
        noteAuthenticationError(client, caught)
        const message = describeError(caught, { serverUrl })
        return { ok: false, message }
      } finally {
        setSaving(false)
      }
    },
    [client, serverUrl],
  )

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { preferences, loading, error, saving, save, reload, dismissError }
}
