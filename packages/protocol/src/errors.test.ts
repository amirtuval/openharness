import { describe, expect, it } from 'vitest'

import {
  API_ERROR_STATUS_BY_TYPE,
  API_ERROR_TYPES,
  ApiErrorBodySchema,
  ApiErrorTypeSchema,
  apiErrorBody,
  httpStatusForErrorType,
  isApiErrorType,
} from './errors'

describe('API error envelope', () => {
  it('parses the shape Anthropic returns', () => {
    expect(
      ApiErrorBodySchema.parse({
        type: 'error',
        error: { type: 'not_found_error', message: 'The requested resource could not be found.' },
        request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
      }),
    ).toMatchObject({ error: { type: 'not_found_error' } })
  })

  it('parses without a request_id: a proxy may not have set one', () => {
    expect(
      ApiErrorBodySchema.safeParse({ type: 'error', error: { type: 'api_error', message: 'x' } })
        .success,
    ).toBe(true)
  })

  it('rejects an unknown error type and a non-error envelope', () => {
    expect(
      ApiErrorBodySchema.safeParse({ type: 'error', error: { type: 'teapot_error', message: 'x' } })
        .success,
    ).toBe(false)
    expect(
      ApiErrorBodySchema.safeParse({ type: 'errors', error: { type: 'api_error' } }).success,
    ).toBe(false)
    expect(
      ApiErrorBodySchema.safeParse({ error: { type: 'api_error', message: 'x' } }).success,
    ).toBe(false)
  })

  it('builds a body, with and without a request id', () => {
    expect(apiErrorBody('invalid_request_error', 'bad')).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'bad' },
    })
    expect(apiErrorBody('api_error', 'oops', 'req_1').request_id).toBe('req_1')
    expect(
      ApiErrorBodySchema.safeParse(apiErrorBody('rate_limit_error', 'slow down')).success,
    ).toBe(true)
  })
})

describe('error types and status codes', () => {
  it('maps Anthropic’s documented pairs', () => {
    expect(API_ERROR_STATUS_BY_TYPE).toEqual({
      invalid_request_error: 400,
      authentication_error: 401,
      billing_error: 402,
      permission_error: 403,
      not_found_error: 404,
      conflict_error: 409,
      request_too_large: 413,
      rate_limit_error: 429,
      api_error: 500,
      timeout_error: 504,
      overloaded_error: 529,
    })
  })

  it('gives every error type a status', () => {
    for (const type of API_ERROR_TYPES) {
      expect(httpStatusForErrorType(type), type).toBeGreaterThanOrEqual(400)
      expect(ApiErrorTypeSchema.safeParse(type).success, type).toBe(true)
      expect(isApiErrorType(type)).toBe(true)
    }
    expect(isApiErrorType('session.error')).toBe(false)
    expect(isApiErrorType(429)).toBe(false)
  })
})
