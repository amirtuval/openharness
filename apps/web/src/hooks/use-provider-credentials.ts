import { ApiError, AuthenticationError, type Client } from '@openharness/client'
import type { ProviderCredential } from '@openharness/protocol'
import { useCallback, useEffect, useState } from 'react'

import { describeError } from '../lib/errors'
import { noteAuthenticationError } from '../lib/auth-store'
import { useSettings } from './use-settings'

/**
 * Why a save or a delete did not happen.
 *
 * - `invalid` — the provider refused the key (422 `invalid_provider_credential`): the message
 *   belongs next to the form, because a different key fixes it.
 * - `session` — the server wants a **fresh** session for credential writes (epic #65, A2):
 *   the reader has to sign in again, and the message says so and links there.
 * - `error` — anything else, as one line.
 */
export type CredentialFailureKind = 'invalid' | 'session' | 'error'

/** The outcome of an add, replace or delete. */
export type CredentialResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: CredentialFailureKind; readonly message: string }

/** Everything the Model providers card needs. */
export interface ProviderCredentialsView {
  /** The saved credentials, metadata only — the keys themselves never come back. */
  readonly credentials: readonly ProviderCredential[]
  /** The list is still loading for the first time. */
  readonly loading: boolean
  /** A failed list, as shown inline. */
  readonly error: string | null
  /** Add or replace one provider's key. */
  readonly save: (provider: string, apiKey: string) => Promise<CredentialResult>
  /** Delete one provider's key. */
  readonly remove: (provider: string) => Promise<CredentialResult>
  /** Clear the list error. */
  readonly dismissError: () => void
}

/** The caller's provider credentials: the list, and adding, replacing and deleting. */
export function useProviderCredentials(client: Client): ProviderCredentialsView {
  const [credentials, setCredentials] = useState<readonly ProviderCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { serverUrl } = useSettings()

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void client.providerCredentials.list({ signal: controller.signal }).then(
      (response) => {
        if (controller.signal.aborted) {
          return
        }
        setCredentials(response.data)
        setError(null)
        setLoading(false)
      },
      (caught: unknown) => {
        if (controller.signal.aborted) {
          return
        }
        // A 401 while listing means there is no session to list for: the shell takes it from
        // here and shows the sign-in page, which is also where the retry is.
        if (!noteAuthenticationError(client, caught)) {
          setError(describeError(caught, { serverUrl }))
        }
        setLoading(false)
      },
    )
    return () => controller.abort()
  }, [client, serverUrl])

  const failureOf = useCallback(
    (caught: unknown): CredentialResult => {
      if (caught instanceof AuthenticationError) {
        return {
          ok: false,
          kind: 'session',
          message:
            'Changing provider keys needs a fresh sign-in. Sign in again, then try once more.',
        }
      }
      if (caught instanceof ApiError && caught.type === 'invalid_provider_credential') {
        return { ok: false, kind: 'invalid', message: caught.message }
      }
      return { ok: false, kind: 'error', message: describeError(caught, { serverUrl }) }
    },
    [serverUrl],
  )

  const save = useCallback(
    async (provider: string, apiKey: string): Promise<CredentialResult> => {
      try {
        const saved = await client.providerCredentials.put(provider, {
          type: 'api_key',
          api_key: apiKey,
        })
        // Replace in place: the list is one entry per provider, so `put` is both "add" and
        // "replace" and the row keeps its position.
        setCredentials((current) => [
          ...current.filter((credential) => credential.provider !== saved.provider),
          saved,
        ])
        return { ok: true }
      } catch (caught) {
        return failureOf(caught)
      }
    },
    [client, failureOf],
  )

  const remove = useCallback(
    async (provider: string): Promise<CredentialResult> => {
      try {
        await client.providerCredentials.delete(provider)
        setCredentials((current) =>
          current.filter((credential) => credential.provider !== provider),
        )
        return { ok: true }
      } catch (caught) {
        return failureOf(caught)
      }
    },
    [client, failureOf],
  )

  const dismissError = useCallback(() => {
    setError(null)
  }, [])

  return { credentials, loading, error, save, remove, dismissError }
}
