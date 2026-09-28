import type { LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { ModelUsage } from '@openharness/protocol'
import { FIXTURE_MODEL_USAGE } from '@openharness/protocol/fixtures'
import { MockLanguageModelV4 } from 'ai/test'

import type { ModelFactory } from '../model'

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
  /** Reject the request outright, as a provider failing before the stream opens. */
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

/** The text block the mock streams under; a real provider picks its own ids. */
const TEXT_ID = 'mock-text-1'

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
