import { APICallError, RetryError } from 'ai'
import { describe, expect, it } from 'vitest'

import { classifyModelError, isRetryableModelError } from './errors'

/** The provider error the AI SDK throws, which is what most of the table is about. */
function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider said ${statusCode}`,
    url: 'https://api.example.test/v1/messages',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  })
}

/**
 * The wrapper the AI SDK reports retries that ran out through — `name: 'AI_RetryError'`,
 * `lastError` the final attempt, `errors` them all, no status of its own.
 */
function aiRetryError(
  errors: unknown[],
  reason: 'maxRetriesExceeded' | 'errorNotRetryable' = 'maxRetriesExceeded',
): RetryError {
  return new RetryError({ message: `Failed after ${errors.length} attempts.`, reason, errors })
}

/** A provider error that crossed a bundle boundary, so `instanceof` does not catch it. */
function duckTyped(statusCode: number): Error {
  return Object.assign(new Error(`provider said ${statusCode}`), { statusCode })
}

describe('classifyModelError', () => {
  it.each([
    [429, 'model_rate_limited_error', true],
    [503, 'model_overloaded_error', true],
    [529, 'model_overloaded_error', true],
    [500, 'model_request_failed_error', true],
    [502, 'model_request_failed_error', true],
    [504, 'model_request_failed_error', true],
    [408, 'model_request_failed_error', true],
    [400, 'model_request_failed_error', false],
    [401, 'model_request_failed_error', false],
    [404, 'model_request_failed_error', false],
    [422, 'model_request_failed_error', false],
  ])('classifies HTTP %i as %s (retryable: %s)', (status, type, retryable) => {
    expect(classifyModelError(apiError(status))).toEqual({
      type,
      retryable,
      message: `provider said ${status}`,
    })
  })

  it('reads a status off an error it cannot recognise as an API error', () => {
    expect(classifyModelError(duckTyped(429))).toMatchObject({
      type: 'model_rate_limited_error',
      retryable: true,
    })
  })

  it('reads a status off a fetch response', () => {
    const failure = Object.assign(new Error('bad gateway'), { response: { status: 502 } })

    expect(classifyModelError(failure)).toMatchObject({
      type: 'model_request_failed_error',
      retryable: true,
    })
  })

  it.each([['ECONNREFUSED'], ['ECONNRESET'], ['ETIMEDOUT'], ['ENOTFOUND'], ['UND_ERR_SOCKET']])(
    'treats %s as a retryable network failure',
    (code) => {
      const failure = Object.assign(new Error('connect failed'), { code })

      expect(classifyModelError(failure)).toMatchObject({
        type: 'model_request_failed_error',
        retryable: true,
      })
    },
  )

  it('follows the cause of a fetch failure', () => {
    const failure = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    })

    expect(classifyModelError(failure).retryable).toBe(true)
  })

  it('treats a timeout as retryable', () => {
    const failure = Object.assign(new Error('The request took too long.'), {
      name: 'TimeoutError',
    })

    expect(classifyModelError(failure)).toMatchObject({
      type: 'model_request_failed_error',
      retryable: true,
    })
  })

  it('treats an API error with no status as a network failure', () => {
    const failure = new APICallError({
      message: 'socket hang up',
      url: 'https://api.example.test/v1/messages',
      requestBodyValues: {},
    })

    expect(classifyModelError(failure)).toMatchObject({
      type: 'model_request_failed_error',
      retryable: true,
    })
  })

  it('trusts a provider that flags a failure retryable without a status', () => {
    const failure = Object.assign(new Error('try again'), { isRetryable: true })

    expect(classifyModelError(failure)).toMatchObject({
      type: 'model_request_failed_error',
      retryable: true,
    })
  })

  it('falls back to unknown_error for anything it cannot place', () => {
    expect(classifyModelError(new Error('something else'))).toEqual({
      type: 'unknown_error',
      retryable: false,
      message: 'something else',
    })
    expect(classifyModelError(undefined)).toMatchObject({
      type: 'unknown_error',
      retryable: false,
    })
    expect(classifyModelError({ message: 42 })).toMatchObject({ type: 'unknown_error' })
  })

  it('takes a string that was thrown at face value', () => {
    expect(classifyModelError('rate limited, honestly')).toEqual({
      type: 'unknown_error',
      retryable: false,
      message: 'rate limited, honestly',
    })
  })

  it('does not retry a failure it cannot name', () => {
    // Concrete verdicts, not `classifyModelError(e).retryable` — which is what this function
    // *is*, so asserting it would pass whatever the classification answered.
    for (const error of [new Error('?'), null, 7, { whatever: true }]) {
      expect(isRetryableModelError(error)).toBe(false)
    }
    expect(isRetryableModelError(apiError(429))).toBe(true)
    expect(isRetryableModelError(apiError(503))).toBe(true)
    expect(isRetryableModelError(apiError(401))).toBe(false)
  })

  // A wrapper reports no status and no `isRetryable` of its own (issue #117): deciding on the
  // wrapper alone would end the turn as `unknown_error` while the provider's verdict — a 503,
  // a 429 — sits in `lastError`. The classification follows it, without letting the wrapper
  // override anything the outer error did say. The message stays the outer error's.
  it('classifies an AI_RetryError by the provider error it wraps', () => {
    const wrapped = aiRetryError([apiError(503), apiError(503), apiError(503)])

    expect(classifyModelError(wrapped)).toEqual({
      retryable: true,
      type: 'model_overloaded_error',
      message: 'Failed after 3 attempts.',
    })
    expect(isRetryableModelError(wrapped)).toBe(true)
  })

  it('keeps a wrapped 429 retryable and a wrapped 401 terminal', () => {
    expect(classifyModelError(aiRetryError([apiError(429)]))).toMatchObject({
      type: 'model_rate_limited_error',
      retryable: true,
    })
    expect(
      classifyModelError(aiRetryError([apiError(503), apiError(401)], 'errorNotRetryable')),
    ).toEqual({
      retryable: false,
      type: 'model_request_failed_error',
      message: 'Failed after 2 attempts.',
    })
  })

  it('follows lastError, errors and cause through wrappers that are not the SDK one', () => {
    expect(
      classifyModelError(Object.assign(new Error('outer'), { lastError: apiError(503) })),
    ).toMatchObject({ type: 'model_overloaded_error', retryable: true })
    // The last of `errors` is the attempt whose verdict counts.
    expect(
      classifyModelError(
        Object.assign(new Error('outer'), { errors: [apiError(400), apiError(429)] }),
      ),
    ).toMatchObject({ type: 'model_rate_limited_error', retryable: true })
    expect(classifyModelError(new Error('outer', { cause: apiError(502) }))).toMatchObject({
      type: 'model_request_failed_error',
      retryable: true,
    })
    expect(
      classifyModelError(
        Object.assign(new Error('outer'), {
          lastError: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toMatchObject({ type: 'model_request_failed_error', retryable: true })
  })

  it('reaches through a wrapper around a wrapper', () => {
    const nested = Object.assign(new Error('outer'), { cause: aiRetryError([apiError(503)]) })

    expect(classifyModelError(nested)).toMatchObject({
      type: 'model_overloaded_error',
      retryable: true,
      message: 'outer',
    })
  })

  it('still answers unknown_error, with the wrapper message, for a wrapper around nothing', () => {
    expect(
      classifyModelError(Object.assign(new Error('outer'), { lastError: new Error('inner') })),
    ).toEqual({ retryable: false, type: 'unknown_error', message: 'outer' })
  })
})
