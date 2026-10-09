import {
  API_VERSION_PREFIX,
  ListProviderCredentialsResponseSchema,
  ProviderCredentialSchema,
} from '@openharness/protocol'
import type {
  ListProviderCredentialsResponse,
  ProviderCredential,
  PutProviderCredentialRequest,
} from '@openharness/protocol'

import type { RequestOptions } from '../client'
import type { Transport } from '../http'

/**
 * The provider-credential endpoints (epic #65, A5): the model-provider keys a user brings.
 *
 * ```
 * PUT    /v1/provider-credentials/{provider}   put     -> credential metadata
 * GET    /v1/provider-credentials              list    -> { data: credential metadata[] }
 * DELETE /v1/provider-credentials/{provider}   delete  -> (204, no body)
 * ```
 *
 * The API is **write-only**: the secret goes up on `put` and only metadata — `name`, `type`,
 * `last4`, timestamps — ever comes back. The secret itself never appears in a response, an
 * error or this client's types. `put` replaces an existing credential under the same **name**,
 * so there is at most one per name per user: the eleven fixed providers have one each (their
 * provider id), and a named credential type (epic #245 A3a) is stored under a name the user
 * chose — the `provider` half of the model ids it serves. Both `put` and `delete` require a
 * fresh session, which the server enforces (a stale one is answered 401).
 */
export interface ProviderCredentialsResource {
  /**
   * List the caller's credentials, metadata only.
   *
   * No pagination: a user has one credential per name, so the list is short by construction,
   * and it is empty (never absent) for an account with none.
   *
   * @param options request options (cancellation)
   */
  list(options?: RequestOptions): Promise<ListProviderCredentialsResponse>

  /**
   * Add or replace the caller's credential under a name.
   *
   * @param name the credential name: a provider id (`anthropic`, `openai`) for an `api_key`,
   *   or a name the user chose (`azure`, `azure-eu`) for a named type
   * @param body the credential payload for its type
   * @param options request options (cancellation)
   * @throws ApiError with `invalid_provider_credential` when the provider rejects the secret
   */
  put(
    name: string,
    body: PutProviderCredentialRequest,
    options?: RequestOptions,
  ): Promise<ProviderCredential>

  /**
   * Delete the caller's credential under a name.
   *
   * The wire answers `204` with no body, so there is nothing to return. Deleting a name that
   * has no credential is not an error.
   *
   * @param name the credential name, e.g. `anthropic`, `azure-eu`
   * @param options request options (cancellation)
   */
  delete(name: string, options?: RequestOptions): Promise<void>
}

/** Build the provider-credentials resource over a transport. */
export function createProviderCredentialsResource(
  transport: Transport,
): ProviderCredentialsResource {
  const path = `${API_VERSION_PREFIX}/provider-credentials`
  const credentialPath = (name: string): string => `${path}/${encodeURIComponent(name)}`

  return {
    list(options) {
      return transport.json(ListProviderCredentialsResponseSchema, {
        method: 'GET',
        path,
        signal: options?.signal,
      })
    },

    put(name, body, options) {
      return transport.json(ProviderCredentialSchema, {
        method: 'PUT',
        path: credentialPath(name),
        body,
        signal: options?.signal,
      })
    },

    delete(name, options) {
      return transport.noContent({
        method: 'DELETE',
        path: credentialPath(name),
        signal: options?.signal,
      })
    },
  }
}
