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
      contextOverflow: false,
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
      contextOverflow: false,
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
      contextOverflow: false,
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
      contextOverflow: false,
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
      contextOverflow: false,
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
    ).toEqual({ retryable: false, type: 'unknown_error', message: 'outer', contextOverflow: false })
  })
})

/**
 * The context-overflow flag (epic #277, K2; C2): one case per provider family, each built from
 * the payload that provider really sends.
 *
 * Getting these shapes wrong is not cosmetic: a missed overflow ends the chat on a context it
 * could have compacted, and a false positive makes the turn compact an ordinary 400 away. So
 * each case carries the status, the parsed body and the message a provider's own SDK produces —
 * not a paraphrase of them.
 */
describe('classifyModelError — a request the provider refused as too long', () => {
  /** An `APICallError` in the shape `@ai-sdk/*` throws for a non-2xx response. */
  function providerError(options: {
    readonly status: number
    readonly body: unknown
    readonly message?: string
  }): APICallError {
    const message =
      options.message ??
      (typeof (options.body as { error?: { message?: unknown } })?.error?.message === 'string'
        ? String((options.body as { error: { message: string } }).error.message)
        : 'provider refused the request')
    return new APICallError({
      message,
      url: 'https://api.example.test/v1/messages',
      requestBodyValues: {},
      statusCode: options.status,
      responseBody: JSON.stringify(options.body),
      data: options.body,
      isRetryable: false,
    })
  }

  it('reads OpenAI’s context_length_exceeded', () => {
    const classification = classifyModelError(
      providerError({
        status: 400,
        body: {
          error: {
            message:
              "This model's maximum context length is 128000 tokens. However, your messages resulted in 131072 tokens.",
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_length_exceeded',
          },
        },
      }),
    )

    expect(classification).toMatchObject({
      contextOverflow: true,
      retryable: false,
      type: 'model_request_failed_error',
    })
  })

  it('reads Azure OpenAI’s copy of the same payload', () => {
    const classification = classifyModelError(
      providerError({
        status: 400,
        body: {
          error: {
            message:
              "This model's maximum context length is 16384 tokens. However, your messages resulted in 17000 tokens.",
            type: 'invalid_request_error',
            param: 'messages',
            code: 'context_length_exceeded',
          },
        },
      }),
    )

    expect(classification.contextOverflow).toBe(true)
  })

  it('reads Anthropic’s “prompt is too long”', () => {
    const classification = classifyModelError(
      providerError({
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'prompt is too long: 210000 tokens > 200000 maximum',
          },
        },
      }),
    )

    expect(classification).toMatchObject({
      contextOverflow: true,
      retryable: false,
      type: 'model_request_failed_error',
    })
  })

  it('reads Bedrock’s Converse ValidationException', () => {
    const classification = classifyModelError(
      providerError({
        status: 400,
        message: 'Input is too long for requested model.',
        body: {
          __type: 'ValidationException',
          message: 'Input is too long for requested model.',
        },
      }),
    )

    expect(classification).toMatchObject({
      contextOverflow: true,
      retryable: false,
      type: 'model_request_failed_error',
    })
  })

  it('reads Vertex Gemini’s token-count refusal', () => {
    const classification = classifyModelError(
      providerError({
        status: 400,
        body: {
          error: {
            code: 400,
            message:
              'The input token count (1050000) exceeds the maximum number of tokens allowed (1048576).',
            status: 'INVALID_ARGUMENT',
          },
        },
      }),
    )

    expect(classification).toMatchObject({
      contextOverflow: true,
      retryable: false,
      type: 'model_request_failed_error',
    })
  })

  it('reads an OpenAI-compatible endpoint’s refusal, code or prose', () => {
    // vLLM answers with OpenAI's code and prose; a bare llama.cpp answers with prose alone.
    const vllm = classifyModelError(
      providerError({
        status: 400,
        body: {
          error: {
            message:
              "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.",
            type: 'BadRequestError',
            code: 400,
          },
        },
      }),
    )
    const llama = classifyModelError(
      providerError({
        status: 400,
        message: 'the request exceeds the available context size, try increasing it',
        body: { error: 'the request exceeds the available context size, try increasing it' },
      }),
    )

    expect(vllm.contextOverflow).toBe(true)
    expect(llama.contextOverflow).toBe(true)
  })

  it('sees through a wrapper the provider SDK put around the refusal', () => {
    const wrapped = aiRetryError([
      providerError({
        status: 400,
        body: { error: { type: 'invalid_request_error', message: 'prompt is too long: 1 > 0' } },
      }),
    ])

    expect(classifyModelError(wrapped).contextOverflow).toBe(true)
  })

  it('does not mistake an ordinary 400 for an overflow', () => {
    const classification = classifyModelError(
      providerError({
        status: 400,
        message: 'Unsupported parameter: max_tokens is not supported with this model.',
        body: {
          error: {
            message: 'Unsupported parameter: max_tokens is not supported with this model.',
            type: 'invalid_request_error',
          },
        },
      }),
    )

    expect(classification.contextOverflow).toBe(false)
  })
})

