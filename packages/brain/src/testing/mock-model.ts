import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ModelUsage } from '@openharness/protocol'
import { FIXTURE_MODEL_USAGE } from '@openharness/protocol/fixtures'
import { APICallError } from 'ai'
import type { LanguageModel } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

import type { ModelCredential, ModelFactory, ResolveCredential } from '../model'

/**
 * The models the brain's tests stream from: AI SDK mock models, scripted per request.
 *
 * A test drives the turn loop through the same `streamText` path production uses, with no API
 * key and no network. The script says what the model answers; the recorded calls say what the
 * loop asked it — the prompt, the abort signal — which is how the steering, context and abort
 * tests assert on the request rather than only on the events it produced.
 */

/** What one model request answers with. */
export interface MockModelScript {
  /** The text chunks to stream, in order. Default: no text at all. */
  readonly text?: readonly string[]
  /**
   * Reject the request outright, as a provider failing before the stream opens. A test about
   * retries passes an {@link apiCallError}, so the SDK's own classifier can see the failure.
   */
  readonly failWith?: Error
  /** Stream `text`, then report this error mid-stream, as a provider dying halfway. */
  readonly failAfterText?: Error
  /** Token usage to report; default `FIXTURE_MODEL_USAGE`. */
  readonly usage?: Partial<ModelUsage>
  /** Called as each text chunk is about to be served — a test can abort or append here. */
  readonly onChunk?: (chunk: string, index: number) => Promise<void> | void
}

/** The scripted model factory, and what the loop sent it. */
export interface MockModel {
  /** Hand this to `runTurn` as `model`. */
  readonly factory: ModelFactory
  /** One entry per model request made, in order. */
  readonly calls: LanguageModelV4CallOptions[]
}

/**
 * A provider failure in the shape a real SDK throws: an `APICallError` carrying the status and
 * the `isRetryable` verdict the AI SDK's own retry classifier reads.
 *
 * A mock failing with a bare `Error` that merely has a `statusCode` property is invisible to
 * that classifier — the SDK only retries an `APICallError.isInstance()` with `isRetryable:
 * true` — so a test that pins "the SDK must not retry underneath the loop" has to fail the way
 * a provider really would, or it passes whichever way the loop is written (issue #117). The
 * retry tests' failure scripts use this shape.
 *
 * @param statusCode the HTTP status the failure reports
 * @param message the provider's error text
 */
export function apiCallError(
  statusCode: number,
  message = `provider said ${statusCode}`,
): APICallError {
  return new APICallError({
    message,
    url: 'https://api.example.test/v1/messages',
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode === 429 || statusCode >= 500,
  })
}

/** The text block the mock streams under; a real provider picks its own ids. */
const TEXT_ID = 'mock-text-1'

/** The key a mock request is made with. The mock ignores it — a request still needs one. */
export const TEST_API_KEY = 'oh-test-api-key-0000'

/** {@link TEST_API_KEY} as one request's credential. */
export const TEST_CREDENTIAL: ModelCredential = { type: 'api_key', apiKey: TEST_API_KEY }

/**
 * The credential resolver a test hands `runTurn`: every provider has {@link TEST_CREDENTIAL}.
 *
 * `runTurn` asks for the credential before it makes a request, so a turn without one ends with
 * `missing_provider_credential` — a test that wants a turn to run passes this (or its own
 * resolver). The mock model ignores what it is given; only the loop sees the answer.
 */
export const resolveTestCredential: ResolveCredential = () => Promise.resolve(TEST_CREDENTIAL)

/**
 * Build a {@link MockModel} from one script per model request.
 *
 * The last script answers every request after the ones spelled out, so a test that cares about
 * the first request only does not have to describe the rest. The factory hands out one model —
 * the turn holds on to it for the whole turn, as it would a real one — and each `doStream` call
 * takes the next script.
 *
 * ```ts
 * const { factory, calls } = mockModel({ text: ['Hello'] })
 * await runTurn(session.id, { store, model: factory })
 * expect(readPrompt(calls[0])).toEqual([{ role: 'system', text: '…' }, …])
 * ```
 *
 * @param scripts what each model request answers with, in order
 */
