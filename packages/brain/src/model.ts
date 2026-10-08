import type { ModelUsage } from '@openharness/protocol'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createCerebras } from '@ai-sdk/cerebras'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createFireworks } from '@ai-sdk/fireworks'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createGroq } from '@ai-sdk/groq'
import { createMistral } from '@ai-sdk/mistral'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createTogetherAI } from '@ai-sdk/togetherai'
import { createXai } from '@ai-sdk/xai'
import type { LanguageModel, ModelMessage } from 'ai'
import { streamText } from 'ai'

import { isOwnershipError } from './errors'

/**
 * Making a model request, and the seam that keeps the brain testable.
 *
 * The brain never reads a provider credential from the environment: the credential is handed
 * to it per request (see {@link ResolveCredential}, epic #65 A5), and it passes it to a
 * {@link ModelFactory} together with the id the session carries (`provider/model`, what the
 * protocol calls a model id). Streaming happens through {@link streamModelRequest}. A test
 * injects a factory that hands back one of the AI SDK's mock models, so the whole turn loop
 * runs with no API keys and no network.
 */

/**
 * The credential one model request is made with — the session owner's own provider key.
 *
 * A model authenticates with a single API key, which is all {@link providerModelFactory}
 * passes to the provider. It is held for exactly one request: the turn resolves it before the
 * request, builds the model with it, and lets it go when the request ends.
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
 * The default is {@link providerModelFactory}, which resolves the `provider/model` id the
 * protocol stores. A host that wants its own provider setup — a different gateway, a fixed
 * model, a fake in a test — passes its own factory instead; a factory that needs no credential
 * (a mock model) ignores the second argument.
 */
export type ModelFactory = (modelId: string, credential: ModelCredential) => LanguageModel

/** What one provider is: where its API lives, and how a client for it is built. */
interface ProviderClient {
  /**
   * The provider's API base URL, pinned.
   *
   * Every AI SDK provider has a `*_BASE_URL` environment variable it falls back to when a
   * constructor options object leaves the setting out, and a request built from the environment
   * is exactly what epic #65 (A5) forbids: a deployment could redirect — an endpoint, and with
   * it a key — to somewhere nobody chose. So the URL is passed explicitly here, in the one
   * place a `provider/model` becomes a client, and the environment cannot move a request at
   * all. The values are the providers' own defaults, which is what the router these replace
   * resolved too (the mapping is in the pull request for #234).
   */
  readonly baseURL: string
  /**
   * The client's model constructor, given the request's key and the pinned base URL. Two of
   * these are the Responses API rather than the chat one (see {@link providerModelFactory});
   * otherwise this is the provider package's own factory function.
   */
  readonly model: (options: {
    readonly apiKey: string
    readonly baseURL: string
  }) => (id: string) => LanguageModel
}

/**
 * The providers a `provider/model` id may name, and the client each one is built with.
 *
 * **This table is the brain's copy of `VALIDATABLE_PROVIDERS`** (`apps/server`'s). They have to
 * agree — a provider a key can be saved for must be one a request can be made to — and the
 * server's `model-catalog.test.ts` pins that they do.
 */
const PROVIDERS: Readonly<Record<string, ProviderClient>> = {
  anthropic: {
    baseURL: 'https://api.anthropic.com/v1',
    model: (options) => createAnthropic(options),
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: (options) => (id) => createOpenAI(options).responses(id),
  },
  google: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    model: (options) => createGoogleGenerativeAI(options),
  },
  // OpenRouter has no first-party AI SDK package in this tree; `@ai-sdk/openai-compatible` at
  // OpenRouter's base URL is the official package for exactly this API, says the same thing to
  // OpenRouter that the old router's bundled client did, and is already a dependency of the
  // Fireworks, Together and Cerebras clients below.
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    model: (options) => (id) =>
      createOpenAICompatible({ name: 'openrouter', ...options }).chatModel(id),
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    model: (options) => createGroq(options),
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    model: (options) => createDeepSeek(options),
  },
  fireworks: {
    baseURL: 'https://api.fireworks.ai/inference/v1',
    model: (options) => createFireworks(options),
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    model: (options) => createMistral(options),
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    model: (options) => createTogetherAI(options),
  },
  xai: {
    baseURL: 'https://api.x.ai/v1',
    model: (options) => (id) => createXai(options).responses(id),
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    model: (options) => createCerebras(options),
  },
}

/**
 * Every provider id {@link providerModelFactory} can build a model for, in table order.
 *
 * The same 11 ids as `VALIDATABLE_PROVIDERS`, and the same set the client's model picker
 * offers. Exported so a host can check its own list against it rather than restate it.
 */
export const SUPPORTED_PROVIDERS: readonly string[] = Object.keys(PROVIDERS)

/**
 * A `provider/model` id naming a provider this build has no client for.
 *
 * A provider outside {@link PROVIDERS} cannot have a credential stored (the server refuses one
 * it cannot validate), so the only way here is a session whose `model.id` names a provider
 * nobody configured — and the turn ends on it at the request boundary, the way a missing
 * credential does, rather than reaching a provider it could not authenticate to.
 */
