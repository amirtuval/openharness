import { EVENT_TYPES } from '@openharness/protocol'
import type { ContextSummaryReason, SessionModelUsage, StoredEvent } from '@openharness/protocol'
import type { AppendableEvent } from '@openharness/session'
import type { LanguageModel, ModelMessage } from 'ai'

import {
  capItemText,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  latestContextSummary,
} from './context'
import { contextSummary, contextSummaryProgress, sessionUsage, spanEnd, spanStart } from './events'
import { usageByModel, withRequestUsage } from './log'
import type { ModelFactory, ResolveCredential } from './model'
import {
  credentialSecrets,
  isUnsupportedProviderError,
  isUsableCredential,
  providerOf,
  streamModelRequest,
  ZERO_MODEL_USAGE,
} from './model'
import { redactSecrets } from './redact'

/**
 * The compaction engine: turning older history into a summary (epic #277, C2; issue #279).
 *
 * The brain's context strategy is pure, synchronous and read-only, so it cannot summarize: a
 * summary needs model calls, and model calls need the store. This module is the other half —
 * the part that runs in the turn loop at a request boundary, where it can call a model and
 * append events.
 *
 * It is deliberately **not** `apps/server`'s `compaction.ts`: that one is the stream's
 * `DeltaCompactor`, which deletes the chunks a finished reply superseded (D9, #46). "Context
 * compaction" is this one — summarizing older history for the model — and the two never touch
 * the same thing. The event it writes is a `session.context_summary`; nothing is deleted.
 *
 * ## What it does, in order
 *
 * 1. **The trigger** (K2). The caller measures the next request (C1's `estimateContextSize`) and
 *    compares it against the threshold share of the **chat** model's budget. Over it, this runs;
 *    under it, `'skipped'` and nothing is written — a chat that never comes near the threshold
 *    behaves exactly as it did before.
 * 2. **Where to cut** (K4, K12). One replaceable function answers "where may history be cut?"
 *    ({@link ContextCutRule}); the default keeps about a quarter of the chat model's budget
 *    verbatim and cuts at a `user.message` boundary, so no model turn is split. Everything
 *    before the cut is what this summary covers.
 * 3. **Which model** (K3). The summary model (`same as the chat` by default); a chosen one with
 *    no usable credential, or one that would need more passes than the limit, hands the work to
 *    the chat model and the event records why in `fallback_reason`.
 * 4. **Chunked passes** (K5). The covered history is folded in slices, each pass
 *    "instructions + the running summary + the next slice" sized to the summary model's budget
 *    with room for its answer. The running summary is capped (12% of the chat budget, the
 *    summary model's output ceiling, and "leaves room for a slice"), and a running summary that
 *    has grown until no slice fits is summarized alone first.
 * 5. **One model call per pass, recorded** (K3, #247). Each pass opens a
 *    `span.model_request_start` with `purpose: 'summary'` and closes it with the usage and a
 *    fresh `session.usage` — so the tokens and cost of summarizing appear in the session's usage
 *    exactly like any other request, while the size accounting refuses the span as a baseline
 *    for the chat's own context (K2).
 * 6. **Progress** (#279). A stored `session.context_summary_progress { pass, passes }` precedes
 *    every pass: everything a client is shown lives in the log (D9).
 * 7. **The summary event**. `session.context_summary` carries the text, the `covers.to_seq` the
 *    model reads from, the reason, the size that triggered it and the record of how it was
 *    written. It supersedes nothing.
 *
 * ## Failure never blocks the chat (K11)
 *
 * A summarizer that fails, times out, is interrupted or returns nothing closes its span with the
 * error — the log says what happened — and the engine answers `'failed'`. The caller carries on
 * to the model request with the strategy's trimming as the safety net, exactly as if no
 * compaction had been asked for. Nothing is retried here: a second attempt would cost another
 * model call for the same answer, and the chat still works without a summary.
 *
 * A write the store refuses (`FencedError`, `ClaimConflictError`) is not a summarizer failure:
 * it stops the turn where it stands like any other refused write, and the engine lets it
 * propagate. A compaction is written by the owner of the turn or not at all.
 *
 * ## Concurrency
 *
 * A session runs one turn at a time (`SessionRunner`), and a turn runs one request at a time, so
 * two compactions of one session cannot be in flight: the second would need a second turn. The
 * fence is the other half — every append here goes through the turn's own `append`, so a brain
 * whose lease was taken over stops at its first refused write rather than writing into the log
 * its successor now owns.
 */