describe('the Vertex Model Garden refusal (#273)', () => {
  /** The APICallError a `:streamGenerateContent` for a not-enabled Claude model gets. */
  function publisherModelError(statusCode: number, message: string): APICallError {
    return new APICallError({
      message,
      url: 'https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/publishers/anthropic/models/claude-sonnet-4-5:streamGenerateContent',
      requestBodyValues: {},
      statusCode,
      responseBody: JSON.stringify({ error: { code: statusCode, message } }),
      isRetryable: false,
    })
  }

  it('turns Google’s “publisher model was not found” 404 into the sentence to act on', () => {
    const classified = classifyModelError(
      publisherModelError(
        404,
        'Publisher model `projects/p/locations/europe-west4/publishers/anthropic/models/claude-sonnet-4-5` was not found or your project does not have access to it.',
      ),
    )
    // The type is unchanged — the request really did fail and is not retryable — and the
    // message is the one a reader can act on, naming the model.
    expect(classified.type).toBe('model_request_failed_error')
    expect(classified.retryable).toBe(false)
    expect(classified.message).toBe(
      'Claude models must be enabled for this Google Cloud project in Vertex AI Model Garden ' +
        '(claude-sonnet-4-5) — open Model Garden, enable the model for the project, and send ' +
        'the message again.',
    )
  })

  it('is not read as a context overflow, so the turn does not compact and retry it', () => {
    // The two decisions are made from the same error and must not meet: the rewrite is a
    // message mapping (#273) while `contextOverflow` is the compact-and-retry signal (epic
    // #277, K2; C2). A 404 for a model the project has not enabled is terminal — compacting
    // the context could not help, and the reader would get "still did not fit" instead of
    // the sentence naming Model Garden.
    const classified = classifyModelError(
      publisherModelError(
        404,
        'Publisher model `projects/p/locations/europe-west4/publishers/anthropic/models/claude-sonnet-4-5` was not found or your project does not have access to it.',
      ),
    )
    expect(classified.contextOverflow).toBe(false)
    expect(classified.type).toBe('model_request_failed_error')
  })

  it('maps a Model Garden terms refusal, whatever status Google answered with', () => {
    expect(
      classifyModelError(
        publisherModelError(
          403,
          'Permission denied: the Model Garden terms of use have not been accepted for publishers/anthropic/models/claude-opus-4-1@20250805',
        ),
      ).message,
    ).toContain('(claude-opus-4-1@20250805)')
  })

  it('leaves every other provider’s error text exactly as it was', () => {
    // A Gemini model on the same credential: Google's own message, unchanged — the sentence
    // is about the partner-model enablement gate, and Gemini has none.
    const gemini = publisherModelError(
      404,
      'Publisher model `projects/p/locations/europe-west4/publishers/google/models/gemini-9.9-pro` was not found or your project does not have access to it.',
    )
    expect(classifyModelError(gemini).message).toContain('was not found or your project')
    // An Anthropic-publisher resource with none of the Model Garden wording — a plain 404 on a
    // wrong path — is not this failure either.
    expect(
      classifyModelError(
        publisherModelError(404, 'publishers/anthropic/models/claude-x: not found'),
      ).message,
    ).toBe('publishers/anthropic/models/claude-x: not found')
    // And an ordinary provider failure is untouched.
    expect(classifyModelError(apiError(429)).message).toBe('provider said 429')
  })
})
