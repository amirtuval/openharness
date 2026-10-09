import { STREAMING_LIMITS, safeFetch } from '@openharness/hands'

import { createSafeProviderFetch, type ProviderFetch, type SafeFetch } from './provider-fetch'

/**
 * The `fetch` every Azure OpenAI model request is made through (epic #245, A3a).
 *
 * The endpoint an Azure credential carries is a URL a **user** typed, so a model request to it
 * goes through `@openharness/hands`' `safeFetch` — the SSRF guard — exactly as the save-time
 * check does. This is not a second, weaker path: the guard runs on every request, and private
 * addresses are always refused (the `allowPrivate` option safeFetch has exists for the custom
 * OpenAI-compatible credential type — `openai-compatible-fetch.ts`, A3b — and is never passed
 * here; Azure is a hosted public service, so a private address can only be a mistake).
 *
 * The limits are the **streaming-safe** ones: a model streams a long reply, so there is no
 * total deadline and no size cap, and what is bounded instead is an idle stream — a connection
 * that sends nothing for two minutes is hung, not slow. A save-time check, which reads one
 * small body and stops, uses safeFetch's tight preset instead (`SAVE_TIME_LIMITS`, in the
 * server's credential validation).
 */

/**
 * `safeFetch` with the streaming-safe limits, as the AI SDK's `FetchFunction`.
 *
 * @param options.safeFetch the guard to call; defaults to the real one, and a test injects a
 *   stub to watch the request the guard allows.
 */
export function createAzureFetch(options: { readonly safeFetch?: SafeFetch } = {}): ProviderFetch {
  return createSafeProviderFetch({
    safeFetch: options.safeFetch ?? safeFetch,
    limits: STREAMING_LIMITS,
  })
}

/** The production Azure `fetch`: safeFetch under the streaming-safe limits. */
export const azureFetch: ProviderFetch = createAzureFetch()

/** Where an Azure OpenAI resource's API lives, given the endpoint a user saved. */
const AZURE_API_PREFIX = 'openai'

/**
 * The base URL `@ai-sdk/azure` needs, from the resource endpoint the credential stores.
 *
 * The Azure portal's "Endpoint" is the resource root — `https://my-resource.openai.azure.com` —
 * while the API lives one path segment below it. `@ai-sdk/azure` appends `/v1` to a base URL
 * that is not already versioned, so the endpoint gains its `/openai` segment here and the
 * request goes to `https://my-resource.openai.azure.com/openai/v1/chat/completions`.
 *
 * A user who pasted the `/openai/v1` form (or the older
 * `/openai/deployments/...` path's prefix) is normalized to the same place, so the two
 * spellings of one endpoint behave identically. Query and fragment are dropped: they are not
 * part of an endpoint.
 */
export function azureBaseUrl(endpoint: string): string {
  const url = new URL(endpoint)
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (segments[segments.length - 1]?.toLowerCase() === 'v1') {
    segments.pop()
  }
  if (segments[segments.length - 1]?.toLowerCase() !== AZURE_API_PREFIX) {
    segments.push(AZURE_API_PREFIX)
  }
  url.pathname = `/${segments.join('/')}`
  url.search = ''
  url.hash = ''
  return url.toString()
}
