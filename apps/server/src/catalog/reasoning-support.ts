import type { ReasoningEffort } from '@openharness/protocol'

import type { ModelRegistry } from './registry'

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
 * `providerOf`), and the model is looked up in the registry's list for that provider.
 *
 * `undefined` is a real answer, not a failure: the registry knows nothing about this id — an
 * unknown provider, a model the snapshot predates, or a free-text id a host accepts (C5) — and
 * the caller reads that as "unknown", which leaves the request on the provider's default, exactly
 * as a model the registry knows takes no effort does. `[]` is the model the registry does know
 * and that takes none: no effort knob, or an effort vocabulary that shares no level with ours.
 *
 * @param registry where the metadata comes from — the bundled models.dev snapshot in production
 */
export function createReasoningSupportResolver(
  registry: ModelRegistry,
): (modelId: string) => readonly ReasoningEffort[] | undefined {
  return (modelId) => {
    const separator = modelId.indexOf('/')
    if (separator <= 0 || separator === modelId.length - 1) {
      return undefined
    }
    const provider = modelId.slice(0, separator)
    const id = modelId.slice(separator + 1)
    const model = registry.models(provider).find((entry) => entry.id === id)
    if (model === undefined) {
      return undefined
    }
    return OUR_EFFORTS.filter((level) => model.efforts?.includes(level) ?? false)
  }
}
