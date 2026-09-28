import type { SessionErrorType } from '@openharness/protocol'
import { APICallError } from 'ai'

/**
 * Turning whatever a model request threw into the two things the turn loop needs: whether the
 * request may be retried, and which `session.error` type the log should carry.
 *
 * The classification is deliberately one function. A retry decision and the event that
 * documents it have to agree — a `retry_status: "retrying"` the brain then does not retry, or a
 * silent drop of an error the provider said was transient, are both worse than a wrong retry.
 *
 * ## What is retryable
 *
 * Retryable means the request never reached a verdict the user should see: HTTP 429, HTTP 5xx,
 * a timeout, or a network failure (the provider SDK could not be reached at all). Everything
 * else — a 400 the model would reject again, a validation error inside the SDK — is terminal,
 * and retrying it would only burn the turn's budget.
 *
 * ## Which protocol type
 *
 * | what the provider said                    | `session.error.error.type`  |
 * | ----------------------------------------- | --------------------------- |
 * | HTTP 429                                  | `model_rate_limited_error`  |
 * | HTTP 503 / 529, the overloaded responses  | `model_overloaded_error`    |
 * | any other HTTP status, or a network error | `model_request_failed_error`|
 * | nothing recognisable                      | `unknown_error`             |
 *
 * The `retry_status` the brain writes next to it is not part of the classification — the loop
 * knows whether it is retrying or has run out of attempts (see `runTurn`).
 */

/** What {@link classifyModelError} decides about a failure: retry it, and how to name it. */
export interface ModelErrorClassification {
  /** Whether the model request may be attempted again. */
  readonly retryable: boolean
  /** The `session.error.error.type` to record. */
  readonly type: SessionErrorType
  /** A human-readable message for the log; the error's own message when it has one. */
  readonly message: string
}

/**
 * Whether the failure is a network failure rather than a model response.
 *
 * These are the `code`s Node's `net`/`undici` layers use, and the two `name`s the runtime uses
 * for a cancelled or expired request. `fetch failed` is undici's own wrapper around a failure
 * that carries the real reason in `cause`.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

/** The last resort for a network failure whose code lives nowhere a duck type can reach. */
const NETWORK_MESSAGE_PATTERN =
  /fetch failed|network|socket hang up|timed? ?out|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i

/** How deep a `cause` chain is followed before giving up on finding a reason. */
const MAX_CAUSE_DEPTH = 3

/**
 * Classify a failed model request.
 *
 * Takes `unknown` because that is what `catch` and the AI SDK's error callbacks hand over: a
 * provider error arrives as an `APICallError`, a network failure as a `TypeError` with a
 * `cause`, and a bug in this process as anything at all. Nothing here throws — an unrecognised
 * value classifies as `unknown_error` and is not retried.
 *
 * @param error whatever the model request failed with
 */
export function classifyModelError(error: unknown): ModelErrorClassification {
  const message = messageOf(error)
  const status = statusOf(error)
  if (status !== undefined) {
    if (status === 429) {
      return { retryable: true, type: 'model_rate_limited_error', message }
    }
    if (status === 503 || status === 529) {
      return { retryable: true, type: 'model_overloaded_error', message }
    }
    if (status === 408 || status >= 500) {
      return { retryable: true, type: 'model_request_failed_error', message }
    }
    return { retryable: false, type: 'model_request_failed_error', message }
  }
  if (isNetworkError(error, 0)) {
    return { retryable: true, type: 'model_request_failed_error', message }
  }
  if (asRecord(error)?.isRetryable === true) {
    // A provider that flags a failure retryable without a status is still telling us it never
    // decided: trust it rather than losing the turn.
    return { retryable: true, type: 'model_request_failed_error', message }
  }
  return { retryable: false, type: 'unknown_error', message }
}

/** Whether {@link classifyModelError} says the request may be attempted again. */
export function isRetryableModelError(error: unknown): boolean {
  return classifyModelError(error).retryable
}

/** A value as a string-keyed record, or `null` when it is not an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** The message to log: the error's own when it has one, otherwise whatever it is. */
function messageOf(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  const message = asRecord(error)?.message
  if (typeof message === 'string' && message.length > 0) {
    return message
  }
  return String(error)
}

/**
 * The HTTP status the failure reports, or `undefined` when it never got one.
 *
 * `APICallError` from the AI SDK is the shape that matters — it is what every provider built
 * on that SDK throws — and the duck-typed reads after it cover a provider error that crossed a
 * bundle boundary, plus the fetch `Response` some SDKs attach.
 */
function statusOf(error: unknown): number | undefined {
  if (APICallError.isInstance(error)) {
    return error.statusCode
  }
  const record = asRecord(error)
  if (record === null) {
    return undefined
  }
  return (
    numberOf(record.statusCode) ??
    numberOf(record.status) ??
    numberOf(asRecord(record.response)?.status)
  )
}

/** Whether a failure is a transport failure rather than a response, following `cause` chains. */
function isNetworkError(error: unknown, depth: number): boolean {
  if (depth > MAX_CAUSE_DEPTH) {
    return false
  }
  if (APICallError.isInstance(error)) {
    // An `APICallError` with no status never reached the provider; one with a status did, and
    // its status was handled before we got here.
    return error.statusCode === undefined
  }
  const record = asRecord(error)
  if (record === null) {
    return false
  }
  const code = record.code
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) {
    return true
  }
  const name = record.name
  if (name === 'AbortError' || name === 'TimeoutError') {
    return true
  }
  const message = record.message
  if (typeof message === 'string' && NETWORK_MESSAGE_PATTERN.test(message)) {
    return true
  }
  return isNetworkError(record.cause, depth + 1)
}

/** A finite number read from a record, or `undefined`. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
