import {
  EVENT_TYPES,
  type NamedCredentialType,
  type ProviderCredentialType,
  type ProviderId,
  type ReasoningEffort,
  type ReasoningEffortRun,
  type StoredEvent,
} from '@openharness/protocol'
import type { ProviderOptions } from './model'
import { providerOf } from './model'

/**
 * Reasoning effort: the three levels a session can ask for, and how each provider is asked.
 *
 * Every provider expresses "think harder" differently — a bare `reasoningEffort`, an Anthropic
 * `effort`, a Gemini thinking level, and, for the OpenAI-compatible clients, the raw
 * `reasoning_effort` body field — and the AI SDK surfaces each one under its own
 * `providerOptions` key. This module is the one place that mapping lives, so the rest of the
 * brain deals in `low | medium | high` and nothing else.
 *
 * **The effort is applied per request, not per session.** A request runs at the effort the log
 * asks for at that moment ({@link requestedReasoningEffort}) — the newest `user.message` that
 * carried one, exactly like the per-message model switch of #111 — and the request's span
 * records what was asked for beside what was applied. Since no effort has ever been stored on a
 * session, that record is the only durable statement of what a request ran with.
 *
 * **Which models take an effort is the host's to say.** This module used to decide it with a
 * hand-written pattern per provider, which rots with every model release — a new reasoning model
 * silently got no effort and a renamed one could be sent a level its API rejects. The gate is
 * now a resolver the host injects ({@link ReasoningSupportFor}), the same seam the context
 * budget's `tokenBudgetFor` uses, built from the registry the host already holds — the server's
 * models.dev snapshot (`apps/server/src/catalog/reasoning-support.ts`). What stays here is only
 * *how* each provider spells an effort and the clamp its own knob needs.
 */

/** The levels, weakest first: the order a clamp measures distance in. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ['low', 'medium', 'high']

/**
 * Which of the three levels a model takes, or `undefined` when the resolver does not know the
 * model at all — the host's answer for the model a request runs, asked once per request.
 *
 * The two negative answers differ, and keeping them apart is deliberate: `[]` is a model the
 * host knows takes no effort (a non-reasoning model, or one whose knob is a token budget rather
 * than a level), while `undefined` is a model the host knows nothing about — a custom URL, an
 * Azure deployment, a model a snapshot predates. Both leave the request on the provider's
 * default, which is the safe reading: every provider below sends the option straight through, and
 * one its API does not know is a **400** rather than an ignored parameter. A model wrongly left
 * out loses an optimization; one wrongly included loses the whole request.
 *
 * A host that injects no resolver is the same as one that knows no model: every request keeps
 * its provider's default. The server wires one (`createReasoningSupportResolver`).
 *
 * @param modelId the model id the request runs, `provider/model`
 * @param credentialType the credential the request is made with — its type is what says which
 *   models a named credential's deployment (`azure-eu/gpt-4o`) is looked up as, since the id's
 *   first half is the credential's *name* and not a provider id
 */
export type ReasoningSupportFor = (
  modelId: string,
  credentialType: ProviderCredentialType,
) => readonly ReasoningEffort[] | undefined

/**
 * One provider's reasoning: how the effort is spelled, and the clamp its own knob needs.
 *
 * There is no `supports` here any more — whether a model takes an effort is the injected
 * resolver's answer, not this table's.
 */
interface ProviderReasoning {
  /** The provider's own options for an effort, keyed the way its AI SDK client reads them. */
  readonly options: (effort: ReasoningEffort) => ProviderOptions
  /**
   * The level the provider actually runs at, when its own knob has fewer levels than ours.
   * Omitted by every provider that takes `low`/`medium`/`high` as they are.
   */
  readonly applied?: (effort: ReasoningEffort) => ReasoningEffort
}

