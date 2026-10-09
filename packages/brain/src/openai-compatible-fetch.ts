import { STREAMING_LIMITS, safeFetch } from '@openharness/hands'

import { createSafeProviderFetch, type ProviderFetch, type SafeFetch } from './provider-fetch'

/**
 * The `fetch` every custom OpenAI-compatible model request is made through (epic #245, A3b).
 *
 * The base URL is a URL a **user** typed — a self-hosted Ollama or vLLM, a gateway, a proxy —
 * so a model request to it goes through `@openharness/hands`' `safeFetch`, exactly as the
 * save-time check that stored it did. Private, loopback and link-local addresses are refused
 * by default, which is what stops a credential from reaching into the deployment's own
 * network; the server's self-host setting (`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS`, off by
 * default) is the one thing that turns that refusal off, **for this credential type only**,
 * and it reaches here as `allowPrivate`.
 *
 * Azure OpenAI does **not** read that setting: its `fetch` (`azure-fetch.ts`) never passes the
 * option, because Azure is a hosted public service and a private address can only be a
 * mistake.
 *
 * The limits are the **streaming-safe** ones: a model streams a long reply, so there is no
 * total deadline and no size cap, and what is bounded instead is an idle stream — a connection
 * that sends nothing for two minutes is hung, not slow. The save-time check and the `/models`
 * listing use safeFetch's tight preset instead (`SAVE_TIME_LIMITS`, in the server).
 */

/** What {@link createOpenAICompatibleFetch} takes: the guard, and the self-host address option. */
export interface OpenAICompatibleFetchOptions {
  /** The guard to call; defaults to the real `safeFetch`, and a test injects a stub. */
  readonly safeFetch?: SafeFetch
  /**
   * Allow private, loopback and link-local addresses (the server's self-host setting, epic
   * #245 M4). Off by default; the server passes its flag's value.
   */
  readonly allowPrivate?: boolean
}

/**
 * `safeFetch` with the streaming-safe limits, as the AI SDK's `FetchFunction`, honouring the
 * self-host address option.
 */
export function createOpenAICompatibleFetch(
  options: OpenAICompatibleFetchOptions = {},
): ProviderFetch {
  return createSafeProviderFetch({
    safeFetch: options.safeFetch ?? safeFetch,
    limits: STREAMING_LIMITS,
    ...(options.allowPrivate === undefined ? {} : { allowPrivate: options.allowPrivate }),
  })
}

/** The production `fetch`: safeFetch under the streaming-safe limits, private addresses refused. */
export const openAICompatibleFetch: ProviderFetch = createOpenAICompatibleFetch()

/**
 * The base URL `@ai-sdk/openai-compatible` needs, from the base URL the credential stores.
 *
 * Unlike Azure's endpoint, nothing is derived: the user pasted the API root itself — the
 * OpenAI-compatible family serves `<base>/models` and `<base>/chat/completions`, and a base of
 * `http://127.0.0.1:11434/v1` is exactly that root. The one normalization is a **trailing
 * slash**, so `…/v1/` and `…/v1` are the same endpoint (appending `/models` to the first would
 * otherwise make `…/v1//models`). Query and fragment are dropped: they are not part of a base
 * URL.
 */
export function openAICompatibleBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}
