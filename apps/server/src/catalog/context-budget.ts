import type { ModelRegistry } from './registry'

/**
 * The context budget, per model (epic #245's A1; issue #246).
 *
 * Every request is trimmed to a history budget, and before this the budget was one number for
 * every model (`DEFAULT_CONTEXT_TOKEN_BUDGET`, 32,768). That is wrong in both directions: it
 * makes a 200k-token model forget a long chat early, and it overflows a model whose window is
 * smaller than the default. So the budget comes from the model the request runs —
 * {@link contextTokenBudget} — and it is looked up per request, not per session, so a
 * mid-session model switch trims to the new model from the next request on.
 *
 * ## The rule
 *
 * ```
 * budget = contextWindow − min(maxOutput, 25% of contextWindow)
 * ```
 *
 * What is subtracted is room for the reply: the model's own output ceiling when it has one,
 * and 25% of the window when it does not. The result is what is left for history, and the
 * strategy's estimate of the history is what gets trimmed to fit it.
 *
 * ## Where the numbers come from
 *
 * The registry (`catalog/registry.ts`), the bundled models.dev snapshot the catalogue already
 * joins for the context windows it shows the model pickers. It is a committed file, so this
 * costs no network call and no boot-time work.
 *
 * ## A resolver, not a record
 *
 * {@link createTokenBudgetResolver} answers with a function, `(modelId) => budget`, rather
 * than a `Record<modelId, budget>` the caller would build from every entry in the registry.
 * The registry holds hundreds of models per snapshot and the snapshot is refreshed wholesale;
 * building the record would mean enumerating all of it to answer for the one id a request
 * actually runs, and rebuilding it whenever the snapshot changed. The lookup is a `find` over
 * the one provider's list, which is what the catalogue's own join already does.
 */

/**
 * The share of a context window reserved for the reply when a model declares no output
 * ceiling: 25%.
 */
export const OUTPUT_RESERVE_RATIO = 0.25

/**
 * The history budget one model's limits leave: `contextWindow − min(maxOutput, 25%)`.
 *
 * @param model the registry's limits for the model; `contextWindow` is tokens, and
 *   `maxOutput` is the model's own ceiling when the registry has one
 */
export function contextTokenBudget(model: {
  readonly contextWindow: number
  readonly maxOutput?: number
}): number {
  // 25% is the share a model with no declared ceiling reserves; a declared one only ever
  // takes less room, never more, so a model cannot be trimmed past three quarters of its
  // window by its own output setting.
  const share = Math.floor(model.contextWindow * OUTPUT_RESERVE_RATIO)
  const reserve = model.maxOutput === undefined ? share : Math.min(model.maxOutput, share)
  return model.contextWindow - reserve
}

/**
 * The per-model budget resolver the server hands the brain as
 * `ContextStrategyConfig.tokenBudgetFor`.
 *
 * A `provider/model` id is split on its first slash (the split a `provider/model` id has — see
 * `providerOf`), the model is looked up in the registry's list for that provider, and its two
 * limits become a budget through {@link contextTokenBudget}.
 *
 * `undefined` is a real answer, not a failure: it means the registry knows nothing about this
 * id — an unknown provider, a model the snapshot predates, or a free-text id a host accepts
 * (C5) — and the caller's own default applies. That default is the brain's
 * `DEFAULT_CONTEXT_TOKEN_BUDGET` (32,768), which is why the fallback lives in one place rather
 * than being repeated here. A model the registry does know but that carries no context window
 * is the same answer for the same reason: there is nothing to compute from.
 */
export function createTokenBudgetResolver(
  registry: ModelRegistry,
): (modelId: string) => number | undefined {
  return (modelId) => {
    const model = registryModel(registry, modelId)
    if (model?.contextWindow === undefined) {
      return undefined
    }
    return contextTokenBudget({ contextWindow: model.contextWindow, maxOutput: model.maxOutput })
  }
}

/**
 * The per-model output ceiling resolver the server hands the brain as
 * `ContextCompactionConfig.maxOutputFor` (epic #277, K5; C2).
 *
 * The compaction engine caps a summary by the smallest of three bounds, and the summary model's
 * own output ceiling is one of them: a model that can answer with 4k tokens cannot be asked for
 * a 12k-token summary, however much room the chat model's budget would leave. `undefined` is the
 * same real answer the budget resolver gives — the registry knows nothing about this id — and it
 * caps nothing: a summary model with no declared ceiling is bounded by the other two bounds
 * instead, which is the honest reading rather than a guessed number.
 *
 * @param registry the same snapshot the budget resolver and the catalogue read
 */
export function createMaxOutputResolver(
  registry: ModelRegistry,
): (modelId: string) => number | undefined {
  return (modelId) => registryModel(registry, modelId)?.maxOutput
}

/** The registry's entry for a `provider/model` id, or `undefined` when it knows none. */
function registryModel(
  registry: ModelRegistry,
  modelId: string,
): { readonly contextWindow?: number; readonly maxOutput?: number } | undefined {
  const separator = modelId.indexOf('/')
  if (separator <= 0 || separator === modelId.length - 1) {
    return undefined
  }
  const provider = modelId.slice(0, separator)
  const id = modelId.slice(separator + 1)
  return registry.models(provider).find((entry) => entry.id === id)
}
