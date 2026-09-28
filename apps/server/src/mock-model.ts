import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ModelUsage } from '@openharness/protocol'
import { MockLanguageModelV4 } from 'ai/test'

import type { ModelFactory } from '@openharness/brain'

/**
 * The deterministic test model: what the server streams from when
 * `OPENHARNESS_TEST_MODEL=mock` is set.
 *
 * It exists so the whole server — scheduler, brain, store, SSE, the AI SDK adapter — can be
 * exercised end to end with no provider keys and no network. It is *only* reachable through
 * {@link resolveModelFactory} (`model.ts`), which reads the environment variable; nothing in
 * the server ever constructs it on its own, so a production process that does not set the
 * variable cannot end up talking to it.
 *
 * The model is an AI SDK `MockLanguageModelV4`, so the brain streams it through the same
 * `streamText` path it uses for a real provider — including aborts, error parts and usage.
 *
 * ## What it does
 *
 * | last user message        | what the model streams                                                           |
 * | ------------------------ | -------------------------------------------------------------------------------- |
 * | anything else            | the message echoed back in {@link MOCK_ECHO_CHUNKS} chunks, one delay each        |
 * | `__slow__`               | {@link MOCK_SLOW_CHUNKS} chunks over about {@link MOCK_SLOW_TOTAL_MS}, so a turn  |
 * |                          | can be interrupted, killed and resumed mid-stream                                 |
 * | `__fail_retryable__`     | HTTP 503 (`model_overloaded_error`) on the *first* attempt, then the echo         |
 * | `__fail_terminal__`      | HTTP 400 (`model_request_failed_error`) on every attempt                          |
 *
 * A marker is matched against the *start* of the message, so a prompt can say
 * `__slow__ tell me something` and still stream slowly.
 *
 * Usage is fixed ({@link MOCK_MODEL_USAGE}), so a test can assert the exact token counts the
 * brain writes into `span.model_request_end`.
 */

/** The value of `OPENHARNESS_TEST_MODEL` that turns the mock on. */
export const MOCK_MODEL_ENV_VALUE = 'mock'

/** Streams a reply this many chunks for an ordinary message. */
export const MOCK_ECHO_CHUNKS = 4

/** The pause between two echoed chunks. Small: the point is that text arrives in pieces. */
export const MOCK_ECHO_CHUNK_DELAY_MS = 25

/** The marker that makes the model stream slowly, so a turn can be interrupted mid-flight. */
export const MOCK_SLOW_MARKER = '__slow__'

/** How many chunks a `__slow__` reply is streamed in. */
export const MOCK_SLOW_CHUNKS = 40

/** The pause between two `__slow__` chunks; {@link MOCK_SLOW_TOTAL_MS} in total. */
export const MOCK_SLOW_CHUNK_DELAY_MS = 250

/** How long a `__slow__` reply takes to stream, near enough: 40 × 250 ms. */
export const MOCK_SLOW_TOTAL_MS = MOCK_SLOW_CHUNKS * MOCK_SLOW_CHUNK_DELAY_MS

/** The marker that fails the first attempt with a 503 and succeeds on the retry. */
export const MOCK_RETRYABLE_MARKER = '__fail_retryable__'

/** The marker that fails every attempt with a 400. */
export const MOCK_TERMINAL_MARKER = '__fail_terminal__'

