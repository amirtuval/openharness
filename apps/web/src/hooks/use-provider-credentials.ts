import { ApiError, AuthenticationError, type Client } from '@openharness/client'
import type { ProviderCredential, PutProviderCredentialRequest } from '@openharness/protocol'
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

/**
 * The outcome of a write, carrying what was stored.
 *
 * A save that succeeded has a credential to show, which is what lets the list this hook holds
 * be updated in place rather than read again — `PUT` is both "add" and "replace".
 */
export type CredentialWriteResult =
  | { readonly ok: true; readonly credential: ProviderCredential }
  | { readonly ok: false; readonly kind: CredentialFailureKind; readonly message: string }

/** Everything the credential surfaces need: the list, and adding, replacing and deleting. */
export interface ProviderCredentialsView {
  /** The saved credentials, metadata only — the keys themselves never come back. */
  readonly credentials: readonly ProviderCredential[]
  /** The list is still loading for the first time. */
  readonly loading: boolean
  /** A failed list, as shown inline. */
  readonly error: string | null
  /**
   * Add or replace one provider's credential, from a whole request body.
   *
   * A body rather than an api key because the fields a form collects are decided by the
   * provider's **credential type** (epic #201, X6): {@link ProviderKeyForm} builds it, and it
   * is the only thing here that knows how many fields that type has.
   */
  readonly put: (
    provider: string,
    body: PutProviderCredentialRequest,
  ) => Promise<CredentialWriteResult>
  /** Add or replace one provider's api key. The `api_key` shorthand over {@link put}. */
  readonly save: (provider: string, apiKey: string) => Promise<CredentialResult>
  /** Delete one provider's key; deleting what is not there is not a failure. */
  readonly remove: (provider: string) => Promise<CredentialResult>
  /**
   * Read the list again.
   *
   * For a surface that shares the screen with the Add-provider dialog (#209): the dialog holds
   * its own list, so a save made in it is invisible to the card behind it until the card reads
   * again. A write through this hook's own {@link put} or {@link remove} updates the list in
   * place and needs nothing.
   */
  readonly reload: () => Promise<void>
  /** Clear the list error. */
  readonly dismissError: () => void
}

/**
 * The caller's provider credentials: the list, and adding, replacing and deleting.
 *
 * One in-memory list per call site. There is no shared store across the app because the three
 * surfaces that hold one — Settings → Providers, the first-run screen, the Add-provider dialog
 * — are never on screen together, and the credentials API is write-only, so a screen that
 * mounts can just read the list again.
 */
export function useProviderCredentials(client: Client): ProviderCredentialsView {
  const [credentials, setCredentials] = useState<readonly ProviderCredential[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { serverUrl } = useSettings()

  /** One read: the mount's, and every {@link reload}. */
  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const response = await client.providerCredentials.list(
          signal === undefined ? undefined : { signal },
        )
        setCredentials(response.data)
        setError(null)
      } catch (caught) {
        if (signal?.aborted === true) {
          return
        }
        // A 401 while listing means there is no session to list for: the shell takes it from
        // here and shows the sign-in page, which is also where the retry is.
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

  const failureOf = useCallback(
    (caught: unknown): { ok: false; kind: CredentialFailureKind; message: string } => {
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

  const put = useCallback(
    async (
      provider: string,
      body: PutProviderCredentialRequest,
    ): Promise<CredentialWriteResult> => {
      try {
        const credential = await client.providerCredentials.put(provider, body)
        // Replace in place: the list is one entry per provider, so `put` is both "add" and
        // "replace" and the row keeps its position.
        setCredentials((current) => [
          ...current.filter((stored) => stored.provider !== credential.provider),
          credential,
        ])
        return { ok: true, credential }
      } catch (caught) {
        return failureOf(caught)
      }
    },
    [client, failureOf],
  )

  const save = useCallback(
    async (provider: string, apiKey: string): Promise<CredentialResult> => {
      const result = await put(provider, { type: 'api_key', api_key: apiKey })
      return result.ok ? { ok: true } : result
    },
    [put],
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

  return { credentials, loading, error, put, save, remove, reload, dismissError }
}
