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
 * The API is **write-only**: `api_key` goes up on `put` and only metadata — `provider`,
 * `last4`, timestamps — ever comes back. The secret itself never appears in a response, an
 * error or this client's types. `put` replaces an existing credential for the same provider,
 * so there is at most one per provider per user; both `put` and `delete` require a fresh
 * session, which the server enforces (a stale one is answered 401).
 */
export interface ProviderCredentialsResource {
  /**
   * List the caller's credentials, metadata only.
   *
   * No pagination: a user has one credential per provider, so the list is short by
   * construction, and it is empty (never absent) for an account with none.
   *
   * @param options request options (cancellation)
   */
  list(options?: RequestOptions): Promise<ListProviderCredentialsResponse>

  /**
   * Add or replace the caller's credential for a provider.
   *
   * @param provider the Mastra router provider name, e.g. `anthropic`, `openai`
   * @param body the credential; today always `{ type: 'api_key', api_key }`
   * @param options request options (cancellation)
   * @throws ApiError with `invalid_provider_credential` when the provider rejects the key
   */
  put(
    provider: string,
    body: PutProviderCredentialRequest,
    options?: RequestOptions,
  ): Promise<ProviderCredential>

  /**
   * Delete the caller's credential for a provider.
   *
   * The wire answers `204` with no body, so there is nothing to return. Deleting a provider
   * that has no credential is not an error.
   *
   * @param provider the Mastra router provider name, e.g. `anthropic`, `openai`
   * @param options request options (cancellation)
   */
  delete(provider: string, options?: RequestOptions): Promise<void>
}

/** Build the provider-credentials resource over a transport. */
export function createProviderCredentialsResource(
  transport: Transport,
): ProviderCredentialsResource {
  const path = `${API_VERSION_PREFIX}/provider-credentials`
  const credentialPath = (provider: string): string => `${path}/${encodeURIComponent(provider)}`

  return {
    list(options) {
      return transport.json(ListProviderCredentialsResponseSchema, {
        method: 'GET',
        path,
        signal: options?.signal,
      })
    },

    put(provider, body, options) {
      return transport.json(ProviderCredentialSchema, {
        method: 'PUT',
        path: credentialPath(provider),
        body,
        signal: options?.signal,
      })
    },

    delete(provider, options) {
      return transport.noContent({
        method: 'DELETE',
        path: credentialPath(provider),
        signal: options?.signal,
      })
    },
  }
}
