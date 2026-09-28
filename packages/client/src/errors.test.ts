import { API_ERROR_STATUS_BY_TYPE } from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import {
  ApiError,
  ResponseValidationError,
  apiErrorFromResponse,
  errorTypeForStatus,
} from './errors'

describe('ApiError', () => {
  it('is built from the protocol error envelope', () => {
    const error = apiErrorFromResponse(
      404,
      {
        type: 'error',
        error: { type: 'not_found_error', message: 'The requested resource could not be found.' },
        request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
      },
      { statusText: 'Not Found' },
    )

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ApiError')
    expect(error.status).toBe(404)
    expect(error.type).toBe('not_found_error')
    expect(error.message).toBe('The requested resource could not be found.')
    expect(error.requestId).toBe('req_011CSHoEeqs5C35K2UUqR7Fy')
    expect(error.retryable).toBe(false)
  })

  it('falls back to the status when the body is not an envelope', () => {
    const error = apiErrorFromResponse(502, '<html>bad gateway</html>', {
      statusText: 'Bad Gateway',
    })

    expect(error.type).toBe('api_error')
    expect(error.status).toBe(502)
    expect(error.message).toBe('The request failed with HTTP status 502 Bad Gateway.')
    expect(error.retryable).toBe(true)
  })

  it('takes the request id from the header when the body has none', () => {
    const error = apiErrorFromResponse(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down.' } },
      { requestId: 'req_from_header' },
    )

    expect(error.type).toBe('rate_limit_error')
    expect(error.requestId).toBe('req_from_header')
  })

  it('describes a body-less error without a status text', () => {
    const error = apiErrorFromResponse(500, undefined)

    expect(error.message).toBe('The request failed with HTTP status 500.')
    expect(error.requestId).toBeUndefined()
  })

  it('maps every documented status back to its error type', () => {
    for (const [type, status] of Object.entries(API_ERROR_STATUS_BY_TYPE)) {
      expect(errorTypeForStatus(status)).toBe(type)
    }
    expect(errorTypeForStatus(418)).toBe('api_error')
  })

  it('marks rate limiting and server failures retryable, and nothing else', () => {
    const retryable = [429, 500, 502, 503, 504, 529]
    const terminal = [400, 401, 402, 403, 404, 409, 413]
    for (const status of retryable) {
      expect(new ApiError(status, 'x').retryable, `status ${status}`).toBe(true)
    }
    for (const status of terminal) {
      expect(new ApiError(status, 'x').retryable, `status ${status}`).toBe(false)
    }
  })
})

describe('ResponseValidationError', () => {
  it('carries the status and what the schema said', () => {
    const error = new ResponseValidationError(200, 'not what we expect', 'message: Required')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ResponseValidationError')
    expect(error.status).toBe(200)
    expect(error.message).toBe('not what we expect')
    expect(error.details).toBe('message: Required')
  })
})