/**
 * The share of the chat model's budget at which the engine summarizes (K2): 70%.
 *
 * A setting on the server (`OPENHARNESS_COMPACTION_THRESHOLD`), and an input here, so a host
 * that wants a different trigger passes one and tests pass small ones.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.7

/** How many passes a chosen summary model may need before the chat model takes over (K5). */
export const DEFAULT_MAX_SUMMARY_PASSES = 3

/**
 * The most of the chat model's budget a summary itself may cost (K5): 12%.
 *
 * Not the only bound — the summary model's own output ceiling and "room for a slice" both cap it
 * down — but the one that keeps a summary from growing back into the context it replaced. The
 * exact value is the epic's decision (`12%`), not a rounded one.
 */
export const SUMMARY_SIZE_RATIO = 0.12

/**
 * How much of the chat model's budget the recent history keeps verbatim (K4): a quarter.
 *
 * The tail is the conversation the model needs to answer the next message in full; everything
 * older is what the summary stands in for.
 */
export const RECENT_TAIL_RATIO = 0.25

/**
 * The tail the **overflow** path keeps (K2): half of the normal one.
 *
 * When a provider has already refused the request as too long, "tighter caps" has to mean
 * something. The summary covers twice as much history — its instructions still say what may be
 * dropped, and the one thing that cannot is a user instruction (K7) — which is what gives the
 * retried request a real chance of fitting.
 */
export const OVERFLOW_RECENT_TAIL_RATIO = 0.125

/**
 * How much of the summary model's budget one history item may take in the summarizer's input
 * (K6): a quarter, so a single huge message cannot swallow a pass.
 */
export const SUMMARY_ITEM_CAP_RATIO = 0.25

/**
 * How much of the summary model's budget one pass's slice may take (K5): half.
 *
 * The other half is the room for the pass's answer — a pass rewrites the whole summary, which
 * can be as long as what it was given — and the planning uses the reserve, before any answer's
 * real size is known.
 */
export const SUMMARY_SLICE_RATIO = 0.5

/**
 * How much of the summary model's **own** budget the summary may take (K5's "leaves room for a
 * slice next round"): a quarter.
 *
 * Without it the cap's other bounds let a summary grow to nearly the whole of the summarizer's
 * budget — 12% of a large chat model's budget is more than a small summarizer can take at all —
 * and every pass after the first would have almost no room for history. A quarter leaves three
 * quarters for the instructions and the slice, which is what makes the cap a coherent statement
 * about a model whose window is smaller than the chat's.
 */
export const SUMMARY_SIZE_BUDGET_RATIO = 0.25

/** A pass's input keeps this much under the summary model's budget, for the estimate's error. */
export const SUMMARY_INPUT_MARGIN = 256

/** A slice smaller than this many tokens is not a slice; the running summary is folded first. */
export const MIN_SLICE_TOKENS = 1024

/** The smallest summary worth asking for, whatever the caps work out to. */
export const MIN_SUMMARY_TOKENS = 256

/**
 * The version of the prompt below (K7), recorded on every summary.
 *
 * A constant rather than a hash of the text: the point is that a change to how summaries are
 * written is visible in the log, and a reader comparing two sessions wants a name for the
 * difference, not a fingerprint. Bumped by hand when {@link SUMMARY_PROMPT} changes meaningfully.
 */
export const SUMMARY_PROMPT_VERSION = 'context-summary-v1'

/**
 * The prompt a summary is written with (K7).
 *
 * Written for this project, in the six sections the epic fixes — goal, constraints and
 * preferences, progress, key decisions, next steps, critical context — for **general chat**
 * rather than only coding, in update mode (the model is given what is there and asked to fold the
 * new history into it).
 *
 * **Licence:** this text is original. The epic allows adapting an open-source prompt (it names
 * Codex's, Apache-2.0) once its licence is checked; nothing was adapted here, so no third-party
 * notice is owed and no licence text needs to travel with this file. The two rules the epic sets
 * — keep every user instruction, quote exact identifiers and values verbatim — are written into
 * the prompt itself. Claude Code's prompt is proprietary and was not consulted.
 */