export class UnsupportedProviderError extends Error {
  /** The provider id, as {@link providerOf} read it. */
  readonly provider: string

  constructor(provider: string) {
    super(
      `no model client for provider ${JSON.stringify(provider)}; supported: ` +
        SUPPORTED_PROVIDERS.join(', '),
    )
    this.name = 'UnsupportedProviderError'
    this.provider = provider
  }
}

/**
 * Whether `value` is the {@link UnsupportedProviderError} this module raises.
 *
 * `instanceof` first, then the stable `name`, the same way `errors.ts` recognises a store
 * error: the class is raised here and caught by the turn loop, but a second copy of this
 * package would throw its own.
 */
export function isUnsupportedProviderError(value: unknown): value is UnsupportedProviderError {
  if (value instanceof UnsupportedProviderError) {
    return true
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate: Partial<UnsupportedProviderError> = value
  return candidate.name === 'UnsupportedProviderError' && typeof candidate.provider === 'string'
}

/**
 * The default {@link ModelFactory}: one official AI SDK provider per `provider/model` prefix.
 *
 * `provider/model` is what the protocol documents for a session's `model.id`, and the part
 * before the first slash chooses the client — `@ai-sdk/anthropic`, `@ai-sdk/openai`,
 * `@ai-sdk/google` and the rest of {@link PROVIDERS} — built with the request's key and the
 * pinned base URL. The key is a **constructor argument** and nothing else: the provider
 * packages read their `*_API_KEY` variable only when they were given no key, so a request with
 * an explicit one can never fall back to the environment (epic #65, A5). The key still has to
 * be non-blank for that reason — `isUsableCredential` checks it before `runTurn` gets this far,
 * so a blank key ends the turn instead of quietly becoming "no key given".
 *
 * Two providers use the **Responses API** rather than the chat one, because that is what the
 * router these replace resolved for them: OpenAI (`openai.responses(id)`) and xAI
 * (`xai.responses(id)`). Every other provider is a chat-completions client.
 *
 * No `maxRetries`/`streamRetries` is configured here, because a provider client has neither:
 * both options live on the `streamText` call in {@link streamModelRequest}, which is the only
 * thing this package streams through (issue #117).
 *
 * @param modelId a model id, `provider/model`
 * @param credential the key this one request authenticates with
 * @throws UnsupportedProviderError when the id names a provider with no client here
 */
export const providerModelFactory: ModelFactory = (modelId, credential) => {
  const provider = providerOf(modelId)
  const client = PROVIDERS[provider]
  if (client === undefined) {
    throw new UnsupportedProviderError(provider)
  }
  // Everything after the first slash: the provider's own id for the model. A fireworks or
  // OpenRouter id carries slashes of its own, which is why this is not `split('/')[1]`.
  const id = modelId.slice(provider.length + 1)
  return client.model({ apiKey: credential.apiKey, baseURL: client.baseURL })(id)
}

/**
 * The provider of a `provider/model` id: the part before the first slash.
 *
 * This is the key {@link ResolveCredential} is asked for — the same provider id the
 * credential's own provider field carries. An id with no slash is its own provider, so a
 * stray config cannot silently resolve somebody else's credential.
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
 * well, and that is not a formality: every provider in {@link providerModelFactory} reads its
 * own `*_API_KEY` environment variable when the key it was constructed with is falsy, so a
 * blank key would silently become "no key given" and hand the request to whatever the process
 * happens to have set — the fallback epic #65 (A5) forbids. So everything that is not a
 * usable key ends the request the same way.
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
 * Every provider in {@link providerModelFactory} declares the spec it implements, so a report
 * arrives as the numbers the protocol wants (`inputTokens: 10`). A report that does not — a
 * provider whose declaration and payload disagree, or one that reports the count one `total`
 * down (`{ total: 10, noCache: 10, … }`) — is still read: the count is looked for inside the
 * value as well as on it. Nothing else has to know which shape arrived.
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
 * This is how the cache counters survive the same mismatch: a report that puts its breakdown
 * inside the usage object rather than beside it (`{ inputTokens: { total, cacheRead, … } }`,
 * the shape `countOf` also has to read through) is only findable inside it.
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
        // below is an *accumulation* over these, so a step is the most truthful place to read
        // the counts from — each one is what the provider reported, not a sum this process
        // built.
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
 * promises — an `ai` version and a provider package that disagree about the provider spec
 * would reshape it on the way through, and the counters the protocol needs would be inside an
 * object where a number belongs. The providers this package builds declare the spec they
 * implement, so that cannot happen today; reading the count wherever it survived costs
 * nothing and is what keeps a bad pairing from shipping the unreadable totals of issue #39
 * instead of an error. The protocol's schema is right to demand integers, so a value that
 * carries no count is `0`, never a value the log would reject. The counters are the ones the
 * request really spent, which is why the caller hands over the model's own step report rather
 * than the SDK's accumulated total.
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
