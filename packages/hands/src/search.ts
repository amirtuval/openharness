/**
 * The search provider seam: one operator-configured search API behind an adapter (epic #303,
 * #305).
 *
 * A deployment that offers `web_search` configures **one** provider and one key — the operator's,
 * not a user's — so the tool is a thin caller over this interface, and adding a provider is
 * adding an adapter rather than touching the tool. `brave` is the first
 * ({@link createBraveSearchProvider}), chosen because Brave's Search API is a plain JSON `GET`
 * with the key in a header, has a free tier an operator can start on, and needs no SDK.
 *
 * The key travels **per call** ({@link SearchRequest.apiKey}) rather than being held by the
 * adapter: the server resolves it for the turn and hands it to the tool through the context's
 * per-user values, which is the same channel every other secret takes and the one the registry
 * scrubs out of anything a tool returns. Nothing in this package reads an environment variable.
 *
 * The request itself goes through {@link SearchTransport} — the server passes its egress client
 * (the same one provider calls use, `catalog/provider-fetch.ts`, #270) — so the fixed endpoint
 * is reached exactly as every other outbound request this deployment makes is.
 */

import { z } from 'zod'

/** The provider names this build can serve; a deployment names one. */
export const SUPPORTED_SEARCH_PROVIDERS = ['brave'] as const

/** A provider name from {@link SUPPORTED_SEARCH_PROVIDERS}. */
export type SearchProviderName = (typeof SUPPORTED_SEARCH_PROVIDERS)[number]

/** The name `brave` is configured under. */
export const BRAVE_SEARCH_PROVIDER: SearchProviderName = 'brave'

/** Brave's web-search endpoint — a constant of this module, so no request supplies a URL. */
export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

/** The most results Brave will return for one query. */
export const BRAVE_MAX_COUNT = 20

/** One search result, as the model is shown it. */
export const SearchResultSchema = z.object({
  /** The page's title, as the provider gave it. */
  title: z.string(),
  /** The page's URL, absolute. */
  url: z.string(),
  /** A short excerpt or summary the provider returned. */
  snippet: z.string(),
})

export type SearchResult = z.infer<typeof SearchResultSchema>

/** One query: what to look for, how many results, whose key, and the turn's signal. */
export interface SearchRequest {
  /** What to search for. */
  readonly query: string
  /** How many results to ask for; the adapter caps it at what the provider accepts. */
  readonly count: number
  /** The operator's key for this provider. Never stored, never logged. */
  readonly apiKey: string
  /** The turn's signal, so an interrupt ends the request rather than outliving it. */
  readonly signal?: AbortSignal
}

/** One search API, as `web_search` calls it. */
export interface SearchProvider {
  /** The provider's name, as the deployment configured it. */
  readonly name: SearchProviderName
  /** Run one query, answering the results in the provider's order. */
  search(request: SearchRequest): Promise<readonly SearchResult[]>
}

/** The part of a response the adapter reads. What a test's stub has to implement. */
export interface SearchResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

/** One request the adapter makes. Structurally the server's `ProviderFetch` init. */
export interface SearchRequestInit {
  readonly headers: Record<string, string>
  readonly signal: AbortSignal
}

/** How a search request reaches the internet: the server's egress client, or a test's stub. */
export type SearchTransport = (url: string, init: SearchRequestInit) => Promise<SearchResponse>

/** What {@link createBraveSearchProvider} takes. */
export interface BraveSearchOptions {
  /** How the request is made; the server passes its egress client. */
  readonly transport: SearchTransport
  /** The request's deadline; {@link BRAVE_TIMEOUT_MS} when absent. */
  readonly timeoutMs?: number
  /** The endpoint; {@link BRAVE_SEARCH_ENDPOINT} when absent, for a test's stub server. */
  readonly endpoint?: string
}

/**
 * How long one search request may take.
 *
 * Fifteen seconds is well inside the tool's own timeout and far past a search API's usual
 * answer: a request still open then is a hung connection, and the model is owed a failed call
 * rather than a stalled turn.
 */
export const BRAVE_TIMEOUT_MS = 15_000

/**
 * The Brave Search adapter.
 *
 * A Brave request is one `GET` of {@link BRAVE_SEARCH_ENDPOINT} with the query and count in the
 * query string and the key in `X-Subscription-Token`, and the answer is JSON with the results
 * under `web.results`. Only `title`, `url` and `description` are read: a result's extra fields
 * (a thumbnail, an age, a profile) are Brave's own metadata and no part of what a model is shown.
 *
 * Anything else — a non-2xx status, a body that is not the shape above — is thrown rather than
 * answered with an empty list, because "Brave refused this key" and "there is nothing on the
 * web about this" are different things and the model must be able to tell them apart. The
 * tool turns the throw into an `is_error` result.
 */
export function createBraveSearchProvider(options: BraveSearchOptions): SearchProvider {
  const endpoint = options.endpoint ?? BRAVE_SEARCH_ENDPOINT
  const timeoutMs = options.timeoutMs ?? BRAVE_TIMEOUT_MS
  return {
    name: BRAVE_SEARCH_PROVIDER,
    async search(request) {
      const url = new URL(endpoint)
      url.searchParams.set('q', request.query)
      url.searchParams.set('count', String(Math.min(request.count, BRAVE_MAX_COUNT)))
      // The provider's deadline and the turn's signal as one: a hung request ends, and so does
      // one whose turn was interrupted.
      const signal =
        request.signal === undefined
          ? AbortSignal.timeout(timeoutMs)
          : AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
      const response = await options.transport(url.href, {
        headers: { accept: 'application/json', 'x-subscription-token': request.apiKey },
        signal,
      })
      if (!response.ok) {
        throw new Error(`brave answered ${response.status}${await snippetOf(response)}`)
      }
      return parseBraveResults(await response.json())
    },
  }
}

/** Brave's payload, read into results; anything else is refused. */
function parseBraveResults(payload: unknown): SearchResult[] {
  const web = asRecord(payload)?.web
  const raw = asRecord(web)?.results
  if (!Array.isArray(raw)) {
    throw new Error('brave answered a payload without a web results list')
  }
  const results: SearchResult[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const url = typeof record?.url === 'string' ? record.url : null
    if (record === null || url === null || url.length === 0) {
      // An entry with no URL is not a result a model can go on; it is skipped rather than
      // turned into an empty one.
      continue
    }
    results.push({
      title: typeof record.title === 'string' ? plain(record.title) : url,
      url,
      snippet: typeof record.description === 'string' ? plain(record.description) : '',
    })
  }
  return results
}

/**
 * `title` or `description` as text: any markup removed and whitespace collapsed.
 *
 * Brave highlights the matched words in a description with `<strong>`, which is markup a model
 * reads as literal text if it is left in — so tags are stripped. It is a strip and not a
 * sanitizer: what comes out is shown to a model as a string, never rendered as HTML.
 */
function plain(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A record, or `null` for anything that is not a JSON object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `: <what the provider said>`, bounded — for an error's message, never its whole body. */
async function snippetOf(response: SearchResponse): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return ''
  }
  const snippet = body.trim().replace(/\s+/g, ' ').slice(0, 200)
  return snippet.length === 0 ? '' : `: ${snippet}`
}
