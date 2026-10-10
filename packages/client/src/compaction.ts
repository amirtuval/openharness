import type { GetPreferencesResponse, ModelEntry } from '@openharness/protocol'

import type { TranscriptContext, TranscriptManualCompaction, TranscriptSummary } from './transcript'

/**
 * How full the context is, and where the line the user chose sits (epic #277, K10/C1–C4; #280).
 *
 * The meter both frontends draw is the same arithmetic over the same two facts: the prompt size
 * of the last real model request, and the **budget** of the model the chat currently runs. Both
 * are things a transcript already holds (the size) or a catalog already answers (the budget), so
 * this module is a handful of pure functions and nothing else — no store, no I/O.
 *
 * ## The budget restates the server's rule
 *
 * A model's history budget is the server's (`apps/server/src/catalog/context-budget.ts`, #246):
 *
 * ```
 * budget = contextWindow − min(maxOutput, 25% of contextWindow)
 * ```
 *
 * — the window less room for the reply. It is restated here rather than shared because the rule
 * lives in a package this one may not depend on, and both frontends need it (the web header and
 * the `oh` status line must agree). A model the catalog does not list — an unknown id, a free-text
 * one — gets the brain's `DEFAULT_CONTEXT_TOKEN_BUDGET`, exactly as the server's resolver answers
 * `undefined` for one and the brain falls back to the same number. Keep the two in step: they are
 * one rule written twice, the way the fake's session-naming rule is (`testing/titles.ts`).
 *
 * ## What the meter measures
 *
 * The size is the **real prompt size** of the last real request — the three input-side counters
 * of its `span.model_request_end.model_usage` summed, which is `promptTokensOf` in the brain. A
 * request the compaction engine made (`purpose: 'summary'`) measures the summarizer's prompt, not
 * the chat's, so the transcript refuses it as the meter's baseline — see {@link TranscriptContext}.
 *
 * After a summary lands, and until the next real request measures itself, the meter is an
 * **estimate**: the baseline less what the summary replaced, plus the summary's own text. It is
 * lower than the baseline (that is the point of the summary), it is flagged
 * ({@link ContextMeter.estimated}), and it is usually seconds old — the request the compaction was
 * making room for reports its real size immediately afterwards.
 *
 * ## The threshold
 *
 * Compaction fires at a share of the budget: the caller's stored `compaction_threshold`
 * preference, or the deployment's own share (`defaults.compaction_threshold`) for one they never
 * chose. {@link compactionThreshold} is the one place that lookup lives, so the frontends read
 * the preference the same way and a default change is one edit.
 */

/** The share of a model's budget at which older history is summarized when nothing says otherwise. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.7

/**
 * The history budget a model with no known limits gets — the brain's own fallback
 * (`DEFAULT_CONTEXT_TOKEN_BUDGET`), so a model the catalog does not carry is measured against the
 * same number the server trims to.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 32_768

/** The share of a context window reserved for the reply when a model declares no output ceiling. */
export const OUTPUT_RESERVE_RATIO = 0.25

/** The characters-per-token estimate the budget is measured in, as the brain measures it. */
export const CHARS_PER_TOKEN = 4

/**
 * The history budget one model's limits leave: `contextWindow − min(maxOutput, 25%)`.
 *
 * The rule the server's `contextTokenBudget` applies (#246), restated for the frontends.
 *
 * @param model the catalog's limits for the model; `contextWindow` is tokens, and `maxOutput` is
 *   the model's own ceiling when the catalog has one
 */
export function contextTokenBudget(model: {
  readonly contextWindow: number
  readonly maxOutput?: number | undefined
}): number {
  const share = Math.floor(model.contextWindow * OUTPUT_RESERVE_RATIO)
  const reserve = model.maxOutput === undefined ? share : Math.min(model.maxOutput, share)
  return model.contextWindow - reserve
}

/**
 * The history budget of a catalog entry, or {@link DEFAULT_CONTEXT_TOKEN_BUDGET} when the entry
 * cannot say: an id nobody lists, or one with no context window (C6's `null`).
 *
 * @param entry the catalog's entry for the model the meter is drawn against, if it has one
 */
export function modelContextBudget(
  entry: Pick<ModelEntry, 'context_window' | 'max_output_tokens'> | null | undefined,
): number {
  const window = entry?.context_window
  if (window === null || window === undefined || window <= 0) {
    return DEFAULT_CONTEXT_TOKEN_BUDGET
  }
  const maxOutput = entry?.max_output_tokens
  return contextTokenBudget({
    contextWindow: window,
    ...(maxOutput === null || maxOutput === undefined ? {} : { maxOutput }),
  })
}

