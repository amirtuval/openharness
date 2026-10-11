import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { type ApiErrorType, apiErrorBody, httpStatusForErrorType } from '@openharness/protocol'

import type { AppEnv } from '../types'

/**
 * Failures the API answers with, in the protocol's error envelope.
 *
 * Every route error goes through {@link HttpError}: either one raised here (a validation
 * failure, a missing resource, a bad key) or one raised by a store, which the app's
 * `onError` maps to the same shape. The envelope is the protocol's —
 * `{ type: 'error', error: { type, message }, request_id }` — and the status is the one
 * `httpStatusForErrorType` gives that type (see `packages/protocol/src/errors.ts`).
 *
 * A stack trace never reaches a client: an error that is not one of these is logged and
 * answered as a generic `api_error`.
 */
export class HttpError extends Error {
  /** The protocol error type; it decides the body and the HTTP status. */
  readonly type: ApiErrorType
  /** The HTTP status `type` is served with. */
  readonly status: number

  constructor(type: ApiErrorType, message: string) {
    super(message)
    this.name = 'HttpError'
    this.type = type
    this.status = httpStatusForErrorType(type)
  }
}

/** A malformed or invalid request: 400 `invalid_request_error`. */
export function invalidRequest(message: string): HttpError {
  return new HttpError('invalid_request_error', message)
}

/** A missing, malformed or unknown API key: 401 `authentication_error`. */
export function authenticationError(message: string): HttpError {
  return new HttpError('authentication_error', message)
}

/** An id in the path that names nothing: 404 `not_found_error`. */
export function notFoundError(message: string): HttpError {
  return new HttpError('not_found_error', message)
}

/**
 * The caller is signed in but this action is not allowed — a stale session on a credential
 * write, or a cookie-authenticated write from an untrusted origin: 403 `permission_error`.
 */
export function permissionError(message: string): HttpError {
  return new HttpError('permission_error', message)
}

/**
 * A provider key that did not validate against its provider (A5): 422
 * `invalid_provider_credential`. The message names the provider, never the key.
 */
export function invalidProviderCredential(message: string): HttpError {
  return new HttpError('invalid_provider_credential', message)
}

/**
 * The request conflicts with the resource's current state — a rewind aimed at a session with
 * a turn in flight (#238): 409 `conflict_error`.
 *
 * The status the protocol gives the type; the message says what the caller can do about it
 * (wait for the turn, or interrupt it).
 */
export function conflictError(message: string): HttpError {
  return new HttpError('conflict_error', message)
}

/**
 * A chat asked for — or continues on — a mode whose model cannot be used (#245, M6): 422
 * `mode_unavailable_error`.
 *
 * Unprocessable rather than a conflict: the request is well-formed, but the mode's model has
 * no credential behind it or is "my default model" with no default set. The server refuses
 * rather than running something else — never a silent fallback — and the message says what the
 * caller can do about it (edit the mode, or pick a model).
 */
export function modeUnavailableError(message: string): HttpError {
  return new HttpError('mode_unavailable_error', message)
}

/**
 * An MCP server that could not be reached, discovered or registered as an OAuth client (epic
 * #303, X10): 422 `mcp_connection_error`.
 *
 * Unprocessable rather than a conflict: the request is well-formed, but the server could not
 * be brought into a usable state — a discovery document with no authorization server, an
 * authorization server without dynamic registration, a token endpoint that refused the code.
 * The message names the endpoint and never a secret.
 */
export function mcpConnectionError(message: string): HttpError {
  return new HttpError('mcp_connection_error', message)
}

/**
 * The caller is over a rate limit — a `GET /v1/models?refresh=true` inside the once-a-minute
 * window (C4): 429 `rate_limit_error`.
 */
export function rateLimitError(message: string): HttpError {
  return new HttpError('rate_limit_error', message)
}

/**
 * One issue of a failed schema parse: the shape both zod and this module's helpers speak.
 *
 * Deliberately structural, so nothing here has to import `zod` to describe a failure the
 * protocol schemas produce.
 */
export interface ValidationIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/** Build the message for a validation failure: the first issue, and how many followed. */
export function validationError(error: { readonly issues: readonly ValidationIssue[] }): HttpError {
  const first = error.issues[0]
  if (first === undefined) {
    return invalidRequest('the request is not valid')
  }
  const path = first.path.map((segment) => String(segment)).join('.')
  const where = path.length === 0 ? '' : `${path}: `
  const rest = error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : ''
  return invalidRequest(`${where}${first.message}${rest}`)
}

/**
 * The error envelope as a response.
 *
 * `request_id` is the value the `request-id` response header carries, so a client can quote
 * one id for both — see the protocol's `ApiErrorBody`.
 */
export function errorResponse(c: Context<AppEnv>, type: ApiErrorType, message: string): Response {
  const status = httpStatusForErrorType(type) as ContentfulStatusCode
  return c.json(apiErrorBody(type, message, c.get('requestId')), status)
}

/** The envelope for a {@link HttpError}, whatever raised it. */
export function httpErrorResponse(c: Context<AppEnv>, error: HttpError): Response {
  return errorResponse(c, error.type, error.message)
}
