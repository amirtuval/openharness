/**
 * The one HTTP client provider calls go through (issue #90): Node's `fetch`, over an egress
 * proxy when the process environment names one.
 *
 * Provider list calls are the only outbound requests this server makes, and deployments that
 * reach the internet through a proxy set `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` — the
 * documented egress-proxy variables (see `e2e/AGENTS.md`). Node's own `fetch` ignores them
 * unless the process was started with `NODE_USE_ENV_PROXY=1`, a flag a deployment can forget;
 * undici's {@link EnvHttpProxyAgent} reads the same three variables directly, so the
 * documented spelling works with no extra flag, and with no proxy configured it behaves like
 * an ordinary direct connection.
 *
 * The fetch is a seam — {@link ProviderFetch} — for the same reason `provider-validation.ts`
 * has one: no test may reach a provider, so the catalogue's tests inject a stub that answers
 * with recorded payloads.
 */

import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

/** The part of a `Response` the catalogue reads. What a stub has to implement. */
export interface ProviderResponse {
  /** Whether the status is 2xx. */
  readonly ok: boolean
  /** The HTTP status; reported in fallback messages. */
  readonly status: number
  /** The body as JSON. */
  json(): Promise<unknown>
  /** The body as text; used for the error snippet a fallback message carries. */
  text(): Promise<string>
}

/** One request the catalogue makes. `GET` only, headers, and the 5-second deadline. */
export interface ProviderRequest {
  readonly headers: Record<string, string>
  /** The request deadline; see {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  readonly signal: AbortSignal
}

/** How the catalogue reaches a provider. Injectable, so tests never touch a socket. */
export type ProviderFetch = (url: string, init: ProviderRequest) => Promise<ProviderResponse>

/** How long one provider's model list may take before the provider counts as failed (C1). */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 5000

/** One dispatcher for the process, created on first use with the environment it is started in. */
let proxyDispatcher: EnvHttpProxyAgent | null = null

/**
 * The production {@link ProviderFetch}: `GET` through undici, with the egress proxy the
 * environment names read at the first call.
 */
export function createProviderFetch(): ProviderFetch {
  return async (url, init) => {
    proxyDispatcher ??= new EnvHttpProxyAgent()
    const response = await undiciFetch(url, {
      method: 'GET',
      headers: init.headers,
      signal: init.signal,
      dispatcher: proxyDispatcher,
    })
    return response
  }
}

/** How much of a provider's error body a message may carry. */
const ERROR_SNIPPET_LENGTH = 200

/**
 * `: <up to 200 characters of the body>` for a provider's error response, or nothing readable.
 *
 * What a provider said when it refused a call is often the whole diagnosis — Google naming the
 * API a project has not enabled, a provider naming the region it does not serve — so the
 * catalogue's fallback messages and the credential check's refusals both carry a bounded piece
 * of it. Bounded and collapsed, because a provider's error body is not a place to read a whole
 * page from, and never a place to look for a secret: nothing a request sent is echoed back by
 * the provider into its own error text.
 */
export async function errorSnippet(response: ProviderResponse): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return ''
  }
  const snippet = body.trim().replace(/\s+/g, ' ').slice(0, ERROR_SNIPPET_LENGTH)
  return snippet.length === 0 ? '' : `: ${snippet}`
}
