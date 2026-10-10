import type { ModelEntry } from '@openharness/protocol'

/**
 * The compaction pass math both frontends share (epic #277, C3; issue #282).
 *
 * The Settings → Context section and `oh settings` both warn when the summary model a reader
 * has chosen is so much smaller than the model their chat runs that the engine will need more
 * passes than the pass limit allows — and then hand the work to the chat model instead (K5).
 * "So much smaller" is not a ratio someone picked: it is the engine's own arithmetic, restated
 * here because the browser and the terminal cannot import the brain. The numbers are the
 * brain's (`packages/brain/src/summarize.ts`), and the mirror is deliberate — this is a warning
 * about what compaction will do, so drift shows a reader a slightly wrong reason, never a
 * wrong setting.
 */

/**
 * The share of a model's window the server reserves for its reply when it declares no output
 * ceiling (`apps/server/src/catalog/context-budget.ts`): 25%.
 */
const OUTPUT_RESERVE_RATIO = 0.25

/**
 * How much of the summary model's budget one pass may spend on history (K5's
 * `SUMMARY_SLICE_RATIO`): half. The other half is room for the answer, so a pass folds at most
 * `summaryBudget / 2` tokens of history.
 */
const SUMMARY_SLICE_RATIO = 0.5

/**
 * The history budget a catalog entry leaves, `contextWindow − min(maxOutput, 25% of it)` — the
 * server's rule (#246), so the warning measures the way the engine will.
 *
 * `null` when the catalog knows no window for the model: there is nothing to compute from, and
 * the caller should say nothing rather than guess.
 *
 * @param entry the catalog's entry, or anything carrying the two limits
 */
export function modelContextBudget(
  entry: Pick<ModelEntry, 'context_window' | 'max_output_tokens'>,
): number | null {
  const window = entry.context_window
  if (window === null || window <= 0) {
    return null
  }
  const share = Math.floor(window * OUTPUT_RESERVE_RATIO)
  const reserve =
    entry.max_output_tokens === null ? share : Math.min(entry.max_output_tokens, share)
  return window - reserve
}

/** What the pass math says about a chosen summary model, when it says the engine falls back. */
export interface SummaryModelFallback {
  /** The chat model's history budget — what a summary could ever have to fold. */
  readonly chatBudget: number
  /** The summary model's history budget — what each pass is sized by. */
  readonly summaryBudget: number
  /** The passes folding the chat model's whole budget would take. */
  readonly passesNeeded: number
  /** The passes the reader allows. */
  readonly maxPasses: number
}

/**
 * Whether the chosen summary model will need more passes than the limit allows, so the chat
 * model summarizes instead (K5) — `null` when it will not, or when the math cannot say.
 *
 * A pass folds at most half the summary model's budget (the other half is its own answer), so
 * `maxPasses` passes fold at most `maxPasses × summaryBudget / 2` tokens. When that is less
 * than the chat model's own budget, any history the chat could fill needs more passes than the
 * reader allows and the engine hands the work back to the chat model — which is the warning.
 *
 * The engine's other caps only ever make a slice *smaller*, so ignoring them here can only
 * under-warn: a model this says is fine may still fall back over a very long chat, but one it
 * flags will. `null` for either model's unknown window, because the arithmetic has nothing to
 * stand on.
 *
 * @param options the chat model the reader's default names, the chosen summary model, and the
 *   pass limit in force (the stored one, or the `defaults` the response reports)
 */
export function summaryModelFallback(options: {
  readonly chat: Pick<ModelEntry, 'context_window' | 'max_output_tokens'>
  readonly summary: Pick<ModelEntry, 'context_window' | 'max_output_tokens'>
  readonly maxPasses: number
}): SummaryModelFallback | null {
  const chatBudget = modelContextBudget(options.chat)
  const summaryBudget = modelContextBudget(options.summary)
  if (chatBudget === null || summaryBudget === null) {
    return null
  }
  const slice = Math.floor(summaryBudget * SUMMARY_SLICE_RATIO)
  const passesNeeded = slice <= 0 ? Number.POSITIVE_INFINITY : Math.ceil(chatBudget / slice)
  return passesNeeded > options.maxPasses
    ? { chatBudget, summaryBudget, passesNeeded, maxPasses: options.maxPasses }
    : null
}
