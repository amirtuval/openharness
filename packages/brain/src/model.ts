import type { ModelUsage } from '@openharness/protocol'
import { ModelRouterLanguageModel } from '@mastra/core/llm'
import type { LanguageModel, LanguageModelUsage, ModelMessage } from 'ai'
import { streamText } from 'ai'
import { isFencedError } from '@openharness/session'

/**
 * Making a model request, and the seam that keeps the brain testable.
 *
 * The brain never constructs a provider client. It asks a {@link ModelFactory} for a model by
 * the id the session carries (`provider/model`, what the protocol calls a Mastra model-router
 * string), and streams through {@link streamModelRequest}. A test injects a factory that hands
 * back one of the AI SDK's mock models, so the whole turn loop runs with no API keys and no
 * network.
 */

/**
 * The model for a session's `agent.model.id`, from the id alone.
 *
 * The default is {@link routerModelFactory}, which resolves the router string the protocol
 * stores. A host that wants its own provider setup — a different gateway, a fixed model, a
 * fake in a test — passes its own factory instead.
 */
export type ModelFactory = (modelId: string) => LanguageModel

/**
 * The default {@link ModelFactory}: Mastra's model router.
 *
 * `provider/model` is what the protocol documents for `agent.model.id`, and Mastra's router is
 * the thing that turns that string into a language model — including the provider-specific
 * authentication a model needs. The cast is because the router's `doGenerate` is declared with
 * Mastra's wrapped signature while its `doStream` is the AI SDK's; this package only streams,
 * which is the shape `streamText` consumes as declared.
 *
 * @param modelId a router string, `provider/model`
 */
export const routerModelFactory: ModelFactory = (modelId) =>
  new ModelRouterLanguageModel(modelId) as unknown as LanguageModel

/** Token counts for a request that never produced any: the AI SDK reports nothing to map. */
export const ZERO_MODEL_USAGE: ModelUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

/** How one model request is made. */
export interface ModelRequestParams {
  /** The model to stream from, already resolved by the factory. */
  readonly model: LanguageModel
  /** The messages to send, system prompt included; see `ContextStrategy`. */
  readonly messages: readonly ModelMessage[]
  /** Aborting this ends the request early; the partial text is still in the result. */
  readonly signal?: AbortSignal
  /** Called with each text chunk as it arrives, to publish the live preview. */
  readonly onTextDelta?: (text: string) => Promise<void> | void
}

/**
 * What a model request produced, however it ended.
 *
 * It answers rather than throws — including for a failure — because all three endings lead
 * back into the turn loop as events, and a `catch` at each call site would only be a second
 * place that has to know about aborting.
 */
export interface ModelRequestResult {
  /** The text streamed so far. Kept on abort; dropped by the caller on failure. */
  readonly text: string
  /** Token counts, or {@link ZERO_MODEL_USAGE} when the request never reported any. */
  readonly usage: ModelUsage
  /** Why the request failed, or `undefined` when it succeeded. */
  readonly error: unknown
  /** Whether the request was cut short by `signal`. */
  readonly aborted: boolean
}

/**
 * Stream one model request.
 *
 * Text arrives as AI SDK stream parts; a provider failure arrives as an `error` part (the SDK
 * reports it through `onError` and keeps the stream alive, so it is captured there and reported
 * once, after the stream ends). An abort ends the stream with an `abort` part, and the partial
 * text is kept — the turn loop stores it.
 */
export async function streamModelRequest(params: ModelRequestParams): Promise<ModelRequestResult> {
  const failures: unknown[] = []
  let aborted = false
  let text = ''
  const result = streamText({
    model: params.model,
    messages: [...params.messages],
    abortSignal: params.signal,
    // The context strategy puts the session's system prompt in `messages`, which is where the
    // loop hands it over; the AI SDK otherwise warns about a system message there.
    allowSystemInMessages: true,
    // The turn loop owns retries — it writes the `session.error` and `session.status_*` events
    // an SDK-level retry would silently skip — so the SDK must not retry underneath it.
    streamRetries: 0,
    onError: ({ error }) => {
      failures.push(error)
    },
  })
  try {
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        text += part.text
        await params.onTextDelta?.(part.text)
      } else if (part.type === 'abort') {
        aborted = true
      }
    }
  } catch (error) {
    // A write the store refused is not a model failure and must not be retried as one: it means
    // another owner has taken the partition over, and the loop has to stop right here.
    if (isFencedError(error)) {
      throw error
    }
    failures.push(error)
  }

  if (aborted || params.signal?.aborted === true) {
    return { text, usage: ZERO_MODEL_USAGE, error: undefined, aborted: true }
  }
  const failure = failures[0]
  if (failure !== undefined) {
    if (isFencedError(failure)) {
      throw failure
    }
    return { text, usage: ZERO_MODEL_USAGE, error: failure, aborted: false }
  }
  return { text, usage: toModelUsage(await result.usage), error: undefined, aborted: false }
}

/**
 * The protocol's token counts for an AI SDK usage report.
 *
 * The protocol keeps Anthropic's four counters; the AI SDK reports totals plus a breakdown.
 * The two cache counters are the breakdown's read and write halves, so the numbers add up the
 * same way on both sides of the boundary.
 */
export function toModelUsage(usage: LanguageModelUsage): ModelUsage {
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cache_read_input_tokens: usage.inputTokenDetails.cacheReadTokens ?? 0,
    cache_creation_input_tokens: usage.inputTokenDetails.cacheWriteTokens ?? 0,
  }
}