/**
 * The providers a `provider/model` id may name and the option each one takes, keyed by the
 * shared provider id (`@openharness/protocol`, epic #245).
 *
 * Typed as a `Record<ProviderId, …>` on purpose: a provider the server can store a key for and
 * this table has no effort for is a compile error. The named credential types (#248 and later,
 * A3a–A3d) are the other half of that, and are keyed by type in
 * {@link CREDENTIAL_TYPE_REASONING}.
 *
 * Each option is the one that provider's installed AI SDK client reads — checked against
 * `@ai-sdk/anthropic@4.0.73`, `@ai-sdk/openai@4.0.85`, `@ai-sdk/google@4.0.89`,
 * `@ai-sdk/groq@4.0.56`, `@ai-sdk/deepseek@3.0.60`, `@ai-sdk/mistral@4.0.58`,
 * `@ai-sdk/xai@5.0.16`, `@ai-sdk/cerebras@3.0.64` and the `@ai-sdk/openai-compatible@3.0.64`
 * clients behind OpenRouter, Fireworks and Together.
 */
export const PROVIDER_REASONING: Readonly<Record<ProviderId, ProviderReasoning>> = {
  anthropic: {
    // `effort` is Anthropic's own adaptive-thinking knob and is the closest thing to our three
    // levels (`xhigh`/`max` exist above them and are never asked for). The alternative,
    // `thinking: { type: 'enabled', budgetTokens }`, needs a token budget that only means
    // anything relative to the model's own output limit.
    options: (effort) => ({ anthropic: { effort } }),
  },
  openai: {
    options: (effort) => ({ openai: { reasoningEffort: effort } }),
  },
  google: {
    // Gemini 3's thinking level is the effort knob; Gemini 2.5's is a token budget, which the
    // resolver's data leaves out, so such a model keeps its default.
    options: (effort) => ({ google: { thinkingConfig: { thinkingLevel: effort } } }),
  },
  openrouter: {
    // OpenRouter is a router, and used to get the effort for every model on the promise that it
    // maps or drops an unknown one. It follows the registry now like every other provider: that
    // promise was a hand-maintained assumption about a third party — the rot this change exists
    // to remove — and models.dev carries OpenRouter's own per-model effort options.
    options: (effort) => ({ openrouter: { reasoningEffort: effort } }),
  },
  groq: {
    options: (effort) => ({ groq: { reasoningEffort: effort } }),
  },
  deepseek: {
    // DeepSeek's knob is `low | high | max` — there is no `medium`, and `medium` runs at `high`,
    // which is the mapping `@ai-sdk/deepseek` itself applies.
    options: (effort) => ({ deepseek: { reasoningEffort: effort === 'medium' ? 'high' : effort } }),
    applied: (effort) => (effort === 'medium' ? 'high' : effort),
  },
  fireworks: {
    options: (effort) => ({ fireworks: { reasoningEffort: effort } }),
  },
  mistral: {
    // Mistral's knob is `none | high`: every level above the default runs at `high`, again the
    // mapping `@ai-sdk/mistral` applies.
    options: () => ({ mistral: { reasoningEffort: 'high' } }),
    applied: () => 'high',
  },
  together: {
    options: (effort) => ({ togetherai: { reasoningEffort: effort } }),
  },
  xai: {
    options: (effort) => ({ xai: { reasoningEffort: effort } }),
  },
  cerebras: {
    options: (effort) => ({ cerebras: { reasoningEffort: effort } }),
  },
}

/**
 * The named credential types and the option each one's client reads, keyed by the credential
 * **type** (epic #245, A3a).
 *
 * A named credential's model ids carry its *name* as the first half (`azure-eu/gpt-4o`), and a
 * name is the user's — `azure`, `azure-eu`, whatever they typed — so {@link PROVIDER_REASONING}
 * has no row for it. The type does: the request was built with a `ModelCredential`, its `type`
 * is what the server's model factory resolves the request by, and it is therefore what
 * says which client — and which options key — a named credential's model is asked with. Typed
 * as a `Record<NamedCredentialType, …>` for the same reason the provider table is typed against
 * `ProviderId`: a credential type the protocol grows without a row here is a compile error.
 */
