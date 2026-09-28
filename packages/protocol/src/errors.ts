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
 * describes a failed turn. Both use the `_error` suffix.
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
  /** 401 — the API key is missing, malformed, revoked or expired. */
  authentication_error: 401,
  /** 402 — the caller cannot pay for the request (billing or payment problem). */
  billing_error: 402,
  /** 403 — the key is valid but not allowed to use this resource. */
  permission_error: 403,
  /** 404 — the resource id in the path does not exist. */
  not_found_error: 404,
  /** 409 — the request conflicts with the resource's current state. */
  conflict_error: 409,
  /** 413 — the request body is too large. */
  request_too_large: 413,
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