export function mockModel(...scripts: MockModelScript[]): MockModel {
  const calls: LanguageModelV4CallOptions[] = []
  let served = 0
  const model = new MockLanguageModelV4({
    provider: 'openharness-test',
    modelId: 'mock-model',
    supportedUrls: {},
    doStream: (options) => {
      calls.push(options)
      const script = scripts[Math.min(served, scripts.length - 1)]
      served += 1
      if (script === undefined) {
        return Promise.reject(new Error('mockModel() needs at least one script'))
      }
      if (script.failWith !== undefined) {
        return Promise.reject(script.failWith)
      }
      return Promise.resolve({ stream: streamOf(script) })
    },
  })
  const factory: ModelFactory = () => model
  return { factory, calls }
}

/**
 * The stream one script produces: the text chunks, then either an error part or the end of the
 * text, and a finish with the usage.
 *
 * Pulled, not pushed: one chunk is served per `pull`, which is what lets a test act between
 * two chunks — aborting the turn, or appending a steering message — and see the loop's next
 * step depend on it.
 */
function streamOf(script: MockModelScript): ReadableStream<LanguageModelV4StreamPart> {
  const usage = { ...FIXTURE_MODEL_USAGE, ...script.usage }
  const steps: (() => Promise<LanguageModelV4StreamPart>)[] = [
    () => Promise.resolve({ type: 'stream-start', warnings: [] }),
    () => Promise.resolve({ type: 'text-start', id: TEXT_ID }),
    ...(script.text ?? []).map((chunk, index) => async (): Promise<LanguageModelV4StreamPart> => {
      await script.onChunk?.(chunk, index)
      return { type: 'text-delta', id: TEXT_ID, delta: chunk }
    }),
    () =>
      Promise.resolve<LanguageModelV4StreamPart>(
        script.failAfterText === undefined
          ? { type: 'text-end', id: TEXT_ID }
          : { type: 'error', error: script.failAfterText },
      ),
    () =>
      Promise.resolve<LanguageModelV4StreamPart>({
        type: 'finish',
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: {
            total: usage.input_tokens,
            noCache: usage.input_tokens - usage.cache_read_input_tokens,
            cacheRead: usage.cache_read_input_tokens,
            cacheWrite: usage.cache_creation_input_tokens,
          },
          outputTokens: { total: usage.output_tokens, text: usage.output_tokens, reasoning: 0 },
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

/**
 * A model that declares the wrong provider spec, as a regression test for {@link toModelUsage}.
 *
 * `MockLanguageModelV4` declares `v4` and reports usage in the shape the AI SDK reads straight
 * off. A provider whose declaration and payload disagree is worse company than that: it says
 * `specificationVersion: 'v2'` while streaming v3-shaped usage, so `ai` runs its v2
 * compatibility layer over a report that is already the newer shape and the counts end up
 * nested inside an object where a number belongs — `0 + { … }`, the string issue #39 shipped.
 * Nothing else about the mock changes; only the declaration it makes is wrong.
 *
 * No provider shipped today does this — the AI SDK providers a request is built from declare
 * the spec they implement — so this model is not a reproduction of a live failure. It is what
 * keeps `toModelUsage` honest about reading a count wherever it survived, which is the
 * insurance against a future pairing that disagrees again.
 *
 * ```ts
 * const { factory } = mockModel({ text: ['Hello'], usage: { input_tokens: 9 } })
 * const model = wrongSpecModel(factory('anthropic/claude-sonnet-5'))
 * ```
 *
 * @param model the model to mislabel
 */
export function wrongSpecModel(model: LanguageModel): LanguageModel {
  // A proxy, not a copy: `LanguageModel` is a union that includes a bare provider-id string,
  // and the model this labels keeps its methods and its `supportedUrls` getter where they are.
  return new Proxy(model as object, {
    get(target, property, receiver): unknown {
      return property === 'specificationVersion' ? 'v2' : Reflect.get(target, property, receiver)
    },
  }) as LanguageModel
}

/** One message of a recorded prompt, as the text it carried. */
export interface PromptMessage {
  /** The role the loop sent the text under. */
  readonly role: string
  /** The message's text, its parts joined. */
  readonly text: string
}

/**
 * A recorded request's prompt, as readable `{ role, text }` pairs.
 *
 * The provider-level prompt is what `streamText` sends — string content for a system message,
 * an array of parts for everything else — so this is the shape a test can assert on.
 *
 * @param call one entry of `MockModel.calls`
 */
export function readPrompt(call: LanguageModelV4CallOptions): PromptMessage[] {
  return call.prompt.map((message) => ({
    role: message.role,
    text:
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
  }))
}