/**
 * The share of the budget a chat compacts at: the caller's stored choice when they made one,
 * else the default the server reports (epic #277; C3, #282).
 *
 * **The one place the preference is read.** `compaction_threshold` is the caller's own share or
 * `null` for "follow the deployment's", and the deployment's number is not knowable here — a
 * server may set `OPENHARNESS_COMPACTION_THRESHOLD` to anything — so a `null` is answered with
 * the `defaults.compaction_threshold` the preferences response carries, which is the same value
 * the server resolves for that owner's chats. `DEFAULT_COMPACTION_THRESHOLD` is what is left for
 * a caller that has no preferences at all (a failed read, or a server that predates the route):
 * the deployment's own share is the only fact this package cannot derive, and everything else is
 * the server's answer.
 *
 * @param preferences the caller's stored preferences, as `GET /v1/me/preferences` answers them
 */
export function compactionThreshold(
  preferences: Pick<GetPreferencesResponse, 'compaction_threshold' | 'defaults'> | null | undefined,
): number {
  return (
    preferences?.compaction_threshold ??
    preferences?.defaults.compaction_threshold ??
    DEFAULT_COMPACTION_THRESHOLD
  )
}

/** A string's token cost, at the same characters-per-token estimate the budget is measured in. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * The context size right after a summary replaced the history it covers (epic #277, K10; #280).
 *
 * The baseline — the last real request's measured prompt size, or the summary's own
 * `tokens_before` when there has been none — counted the history the summary just replaced. What
 * is left is that baseline, less the covered conversation (estimated from the text the transcript
 * still holds, at {@link estimateTokens}), plus the summary's own text. Floored at the summary
 * itself, which the model is at least told.
 *
 * An **estimate**, deliberately: nothing measures a prompt until a request is made with it, and
 * the request the summary was made for reports its real size immediately afterwards. It
 * over-counts rather than under-counts (the covered text estimate leaves out framing the real
 * prompt paid for), which is the safe direction for a meter whose job is to warn early.
 *
 * @param input.baseline the request's measured prompt size, in tokens
 * @param input.summary the summary's text
 * @param input.coveredText the text of the conversation the summary covers
 */
export function contextAfterSummary(input: {
  readonly baseline: number
  readonly summary: string
  readonly coveredText: string
}): number {
  const summaryTokens = estimateTokens(input.summary)
  const replaced = estimateTokens(input.coveredText) - summaryTokens
  return Math.max(summaryTokens, Math.round(input.baseline - replaced))
}

/**
 * How full the context is, as a frontend draws it (epic #277, K10; #280).
 *
 * Every number a UI needs and both words for it, so the web header and the `oh` status line
 * cannot disagree about what the meter says — the same "one rule, two renderers" shape as
 * {@link replyCost} and `credentialRowLabel`.
 */
export interface ContextMeter {
  /** The prompt size the meter is drawn from, in tokens — {@link ContextMeter.estimated} says how. */
  readonly tokens: number
  /** The history budget of the model the chat runs. */
  readonly budget: number
  /** The share of the budget compaction fires at. */
  readonly threshold: number
  /** `tokens / budget`, unrounded — what a bar's width is drawn from. */
  readonly ratio: number
  /** The ratio as a whole percentage: `62` for 62%, `104` for a context over its budget. */
  readonly percent: number
  /** Whether the context has reached the threshold its chat compacts at. */
  readonly nearThreshold: boolean
  /** Whether {@link ContextMeter.tokens} is an estimate rather than a measurement. */
  readonly estimated: boolean
  /** The meter in words: `62% of context used`, or `~62% of context used` when estimated. */
  readonly label: string
  /**
   * The same fact in as few columns as it can be said in (`62%`, `~62%`), for a status line with
   * no room for the sentence — the shape `formatCostTotal`'s compact form has for the cost.
   */
  readonly shortLabel: string
}

/**
 * The meter for a transcript's context, or `null` when nothing has measured one yet.
 *
 * `null` is a real answer, not a failure: a chat that has not made a request has no prompt size
 * to draw, and a caller with no catalog still gets a meter — against the default budget, since
 * the model's window is the one thing it could not look up. The threshold is the caller's, from
 * {@link compactionThreshold}.
 *
 * @param context what the transcript knows about the last real request, or `null`
 * @param options.model the catalog's entry for the model the chat currently runs
 * @param options.threshold the share of the budget that counts as near-full; the default applies
 */