const SUMMARY_PROMPT = `You compress the earlier part of a conversation so the chat can continue with less context. You are given the history to fold in and, when there is one, the summary so far. Answer with the updated summary and nothing else: no preamble, no commentary.

Write these six sections, in this order, with exactly these headings:

## Goal
What the user is trying to do, in their own terms.

## Constraints and preferences
Every instruction, requirement, preference and constraint the user has stated, including the ones they later withdrew — say which. Quote names, identifiers, numbers, paths, versions and values exactly as they appear.

## Progress
What has happened: what was asked, what was answered, what was decided, what failed and why.

## Key decisions
Each decision and the reason for it, so it is not revisited. Name the alternatives that were rejected.

## Next steps
What is still to do, and what was about to happen when the history ends.

## Critical context
What cannot be recovered from the rest of the summary: exact quotes, values, identifiers, error messages, and anything the user is likely to refer back to.

Rules:
- Keep every user instruction and constraint, including ones that now seem irrelevant.
- Quote exact identifiers and values verbatim; never paraphrase one.
- Prefer the specific to the general: a fact the next turn needs beats a tidy sentence.
- Write in the language the conversation is in.
- This may be any kind of chat, not only coding, so do not assume the work is software.`

/** The sentence that turns {@link SUMMARY_PROMPT} into update mode (K4's incrementality). */
const SUMMARY_UPDATE_CLAUSE = `

The summary so far and the new history follow. Update the summary with the new history: keep what is still true, replace or correct what the new history changes, and add what it adds. Do not restate the new history verbatim; fold it in.`

/** How {@link summarizeContext} is configured. All of it is a host's, none of it is the log's. */
export interface ContextCompactionConfig {
  /**
   * The share of the chat model's budget at which to summarize (K2); `0.7` by default.
   *
   * A number strictly between 0 and 1: a threshold of 0 would summarize every request, and one
   * of 1 would never fire before the provider refuses.
   */
  readonly threshold?: number
  /**
   * The `provider/model` that writes summaries, or `null` (the default) for the chat model
   * itself (K3). C3 wires a per-user preference into this; the engine only takes the answer.
   */
  readonly summaryModel?: string | null
  /**
   * How many passes the chosen summary model may need before the chat model takes over (K5).
   * Defaults to {@link DEFAULT_MAX_SUMMARY_PASSES}. The chat model itself is never refused for
   * needing many passes — refusing would leave the chat with no way to fit at all.
   */
  readonly maxPasses?: number
  /**
   * The context budget of one model (K2/K5) — the same resolver the context strategy is given
   * (`ContextStrategyConfig.tokenBudgetFor`, #246), asked here for the chat model's trigger and
   * the summary model's passes. `undefined` means the brain's default for every model.
   */
  readonly tokenBudgetFor?: (modelId: string) => number | undefined
  /**
   * The output ceiling of one model, when the registry knows it (K5's summary-size cap). The
   * `undefined` case is "no ceiling known" and caps nothing; the budget above already reserves
   * the model's output room, so an unknown ceiling never makes a pass overflow.
   */
  readonly maxOutputFor?: (modelId: string) => number | undefined
  /**
   * Where history may be cut (K4, K12). One function, replaceable: #276 replaces it with one that
   * keeps tool call/result pairs together, without this module changing.
   */
  readonly cutRule?: ContextCutRule
}

/** {@link ContextCompactionConfig} with every default resolved. */
export interface ResolvedContextCompaction {
  readonly threshold: number
  readonly summaryModel: string | null
  readonly maxPasses: number
  readonly tokenBudgetFor: ((modelId: string) => number | undefined) | undefined
  readonly maxOutputFor: ((modelId: string) => number | undefined) | undefined
  readonly cutRule: ContextCutRule
}

/**
 * Resolve a host's configuration, filling in the defaults.
 *
 * @param config what the host asked for
 */
export function resolveContextCompaction(
  config: ContextCompactionConfig = {},
): ResolvedContextCompaction {
  return {
    threshold: config.threshold ?? DEFAULT_COMPACTION_THRESHOLD,
    summaryModel: config.summaryModel ?? null,
    maxPasses: config.maxPasses ?? DEFAULT_MAX_SUMMARY_PASSES,
    tokenBudgetFor: config.tokenBudgetFor,
    maxOutputFor: config.maxOutputFor,
    cutRule: config.cutRule ?? cutAtUserBoundary,
  }
}

