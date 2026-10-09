import type { SafeFetchOptions } from '@openharness/hands'

/**
 * The one place a guarded provider `fetch` is built (epic #245).
 *
 * The endpoint of a credential whose URL a **user** typed — an Azure OpenAI resource for A3a, a
 * custom OpenAI-compatible base URL for A3b — is not a constant this process chose, so every
 * request to it goes through `@openharness/hands`' `safeFetch`, the SSRF guard, exactly as the
 * save-time check that stored it did. What differs between the two credential types is only
 * the address option (a custom URL may reach a private one behind the server's self-host
 * setting; Azure never may) and the caller's seam for a test.
 *
 * `createSafeProviderFetch` is that one construction, so the two type-specific modules
 * (`azure-fetch.ts`, `openai-compatible-fetch.ts`) are a base URL, a preset and a default —
 * not two copies of the same adapter.
 */

/** The `fetch` shape a model client is given: the platform's own, minus everything safeFetch decides. */
export type SafeFetch = (
  input: string | URL,
  init?: RequestInit,
  options?: SafeFetchOptions,
) => Promise<Response>

/** The `fetch` shape the AI SDK accepts — its `FetchFunction`. */
export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** What {@link createSafeProviderFetch} takes: the guard, its limits, and the address option. */
export interface SafeProviderFetchOptions {
  /** The guard to call — `safeFetch` in production, a stub in a test. */
  readonly safeFetch: SafeFetch
  /** The limits preset for this call: `STREAMING_LIMITS` for a model call. */
  readonly limits: SafeFetchOptions
  /**
   * Allow private, loopback and link-local addresses (epic #245, A3b's server setting). Off —
   * the guard's own default — unless the server's self-host flag turned it on, and **never** for
   * an Azure endpoint, whose module leaves it unset.
   */
  readonly allowPrivate?: boolean
}

/**
 * `safeFetch` under one limits preset, as the AI SDK's `FetchFunction`.
 *
 * The AI SDK may hand a `Request` rather than a URL; only its URL is used, because the guard
 * has to resolve the host itself and a `Request` carries headers the model client already put
 * in `init`.
 */
export function createSafeProviderFetch(options: SafeProviderFetchOptions): ProviderFetch {
  const limits: SafeFetchOptions =
    options.allowPrivate === true ? { ...options.limits, allowPrivate: true } : options.limits
  return (input, init) =>
    options.safeFetch(
      typeof input === 'string' || input instanceof URL ? input : input.url,
      init,
      limits,
    )
}
