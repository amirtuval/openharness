import type { ModelUsage } from '@openharness/protocol'
import { ModelRouterLanguageModel } from '@mastra/core/llm'
import type { LanguageModel, ModelMessage } from 'ai'
import { streamText } from 'ai'

import { isOwnershipError } from './errors'

/**
 * Making a model request, and the seam that keeps the brain testable.
 *
 * The brain never constructs a provider client, and it never reads a provider credential from
 * the environment: the credential is handed to it per request (see {@link ResolveCredential},
 * epic #65 A5), and it passes it to a {@link ModelFactory} together with the id the session
 * carries (`provider/model`, what the protocol calls a Mastra model-router string). Streaming
 * happens through {@link streamModelRequest}. A test injects a factory that hands back one of
 * the AI SDK's mock models, so the whole turn loop runs with no API keys and no network.
 */

/**
 * The credential one model request is made with — the session owner's own provider key.
 *
 * Today a model authenticates with a single API key, which is all {@link routerModelFactory}
 * forwards to Mastra's router. It is held for exactly one request: the turn resolves it before
 * the request, builds the model with it, and lets it go when the request ends.
 */
export interface ModelCredential {
  /** The provider's API key. Passed to the provider explicitly; never read from the environment. */
  readonly apiKey: string
}

/**
 * Where the credential for one model request comes from.
 *
 * Called once per model request with the provider — the part of the session's
 * `model.id` before the slash, as {@link providerOf} reads it — and awaited before the
 * request is made. A host supplies it (the server decodes the session owner's stored
 * credential; #61); `null` means the owner has none for that provider, and the request is then
 * never attempted: the turn ends with a non-retryable `missing_provider_credential` error
 * instead of falling back to a key of its own.
 */
export type ResolveCredential = (provider: string) => Promise<ModelCredential | null>

/**
 * The model for a session's `model.id`, made with the credential the request runs under.
 *
 * The default is {@link routerModelFactory}, which resolves the router string the protocol
 * stores. A host that wants its own provider setup — a different gateway, a fixed model, a
 * fake in a test — passes its own factory instead; a factory that needs no credential (a mock
 * model) ignores the second argument.
 */
export type ModelFactory = (modelId: string, credential: ModelCredential) => LanguageModel

/**
 * The default {@link ModelFactory}: Mastra's model router.
 *
 * `provider/model` is what the protocol documents for a session's `model.id`, and Mastra's router is
 * the thing that turns that string into a language model. The API key is passed **explicitly**
 * in the router's config, and that is the whole of A5's "no environment fallback": Mastra's
 * `resolveAuth()` returns a config-supplied key as-is (`source: 'explicit'`) without ever
 * consulting the gateway that would read `OPENAI_API_KEY` and friends, so an explicit key
 * cannot be overridden and the environment is not read. The key must be non-blank — the router
 * treats a falsy `apiKey` as "none given" and falls back to that gateway — which is why
 * `runTurn` checks it with {@link isUsableCredential} before it ever gets here.
 *
 * The cast is because the router's `doGenerate` is declared with Mastra's wrapped signature
 * while its `doStream` is the AI SDK's; this package only streams, which is the shape
 * `streamText` consumes as declared.
 *
 * @param modelId a router string, `provider/model`
 * @param credential the key this one request authenticates with
 */
export const routerModelFactory: ModelFactory = (modelId, credential) =>
  new ModelRouterLanguageModel({
    // The protocol documents `provider/model`, which is what the router's `id` is; the cast
    // is the template-literal type it spells that with.
    id: modelId as `${string}/${string}`,
    apiKey: credential.apiKey,
  }) as unknown as LanguageModel

/**
 * The provider of a `provider/model` id: the part before the first slash.
 *
 * This is the key {@link ResolveCredential} is asked for — the same provider id Mastra's
 * router uses. An id with no slash is its own provider, so a stray config cannot silently
 * resolve somebody else's credential.
 *
 * @param modelId the session's `model.id`
 */
export function providerOf(modelId: string): string {
  const slash = modelId.indexOf('/')
  return slash === -1 ? modelId : modelId.slice(0, slash)
}

/**
 * Whether a resolved credential can authenticate a request.
 *
 * `null` means the owner has no credential for the provider. A blank key counts as none as
 * well: it must never reach {@link routerModelFactory}, because Mastra's router reads a falsy
 * `apiKey` as "no key given" and falls back to the environment — the fallback epic #65 (A5)
 * forbids. So everything that is not a usable key ends the request the same way.
 *
 * @param credential what {@link ResolveCredential} answered
 */
export function isUsableCredential(
  credential: ModelCredential | null,
): credential is ModelCredential {
  return credential !== null && credential.apiKey.trim().length > 0
}

/** How a provider id is spelled for a person: the ones we know, by their own capitalisation. */
const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  google: 'Google',
  groq: 'Groq',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

/**
 * What the log says when a request had no credential to make: a sentence for the user, naming
 * the provider so a client can point at the right Settings entry (epic #65, A5).
 *
 * @param provider the provider id, as {@link providerOf} read it
 */
export function missingCredentialMessage(provider: string): string {
  const name = PROVIDER_DISPLAY_NAMES[provider] ?? capitalize(provider)
  return `No ${name} key is set. Add one in Settings → Model providers.`
}

/** A provider id as a name: `mistral` → `Mistral`. */
function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1)
}

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
    // an SDK-level retry would silently skip — so the SDK must not retry underneath it. In
    // `ai@7` two options control retries, and only the second is about streaming:
    // - `maxRetries` bounds the provider retries of one model call and defaults to 2, so it
    //   must be 0: left at the default, one failure makes up to three provider calls the loop
    //   never sees, and what the loop does see is an `AI_RetryError` wrapper around the
    //   provider's error rather than the error itself.
    // - `streamRetries` bounds only provider errors received *after* streaming has started;
    //   its default is already 0 (disabled when omitted). It is kept explicit so a changed
    //   default cannot re-enable those retries. `onError` here never returns `{ retry: true }`,
    //   the one way a stream error could still be retried with this set.
    maxRetries: 0,
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
