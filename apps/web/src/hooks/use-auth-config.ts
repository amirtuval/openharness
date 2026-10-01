import { useEffect, useState } from 'react'

import { fetchAuthConfig, type AuthConfig } from '../lib/auth-config'
import { describeError } from '../lib/errors'
import { useSettings } from './use-settings'

/** What the sign-in page needs from `GET /v1/auth-config`. */
export interface AuthConfigView {
  /** The config, once the server has answered. */
  readonly config: AuthConfig | null
  /** The request is still in flight. */
  readonly loading: boolean
  /** The request failed, as shown inline. */
  readonly error: string | null
}

/**
 * Load the server's auth config.
 *
 * Requested once per mount — the sign-in page is the only caller, and the answer cannot
 * change while the page is open (enabling a provider is a server restart). The configured
 * server is what the API client is pointed at, so the button this screen draws and the
 * endpoints it calls can never disagree about where the server is.
 */
export function useAuthConfig(): AuthConfigView {
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { serverUrl } = useSettings()

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void fetchAuthConfig({ baseUrl: serverUrl, signal: controller.signal }).then(
      (loaded) => {
        if (controller.signal.aborted) {
          return
        }
        setConfig(loaded)
        setLoading(false)
      },
      (caught: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        setError(describeError(caught, { serverUrl }))
        setLoading(false)
      },
    )
    return () => controller.abort()
  }, [serverUrl])

  return { config, loading, error }
}