export const CREDENTIAL_TYPE_REASONING: Readonly<Record<NamedCredentialType, ProviderReasoning>> = {
  azure_openai: {
    // `@ai-sdk/azure`'s chat model **is** `@ai-sdk/openai`'s under an Azure URL:
    // `createAzure(...).chat(id)` returns an `OpenAIChatLanguageModel` whose provider string is
    // `azure.chat`, and it reads its call options from `providerOptions.openai` — never
    // `providerOptions.azure`, which that model does not look at (checked against
    // `@ai-sdk/azure@4.0.97`). So an Azure deployment is asked for an effort exactly as an
    // OpenAI model is, and the option its client actually reads is the OpenAI one.
    options: (effort) => ({ openai: { reasoningEffort: effort } }),
  },
  openai_compatible: {
    // `createOpenAICompatible(...).chatModel(id)` reads its options from the canonical
    // `openaiCompatible` key — and, for compatibility, the deprecated `openai-compatible` and
    // the provider's own name — checked against `@ai-sdk/openai-compatible@3.0.64`. Its
    // `reasoningEffort` is the request body's `reasoning_effort`, the field the whole
    // OpenAI-compatible family carries, so one option covers every custom endpoint. Whether a
    // given endpoint's model takes one is the resolver's question and not this table's: a
    // custom URL has no models.dev entry, so an unknown deployment gets nothing (the safe
    // default), and a level is sent only where a host's resolver grants one.
    options: (effort) => ({ openaiCompatible: { reasoningEffort: effort } }),
  },
  bedrock: {
    // `createAmazonBedrock(...)(id)` reads `providerOptions.bedrock` (and, first, the
    // `amazonBedrock` alias), whose `reasoningConfig.maxReasoningEffort` it maps onto the right
    // vendor field for the model — Anthropic's `output_config.effort`, an OpenAI model's
    // `reasoning_effort`, the generic `reasoningConfig` — checked against
    // `@ai-sdk/amazon-bedrock@5.0.111`. Its levels are `low | medium | high | xhigh | max`, so
    // our three need no clamp.
    options: (effort) => ({ bedrock: { reasoningConfig: { maxReasoningEffort: effort } } }),
  },
}

/** What one model request does with the effort the log asked for. */
export interface ReasoningPlan {
  /** What the log asked for, or `null` when it asked for nothing. */
  readonly requested: ReasoningEffort | null
  /** What the request runs with, or `null` for the provider's default. */
  readonly applied: ReasoningEffort | null
  /** The `providerOptions` to stream with, or `undefined` when nothing is sent. */
  readonly providerOptions: ProviderOptions | undefined
  /** The `span.model_request_start` field, or `undefined` when nothing was asked for. */
  readonly record: ReasoningEffortRun | undefined
}

/** A plan for a request that asked for nothing: no option, and no span field. */
const NO_REASONING: ReasoningPlan = {
  requested: null,
  applied: null,
  providerOptions: undefined,
  record: undefined,
}

/**
 * What a request does with the effort the log asks for.
 *
 * The effort is sent only when the injected resolver says the model takes one; everything else
 * runs the provider's default and the plan says so (`applied: null`), which is what the span
 * records. A model id naming a provider this build has no client for is answered the same way:
 * the request will end as an unsupported provider before it is made, and there is nothing to
 * send an effort to. So is every model of a host that injected no resolver at all.
 *
 * When the resolver names the levels a model takes, the level the provider's own knob produced
 * is **clamped to them** — a `medium` asked of a model that only takes `low` and `high` is sent
 * as `high`, and a model that takes none of our levels at all is sent nothing — so an effort the
 * model does not accept is never the level put on the wire.
 *
 * @param modelId the model id the request runs, `provider/model`
 * @param credentialType the credential the request is made with. A fixed provider id's own row
 *   is chosen by the id's first half; anything else is a named credential, whose row is its
 *   *type*'s (`azure-eu` is an `azure_openai` credential, whatever the reader called it).
 * @param requested what the log asks for, or `null`
 * @param supportFor which levels the model takes, the host's answer — see
 *   {@link ReasoningSupportFor}; omitted means no model is known to take one
 */
