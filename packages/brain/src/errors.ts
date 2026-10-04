import type { SessionErrorType } from '@openharness/protocol'
import { APICallError } from 'ai'
import { CLAIM_CONFLICT_ERROR_CODE, ClaimConflictError, isFencedError } from '@openharness/session'
import type { FencedError } from '@openharness/session'

/**
 * Turning whatever a model request threw into the two things the turn loop needs: whether the
 * request may be retried, and which `session.error` type the log should carry.
 *
 * The classification is deliberately one function. A retry decision and the event that
 * documents it have to agree — a `retry_status: "retrying"` the brain then does not retry, or a
 * silent drop of an error the provider said was transient, are both worse than a wrong retry.
 *
 * Not every failure that reaches this module is a model failure: a write the store refused
 * because another owner holds the log ({@link isOwnershipError}) must never be classified,
 * retried or written about — it is the refusal itself that matters, and the turn stops at it.
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
 *
 * ## Wrapped errors
 *
 * A failure does not always arrive as itself. The AI SDK reports call-level retries that ran
 * out as an `AI_RetryError` — a wrapper whose own `statusCode` and `isRetryable` are undefined,
 * carrying the provider's final error in `lastError` (and every attempt in `errors`) — and a
 * provider SDK may wrap a failure the same way in its own retry/aggregate error. Classifying
 * such a wrapper on its own would end the turn as `unknown_error` even though the error inside
 * it is a 429 or a 503 the loop should have retried. So when nothing on the error itself
 * decides, the error it carries is classified instead: `lastError`, the last of `errors`, or
 * `cause`. What an error decides about itself always wins — a wrapper never overrides the
 * status or `isRetryable` of the error around it.
 *
 * The brain sets `maxRetries: 0` (see `model.ts`), so the AI SDK's own wrapper should not be
 * reached; the unwrapping is what keeps a wrapper from a provider SDK — or from the AI SDK,
 * should a future version start wrapping again — from downgrading a retryable failure.
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
 * How deep a wrapper is followed — through `lastError`, `errors` or `cause` — before the
 * failure inside it is called unreadable. A wrapper of a wrapper is still a wrapper.
 */
const MAX_WRAPPER_DEPTH = 3

/**
 * Classify a failed model request.
 *
 * Takes `unknown` because that is what `catch` and the AI SDK's error callbacks hand over: a
 * provider error arrives as an `APICallError`, a network failure as a `TypeError` with a
 * `cause`, a wrapper as an `AI_RetryError` around either (see the module docs), and a bug in
 * this process as anything at all. Nothing here throws — an unrecognised value classifies as
 * `unknown_error` and is not retried.
 *
 * The message is the outer error's own — what the provider or the wrapping SDK said — even
 * when the decision comes from the error inside it.
 *
 * @param error whatever the model request failed with
 */
export function classifyModelError(error: unknown): ModelErrorClassification {
  const message = messageOf(error)
  return { ...decideModelError(error, 0), message }
}

/**
 * The retry/type half of the classification for one error, looking inside a wrapper when the
 * error itself does not decide anything.
 *
 * Each step asks the same three questions in order — a status, a network failure,
 * `isRetryable` — and only when all three are silent follows {@link wrappedErrorOf} into the
 * error a wrapper carries. That is what keeps a wrapper from downgrading the 429 or 503
 * inside it to `unknown_error`, and equally keeps it from overriding anything the outer error
 * really said.
 *
 * @param error the error to decide on
 * @param depth how many wrappers have already been opened
 */
function decideModelError(
  error: unknown,
  depth: number,
): Omit<ModelErrorClassification, 'message'> {
  const status = statusOf(error)
  if (status !== undefined) {
    if (status === 429) {
      return { retryable: true, type: 'model_rate_limited_error' }
    }
    if (status === 503 || status === 529) {
      return { retryable: true, type: 'model_overloaded_error' }
    }
    if (status === 408 || status >= 500) {
      return { retryable: true, type: 'model_request_failed_error' }
    }
    return { retryable: false, type: 'model_request_failed_error' }
  }
  if (isNetworkError(error, 0)) {
    return { retryable: true, type: 'model_request_failed_error' }
  }
  if (asRecord(error)?.isRetryable === true) {
    // A provider that flags a failure retryable without a status is still telling us it never
    // decided: trust it rather than losing the turn.
    return { retryable: true, type: 'model_request_failed_error' }
  }
  if (depth < MAX_WRAPPER_DEPTH) {
    const wrapped = wrappedErrorOf(error)
    if (wrapped !== undefined && wrapped !== error) {
      return decideModelError(wrapped, depth + 1)
    }
  }
  return { retryable: false, type: 'unknown_error' }
}

/**
 * The failure a wrapper error carries, or `undefined` when the error wraps none.
 *
 * `lastError` is the AI SDK's `AI_RetryError` — the provider error of the attempt that ran the
 * retries out — and the only one of the three the SDK sets. `cause` is the ordinary chain of
 * `TypeError('fetch failed', { cause })` and of a provider SDK's own wrapper. `errors` is the
 * same idea in an `AggregateError` or another provider's retry error, read from its last
 * entry: the final attempt is the one whose verdict counts. A value with none of them is not
 * a wrapper, and stays unreadable.
 */
function wrappedErrorOf(error: unknown): unknown {
  const record = asRecord(error)
  if (record === null) {
    return undefined
  }
  for (const carried of [record.lastError, record.cause]) {
    if (carried !== undefined && carried !== null) {
      return carried
    }
  }
  const errors = record.errors
  if (Array.isArray(errors) && errors.length > 0) {
    return errors[errors.length - 1]
  }
  return undefined
}

/** Whether {@link classifyModelError} says the request may be attempted again. */
export function isRetryableModelError(error: unknown): boolean {
  return classifyModelError(error).retryable
}

/**
 * Whether `value` is the store's {@link ClaimConflictError}.
 *
 * `instanceof` first, then the stable `name`/`code` pair, for the same reason
 * `isFencedError()` does it: a store reached through a second copy of `@openharness/session`
 * throws that copy's class, which no `instanceof` check here can match.
 */
export function isClaimConflictError(value: unknown): value is ClaimConflictError {
  if (value instanceof ClaimConflictError) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate: Partial<ClaimConflictError> = value
  return candidate.name === 'ClaimConflictError' && candidate.code === CLAIM_CONFLICT_ERROR_CODE
}

/**
 * Whether a refused write is an ownership failure: the partition is somebody else's
 * (`FencedError`), or another owner claimed the user events this write answers
 * (`ClaimConflictError`).
 *
 * The two are one thing to the turn loop — "this log is not mine any more" — and both must
 * stop the turn where it stands rather than be classified, retried or written about: an event
 * that could not be stored is not a model failure, and a turn that kept going would answer
 * events another brain owns. See `runTurn`.
 */
export function isOwnershipError(error: unknown): error is FencedError | ClaimConflictError {
  return isFencedError(error) || isClaimConflictError(error)
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