/** One conversation message, as the cut rule sees it. */
export interface ContextCutItem {
  /** The `seq` of the event the text came from. */
  readonly seq: number
  /** The role the model reads it under. */
  readonly role: 'user' | 'assistant'
  /** The message's text. */
  readonly text: string
  /** Its size, at {@link estimateTokens}. */
  readonly tokens: number
}

/**
 * Where may history be cut? Returns the index of the first item to keep verbatim; everything
 * before it is what a summary covers. An index of `0` (or `items.length`) means "nowhere".
 *
 * This is K12's one replaceable function, and the whole of the answer to "what may the model be
 * told in summary instead of in full?". Two rules are the default's, not the engine's: keep a
 * recent tail of about `tailTokens`, and never split a model turn. #276 replaces the default with
 * one that also keeps a tool call with its result — same signature, same call site.
 */
export type ContextCutRule = (items: readonly ContextCutItem[], tailTokens: number) => number

/**
 * The default cut rule: the smallest recent tail that reaches `tailTokens`, widened to start at a
 * `user.message` (K4).
 *
 * A turn is a user message and the reply to it, so a cut that landed between the two would hand
 * the model an answer to a question it cannot see. Walking back from the newest item to the first
 * `user.message` is therefore not a refinement but the rule: the kept tail always begins with
 * what the user asked.
 *
 * A tail that reaches the start of the history returns `0` — there is nothing to summarize — and
 * so does a history with no user message in it, which is not a conversation the engine can
 * compress.
 *
 * @param items the visible conversation, oldest first
 * @param tailTokens how many tokens the kept tail should reach
 */
export function cutAtUserBoundary(items: readonly ContextCutItem[], tailTokens: number): number {
  if (items.length === 0) {
    return 0
  }
  const target = Math.max(1, tailTokens)
  let index = items.length
  let tokens = 0
  while (index > 0 && tokens < target) {
    index -= 1
    tokens += items[index]?.tokens ?? 0
  }
  // Ascend to the user message that opens the turn the tail would otherwise start inside.
  while (index > 0 && items[index]?.role !== 'user') {
    index -= 1
  }
  return index
}

/** How {@link summarizeContext} is called. Everything it cannot read off the log is here. */
export interface SummarizeContextOptions {
  /** The `provider/model` the next chat request will run — the model the trigger is sized by. */
  readonly chatModel: string
  /** Why the summary is being made (K2/K8); `'overflow'` also skips the trigger check. */
  readonly reason: ContextSummaryReason
  /** The log as the request boundary sees it, as `readLog` handed it over. */
  readonly events: readonly StoredEvent[]
  /** The session's system prompt, or `null`. */
  readonly system: string | null
  /** The measured context size at this boundary, in tokens — the trigger's number, and K10's. */
  readonly estimatedTokens: number
  /** The trigger, the model and the limits. */
  readonly config: ResolvedContextCompaction
  /** How a `provider/model` becomes a model to stream. */
  readonly model: ModelFactory
  /** Where the credential of the summary model's provider comes from (A5). */
  readonly resolveCredential: ResolveCredential
  /**
   * Append events, exactly as the turn loop does — fenced, validated, in one place. The engine
   * writes everything through this, which is what ties a compaction to the owner of the turn.
   */
  readonly append: (events: AppendableEvent[]) => Promise<StoredEvent[]>
  /** Aborting this stops the compaction at the next safe point, as it stops a request. */
  readonly signal?: AbortSignal
}

/** What one compaction run did. */
export interface SummarizeResult {
  /**
   * `'summarized'` — a `session.context_summary` was written.
   * `'skipped'` — nothing was written: under the threshold, nowhere to cut, or no usable model.
   * `'failed'` — the summarizer failed; its span says so and the chat carries on (K11).
   */
  readonly outcome: 'summarized' | 'skipped' | 'failed'
  /** The `seq` the new summary covers, when one was written. */
  readonly coversTo?: number
  /** The model that wrote it — the summary model, or the chat model on a fallback. */
  readonly summaryModel?: string
  /** Why the chat model wrote it instead of the chosen summary model (K3/K5), when it did. */
  readonly fallbackReason?: string
  /** How many passes it took. */
  readonly passes?: number
}

