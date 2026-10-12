import { isSafeFetchError, type McpFetch } from '@openharness/hands'

import { MCP_LAST_ERROR_MAX_LENGTH } from '@openharness/protocol'

/**
 * What a failed MCP request really was (epic #303, X10; issue #314).
 *
 * The SDK's own failure is a thin wrapper — `Streamable HTTP error: Error POSTing to endpoint:
 * <body>` — and the one thing it does **not** carry is the status as a field: a Linear 401 with
 * an empty body reads as a sentence that stops at a colon, which tells a reader nothing. Two
 * things here fix that: a fetch wrapper that remembers the last response's status, status text
 * and a bounded body snippet, and a formatter that turns the observed fact and an optional
 * thrown error into one bounded, secret-free sentence **naming the status**.
 *
 * The snippet is read off a **clone** of the response, so the body the SDK is about to read is
 * untouched — and only for a response that is not `ok`, because a 2xx body is the SDK's to
 * consume whole (it may be an SSE stream).
 */

/** What a request observed: the status of the last response, and a bounded snippet of a bad one. */
export interface McpHttpObservation {
  readonly status: number
  readonly statusText: string
  /** A short, scrubbed body excerpt, or `''` when the response carried none. */
  readonly body: string
}

/** How long an excerpt of a failing response is kept. */
const BODY_SNIPPET_MAX_LENGTH = 200

/** A fetch that remembers the last failing response, so a thrown error can be explained. */
export interface RecordingMcpFetch {
  /** Pass this where the `McpFetch` is expected. */
  readonly fetch: McpFetch
  /** The last non-2xx response seen, or `null` when every request succeeded. */
  lastFailure(): McpHttpObservation | null
}

/**
 * Wrap a guarded fetch so the last non-2xx response it saw is remembered.
 *
 * A successful response is passed through untouched and unread — its body belongs to the SDK,
 * and for an MCP endpoint that body may be an event stream. A failure is cloned and a bounded
 * excerpt read, because the status alone is often not enough (an OAuth resource server's 401 is
 * empty; another server's names the missing scope).
 *
 * @param base the guarded fetch the MCP client and the OAuth flow were built with
 */
export function recordingMcpFetch(base: McpFetch): RecordingMcpFetch {
  let last: McpHttpObservation | null = null
  const fetch: McpFetch = async (url, init) => {
    const response = await base(url, init)
    if (!response.ok) {
      last = {
        status: response.status,
        statusText: response.statusText,
        body: await readSnippet(response),
      }
    }
    return response
  }
  return { fetch, lastFailure: () => last }
}

/** A bounded excerpt of a failing response's body, read off a clone. Never throws. */
async function readSnippet(response: Response): Promise<string> {
  try {
    const text = await response.clone().text()
    return text.replace(/\s+/g, ' ').trim().slice(0, BODY_SNIPPET_MAX_LENGTH)
  } catch {
    return ''
  }
}

/**
 * The status a thrown error carries, when the fetch wrapper did not observe one.
 *
 * `@modelcontextprotocol/sdk`'s transport error is duck-typed here rather than imported, so this
 * module stays free of the SDK — the server's dependency on it is `@openharness/hands`' business.
 */
export function httpStatusOf(error: unknown): number | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object') {
      const candidate = current as { code?: unknown; status?: unknown; name?: unknown }
      const code = candidate.code ?? candidate.status
      if (typeof code === 'number' && Number.isInteger(code)) {
        return code
      }
      if (candidate.name === 'UnauthorizedError') {
        return 401
      }
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}

/**
 * The one sentence a failed MCP request is reported with (epic #303, X10; issue #314).
 *
 * The **status and a body excerpt lead it** when either is known — `The MCP server answered 401
 * (Unauthorized): {"error":"invalid_token"}` — because that is what makes a Linear failure
 * diagnosable; the thrown error's own message is the fallback, and it is the whole answer when
 * the request never got a response (a DNS failure, a refused connection, a guard refusal).
 *
 * Every value this server sent — a header value, a bearer token — is scrubbed out first, so an
 * error page that quotes the request cannot turn into a stored secret, and the whole is bounded
 * to {@link MCP_LAST_ERROR_MAX_LENGTH}. A guard refusal is *not* handled here: it is a 400 the
 * caller raises, and `isMcpFetchRefusal` is how it is told apart.
 *
 * @param error the thrown error, when there was one
 * @param observed the last failing response, when the recording fetch saw one
 * @param secrets the values this server sent, to scrub out
 */
export function describeMcpFailure(
  error: unknown,
  observed: McpHttpObservation | null,
  secrets: readonly string[] = [],
): string {
  const status = observed?.status ?? httpStatusOf(error)
  if (status !== undefined) {
    const statusText = observed !== null && observed.status === status ? observed.statusText : ''
    const detail = observed !== null && observed.status === status ? observed.body : ''
    const head = `the MCP server answered ${status}${statusText.length === 0 ? '' : ` ${statusText}`}`
    const base = detail.length === 0 ? `${head}, with no message` : `${head}: ${detail}`
    return bound(scrub(base, secrets))
  }
  const message = messageOf(error)
  const reason = message === null ? 'the request failed' : scrub(message, secrets)
  const trimmed = reason.trim()
  return bound(trimmed.length === 0 ? 'the request failed' : trimmed)
}

/** An error's message, or `null` when there is nothing readable. */
function messageOf(error: unknown): string | null {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  return null
}

/** Every value this server sent, removed from a message that may quote the request. */
function scrub(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) {
    return text
  }
  return secrets.reduce((result, secret) => result.split(secret).join('[redacted]'), text)
}

/** Bound a message to what the resource can report. */
function bound(message: string): string {
  return message.length > MCP_LAST_ERROR_MAX_LENGTH
    ? `${message.slice(0, MCP_LAST_ERROR_MAX_LENGTH - 1)}…`
    : message
}

/**
 * Whether an error is a `safeFetch` **refusal** — a URL this server will not fetch at all.
 *
 * A refusal is the caller's to turn into a 400 (nothing is stored); a server that is merely
 * unreachable is a `status: 'error'` with a reason. The distinction is the one `safeFetch` draws
 * and `@openharness/hands` exports the predicate for.
 */
export function isMcpFetchRefusal(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (isSafeFetchError(current) && isRefusalCode(current.code)) {
      return true
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

/** The `safeFetch` codes that mean "this URL is not fetched at all". */
function isRefusalCode(code: string): boolean {
  return (
    code === 'blocked_address' ||
    code === 'metadata_host' ||
    code === 'invalid_protocol' ||
    code === 'invalid_url'
  )
}

/**
 * The `safeFetch` refusal's own message, for the 400 a refused URL is answered with.
 *
 * A refusal is always accompanied by one — `safeFetch` writes it — and the fallback exists only
 * so a caller cannot produce an empty sentence.
 */
export function refusalMessage(error: unknown): string {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (isSafeFetchError(current) && isRefusalCode(current.code)) {
      return current.message
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return 'the MCP server URL is not one this deployment will reach'
}
