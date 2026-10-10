/**
 * The one HTTP client provider calls go through (issue #90): Node's `fetch`, over an egress
 * proxy when the process environment names one.
 *
 * Provider list calls, the save-time credential checks and — since #270 — every **model**
 * request are the outbound requests this server makes, and deployments that reach the internet
 * through a proxy set `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` — the documented egress-proxy
 * variables (see `e2e/AGENTS.md`). Node's own `fetch` ignores them unless the process was
 * started with `NODE_USE_ENV_PROXY=1`, a flag a deployment can forget; undici's
 * {@link EnvHttpProxyAgent} reads the same three variables directly, so the documented spelling
 * works with no extra flag, and with no proxy configured it behaves like an ordinary direct
 * connection.
 *
 * Two fetches are built from that one agent, because a model request and a catalog call have
 * different shapes: {@link createProviderFetch} is the `GET`-with-a-deadline client the
 * catalogue and the credential checks use, and {@link createProviderModelFetch} is the AI SDK's
 * `FetchFunction` a model client's `fetch` option takes — no deadline of its own, because a
 * model streams a long reply (see `@openharness/brain`'s model seam).
 *
 * The catalogue's fetch is a seam — {@link ProviderFetch} — for the same reason
 * `provider-validation.ts` has one: no test may reach a provider, so the catalogue's tests
 * inject a stub that answers with recorded payloads.
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

/**
 * One request the catalogue makes: headers, the 5-second deadline, and — for the one call that
 * is not a read — a method and a body.
 *
 * Everything a provider's model list takes is a `GET`, and that default is what a caller gets
 * when it says nothing; the exception is Google's Model Garden EULA check (#273), which is a
 * `POST` with a small JSON body, and the one place a request method has to be named.
 */
export interface ProviderRequest {
  readonly headers: Record<string, string>
  /** The request deadline; see {@link DEFAULT_PROVIDER_TIMEOUT_MS}. */
  readonly signal: AbortSignal
  /** The HTTP method; `GET`, the only one most calls use, when this is absent. */
  readonly method?: string
  /** The request body, for a `POST`; absent for every `GET`. */
  readonly body?: string
}

/** How the catalogue reaches a provider. Injectable, so tests never touch a socket. */
export type ProviderFetch = (url: string, init: ProviderRequest) => Promise<ProviderResponse>

/** How long one provider's model list may take before the provider counts as failed (C1). */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 5000

/** One dispatcher for the process, created on first use with the environment it is started in. */
let proxyDispatcher: EnvHttpProxyAgent | null = null

/**
 * The agent every provider call is dispatched through, built once from the environment the
 * process was started in. It reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` at construction,
 * so the two fetches below must share it rather than build one each.
 */
function egressDispatcher(): EnvHttpProxyAgent {
  proxyDispatcher ??= new EnvHttpProxyAgent()
  return proxyDispatcher
}

/**
 * The production {@link ProviderFetch}: a request through undici, with the egress proxy the
 * environment names read at the first call.
 */
export function createProviderFetch(): ProviderFetch {
  return async (url, init) => {
    const response = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: init.signal,
      dispatcher: egressDispatcher(),
    })
    return response
  }
}

/** The AI SDK's `FetchFunction` shape — what a model client's `fetch` option is given. */
export type ModelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * The production model-request fetch (#270): the AI SDK's `FetchFunction` over the same egress
 * proxy agent {@link createProviderFetch} uses, with the whole request passed through.
 *
 * It adds **no deadline**: the catalogue's 5 s bounds one model *list*, while a model request
 * streams a reply for as long as the model keeps producing — the same reason Azure's guarded
 * fetch runs under the streaming-safe limits. What bounds a hung stream is the provider
 * package's own behaviour and undici's agent timeouts, not a total timeout here. The signal
 * the caller passes (an abort from a turn) is forwarded untouched, because that is the only
 * deadline a model request should have.
 *
 * The server injects it into `createProviderModelFactory` (`apps/server/src/model.ts`) so the
 * eleven fixed providers reach the internet the same way the catalogue and the credential
 * checks do — `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` honoured without `NODE_USE_ENV_PROXY`.
 */
export function createProviderModelFetch(): ModelFetch {
  return async (input, init) => {
    const response = await undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      { ...init, dispatcher: egressDispatcher() } as Parameters<typeof undiciFetch>[1],
    )
    // undici's own `Response` is Node's global one at runtime; the cast is only because the
    // two type identities are spelled separately.
    return response as unknown as Response
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
