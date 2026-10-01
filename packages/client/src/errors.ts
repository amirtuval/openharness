import {
  API_ERROR_TYPES,
  API_ERROR_STATUS_BY_TYPE,
  ApiErrorBodySchema,
  type ApiErrorType,
} from '@openharness/protocol'

/**
 * The errors `@openharness/client` throws.
 *
 * - {@link ApiError} — the server answered with a non-2xx status and (usually) the protocol's
 *   error envelope. It carries the HTTP status, the `error.type` string and the request id,
 *   so a caller can branch on the status or show the message.
 * - {@link AuthenticationError} — the 401 case of that, as its own type so a frontend can tell
 *   "sign in again" from every other failure without inspecting numbers or strings. It is an
 *   {@link ApiError} subclass; the event stream stops on it rather than reconnecting.
 * - {@link ResponseValidationError} — the server answered 2xx with a body that does not match
 *   the protocol. That is a server bug, not a request one, so it gets its own type instead of
 *   being flattened into an {@link ApiError}.
 *
 * A failed `fetch` itself (no network, DNS, TLS, an abort) is *not* wrapped: the original
 * error rejects the promise. Only an answer from the server becomes an {@link ApiError}.
 */

/** The HTTP statuses that are worth retrying: rate limiting and server-side failures. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])

/**
 * The error type a status maps to, when the response did not carry an error envelope.
 *
 * The inverse of the protocol's `API_ERROR_STATUS_BY_TYPE`, so a proxy or a load balancer
 * that answers with bare HTML still produces a typed error: a 401 is an
 * `authentication_error` whether or not the body says so.
 *
 * @param status the HTTP status of the response
 */
export function errorTypeForStatus(status: number): ApiErrorType {
  const match = API_ERROR_TYPES.find((type) => API_ERROR_STATUS_BY_TYPE[type] === status)
  return match ?? 'api_error'
}

/**
 * A non-2xx answer from the server.
 *
 * @example
 * ```ts
 * try {
 *   await client.sessions.get(sessionId)
 * } catch (error) {
 *   if (error instanceof ApiError && error.type === 'not_found_error') showMissing()
 * }
 * ```
 */
export class ApiError extends Error {
  /** HTTP status of the response, e.g. `404`. */
  readonly status: number

  /** The protocol's error type, e.g. `not_found_error`. */
  readonly type: ApiErrorType

  /** The server's request id, when it reported one. */
  readonly requestId?: string

  constructor(
    status: number,
    message: string,
    options: { type?: ApiErrorType; requestId?: string | undefined } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.type = options.type ?? errorTypeForStatus(status)
    this.requestId = options.requestId
  }

  /**
   * Whether retrying the request has a chance of succeeding: `429` and the `5xx` family.
   *
   * The event stream uses this to decide between reconnecting and giving up, and a caller
   * that sends user events can use it the same way.
   */
  get retryable(): boolean {
    return RETRYABLE_STATUSES.has(this.status)
  }
}

/**
 * The server does not know who is calling: no session cookie, no bearer token, or one that is
 * missing, malformed, expired or revoked (401 `authentication_error`).
 *
 * A subclass of {@link ApiError}, so existing `instanceof ApiError` handling keeps working; the
 * distinct type is what lets a frontend send the user to sign-in, or the CLI to `oh login`,
 * without matching on a status number. It is never retryable — the event stream stops on it
 * instead of reconnecting forever.
 *
 * @example
 * ```ts
 * try {
 *   await client.me()
 * } catch (error) {
 *   if (error instanceof AuthenticationError) redirectToSignIn()
 * }
 * ```
 */
export class AuthenticationError extends ApiError {
  /** Authentication failures are always 401. */
  declare readonly status: 401

  /** Always the protocol's `authentication_error`. */
  declare readonly type: 'authentication_error'

  constructor(message: string, options: { requestId?: string | undefined } = {}) {
    super(401, message, { type: 'authentication_error', requestId: options.requestId })
    this.name = 'AuthenticationError'
  }
}

/**
 * A 2xx response whose body did not match the protocol.
 *
 * Thrown instead of returning a half-typed object: a caller that gets a value out of this
 * client can rely on its shape. Unknown *fields* are stripped by the protocol's schemas, so
 * this only fires for a missing field, a wrong type, or a body that is not JSON at all.
 */
export class ResponseValidationError extends Error {
  /** HTTP status of the response that failed to parse. */
  readonly status: number

  /** What the schema reported, when it said anything specific. */
  readonly details: string | undefined

  constructor(status: number, message: string, details?: string) {
    super(message)
    this.name = 'ResponseValidationError'
    this.status = status
    this.details = details
  }
}

/**
 * Build the error for a non-2xx response: an {@link AuthenticationError} for a 401,
 * an {@link ApiError} for everything else.
 *
 * A body carrying the protocol's envelope wins: its `error.type` and `error.message` are what
 * the server meant. Anything else — HTML from a proxy, an empty body, a body shaped
 * differently — falls back to the type the status maps to. A 401 is an
 * {@link AuthenticationError} either way, envelope or not, exactly as the protocol defines it.
 *
 * @param status the response status
 * @param body the parsed body, when the response had one that was JSON
 * @param options `statusText` and the `request-id` header, when the transport has them
 */
export function apiErrorFromResponse(
  status: number,
  body: unknown,
  options: { statusText?: string | undefined; requestId?: string | undefined } = {},
): ApiError {
  const parsed = ApiErrorBodySchema.safeParse(body)
  if (status === 401) {
    return new AuthenticationError(
      parsed.success ? parsed.data.error.message : describeStatus(status, options.statusText),
      { requestId: (parsed.success ? parsed.data.request_id : undefined) ?? options.requestId },
    )
  }
  if (parsed.success) {
    return new ApiError(status, parsed.data.error.message, {
      type: parsed.data.error.type,
      requestId: parsed.data.request_id ?? options.requestId,
    })
  }
  return new ApiError(status, describeStatus(status, options.statusText), {
    requestId: options.requestId,
  })
}

/** A readable description of a status with no error envelope to quote. */
function describeStatus(status: number, statusText?: string): string {
  const reason = statusText === undefined || statusText === '' ? '' : ` ${statusText}`
  return `The request failed with HTTP status ${status}${reason}.`
}
