import { ApiError } from '@openharness/client'

/** What {@link describeError} needs to say which server could not be reached. */
export interface ErrorContext {
  /** The configured server URL. Empty means the app calls its own origin. */
  readonly serverUrl?: string | undefined
}

/**
 * One line of text for anything that was thrown.
 *
 * Request failures in this app are shown inline rather than thrown at the user, so every
 * `catch` ends up here. Three of them are worth words of their own — a request that was
 * cancelled (nothing to report), a server that is not there, and a key the server would not
 * take — because the browser's own words for the first of those ("Failed to fetch") name
 * neither the server nor anything the reader can do about it. The rest keep the message they
 * arrived with, which is the only part that knows what actually happened.
 *
 * @param error anything that was thrown
 * @param context the server the client was pointed at, for the unreachable message
 */
export function describeError(error: unknown, context: ErrorContext = {}): string {
  if (isAbort(error)) {
    return 'The request was cancelled.'
  }
  if (error instanceof ApiError) {
    return describeApiError(error)
  }
  if (isTransportFailure(error)) {
    return unreachableMessage(context)
  }
  if (error instanceof Error) {
    return error.message === '' ? error.name : error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'Something went wrong.'
}

/**
 * A failed HTTP answer.
 *
 * A rejected key is the one status the reader can do something about, and the app knows where
 * that something is, so it says so; the server's own message stays in front, because it is the
 * only part that knows what was wrong with the key. The wording follows the CLI's
 * (`apps/tui/src/errors.ts`), which the issue asks this to match.
 */
function describeApiError(error: ApiError): string {
  if (error.status === 401 || error.status === 403) {
    return `The server rejected the request (${error.status}): ${error.message} Check the API key in Settings.`
  }
  return error.message
}

/** What to say when nothing answered: where the app was pointing, and two things to try. */
function unreachableMessage(context: ErrorContext): string {
  return `Can't reach the openharness server at ${serverLabel(context)}. Check that it's running, or change the server URL in Settings.`
}

/** The server as the reader knows it: the URL they configured, or this origin when it is empty. */
function serverLabel(context: ErrorContext): string {
  const url = context.serverUrl?.trim() ?? ''
  return url === '' ? 'this site' : url
}

/**
 * Whether the failure was the transport, rather than an answer.
 *
 * `fetch` reports "the request never got anywhere" as a `TypeError`, with a message that is
 * the browser's own and differs between them: "Failed to fetch" in Chromium, "NetworkError
 * when attempting to fetch resource." in Firefox, "Load failed" in Safari. Node's `fetch`
 * says "fetch failed" and hangs the reason off `cause` — `ECONNREFUSED` for nothing listening,
 * `ENOTFOUND` for a name that does not resolve. The client does not wrap any of this (only an
 * answer from the server becomes an `ApiError`), so the original error is what arrives here.
 */
function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError && TRANSPORT_MESSAGE.test(error.message)) {
    return true
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NetworkError'
  ) {
    return true
  }
  return TRANSPORT_CODES.has(errorCode(error) ?? '')
}

/** The message a `TypeError` carries when the request never reached the server. */
const TRANSPORT_MESSAGE = /failed to fetch|fetch failed|network|load failed/iu

/** The connection-level failures a `cause` chain can name. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

/** The `code` of the error or of anything in its `cause` chain, e.g. `ECONNREFUSED`. */
function errorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') {
      return code
    }
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** A cancelled request: an `AbortError`, however the runtime spells it. */
function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError')
  )
}
