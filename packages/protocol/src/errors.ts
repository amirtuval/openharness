import { z } from 'zod'

/**
 * The Anthropic HTTP error envelope, shared by every endpoint.
 *
 * ```json
 * {
 *   "type": "error",
 *   "error": { "type": "not_found_error", "message": "The requested resource could not be found." },
 *   "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
 * }
 * ```
 *
 * Note that the HTTP error types here (`not_found_error`, `rate_limit_error`, ...) are a
 * different vocabulary from the types carried inside a stored `session.error` event
 * (`model_overloaded_error`, ...): the first describes a failed HTTP request, the second
 * describes a failed turn. Both mostly use the `_error` suffix; the exceptions are this
 * package's own extensions, `invalid_provider_credential` here and
 * `missing_provider_credential` in `events/session.ts`.
 *
 * Authentication failures are the `authentication_error` (401) type: a request with no
 * session cookie, or with a bearer token that is missing, malformed, expired or revoked.
 * Sign-in itself is not an HTTP API of this protocol — it is Better Auth's `/api/auth/*`
 * surface (epic #65, A1).
 */

/** Every error type the API returns. */
export const API_ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'billing_error',
  'permission_error',
  'not_found_error',
  'conflict_error',
  'request_too_large',
  // extension: Anthropic has no provider credentials to reject, and this is the one type
  // here that does not end in `_error` (epic #65, A5).
  'invalid_provider_credential',
  // extension: a chat asked for a mode whose model cannot be used — no credential for its
  // provider, or "my default model" with no default set (epic #245, M6). Anthropic has no
  // modes and so nothing to refuse.
  'mode_unavailable_error',
  'rate_limit_error',
  'api_error',
  'timeout_error',
  'overloaded_error',
] as const

/** An error type string from {@link API_ERROR_TYPES}. */
export type ApiErrorType = (typeof API_ERROR_TYPES)[number]

/** An error type string accepted by the API. */
export const ApiErrorTypeSchema = z.enum(API_ERROR_TYPES)

/**
 * The HTTP status each error type is served with, as Anthropic documents it in
 * "Claude API errors". The SDKs branch on the status and the `error.type` string.
 *
 * Typed as a total record, so adding an entry to {@link API_ERROR_TYPES} without giving it a
 * status is a compile error.
 */
export const API_ERROR_STATUS_BY_TYPE: Record<ApiErrorType, number> = {
  /** 400 — malformed request, bad parameters, or a request rejected on its content. */
  invalid_request_error: 400,
  /** 401 — not signed in: no session cookie or bearer token, or the one presented is invalid or expired. */
  authentication_error: 401,
  /** 402 — the caller cannot pay for the request (billing or payment problem). */
  billing_error: 402,
  /** 403 — the caller is signed in but not allowed to use this resource. */
  permission_error: 403,
  /**
   * 404 — the resource id in the path does not exist — or it exists and belongs to another
   * user. v1 has no sharing, so another user's agent, session or credential is answered as
   * missing rather than forbidden (epic #65, A4): a 403 would confirm it exists.
   */
  not_found_error: 404,
  /** 409 — the request conflicts with the resource's current state. */
  conflict_error: 409,
  /** 413 — the request body is too large. */
  request_too_large: 413,
  /** 422 — a provider credential failed validation against its provider on save. */
  invalid_provider_credential: 422,
  /**
   * 422 — a chat asked for — or continues on — a mode whose model cannot be used: no
   * credential for its provider, or "my default model" with no default set. Unprocessable
   * rather than a conflict: the request is well-formed, but the mode's model is not usable
   * right now (epic #245, M6).
   */
  mode_unavailable_error: 422,
  /** 429 — rate limited, or a spend limit was reached. */
  rate_limit_error: 429,
  /** 500 — an unexpected internal error. */
  api_error: 500,
  /** 504 — the request timed out while processing. */
  timeout_error: 504,
  /** 529 — the API is temporarily overloaded. */
  overloaded_error: 529,
}

/** The `error` object of {@link ApiErrorBodySchema}: a type and a human-readable message. */
export const ApiErrorSchema = z.object({
  type: ApiErrorTypeSchema,
  message: z.string(),
})

export type ApiError = z.infer<typeof ApiErrorSchema>

/**
 * The body of every non-2xx JSON response.
 *
 * `request_id` is the same value as the `request-id` response header; it is optional here
 * because a proxy, or an error raised before the request reaches the app, may not set it.
 */
export const ApiErrorBodySchema = z.object({
  type: z.literal('error'),
  error: ApiErrorSchema,
  request_id: z.string().optional(),
})

export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>

/**
 * Build an error body for the wire.
 *
 * @param type an error type from {@link API_ERROR_TYPES}
 * @param message human-readable description
 * @param requestId value of the `request-id` header, when there is one
 */
export function apiErrorBody(
  type: ApiErrorType,
  message: string,
  requestId?: string,
): ApiErrorBody {
  return {
    type: 'error',
    error: { type, message },
    ...(requestId === undefined ? {} : { request_id: requestId }),
  }
}

/** The HTTP status an error type is served with. */
export function httpStatusForErrorType(type: ApiErrorType): number {
  return API_ERROR_STATUS_BY_TYPE[type]
}

/** Whether `value` is one of the API's error types. */
export function isApiErrorType(value: unknown): value is ApiErrorType {
  return typeof value === 'string' && API_ERROR_TYPES.some((type) => type === value)
}