export function contextMeter(
  context: TranscriptContext | null,
  options: {
    readonly model?: Pick<ModelEntry, 'context_window' | 'max_output_tokens'> | null | undefined
    readonly threshold?: number | undefined
  } = {},
): ContextMeter | null {
  if (context === null) {
    return null
  }
  const budget = modelContextBudget(options.model)
  const threshold = options.threshold ?? DEFAULT_COMPACTION_THRESHOLD
  const ratio = budget <= 0 ? 0 : context.tokens / budget
  const percent = Math.round(ratio * 100)
  const marker = context.estimated ? '~' : ''
  return {
    tokens: context.tokens,
    budget,
    threshold,
    ratio,
    percent,
    nearThreshold: ratio >= threshold,
    estimated: context.estimated,
    label: `${marker}${String(percent)}% of context used`,
    shortLabel: `${marker}${String(percent)}%`,
  }
}

/**
 * The divider's own words for a summary (epic #277, K10; #280): why it happened and what wrote it,
 * in the order a reader asks — reason, model, passes.
 *
 * Keyed by the reason rather than spelled out at each renderer, so the transcript's divider and
 * the `oh` transcript say the same thing. `automatic` is the protocol's `threshold`: the context
 * reached the share the settings allow, which is the one reason nobody asked for.
 *
 * @param summary the divider's summary, from `selectSummaries`
 */
export function summaryDescription(summary: TranscriptSummary): string {
  const reason =
    summary.reason === 'threshold'
      ? 'automatic'
      : summary.reason === 'overflow'
        ? 'overflow'
        : 'manual'
  const passes = summary.passes === 1 ? '1 pass' : `${String(summary.passes)} passes`
  return `${reason} · ${summary.model} · ${passes}`
}

/**
 * How much of the summary model's budget one pass may spend on history (K5's
 * `SUMMARY_SLICE_RATIO`): half. The other half is room for the answer, so a pass folds at most
 * `summaryBudget / 2` tokens of history.
 */
const SUMMARY_SLICE_RATIO = 0.5

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
 * model summarizes instead (K5) — `null` when it will not.
 *
 * A pass folds at most half the summary model's budget (the other half is its own answer), so
 * `maxPasses` passes fold at most `maxPasses × summaryBudget / 2` tokens. When that is less
 * than the chat model's own budget, any history the chat could fill needs more passes than the
 * reader allows and the engine hands the work back to the chat model — which is the warning.
 *
 * The engine's other caps only ever make a slice *smaller*, so ignoring them here can only
 * under-warn: a model this says is fine may still fall back over a very long chat, but one it
 * flags will.
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
  const slice = Math.floor(summaryBudget * SUMMARY_SLICE_RATIO)
  const passesNeeded = slice <= 0 ? Number.POSITIVE_INFINITY : Math.ceil(chatBudget / slice)
  return passesNeeded > options.maxPasses
    ? { chatBudget, summaryBudget, passesNeeded, maxPasses: options.maxPasses }
    : null
}

/**
 * What a manual compaction says while the brain has not answered it yet (epic #277, K8; #283):
 * `Compacting…`.
 *
 * A `/compact` is stored and answered asynchronously, so a UI that said nothing between the
 * ask and the outcome would look like it had ignored the reader. Both frontends draw this word,
 * from {@link TranscriptManualCompaction.pending} — one string, so the terminal and the web
 * cannot word the same wait differently.
 */
export const COMPACTING_LABEL = 'Compacting…'

/** The tone of a manual compaction's notice: something to read, or something that went wrong. */
export type ManualCompactionTone = 'info' | 'error'

/** The line a frontend shows for a manual compaction's outcome, and how loudly. */
export interface ManualCompactionNotice {
  /** `info` for a result that is merely explanatory, `error` for a failure. */
  readonly tone: ManualCompactionTone
  /** The words: the brain's own sentence where it sent one, a fixed one otherwise. */
  readonly text: string
}

/**
 * The notice a manual compaction's outcome is owed, or `null` when no notice is needed
 * (epic #277, K8; #283).
 *
 * `summarized` is `null`: the summary landed, the conversation shows C5's divider for it, and a
 * second line saying so would be noise. The other two outcomes are exactly what the epic asks a
 * client to show — "there was no older history to summarize" and "the summary could not be
 * written" — and the brain's `message` is preferred over these fallbacks wherever it sent one,
 * because it knows why. The words live here rather than in each frontend so `oh` and the web
 * say the same thing, the same reason `summaryDescription` does.
 *
 * @param compaction the state `selectManualCompaction` answers
 */
export function manualCompactionNotice(
  compaction: Pick<TranscriptManualCompaction, 'outcome' | 'message'>,
): ManualCompactionNotice | null {
  if (compaction.outcome === null || compaction.outcome === 'summarized') {
    return null
  }
  if (compaction.outcome === 'failed') {
    return {
      tone: 'error',
      text: compaction.message ?? 'The summary could not be written.',
    }
  }
  return {
    tone: 'info',
    text: compaction.message ?? 'There was no older history to summarize.',
  }
}