/** The model a compaction will run on, and how to build it. */
interface SummaryWriter {
  readonly modelId: string
  readonly model: LanguageModel
  readonly secrets: readonly string[]
  readonly fallbackReason?: string
}

/**
 * Compact the context, if this boundary needs it (epic #277, C2).
 *
 * See the module documentation for the order of what happens; this is the entry point a turn
 * calls. It answers rather than throws for everything the **summarizer** can hit — a failure is
 * the chat's to survive (K11) — and lets a refused write propagate, because that is the turn's
 * ownership failing, not the summarizer's.
 *
 * @param options the model, the trigger, the log and the way to write; see
 *   {@link SummarizeContextOptions}
 */
export async function summarizeContext(options: SummarizeContextOptions): Promise<SummarizeResult> {
  const { config, events } = options
  const chatBudget = budgetFor(config, options.chatModel)
  if (options.reason !== 'overflow' && options.estimatedTokens <= chatBudget * config.threshold) {
    return { outcome: 'skipped' }
  }

  const previous = latestContextSummary(events)
  const items = conversationItems(events, previous === null ? 0 : previous.covers.to_seq)
  const tailTokens = Math.floor(
    chatBudget * (options.reason === 'overflow' ? OVERFLOW_RECENT_TAIL_RATIO : RECENT_TAIL_RATIO),
  )
  const cut = config.cutRule(items, tailTokens)
  const firstKept = items[cut]
  if (cut <= 0 || firstKept === undefined) {
    // Nowhere to cut: the model would have to summarize away everything it needs, or there is
    // nothing older than the newest turn. Trimming (and the strategy's cap, K6) is what is left,
    // and it is what the request below gets.
    return { outcome: 'skipped' }
  }
  const covered = items.slice(0, cut)
  const coversTo = firstKept.seq - 1
  if (coversTo <= (previous?.covers.to_seq ?? 0)) {
    return { outcome: 'skipped' }
  }

  const writer = await chooseWriter(options)
  if (writer === null) {
    return { outcome: 'skipped' }
  }

  const runningSummary = previous === null ? null : previous.summary
  // Everything that depends on which model writes the summary, in one place, so the plan the
  // fallback is judged by and the plan the run follows are computed the same way.
  const plan = (modelId: string) => {
    const budget = budgetFor(config, modelId)
    const cap = summarySizeCap(config, budget, chatBudget, modelId)
    const instructions = instructionsFor(previous !== null, cap)
    const sliceBudget = sliceBudgetOf(budget, estimateTokens(instructions), cap)
    const needsFold = runningSummary !== null && estimateTokens(runningSummary) > cap
    const capped = capItems(covered, budget)
    return {
      instructions,
      sliceBudget,
      sizeCap: cap,
      capped,
      planned: planPasses(sliceBudget, capped) + (needsFold ? 1 : 0),
    }
  }

  let fallbackReason = writer.fallbackReason
  let writer_ = writer
  let { instructions, sliceBudget, sizeCap, capped, planned } = plan(writer.modelId)
  if (planned > config.maxPasses && writer.modelId !== options.chatModel) {
    // K5: the chosen summary model would need more passes than the limit allows, so the chat
    // model does it — usually in one — and the event says why.
    const fallback = await buildWriter(options, options.chatModel, {
      fallbackReason: `${writer.modelId} would need ${planned} passes, over the limit of ${config.maxPasses}`,
    })
    if (fallback === null) {
      return { outcome: 'skipped' }
    }
    writer_ = fallback
    fallbackReason = fallback.fallbackReason
    ;({ instructions, sliceBudget, sizeCap, capped, planned } = plan(writer_.modelId))
  }

  const written = await runPasses({
    options,
    writer: writer_,
    instructions,
    sliceBudget,
    sizeCap,
    planned,
    capped,
    running: runningSummary,
  })
  if (written === null) {
    return { outcome: 'failed' }
  }
  await options.append([
    contextSummary(written.text, { to_seq: coversTo }, options.reason, {
      tokensBefore: options.estimatedTokens,
      summaryModel: writer_.modelId,
      promptVersion: SUMMARY_PROMPT_VERSION,
      passes: written.passes,
      ...(fallbackReason === undefined ? {} : { fallbackReason }),
    }),
  ])
  return {
    outcome: 'summarized',
    coversTo,
    summaryModel: writer_.modelId,
    passes: written.passes,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
  }
}