export function planReasoning(
  modelId: string,
  credentialType: ProviderCredentialType,
  requested: ReasoningEffort | null,
  supportFor?: ReasoningSupportFor,
): ReasoningPlan {
  if (requested === null) {
    return NO_REASONING
  }
  const reasoning = reasoningFor(providerOf(modelId), credentialType)
  if (reasoning === undefined) {
    return unapplied(requested)
  }
  const supported = supportFor?.(modelId, credentialType)
  if (supported === undefined || supported.length === 0) {
    return unapplied(requested)
  }
  // The provider's own knob first — DeepSeek runs `medium` at `high` — then never a level the
  // model does not take: the two are one final level, which is what `applied` records and what
  // the options are built from.
  const applied = clampEffort(reasoning.applied?.(requested) ?? requested, supported)
  return {
    requested,
    applied,
    providerOptions: reasoning.options(applied),
    record: { requested, applied },
  }
}

/**
 * The level to send: `requested` when the model takes it, otherwise the nearest level it does.
 *
 * Walked weakest-first over our own order, taking the later level on a tie, so a model that
 * accepts `low` and `high` runs a requested `medium` at `high` — the same reading DeepSeek's own
 * client gives the level it cannot spell. `supported` never reaches here empty (the caller treats
 * an empty answer as "takes none"), and its levels are our three by construction, so there is
 * always one to pick.
 *
 * @param requested the level the provider's knob mapped the request to
 * @param supported the levels the model takes, in any order
 */
function clampEffort(
  requested: ReasoningEffort,
  supported: readonly ReasoningEffort[],
): ReasoningEffort {
  const target = EFFORT_ORDER.indexOf(requested)
  const distance = (level: ReasoningEffort): number =>
    Math.abs(EFFORT_ORDER.indexOf(level) - target)
  let closest: ReasoningEffort | null = null
  for (const level of EFFORT_ORDER) {
    if (supported.includes(level) && (closest === null || distance(level) <= distance(closest))) {
      closest = level
    }
  }
  // Unreachable for a resolver that answers in our three levels, which its type promises; the
  // requested level is the honest fallback for one that does not.
  return closest ?? requested
}

/** A plan for an effort this model does not take: asked for, not applied, nothing sent. */
function unapplied(requested: ReasoningEffort): ReasoningPlan {
  return {
    requested,
    applied: null,
    providerOptions: undefined,
    record: { requested, applied: null },
  }
}

/**
 * The row for a request's model, or `undefined` for one this build has no effort for.
 *
 * A fixed provider id is its own row. Anything else names a credential — `azure-eu`, not
 * `azure_openai` — so the row is the credential's **type**'s, which is the fact a request is
 * actually built with and the only one that can name a knob for a name the reader chose.
 */
function reasoningFor(
  provider: string,
  credentialType: ProviderCredentialType,
): ProviderReasoning | undefined {
  // `Object.hasOwn`, not a bare index: a `provider/model` whose first half names an inherited
  // property (`toString`, `constructor`) is a provider with no row, not a row.
  if (Object.hasOwn(PROVIDER_REASONING, provider)) {
    return PROVIDER_REASONING[provider as ProviderId]
  }
  return Object.hasOwn(CREDENTIAL_TYPE_REASONING, credentialType)
    ? CREDENTIAL_TYPE_REASONING[credentialType as NamedCredentialType]
    : undefined
}

/**
 * The effort this log asks the next request to run with.
 *
 * The newest `user.message` that carried one wins — the same "from this message on" reading as
 * the model switch of #111, and the same message an answer is made from, since the brain asks
 * this question at each request boundary. A message that carried an explicit `null` asks for the
 * provider's default again, and one that carried nothing leaves whatever was in effect alone; a
 * log no message of which ever named an effort answers `null`, which is what keeps a session
 * stored before #252 unchanged.
 *
 * @param events the log, as `readLog` handed it over — the replay read, so a message an edit or
 *   a rewind took back is already gone
 */
export function requestedReasoningEffort(events: readonly StoredEvent[]): ReasoningEffort | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (
      event !== undefined &&
      event.type === EVENT_TYPES.userMessage &&
      event.reasoning_effort !== undefined
    ) {
      return event.reasoning_effort
    }
  }
  return null
}
