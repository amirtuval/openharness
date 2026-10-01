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
 */

/**
 * The providers this server can validate — the Mastra router ids whose one-key providers have
 * a cheap authenticated read. The protocol stores any provider string; a key for one outside
 * this set is refused on save because it cannot be validated, rather than stored unchecked.
 */
export const VALIDATABLE_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'groq',
  'deepseek',
  'fireworks',
] as const

/** A provider id {@link VALIDATABLE_PROVIDERS} knows. */
export type ValidatableProvider = (typeof VALIDATABLE_PROVIDERS)[number]

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
  let response: Response
  try {
    response = await fetch(request.url, {
      method: 'GET',
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
  await response.arrayBuffer()
}

/** The one cheap, authenticated read that proves a key: `GET <url>` with these headers. */
function requestFor(
  provider: string,
  apiKey: string,
): { readonly url: string; readonly headers: Record<string, string> } | null {
  switch (provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=1',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      }
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { authorization: `Bearer ${apiKey}` },
      }
    case 'google':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        headers: { 'x-goog-api-key': apiKey },
      }
    case 'openrouter':
      // The key's own metadata: the cheapest authenticated call OpenRouter answers.
      return {
        url: 'https://openrouter.ai/api/v1/key',
        headers: { authorization: `Bearer ${apiKey}` },
      }
    case 'groq':
      return {
        url: 'https://api.groq.com/openai/v1/models',
        headers: { authorization: `Bearer ${apiKey}` },
      }
    case 'deepseek':
      return {
        url: 'https://api.deepseek.com/models',
        headers: { authorization: `Bearer ${apiKey}` },
      }
    case 'fireworks':
      return {
        url: 'https://api.fireworks.ai/inference/v1/models',
        headers: { authorization: `Bearer ${apiKey}` },
      }
    default:
      return null
  }
}