/**
 * Pick the model that will write the summary (K3/K5's first half): the chosen one when it can be
 * used, the chat model otherwise.
 *
 * "Can be used" is both halves of K3 — a credential the owner has, and a provider this build has
 * a client for — and each refusal carries the sentence the event records. A chat model that
 * cannot be used at all answers `null`: the turn ends with `missing_provider_credential` before
 * it makes any request, so there is nothing to summarize for.
 */
async function chooseWriter(options: SummarizeContextOptions): Promise<SummaryWriter | null> {
  const chosen = options.config.summaryModel
  if (chosen !== null && chosen !== options.chatModel) {
    const writer = await buildWriter(options, chosen, {})
    if (writer !== null) {
      return writer
    }
    const reason = await chosenUnusableReason(options, chosen)
    return await buildWriter(options, options.chatModel, { fallbackReason: reason })
  }
  return await buildWriter(options, options.chatModel, {})
}

/** The sentence a summary event records when the chosen model could not be used (K3). */
async function chosenUnusableReason(
  options: SummarizeContextOptions,
  chosen: string,
): Promise<string> {
  const credential = await options.resolveCredential(providerOf(chosen))
  return isUsableCredential(credential)
    ? `${chosen} is not a provider this build can run`
    : `${chosen} has no credential`
}

/**
 * Build one writer, or `null` when the model cannot be used.
 *
 * A name a provider has no client for is caught here rather than at the first pass, so the
 * fallback decision is made before anything is written.
 */
async function buildWriter(
  options: SummarizeContextOptions,
  modelId: string,
  extra: { readonly fallbackReason?: string },
): Promise<SummaryWriter | null> {
  const credential = await options.resolveCredential(providerOf(modelId))
  if (!isUsableCredential(credential)) {
    return null
  }
  let model: LanguageModel
  try {
    model = options.model(modelId, credential)
  } catch (error) {
    if (!isUnsupportedProviderError(error)) {
      throw error
    }
    return null
  }
  return {
    modelId,
    model,
    secrets: credentialSecrets(credential),
    ...(extra.fallbackReason === undefined ? {} : { fallbackReason: extra.fallbackReason }),
  }
}

/** The budget one model gets: its resolver's answer, or the brain's default for every model. */
function budgetFor(config: ResolvedContextCompaction, modelId: string): number {
  // The same `DEFAULT_CONTEXT_TOKEN_BUDGET` the strategy falls back to, so the two cannot
  // disagree about what an unknown model gets.
  return config.tokenBudgetFor?.(modelId) ?? DEFAULT_CONTEXT_TOKEN_BUDGET
}

/**
 * The most a summary may cost (K5): the smallest of 12% of the chat model's budget, the summary
 * model's own output ceiling, and a quarter of the summary model's own budget — the room the
 * passes after the first need for the history they fold in.
 */
function summarySizeCap(
  config: ResolvedContextCompaction,
  summaryBudget: number,
  chatBudget: number,
  summaryModel: string,
): number {
  const share = Math.floor(chatBudget * SUMMARY_SIZE_RATIO)
  const output = config.maxOutputFor?.(summaryModel) ?? Number.POSITIVE_INFINITY
  const sliceRoom = Math.floor(summaryBudget * SUMMARY_SIZE_BUDGET_RATIO)
  return Math.max(MIN_SUMMARY_TOKENS, Math.min(share, output, sliceRoom))
}

/**
 * How many passes a plan of these items needs (K5).
 *
 * The planning is deliberately conservative: it assumes every pass may fold at most
 * {@link SUMMARY_SLICE_RATIO} of the summary model's budget, before any answer's real size is
 * known. That is the number the pass limit is compared against, and it is what makes the limit a
 * decision about the *model* rather than about how the run happened to go.
 *
 * Worked example — the epic's own (K5): a chat model with a 1M-token window and a summary model
 * with 200k. The chat's budget is `1,000,000 − min(maxOutput, 250,000)`, and with a 64k output
 * ceiling that is **936,000**; the summary model's is `200,000 − min(8,192, 50,000)` =
 * **191,808**. The summary's own cap is `min(12% × 936,000 = 112,320, 8,192, room)` = **8,192**,
 * and one pass's slice is `min(½ × 191,808, 191,808 − ~700 − 8,192 − 256)` ≈ **95,904**. Folding
 * ~390,000 tokens of older history therefore needs `⌈390,000 / 95,904⌉ = 5` passes, over the
 * limit of 3 — so the 1M chat model takes over, whose slice is ≈
 * `min(½ × 936,000, …)` ≈ 468,000, and folds the same history in **one** pass. (The exact count
 * moves with the two models' ceilings; the rule is that the *plan*, not the run, decides.)
 */
