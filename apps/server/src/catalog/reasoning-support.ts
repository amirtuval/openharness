import type { ReasoningSupportFor } from '@openharness/brain'
import {
  credentialTypeInfo,
  PROVIDER_IDS,
  type ProviderCredentialType,
  type ReasoningEffort,
} from '@openharness/protocol'

import { bedrockUnderlyingModelId } from './bedrock-profiles'
import type { ModelRegistry, RegistryModel } from './registry'

/**
 * Which reasoning efforts a model takes, per model (#252's follow-up).
 *
 * The brain used to decide this itself, with a hand-written pattern per provider, which rots
 * with every model release: a new reasoning model silently got no effort and a renamed one could
 * be sent a level its API rejects with a 400. The gate is now a resolver the host injects into
 * the brain — the same seam #246 introduced for the context budget — and this is the server's,
 * built from the registry the catalogue already joins for context windows and prices.
 *
 * ## The rule
 *
 * ```
 * efforts = { low, medium, high } ∩ models.dev's effort levels for the model
 * ```
 *
 * models.dev marks a model's reasoning knob with `reasoning_options`; only an
 * `{ type: 'effort', values: [...] }` option is an effort knob, and its `values` are the levels
 * the provider's own API takes — `low`/`medium`/`high` for most, and the values above and below
 * them (`minimal`, `none`, `xhigh`, `max`) that our three never name. The intersection is what a
 * request may ask for; a level outside it is clamped to the nearest the model takes, in the
 * brain (`planReasoning`). A model whose knob is a token budget or a plain toggle is not an
 * effort model however reasoning-capable it is, and carries no `efforts` — the same answer as a
 * non-reasoning model: nothing sent, the provider's default kept.
 *
 * ## A resolver, not a record
 *
 * {@link createReasoningSupportResolver} answers with a function, `(modelId) => levels`, rather
 * than a `Record<modelId, levels>`: the registry holds hundreds of models per snapshot and the
 * snapshot is refreshed wholesale, so a record would mean enumerating all of it to answer for the
 * one id a request runs (the same argument as `createTokenBudgetResolver`). The lookup is a
 * `find` over the one provider's list.
 */

/** Our three levels, weakest first — the vocabulary a resolver's answer is drawn from. */
const OUR_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

/**
 * The per-model reasoning resolver the server hands the brain as
 * `RunTurnOptions.reasoningSupportFor`.
 *
 * A `provider/model` id is split on its first slash (the split a `provider/model` id has — see
 * `providerOf`), and the model is looked up in the registry's list for that provider. A Bedrock
 * **cross-region inference profile** id that the registry has not itself filed is looked up by
 * the foundation model it wraps ({@link findModel}); its reasoning knob is that model's (issue
 * #274).
 *
 * `undefined` is a real answer, not a failure: the registry knows nothing about this id — an
 * unknown provider, a model the snapshot predates, or a free-text id a host accepts (C5) — and
 * the caller reads that as "unknown", which leaves the request on the provider's default, exactly
 * as a model the registry knows takes no effort does. `[]` is the model the registry does know
 * and that takes none: no effort knob, or an effort vocabulary that shares no level with ours.
 *
 * @param registry where the metadata comes from — the bundled models.dev snapshot in production
 */
export function createReasoningSupportResolver(registry: ModelRegistry): ReasoningSupportFor {
  return (modelId, credentialType) => {
    const separator = modelId.indexOf('/')
    if (separator <= 0 || separator === modelId.length - 1) {
      return undefined
    }
    const provider = modelId.slice(0, separator)
    const id = modelId.slice(separator + 1)
    const key = registryKeyFor(provider, credentialType)
    if (key === undefined) {
      return undefined
    }
    const model = findModel(registry, key, id, credentialType)
    if (model === undefined) {
      return undefined
    }
    return OUR_EFFORTS.filter((level) => model.efforts?.includes(level) ?? false)
  }
}

/**
 * The registry's entry for a model id, with one fallback: a **Bedrock cross-region inference
 * profile** is looked up by the foundation model it wraps when its own id is not filed.
 *
 * A profile's model id (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) is geography-scoped —
 * and an application profile's is account-scoped — so models.dev may not have that exact id
 * even though it files the model underneath it. The profile's reasoning knob is the wrapped
 * model's, and `bedrockUnderlyingModelId` is the one place that turns the first into the
 * second. The fallback is guarded to the `bedrock` credential type for that reason: stripping a
 * geography prefix off some other provider's id would be turning one model into another.
 */
function findModel(
  registry: ModelRegistry,
  key: string,
  id: string,
  credentialType: ProviderCredentialType,
): RegistryModel | undefined {
  const models = registry.models(key)
  const exact = models.find((entry) => entry.id === id)
  if (exact !== undefined || credentialType !== 'bedrock') {
    return exact
  }
  const underlying = bedrockUnderlyingModelId(id)
  return underlying === undefined ? undefined : models.find((entry) => entry.id === underlying)
}

/**
 * The snapshot key a `provider/model` id reads its model under.
 *
 * A fixed provider id is its own key — the snapshot is keyed by **our** ids. Anything else is a
 * **named credential**, and its first half is the name the reader chose (`azure-eu`), which the
 * snapshot has never heard of: its models are filed under the credential *type*'s models.dev key
 * (`azure`, `amazon-bedrock`), which is the same mapping the catalogue borrows a deployment's
 * window and price with (`credentialTypeInfo`, epic #245 A3a). A type with no models.dev key —
 * the OpenAI-compatible custom URL, which is a host the reader typed — has no entry to read and
 * answers nothing, as does an `api_key` credential under a name no provider carries.
 *
 * @param provider the id's first half: a provider id, or a named credential's name
 * @param credentialType what the request is made with — the fact that says which key a name reads
 */
function registryKeyFor(
  provider: string,
  credentialType: ProviderCredentialType,
): string | undefined {
  if ((PROVIDER_IDS as readonly string[]).includes(provider)) {
    return provider
  }
  return credentialTypeInfo(credentialType)?.modelsDevKey
}
