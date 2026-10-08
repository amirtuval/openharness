/**
 * Validating a provider key with one cheap provider call (epic #65, A5).
 *
 * A credential is checked on save: the server asks the provider for one page of its model
 * list (or an equivalent cheap, authenticated read) and stores nothing unless that call
 * succeeds. The check is a real request to the provider, which is exactly why it is a seam
 * (`ProviderCredentialValidator`) the server's tests inject a fake into: no test should reach
 * a provider, and no test should need a real key.
 *
 * The validator never logs, echoes or includes the key in an error message: a rejected
 * credential answers with the provider's status, not with what was sent.
 *
 * The call goes through the same provider HTTP client the model catalogue uses
 * (`catalog/provider-fetch.ts`): the one outbound path that honors the egress-proxy variables
 * a deployment sets, so saving a key works behind a proxy exactly as listing models does.
 */

import { PROVIDER_IDS, type ProviderId } from '@openharness/protocol'

import {
  createProviderFetch,
  type ProviderFetch,
  type ProviderResponse,
} from './catalog/provider-fetch'

/** The provider HTTP client, built once: one outbound path for validation and listing. */
const providerFetch: ProviderFetch = createProviderFetch()

/**
 * The providers this server can validate — the `provider/model` provider ids whose one-key
 * providers have a cheap authenticated read. The protocol stores any provider string; a key for
 * one outside this set is refused on save because it cannot be validated, rather than stored
 * unchecked.
 *
 * The set is the shared provider list's (`@openharness/protocol`): every provider openharness
 * knows has a cheap read here, a model-list adapter in `catalog/adapters.ts` and a model client
 * in the brain. That used to be three tables and a test; since #245 each table is typed against
 * `ProviderId`, so a provider missing from one is a compile error rather than a failure here.
 */
export const VALIDATABLE_PROVIDERS: readonly ProviderId[] = PROVIDER_IDS

/** A provider id {@link VALIDATABLE_PROVIDERS} knows. */
export type ValidatableProvider = ProviderId

/** Checks that a key authenticates against a provider; throws when it does not. */
export type ProviderCredentialValidator = (provider: string, apiKey: string) => Promise<void>

/** How long the validating call may take before it counts as a failure. */
const VALIDATION_TIMEOUT_MS = 10_000

/**
 * The production validator: one authenticated `GET` per provider.
 *
 * A non-2xx answer, a transport failure or a timeout all throw — the caller turns that into
 * the protocol's 422 `invalid_provider_credential`. The error's message names the provider
 * and the status, never the key.
 */
export const validateProviderApiKey: ProviderCredentialValidator = async (provider, apiKey) => {
  const request = requestFor(provider, apiKey)
  if (request === null) {
    throw new Error(
      `no validation for provider ${JSON.stringify(provider)}; supported: ` +
        VALIDATABLE_PROVIDERS.join(', '),
    )
  }
  let response: ProviderResponse
  try {
    response = await providerFetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `could not reach ${provider} to validate the key: ` +
        (error instanceof Error ? error.message : 'the request failed'),
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new Error(
      `${provider} answered ${response.status} for the validating request; ` +
        'the key was rejected',
    )
  }
  // The body is drained so the connection can be reused; nothing in it is read or stored.
  await response.text()
}

/** The one cheap, authenticated read that proves a key: `GET <url>` with these headers. */
interface ValidationRequest {
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * The validating request per provider, as a table typed against the shared list (#245): a
 * provider with no request is a compile error, not a key that silently cannot be saved.
 *
 * Every entry is a constant: the URL never comes from a request, so a key can only be sent to
 * the provider it was stored for.
 */
const VALIDATION_REQUESTS: Readonly<Record<ProviderId, (apiKey: string) => ValidationRequest>> = {
  anthropic: (apiKey) => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  }),
  openai: (apiKey) => ({
    url: 'https://api.openai.com/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  google: (apiKey) => ({
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': apiKey },
  }),
  // The key's own metadata: the cheapest authenticated call OpenRouter answers.
  openrouter: (apiKey) => ({
    url: 'https://openrouter.ai/api/v1/key',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  groq: (apiKey) => ({
    url: 'https://api.groq.com/openai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  deepseek: (apiKey) => ({
    url: 'https://api.deepseek.com/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  fireworks: (apiKey) => ({
    url: 'https://api.fireworks.ai/inference/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  mistral: (apiKey) => ({
    url: 'https://api.mistral.ai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  together: (apiKey) => ({
    url: 'https://api.together.xyz/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  xai: (apiKey) => ({
    url: 'https://api.x.ai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  cerebras: (apiKey) => ({
    url: 'https://api.cerebras.ai/v1/models',
    headers: { authorization: `Bearer ${apiKey}` },
  }),
}

/**
 * The request that validates a key for `provider`, or `null` for a provider the table has no
 * entry for — a provider the server refuses on save rather than storing unchecked. The lookup
 * is `Object.hasOwn` rather than a bare index so a provider string that names an inherited
 * property (`toString`, `constructor`) is a miss, not a function call.
 */
function requestFor(provider: string, apiKey: string): ValidationRequest | null {
  if (!Object.hasOwn(VALIDATION_REQUESTS, provider)) {
    return null
  }
  return VALIDATION_REQUESTS[provider as ProviderId](apiKey)
}