function planPasses(sliceBudget: number, items: readonly CappedItem[]): number {
  const total = items.reduce((sum, item) => sum + item.tokens, 0)
  return Math.max(1, Math.ceil(total / Math.max(1, sliceBudget)))
}

/**
 * How big one pass's slice may be (K5): half the summary model's budget, less what the pass
 * carries besides the slice.
 *
 * The half is the room for the answer; the two subtractions are the instructions themselves and
 * the running summary at its cap.
 */
function sliceBudgetOf(summaryBudget: number, instructionTokens: number, sizeCap: number): number {
  const half = Math.floor(summaryBudget * SUMMARY_SLICE_RATIO)
  return Math.max(
    0,
    Math.min(half, summaryBudget - instructionTokens - sizeCap - SUMMARY_INPUT_MARGIN),
  )
}

/** The summarizer's instructions, with the update clause when there is a summary to update. */
function instructionsFor(incremental: boolean, sizeCap: number): string {
  return `${SUMMARY_PROMPT}${incremental ? SUMMARY_UPDATE_CLAUSE : ''}\n\nKeep the summary under ${sizeCap} tokens.`
}

/** The covered items, each capped to a quarter of the summary model's budget (K6). */
function capItems(items: readonly ContextCutItem[], summaryBudget: number): CappedItem[] {
  const itemCap = Math.max(1, Math.floor(summaryBudget * SUMMARY_ITEM_CAP_RATIO))
  return items.map((item) => ({
    text: item.tokens > itemCap ? capItemText(item.text, itemCap) : item.text,
    tokens: Math.min(item.tokens, itemCap),
  }))
}

/** One covered item, already capped for the summarizer's input (K6). */
interface CappedItem {
  /** The text to send — cut around an omission marker when the item was over the cap. */
  readonly text: string
  /** What it costs, cap included. */
  readonly tokens: number
}

/** What one run of the passes produced: the summary text, and how many calls it took. */
interface WrittenSummary {
  readonly text: string
  readonly passes: number
}

/** What {@link runPasses} needs that {@link summarizeContext} already worked out. */
interface RunPassesOptions {
  readonly options: SummarizeContextOptions
  readonly writer: SummaryWriter
  readonly instructions: string
  readonly sliceBudget: number
  readonly sizeCap: number
  readonly planned: number
  readonly capped: readonly CappedItem[]
  readonly running: string | null
}

/**
 * Fold the covered history into a summary, one recorded model call per pass (K5).
 *
 * Answers `null` when a pass failed or the run was interrupted: the span says why and the caller
 * carries on (K11). Every pass writes its progress event first, then the request's span pair, and
 * the running totals ride with the span end — the same shape the chat's own requests have, so a
 * reader prices a summary the way it prices anything else (#247).
 *
 * The slices are the size the plan assumed, so the pass count the progress events report is the
 * count that really runs. The one exception is the fold of K5: a running summary grown past the
 * cap it was asked for is summarized alone first — **once**, which is what bounds the run — and
 * the plan added a pass for it before the first request was made.
 */
async function runPasses(state: RunPassesOptions): Promise<WrittenSummary | null> {
  const { options, writer, instructions } = state
  let totals: readonly SessionModelUsage[] = usageByModel(options.events)
  let running = state.running
  let folded = false
  let passes = 0
  let index = 0

  while (index < state.capped.length) {
    if (options.signal?.aborted === true) {
      return null
    }
    if (!folded && running !== null && estimateTokens(running) > state.sizeCap) {
      // K5: the running summary has grown until no meaningful slice fits beside it, so it is
      // summarized alone first — one pass, counted in the plan — and the slices continue
      // against a smaller summary.
      folded = true
      passes += 1
      await options.append([contextSummaryProgress(passes, state.planned)])
      const result = await onePass(options, writer, instructions, '', totals, running)
      if (result === null) {
        return null
      }
      running = result.text
      totals = result.totals
      continue
    }
    const slice: CappedItem[] = []
    let sliceTokens = 0
    while (index < state.capped.length) {
      const item = state.capped[index]
      if (item === undefined) {
        break
      }
      if (slice.length > 0 && sliceTokens + item.tokens > state.sliceBudget) {
        break
      }
      slice.push(item)
      sliceTokens += item.tokens
      index += 1
      if (sliceTokens >= state.sliceBudget) {
        break
      }
    }
    passes += 1
    await options.append([contextSummaryProgress(passes, state.planned)])
    const result = await onePass(
      options,
      writer,
      instructions,
      slice.map((item) => item.text).join('\n\n'),
      totals,
      running,
    )
    if (result === null) {
      return null
    }
    running = result.text
    totals = result.totals
  }
  return running === null ? null : { text: running, passes }
}

