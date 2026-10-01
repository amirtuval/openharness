import type { ModelUsage } from '@openharness/protocol'
import { ModelRouterLanguageModel } from '@mastra/core/llm'
import type { LanguageModel, ModelMessage } from 'ai'
import { streamText } from 'ai'

import { isOwnershipError } from './errors'

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

/** How deep a `{ total }` chain is followed before a value is called unreadable. */
const MAX_USAGE_DEPTH = 3

/** A value as a string-keyed record, or `null` when it is not an object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * A value as a count the protocol accepts — a non-negative integer — or `undefined` when it
 * carries no number at all. A numeric string counts: it is a count that arrived spelled out,
 * not one that was lost.
 */
function asCount(value: unknown): number | undefined {
  const spelled = typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined
  const count = typeof value === 'number' ? value : spelled
  return count !== undefined && Number.isFinite(count) ? Math.max(0, Math.round(count)) : undefined
}

/**
 * A usage report's count, wherever the report put it.
 *
 * A model that obeys the spec it declares reports `inputTokens: 10`. A model that does not —
 * Mastra's router declares the `v2` provider spec and streams v3-shaped usage — reports the
 * count one `total` down instead (`{ total: 10, noCache: 10, … }`), and the AI SDK's
 * compatibility layer for the spec it declared wraps that object again, so the count can sit
 * two `total`s down. Both arrive here as the usage object itself; the count is inside it.
 */
function countOf(value: unknown, depth = 0): number | undefined {
  const count = asCount(value)
  if (count !== undefined) {
    return count
  }
  const record = asRecord(value)
  if (record === null || depth >= MAX_USAGE_DEPTH) {
    return undefined
  }
  return countOf(record.total, depth + 1)
}

/**
 * The first readable `field` on a usage value, or on the usage values nested under its `total`s.
 *
 * This is how the cache counters survive the same mis-declaration: the SDK reads them from the
 * v2 field names (`cachedInputTokens`) that a v3-shaped report does not have, so the breakdown
 * a v2-declared model reports is only findable inside the usage object it sent.
 */
function detailOf(value: unknown, field: string, depth = 0): number | undefined {
  const record = asRecord(value)
  if (record === null || depth >= MAX_USAGE_DEPTH) {
    return undefined
  }
  return asCount(record[field]) ?? detailOf(record.total, field, depth + 1)
}

/** How one model request is made. */
export interface ModelRequestParams {
  /** The model to stream from, already resolved by the factory. */
  readonly model: LanguageModel
  /** The messages to send, system prompt included; see `ContextStrategy`. */
  readonly messages: readonly ModelMessage[]
  /** Aborting this ends the request early; the partial text is still in the result. */
  readonly signal?: AbortSignal
  /**
   * Called with each text chunk as it arrives, and awaited: the loop stores the chunk before
   * the next one is pulled, so a store refusal surfaces here rather than being swallowed.
   */
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
  const stepUsages: ModelUsage[] = []
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
      } else if (part.type === 'finish-step') {
        // The model's own report for one step, read as it arrives: the SDK's `result.usage`
        // below is an *accumulation* over these, and a mis-declared provider spec corrupts it
        // past recovery — the totals are only still numbers here (see `toModelUsage`).
        stepUsages.push(toModelUsage(part.usage))
      }
    }
  } catch (error) {
    // A write the store refused is not a model failure and must not be retried as one: it means
    // another owner has taken the partition over — or claimed the events this request answers —
    // and the loop has to stop right here. Deltas are appended from `onTextDelta`, so a refusal
    // inside the stream surfaces here.
    if (isOwnershipError(error)) {
      throw error
    }
    failures.push(error)
  }

  if (aborted || params.signal?.aborted === true) {
    return { text, usage: ZERO_MODEL_USAGE, error: undefined, aborted: true }
  }
  const failure = failures[0]
  if (failure !== undefined) {
    if (isOwnershipError(failure)) {
      throw failure
    }
    return { text, usage: ZERO_MODEL_USAGE, error: failure, aborted: false }
  }
  const usage =
    stepUsages.length === 0
      ? // No step reported anything (a model that streams text without usage), so the SDK's
        // total is the only report there is.
        toModelUsage(await result.usage)
      : stepUsages.reduce(addModelUsage)
  return { text, usage, error: undefined, aborted: false }
}

/**
 * The protocol's token counts for an AI SDK usage report.
 *
 * The protocol keeps Anthropic's four counters; the AI SDK reports totals plus a breakdown.
 * The two cache counters are the breakdown's read and write halves, so the numbers add up the
 * same way on both sides of the boundary.
 *
 * Takes `unknown` because the report that actually arrives is not always the shape its type
 * promises. A model whose declared provider spec is older than the usage it emits — Mastra's
 * router, which says `v2` and streams v3-shaped usage — has that usage reshaped by the SDK's
 * compatibility layer into something no counter can be read off directly, and a request that
 * accumulates such a report ends up with a *string* where the number was (issue #39). The
 * protocol's schema is right to demand integers, so the count is recovered here, from wherever
 * in the report it survived; a value that carries none is `0`, never a value the log would
 * reject. The counters are the ones the request really spent, which is why the caller hands
 * over the model's own step report rather than the SDK's accumulated total.
 *
 * @param usage what the request reported, in whatever shape it arrived
 */
export function toModelUsage(usage: unknown): ModelUsage {
  const report = asRecord(usage) ?? {}
  const details = asRecord(report.inputTokenDetails) ?? {}
  const input = report.inputTokens
  return {
    input_tokens: countOf(input) ?? 0,
    output_tokens: countOf(report.outputTokens) ?? 0,
    cache_read_input_tokens:
      detailOf(details, 'cacheReadTokens') ?? detailOf(input, 'cacheRead') ?? 0,
    cache_creation_input_tokens:
      detailOf(details, 'cacheWriteTokens') ?? detailOf(input, 'cacheWrite') ?? 0,
  }
}

/** One request's counters, step by step: every step of a request is spent inside the same span. */
function addModelUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cache_read_input_tokens: left.cache_read_input_tokens + right.cache_read_input_tokens,
    cache_creation_input_tokens:
      left.cache_creation_input_tokens + right.cache_creation_input_tokens,
  }
}