/** The token counts every request of this model reports. Fixed, so tests can assert them. */
export const MOCK_MODEL_USAGE: ModelUsage = {
  input_tokens: 42,
  output_tokens: 17,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** The text block the mock streams under; a real provider picks its own ids. */
const TEXT_ID = 'mock-text-1'

/**
 * Build the {@link ModelFactory} the test hook uses.
 *
 * One model instance is shared by every call, which is what makes the retry markers work:
 * `__fail_retryable__` has to fail once and then succeed across two attempts of the same
 * turn, and the attempt count therefore has to outlive a single `doStream` call. The count
 * is kept per prompt, so two sessions sending the same test message do not interfere.
 */
export function createMockModelFactory(): ModelFactory {
  const attempts = new AttemptCounter()
  const model = new MockLanguageModelV4({
    provider: 'openharness-test',
    modelId: 'openharness-test-model',
    supportedUrls: {},
    doStream: (options) => {
      const message = lastUserText(options.prompt)
      const plan = planFor(message, attempts.record(message))
      if (plan.error !== undefined) {
        return Promise.reject(plan.error)
      }
      return Promise.resolve({ stream: streamOf(plan) })
    },
  })
  return () => model
}

/** What the model does with one request. */
interface ModelPlan {
  /** The text chunks to stream, in order. */
  readonly chunks: readonly string[]
  /** How long to wait before each chunk. */
  readonly delayMs: number
  /** The error to reject the request with, if any. */
  readonly error?: Error
}

/**
 * What the request answers with, from the last user message and how many times it has been
 * asked.
 *
 * @param message the last user message's text
 * @param attempt 1 for the first request of this prompt, 2 for the next, ...
 */
export function planFor(message: string, attempt: number): ModelPlan {
  if (message.startsWith(MOCK_TERMINAL_MARKER)) {
    return { chunks: [], delayMs: 0, error: providerError(400, 'the test model was told to fail') }
  }
  if (message.startsWith(MOCK_RETRYABLE_MARKER) && attempt === 1) {
    return {
      chunks: [],
      delayMs: 0,
      error: providerError(503, 'the test model is briefly overloaded'),
    }
  }
  if (message.startsWith(MOCK_SLOW_MARKER)) {
    const text = slowReplyText()
    return { chunks: chunkText(text, MOCK_SLOW_CHUNKS), delayMs: MOCK_SLOW_CHUNK_DELAY_MS }
  }
  return { chunks: chunkText(message, MOCK_ECHO_CHUNKS), delayMs: MOCK_ECHO_CHUNK_DELAY_MS }
}

/**
 * The deterministic reply to a `__slow__` message: one numbered part per chunk, so both the
 * text and its split are the same on every run.
 */
export function slowReplyText(): string {
  return Array.from(
    { length: MOCK_SLOW_CHUNKS },
    (_, index) => `part ${index + 1}/${MOCK_SLOW_CHUNKS}`,
  ).join(' ')
}

/**
 * Split `text` into at most `count` pieces of roughly equal length, by code point so a
 * character outside the BMP is never cut in half.
 *
 * A text shorter than `count` characters yields one chunk per character: empty chunks would
 * be deltas the model never produced.
 */
export function chunkText(text: string, count: number): string[] {
  const characters = Array.from(text)
  if (characters.length === 0 || count <= 0) {
    return []
  }
  const size = Math.max(1, Math.ceil(characters.length / count))
  const chunks: string[] = []
  for (let index = 0; index < characters.length; index += size) {
    chunks.push(characters.slice(index, index + size).join(''))
  }
  return chunks
}

/** How often each prompt has been asked, so a marker can fail only its first attempt. */
class AttemptCounter {
  readonly #attempts = new Map<string, number>()

  /** Count this request and answer which attempt it is: 1 for the first, 2 for the next, ... */
  record(message: string): number {
    const attempt = (this.#attempts.get(message) ?? 0) + 1
    if (this.#attempts.size >= MAX_TRACKED_PROMPTS) {
      // A long-running server should not grow a map for every distinct test message. The
      // first-request markers have all been used by now; forgetting is harmless.
      this.#attempts.clear()
    }
    this.#attempts.set(message, attempt)
    return attempt
  }
}

/** How many prompts the attempt counter remembers before it starts over. */
const MAX_TRACKED_PROMPTS = 1000

/** A provider failure shaped the way the brain classifies one: a message and an HTTP status. */
function providerError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

/** The text of the last user message of a provider-level prompt, or `''` when there is none. */
function lastUserText(prompt: readonly PromptMessage[]): string {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index]
    if (message === undefined || message.role !== 'user') {
      continue
    }
    if (typeof message.content === 'string') {
      return message.content
    }
    return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
  return ''
}

/** One message of a provider-level prompt: what `streamText` sends the model. */
interface PromptMessage {
  readonly role: string
  readonly content: string | readonly PromptPart[]
}

/** One content part of a prompt message. */
interface PromptPart {
  readonly type: string
  readonly text?: string
}

/**
 * The stream one plan produces: the chunks, one per pull, with the plan's delay before each
 * of them, then the usage.
 *
 * Pulled rather than pushed on purpose — a consumer that stops reading (an abort) stops the
 * stream, which is exactly what makes `__slow__` interruptible.
 */
function streamOf(plan: ModelPlan): ReadableStream<LanguageModelV4StreamPart> {
  const steps: (() => Promise<LanguageModelV4StreamPart>)[] = [
    () => Promise.resolve({ type: 'stream-start', warnings: [] }),
    () => Promise.resolve({ type: 'text-start', id: TEXT_ID }),
    ...plan.chunks.map((chunk) => async (): Promise<LanguageModelV4StreamPart> => {
      await delay(plan.delayMs)
      return { type: 'text-delta', id: TEXT_ID, delta: chunk }
    }),
    () => Promise.resolve({ type: 'text-end', id: TEXT_ID }),
    () =>
      Promise.resolve({
        type: 'finish',
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: {
            total: MOCK_MODEL_USAGE.input_tokens,
            noCache: MOCK_MODEL_USAGE.input_tokens - MOCK_MODEL_USAGE.cache_read_input_tokens,
            cacheRead: MOCK_MODEL_USAGE.cache_read_input_tokens,
            cacheWrite: MOCK_MODEL_USAGE.cache_creation_input_tokens,
          },
          outputTokens: {
            total: MOCK_MODEL_USAGE.output_tokens,
            text: MOCK_MODEL_USAGE.output_tokens,
            reasoning: 0,
          },
        },
      }),
  ]
  let step = 0
  return new ReadableStream<LanguageModelV4StreamPart>({
    async pull(controller) {
      const next = steps[step]
      step += 1
      if (next === undefined) {
        controller.close()
        return
      }
      controller.enqueue(await next())
    },
  })
}

/** Sleep `ms`; a zero or negative delay is not a delay at all. */
function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