/** One pass's answer: the new running summary, and the totals it moved to. */
interface PassResult {
  readonly text: string
  readonly totals: readonly SessionModelUsage[]
}

/**
 * One recorded summary request: its span pair, its usage and its text.
 *
 * `payload` is the slice to fold in, or `''` for the pass that compresses the running summary
 * alone (K5). A failed, interrupted or empty answer closes the span with the error and answers
 * `null` — the log records what happened, and nothing is retried (K11).
 */
async function onePass(
  options: SummarizeContextOptions,
  writer: SummaryWriter,
  instructions: string,
  payload: string,
  totalsBefore: readonly SessionModelUsage[],
  running: string | null,
): Promise<PassResult | null> {
  const messages: ModelMessage[] = [{ role: 'system', content: instructions }]
  if (running === null) {
    messages.push({ role: 'user', content: `History to summarize:\n${payload}` })
  } else if (payload.length === 0) {
    messages.push({ role: 'user', content: `Summary so far:\n${running}` })
  } else {
    messages.push({ role: 'user', content: `Summary so far:\n${running}` })
    messages.push({ role: 'user', content: `New history:\n${payload}` })
  }
  const [start] = await options.append([spanStart([], writer.modelId, { purpose: 'summary' })])
  if (start === undefined) {
    throw new Error('the store did not return the summary span it was asked to append')
  }
  const result = await streamModelRequest({ model: writer.model, messages, signal: options.signal })
  if (result.aborted || result.error !== undefined) {
    const message = result.aborted
      ? 'The summary request was interrupted.'
      : redactSecrets(messageOf(result.error), writer.secrets)
    await options.append([
      spanEnd(start.id, ZERO_MODEL_USAGE, {
        error: { type: result.aborted ? 'interrupted' : 'model_error', message },
      }),
    ])
    return null
  }
  const text = result.text.trim()
  if (text.length === 0) {
    await options.append([
      spanEnd(start.id, result.usage, {
        error: { type: 'model_error', message: 'The summarizer returned no text.' },
      }),
    ])
    return null
  }
  const totals = withRequestUsage(totalsBefore, writer.modelId, result.usage)
  await options.append([spanEnd(start.id, result.usage), sessionUsage(totals)])
  return { text, totals }
}

/** The message to record for a failed request: the error's own, or its string form. */
function messageOf(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  const message =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined
  return typeof message === 'string' && message.length > 0 ? message : String(error)
}

/**
 * The visible conversation after `afterSeq`, as cut items: user and agent messages with text,
 * oldest first.
 *
 * Only the two message types are history the model was told or said — the same reading the
 * strategy's `conversationAfter` makes — so a span, a status transition, a progress event or
 * another summary is not something the summarizer is handed.
 */
function conversationItems(events: readonly StoredEvent[], afterSeq: number): ContextCutItem[] {
  const items: ContextCutItem[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) {
      continue
    }
    let role: 'user' | 'assistant'
    let text: string
    if (event.type === EVENT_TYPES.userMessage) {
      role = 'user'
      text = textOfBlocks(event.content)
    } else if (event.type === EVENT_TYPES.agentMessage) {
      role = 'assistant'
      text = textOfBlocks(event.content)
    } else {
      continue
    }
    if (text.length === 0) {
      continue
    }
    items.push({ seq: event.seq, role, text, tokens: estimateTokens(text) })
  }
  return items
}

/** A message's text blocks joined into the string the model reads. */
function textOfBlocks(content: readonly { readonly text: string }[]): string {
  return content.map((block) => block.text).join('')
}
