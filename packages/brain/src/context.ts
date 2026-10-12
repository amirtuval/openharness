import { DEFAULT_TOOL_RESULT_TOKENS } from '@openharness/hands'
import type { ToolRegistry } from '@openharness/hands'
import type {
  ClearedResults,
  ContextSummaryEvent,
  EventId,
  ModelConfig,
  ModelRequestPurpose,
  ModelUsage,
  RequestReminder,
  StoredEvent,
  Supersedes,
  TodoList,
  ToolResultTruncation,
  Truncation,
} from '@openharness/protocol'
import {
  EVENT_TYPES,
  isToolCallEvent,
  isToolResultEvent,
  readTodoList,
  toolCallInput,
  toolCallOfferedName,
  toolCallSource,
  toolResultCallId,
  toolResultIsError,
} from '@openharness/protocol'
import type { ModelMessage } from 'ai'

import { lastModelRequest } from './log'
import { opaqueReplayParts } from './opaque'
import type { OpaqueMessagePart, OpaqueReplayedPart, OpaqueTarget } from './opaque'
import { stuckReminder } from './stuck'

/**
 * Turning the session log into the messages a model request is made with — and measuring how
 * big that request is.
 *
 * The brain holds no conversation state: every turn rebuilds its context from the log it is
 * handed, which is what makes crash recovery and a second brain on a partition possible. How
 * that rebuild works — which events become messages, how long the history may get, what happens
 * when the context fills — is the one part of the loop a host may want to change, so it is a
 * strategy rather than a hardcoded conversion.
 *
 * Since epic #277 the log may also carry a `session.context_summary`: the older history replaced
 * *for the model* by a summary (K1). The strategy is the only reader of it — the transcript and
 * replay still show the full history — and what it builds is the system prompt, then the latest
 * summary that no rewind has superseded, then every event after the summary's `covers.to_seq`.
 * Trimming stays as the last-resort safety net, and an item too big to send at all is capped
 * rather than dropped (K6).
 *
 * Since epic #303 (X9, #306) a tool result is a *sized* thing in a request: one older than the
 * verbatim tail has its body replaced by a placeholder ("result cleared, N tokens"), and one
 * over its tool's cap carries a head and a tail around an omission marker. Both are the
 * request's alone — the stored `agent.tool_result` keeps its body, which is why replay, the
 * transcript and the summarizer still read what the tool said — and both are derived from the
 * log and a budget rather than from a decision written anywhere, so the measurement the
 * compaction trigger takes ({@link estimateContextSize}) builds the same request this does.
 * That is what makes clearing the first answer to a filling context: a context clearing alone
 * brings under the threshold is never summarized.
 */

/**
 * Build the messages for one model request out of the session's log.
 *
 * Called once per model request, with the log as that request will answer it — the pending user
 * events the request is about to claim are already part of the view (see
 * {@link ContextStrategyOptions}). It answers the messages to send **and** what it had to cut to
 * fit: the truncation record cannot be written by the strategy (the store is the loop's), so the
 * loop carries it onto the request's `span.model_request_start` (K6) — and what it cleared, which
 * the loop records beside it (X9).
 *
 * Implementations must not write: the store is the loop's to append to, and a strategy that
 * published events would put the transcript out of step with the request that produced it.
 */
export type ContextStrategy = (
  events: readonly StoredEvent[],
  options: ContextStrategyOptions,
) => ContextStrategyResult

/** What a {@link ContextStrategy} answers: the messages, and what it had to shorten. */
export interface ContextStrategyResult {
  /** The messages to send, system prompt first. */
  readonly messages: ModelMessage[]
  /**
   * The newest message was over the model's budget and was capped to a head and a tail (K6), or
   * tool results were over their cap and were shortened (X9), or absent when nothing had to be
   * cut. The loop records it on the request's span so a client can tell the user their message or
   * a tool's answer was shortened rather than silently dropped.
   */
  readonly truncated?: Truncation
  /**
   * The old tool results the request cleared, or absent when it cleared none (X9). The loop
   * records it on the request's span; the results themselves stay whole in the log.
   */
  readonly cleared?: ClearedResults
  /**
   * The reminders the request carried besides the history (#331), or absent when it carried none:
   * the session's current todo list, and the stuck reminder a streak of identical calls earns.
   * The loop records them on the request's span — the only place the log says the model was told,
   * because none of it is stored as a message.
   */
  readonly reminders?: readonly RequestReminder[]
}

/** What a {@link ContextStrategy} is told about the session it is building a context for. */
export interface ContextStrategyOptions {
  /** The model the session runs, `{ id: 'provider/model' }`. What to budget for. */
  readonly model: ModelConfig
  /** The session's system prompt, or `null` when it has none. */
  readonly system: string | null
  /**
   * The tools this turn may call, when the host wired any (epic #303, X4). Their declarations
   * carry the cap on what one result may cost a request (X9), so the strategy needs the registry
   * even for a request that offers no tools: a result from an earlier step is still capped.
   */
  readonly tools?: ToolRegistry
  /**
   * // extension: the share of the budget at which old tool results are cleared (#331);
   * {@link DEFAULT_CLEAR_THRESHOLD} when absent.
   *
   * Per request rather than baked into the strategy, because the size accounting has to read the
   * same number: the loop hands its `clearThreshold` to this and to
   * {@link estimateContextSize}, so the request it measures and the request it builds clear on
   * the same condition (#306's invariant).
   */
  readonly clearThreshold?: number
  /**
   * // extension: whether to nudge the model to write a todo list before its first tool call
   * (#331). Off when absent, which is the default everywhere: the study's benefit for showing a
   * plan is real but small, and a nudge on every turn's first request is not free.
   */
  readonly todoNudge?: boolean
  /**
   * // extension: the client family and model this request goes to, when its client reads back
   * parts only it can read (epic #303, X13; #334); absent means none of them are replayed.
   *
   * The loop computes it from the request's model id and credential type (`./opaque`) and hands
   * the same value to {@link estimateContextSize}, so the request that is measured and the
   * request that is built carry the same opaque parts.
   */
  readonly opaqueTarget?: OpaqueTarget
}

/** Characters per token in {@link estimateTokens}. Rough, and deliberately so. */
export const CHARS_PER_TOKEN = 4

/**
 * The history budget {@link createContextStrategy} trims to when a model has no budget of its
 * own. Conservative for a chat agent: it leaves room under a modern model's window for the
 * system prompt, the reply and the estimate's own error.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 32_768

/**
 * How much of the chat model's budget no **single** tool result may take (epic #303, X9): a fifth.
 *
 * A result is capped to the smaller of this and the cap its tool declares
 * ({@link DEFAULT_TOOL_RESULT_TOKENS} when it declares none), so a tool with a generous
 * declaration cannot overrun a small model's window. A fifth sits under the quarter the
 * compaction engine keeps verbatim (K4, {@link RECENT_TAIL_RATIO}), so a result at the global
 * cap still leaves the verbatim tail its room, and above the per-tool default for a model of the
 * brain's own default budget — which is what makes the tool's declaration the bound that
 * normally decides, and the model's budget the backstop.
 */
export const TOOL_RESULT_BUDGET_RATIO = 0.2

/**
 * How much of the chat model's budget the recent history keeps **verbatim** (epic #277, K4): a
 * quarter.
 *
 * Two rules are written in terms of it. The compaction engine's cut keeps about this much of the
 * conversation in full and summarizes everything older (K4), and a tool result older than the
 * tail it starts is **cleared** rather than carried (epic #303, X9): older output is the first
 * thing a request can afford to give up, and dropping it is cheaper than summarizing.
 */
export const RECENT_TAIL_RATIO = 0.25

/**
 * The share of the chat model's budget at which clearing turns on (#331): a half.
 *
 * Clearing old tool results is the first answer to a filling context (X9) — cheaper than a
 * summary, and the only answer that costs no model call — but clearing on *every* request, as
 * #306 did, throws away output a chat at 30% of its budget could still use. The study this comes
 * from stages its two levers: it elides old tool output at 0.6 of the usable window and only
 * summarizes past 0.85. Its clearing sits at 0.6/0.85 ≈ 0.71 of its summarization threshold, so
 * this one sits at the same ~0.71 of **this** deployment's 0.7 ({@link DEFAULT_COMPACTION_THRESHOLD}
 * in `./summarize`) ≈ 0.5 — a half of the budget. Below it a request carries its results as they
 * were stored (still capped, X9); at or above it, old ones are cleared, and the
 * {@link CLEAR_STEP_RATIO} step keeps the boundary still between requests (see
 * {@link resultPolicy}).
 */
export const DEFAULT_CLEAR_THRESHOLD = 0.5

/**
 * How far the clearing boundary moves when it moves (#331): a tenth of the chat model's budget.
 *
 * The boundary is a prefix of the request, and a provider's prompt cache keys on that prefix, so
 * a boundary that crept forward on every turn would invalidate the cache with it. Instead the
 * cleared span is snapped **up** to a whole step of {@link CLEAR_STEP_RATIO} of the budget (see
 * {@link clearingCut}): a step costs at most that much extra tool output, and it is a whole
 * {@link RECENT_TAIL_RATIO} — one tail — because a turn that leaves the tail does so in about a
 * tail's worth of tokens, so a step of the same size is the smallest that can hold the boundary
 * across a turn rather than follow it. The boundary therefore moves about once per tail's worth
 * of new history and holds still for the requests in between, which is what keeps the request
 * prefix — and the provider's prompt cache on it — stable.
 */
export const CLEAR_STEP_RATIO = 0.25

/**
 * What an old tool result's body is replaced by in a request (epic #303, X9; #331).
 *
 * The result keeps its place — the call it answers is still answered, so a request stays one a
 * provider accepts — and says what it cost instead of what it said, **and that the model can have
 * it back**: nothing else tells the model that a whole fetch or search it once ran is still one
 * call away, and the study's finding that a `recall` tool goes unused is what makes saying so the
 * whole of the answer rather than adding a tool for it. The stored `agent.tool_result` is
 * untouched: replay, the transcript and the summarizer still read the body, and only the request
 * the model is sent carries this.
 *
 * @param tokens what the cleared body cost
 */
export function CLEARED_TOOL_RESULT(tokens: number): string {
  return `result cleared, ${tokens} tokens — call the tool again if you need it`
}

/** How {@link createContextStrategy} budgets, per model and overall. */
export interface ContextStrategyConfig {
  /** Tokens of history every model gets, when `tokenBudgetFor` answers nothing for it. */
  readonly tokenBudget?: number
  /**
   * The budget for one model id, `provider/model`, overriding `tokenBudget`.
   *
   * A function rather than a record because the model space is not a handful of ids: the
   * server's registry holds hundreds (the bundled models.dev snapshot), and a record would
   * have to be built from all of them to answer for the one a request runs. The strategy asks
   * for that one id, and `undefined` means "budget it like every other model".
   */
  readonly tokenBudgetFor?: (modelId: string) => number | undefined
}

/**
 * The default strategy: the conversation, summarized where the log says so, trimmed to a token
 * budget, and with an oversized newest message capped.
 *
 * `user.message` and `agent.message` become `user` and `assistant` messages in `seq` order —
 * which is the whole conversation the session has had, whatever happened to it in between:
 * `user.interrupt`, status transitions, spans and a `session.rewind` are bookkeeping, not
 * things the model said or was told (a rewind's *range* is not bookkeeping either: the log the
 * brain reads has already left out what it replaced, so the model is handed the conversation
 * as the reader left it, #238). The session's `system` prompt, when it has one, becomes the
 * leading system message.
 *
 * Messages with no text (an empty `content`, which is how a model that answered with nothing
 * is recorded) are left out rather than sent as empty turns.
 *
 * ## The summary (K1)
 *
 * When the log's latest non-superseded `session.context_summary` is in `events`, the model is
 * told the summary instead of the history it covers: the summary becomes a **system** message
 * after the session's own system prompt, and only the events after its `covers.to_seq` become
 * conversation messages. The role is deliberate. The summary is not something the *user* said —
 * a `user` message would read as a fresh instruction from them, and an `assistant` one as
 * something the model itself had said — and it must survive trimming: `trimToBudget` keeps every
 * system message and drops the oldest turns first, so a system-role summary is the one message
 * the safety net can never throw away, which is exactly what the summary is for. The AI SDK
 * groups leading system messages ahead of the conversation, which is where K1 puts the summary,
 * and the wording below marks it plainly as context rather than an instruction.
 *
 * A summary a later `session.rewind` covers is ignored — the edit took the branch it summarized
 * back, so it must not be handed to the model (K1). The strategy reads that off the rewind's
 * `supersedes` range, which the replay read the brain uses would normally have applied already;
 * doing it here too keeps the rule true for a caller that hands the strategy a whole log.
 *
 * ## Trimming
 *
 * The oldest complete turns are dropped until the history fits the budget, and never the newest
 * turn: a request that dropped the question it is answering would be worse than an
 * over-budget one. A turn is two messages — one user, one assistant — so the cut lands on a
 * boundary a chat model can read, and a history that would start with an assistant message
 * loses that message too.
 *
 * ## The newest item (K6)
 *
 * Summarizing cannot help when the newest item alone is over the budget — it has to stay
 * verbatim — so it is not dropped but **capped**: a message keeps a head and a tail with an
 * {@link OMISSION_MARKER} between them (both ends carry what the other side needs), a tool
 * result keeps its beginning ({@link capResultText} — a tool said what it had to say in the
 * order it said it), and the record of what was cut is returned for the span. The newest user
 * message is never dropped, so nothing is silently lost.
 *
 * ## Tool results (X9, #306)
 *
 * A result is the one part of a request that can be arbitrarily large without anyone having
 * written it, so it is sized twice. A result older than the verbatim tail of the history — the
 * recent quarter of the budget the compaction engine keeps in full (K4) — has its body replaced
 * by {@link CLEARED_TOOL_RESULT}: old tool output is what a request can most afford to give up,
 * and giving it up is cheaper than a summary, which is why clearing happens first and why a
 * context it brings back under the threshold is never summarized at all. A result **inside** the
 * tail is capped to the smaller of its tool's declared `maxResultTokens` and a fifth of the
 * budget ({@link TOOL_RESULT_BUDGET_RATIO}) — kept from its **beginning**, with the omission
 * marker where the rest went — and every cap is recorded for the span. Neither touches the log, and neither splits a pair: the result
 * still answers its call, with a shorter answer.
 *
 * ## Tool results (X9, #306)
 *
 * A result is the one part of a request that can be arbitrarily large without anyone having
 * written it, so it is sized twice. A result older than the verbatim tail of the history — the
 * recent quarter of the budget the compaction engine keeps in full (K4) — has its body replaced
 * by {@link CLEARED_TOOL_RESULT}: old tool output is what a request can most afford to give up,
 * and giving it up is cheaper than a summary, which is why clearing happens first and why a
 * context it brings back under the threshold is never summarized at all. A result **inside** the
 * tail is capped to the smaller of its tool's declared `maxResultTokens` and a fifth of the
 * budget ({@link TOOL_RESULT_BUDGET_RATIO}), head and tail around the omission marker, and every
 * cap is recorded for the span. Neither touches the log, and neither splits a pair: the result
 * still answers its call, with a shorter answer.
 *
 * @param config the per-model budgets; see {@link DEFAULT_CONTEXT_TOKEN_BUDGET}
 */
export function createContextStrategy(config: ContextStrategyConfig = {}): ContextStrategy {
  const defaultBudget = config.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET
  const budgetFor = config.tokenBudgetFor
  return (events, options) => {
    // Per request, from the model that request runs: the loop re-reads the session at every
    // request boundary, so a switch applies to the next request's budget as well as its model.
    const budget = budgetFor?.(options.model.id) ?? defaultBudget
    const summary = latestContextSummary(events)
    return planRequest(events, options, summary, budget)
  }
}

/**
 * The strategy every turn gets when it is not given one: the default, with the default budget.
 */
export const DEFAULT_CONTEXT_STRATEGY: ContextStrategy = createContextStrategy()

/**
 * Estimate the tokens a string costs, at {@link CHARS_PER_TOKEN} characters per token.
 *
 * A real tokenizer would be exact and would add a dependency, a model lookup and a hook that
 * changes when the model does. The budget this feeds is about not sending an unbounded history,
 * not about filling a context window to the byte, so the cheap estimate is the right one.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * The real prompt size a request's stored counters describe (epic #277, K2).
 *
 * `span.model_request_end.model_usage` carries Anthropic's four **disjoint** counters, and the
 * three input-side ones are the prompt: the uncached input plus both cache halves. That is the
 * whole of "the request's actual size" — the tokens the provider really counted — and it is why
 * the counters had to be normalized per provider on the way in (`toModelUsage` in `./model`
 * reads the SDK's uncached half, so a provider whose raw `input_tokens` includes cached tokens
 * does not count them twice here).
 *
 * @param usage one request's counters, as `span.model_request_end.model_usage` stored them
 */
export function promptTokensOf(usage: ModelUsage): number {
  return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
}

/**
 * The previous request, as the size accounting's baseline (epic #277, K2).
 *
 * Only a request that says something about the *next* one may be a baseline: it has to have run
 * on the model the next request runs (each model counts tokens differently), it must not be a
 * summary request (a summary measures the summarizer's prompt, not the chat's — the
 * `purpose: 'summary'` span the compaction engine writes, C2), and its context must not have been
 * superseded by a `session.rewind` since (the branch it measured is gone). Anything else is
 * refused by {@link estimateNextRequestTokens} and the characters-per-token estimate stands in.
 */
export interface ContextSizeBaseline {
  /** The `provider/model` that request ran — `span.model_request_start.model`, or `null`. */
  readonly model: string | null
  /** What it reported, `span.model_request_end.model_usage`. */
  readonly usage: ModelUsage
  /** Why it was made, when it was not the chat's own request (`purpose: 'summary'`). */
  readonly purpose?: ModelRequestPurpose
  /** Whether a `session.rewind` has replaced its context since it ran. */
  readonly superseded?: boolean
}

/** How {@link estimateNextRequestTokens} is asked for a size. */
export interface NextRequestSizeOptions {
  /** The model the next request will run — the budget the size is measured against (K2). */
  readonly model: string
  /**
   * The previous request, or `null` when there is none. A baseline the rules refuse (a summary
   * request, another model, a superseded context) falls back to {@link estimateTokens} the same
   * way `null` does.
   */
  readonly previous?: ContextSizeBaseline | null
  /**
   * The text of the events the next request will see **since** the baseline — or the whole
   * visible history when there is none, which is what makes the fallback a real estimate rather
   * than a lower bound.
   */
  readonly since: readonly string[]
}

/**
 * Estimate how big the next request's context will be (epic #277, K2).
 *
 * The real measure where there is one: the previous request's actual prompt size
 * ({@link promptTokensOf}) plus the characters-per-token estimate for what is new since. That is
 * the number the compaction trigger compares against the threshold share of the model's budget,
 * and it is deliberately *measured*, not guessed — a context that is really 60% full must not
 * read as 40% because the guess is off.
 *
 * There is no real measure when there is no previous request, when the previous one cannot say
 * anything about this one (see {@link ContextSizeBaseline}), or when the caller has none in hand
 * — a session whose first request this is, or one stored before the spans carried usage. Then
 * the whole estimate is the characters-per-token one over `since`, which must be the entire
 * visible history in that case. The caller passes `previous: null` for one case beyond the ones
 * the rules refuse: a summary written since the baseline, because it replaced the history that
 * baseline measured, so its prompt size says nothing about the much smaller context the next
 * request is built from.
 *
 * @param options the model, the baseline and the new text; see {@link NextRequestSizeOptions}
 */
export function estimateNextRequestTokens(options: NextRequestSizeOptions): number {
  const since = options.since.reduce((total, text) => total + estimateTokens(text), 0)
  const previous = options.previous
  if (
    previous === undefined ||
    previous === null ||
    !isUsableContextSizeBaseline(previous, options.model)
  ) {
    return since
  }
  return promptTokensOf(previous.usage) + since
}

/**
 * Whether a previous request may be the next one's baseline (K2).
 *
 * The refusals are the epic's: a request on another model counts tokens differently, a summary
 * request measured the summarizer's prompt rather than the chat's, and a context a rewind has
 * replaced is not the context the next request builds on. A span start from before D9 carries no
 * `model`, and an unknown model is no model: the safer answer is the estimate, not a number
 * attributed to the wrong window.
 *
 * Exported because a caller that builds {@link NextRequestSizeOptions}`.since` has to make the
 * same decision: the new text is "what is new since the baseline" only when the baseline is
 * usable, and the whole visible history otherwise (C2's engine is that caller). Reading the rule
 * off one exported function is what keeps the two halves from drifting.
 */
export function isUsableContextSizeBaseline(previous: ContextSizeBaseline, model: string): boolean {
  return (
    previous.purpose !== 'summary' &&
    previous.superseded !== true &&
    previous.model !== null &&
    previous.model === model
  )
}

/** What the model is told about a summary. Kept next to the builder so the two cannot drift. */
function summaryIntroduction(summary: string): string {
  return `Earlier messages in this conversation were summarized to fit the model's context. Treat the summary below as the history so far, and continue from the messages that follow.\n\n${summary}`
}

/** How {@link estimateContextSize} is asked. */
export interface ContextSizeOptions {
  /** The model the next request will run — the budget the size is compared against (K2). */
  readonly model: string
  /** The session's system prompt, or `null` when it has none. */
  readonly system: string | null
  /**
   * The tools a turn may call, so the estimate counts a result as the request will carry it
   * (X9): capped to its tool's declaration. Omitted means each result counts at
   * {@link DEFAULT_TOOL_RESULT_TOKENS} — the cap a tool that declares none gets.
   */
  readonly tools?: ToolRegistry
  /**
   * The history budget of `model`, for the two caps that are measured against it (X9): the share
   * of it no single result may take, and the tail old results are cleared before. The caller
   * passes what the compaction engine is configured with (`tokenBudgetFor`), which is the same
   * resolver the strategy is given (#246); omitted means {@link DEFAULT_CONTEXT_TOKEN_BUDGET}.
   */
  readonly budget?: number
  /**
   * // extension: the share of the budget at which old tool results are cleared (#331); the
   * strategy's own `clearThreshold` when absent, so the two agree on what this request clears.
   */
  readonly clearThreshold?: number
  /**
   * // extension: whether the request would carry the off-by-default todo nudge (#331). The
   * nudge is part of the request, so it is part of the size; a caller that leaves it out measures
   * the request without it, exactly as a strategy built with no nudge builds it.
   */
  readonly todoNudge?: boolean
  /**
   * // extension: the family and model the request goes to, when its client reads back parts
   * only it can read (epic #303, X13; #334). An entry is replayed only to the family and the
   * model that produced it, so its tokens count here exactly as they will in the request — which
   * is what keeps this measurement and the strategy's request one answer (K2).
   *
   * A caller that leaves it out measures a request that carries no opaque parts. The one such
   * caller is a manual compaction's size, taken before the request's credential is resolved: the
   * number is that event's `tokens_before` alone, because a manual run skips the trigger.
   */
  readonly opaqueTarget?: OpaqueTarget
}

/**
 * How big the next request's context will be, read off the log (epic #277, K2; C2).
 *
 * The log-walking companion of {@link estimateNextRequestTokens}: a caller that only has the
 * session's events asks this, and it assembles the two inputs the estimate takes — the baseline
 * request and the text that is new since it — with the rules the module documents. The baseline
 * is the log's newest `span.model_request_end` (with the `span.model_request_start` it closes,
 * which carries the model and the purpose), and the new text is every conversation message after
 * it. When there is no usable baseline — the session's first request, a model switch, a summary
 * request, a failed summary pass, or a summary written since — the whole visible history is the
 * estimate's input: the session's system prompt, the summary in force when there is one, and the
 * messages after its `covers.to_seq`. The reminders a request carries — the todo block, a stuck
 * reminder, the nudge — ride after the history and are counted too, because the strategy sends
 * them (#331).
 *
 * The result is a token count, not a decision: the trigger that compares it against a share of
 * the chat model's budget is the compaction engine's (C2).
 *
 * What it measures is the request as the **default strategy would build it** (X9): a tool result
 * beyond its cap counts as the capped text, and one older than the verbatim tail counts as the
 * placeholder that replaces it. That is what makes clearing the first answer to a filling context
 * — a context that clearing alone brings under the threshold is never summarized (X9), because
 * the trigger never sees a size that needs one. Since #331 clearing is itself gated (see
 * {@link clearingBoundary}), and the estimate reads the same gate the strategy does, so the two
 * still describe one request.
 *
 * @param events the session's log, as {@link readLog} handed it over
 * @param options the model the next request runs, and the session's system prompt
 */
export function estimateContextSize(
  events: readonly StoredEvent[],
  options: ContextSizeOptions,
): number {
  return measureRequest(events, options, clearingBoundary(events, options))
}

/**
 * The size of the request as the strategy builds it, with the results older than `clearBefore`
 * cleared (X9; #331).
 *
 * Factored out of {@link estimateContextSize} so {@link clearingBoundary} can measure the same
 * request **without** clearing: comparing that size to the soft threshold is what decides whether
 * clearing turns on, and it has to be the size the request would have if nothing were cleared, or
 * the decision would depend on its own outcome.
 */
function measureRequest(
  events: readonly StoredEvent[],
  options: ContextSizeOptions,
  clearBefore: number,
): number {
  const baseline = lastModelRequest(events)
  const summary = latestContextSummary(events)
  const summarySinceBaseline = summary !== null && (baseline === null || summary.seq > baseline.seq)
  const previous: ContextSizeBaseline | null =
    baseline === null
      ? null
      : {
          model: baseline.model,
          usage: baseline.usage,
          ...(baseline.purpose === undefined ? {} : { purpose: baseline.purpose }),
          superseded: isSuperseded(events, baseline.seq),
        }
  const usable =
    previous !== null &&
    !summarySinceBaseline &&
    isUsableContextSizeBaseline(previous, options.model)
  const afterSeq = summary === null ? 0 : summary.covers.to_seq
  const results = resultPolicy(
    events,
    afterSeq,
    options.budget ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
    options.tools,
    clearBefore,
  )
  const since =
    usable && baseline !== null
      ? messageTextsAfter(events, baseline.seq, results, options.opaqueTarget ?? null)
      : visibleHistoryTexts(events, options.system, summary, results, options.opaqueTarget ?? null)
  // The reminders ride after the history (see {@link requestReminders}); they are part of the
  // request and so part of its size.
  since.push(...reminderTexts(events, options))
  return estimateNextRequestTokens({
    model: options.model,
    previous: usable ? previous : null,
    since,
  })
}

/**
 * The `seq` results older than which the next request clears, or `0` when it clears none (#331).
 *
 * Two conditions, in order:
 *
 * 1. **The gate.** Clearing turns on only once the request would be at or above
 *    {@link DEFAULT_CLEAR_THRESHOLD} of the budget — measured with the results as stored, capped
 *    but not cleared, so the decision is the same everywhere and does not depend on itself. Below
 *    it a request carries its old results whole, which is the whole point of the threshold: a chat
 *    at 30% of its budget used to lose them for nothing.
 * 2. **The boundary.** The cut K4's rule already gives — everything older than the verbatim tail —
 *    snapped to a step ({@link clearingCut}) so consecutive requests keep the same prefix.
 */
function clearingBoundary(events: readonly StoredEvent[], options: ContextSizeOptions): number {
  const budget = options.budget ?? DEFAULT_CONTEXT_TOKEN_BUDGET
  const threshold = options.clearThreshold ?? DEFAULT_CLEAR_THRESHOLD
  if (measureRequest(events, options, 0) < budget * threshold) {
    return 0
  }
  const summary = latestContextSummary(events)
  const afterSeq = summary === null ? 0 : summary.covers.to_seq
  const items = conversationItems(events, afterSeq, toolResultCap(options.tools, budget))
  const cut = clearingCut(items, budget)
  return cut <= 0 ? 0 : (items[cut]?.seq ?? 0)
}

/**
 * Where clearing cuts the conversation: the first item the request keeps, snapped to a step of
 * the budget so it holds still between requests (#331).
 *
 * The plain boundary is everything older than the verbatim tail (`cutAtUserBoundary`, K4). That
 * boundary follows the tail, so a turn of new history nudges it forward — and since it sits at the
 * front of the request, which is exactly what a provider's prompt cache keys on, each nudge
 * invalidates the cache behind it. So the cleared span is rounded **up** to a whole
 * {@link CLEAR_STEP_RATIO} step of the budget: the cut is the last safe position at most a step
 * boundary's worth of tokens into the history. The grid is a property of the log's prefix, which
 * only grows at the end, so a move of less than a step does not move the boundary — it holds for
 * the requests in between and then jumps by a whole step. It is derived from the log and the
 * budget alone, so a second brain on a partition computes the same one.
 *
 * Exported because it is the rule the two sides that must agree read: the strategy cuts here, and
 * {@link estimateContextSize} measures the same request the same way.
 *
 * @param items the visible conversation, as {@link conversationItems} measured it
 * @param budget the chat model's history budget
 */
export function clearingCut(items: readonly ContextCutItem[], budget: number): number {
  const tailTokens = Math.floor(budget * RECENT_TAIL_RATIO)
  const plain = cutAtUserBoundary(items, tailTokens)
  if (plain <= 0) {
    return 0
  }
  const step = Math.max(1, Math.floor(budget * CLEAR_STEP_RATIO))
  const cleared = tokensBefore(items, plain)
  // With the step a whole tail, the round-up can reach `total` but never past it: a step is no
  // more than the tail, and the plain cut clears at most that much less than the whole history.
  const target = Math.ceil(cleared / step) * step
  const candidate = lastIndexAtMost(items, target)
  const cut = Math.max(widenToSafeCut(items, candidate), plain)
  // A cut that would clear the newest turn is not one the strategy may build; fall back to the
  // plain boundary, which never does.
  return cut <= 0 || cut >= items.length ? plain : cut
}

/** What the items before `index` cost together (X9's capped sizes). */
function tokensBefore(items: readonly ContextCutItem[], index: number): number {
  let total = 0
  for (let position = 0; position < index && position < items.length; position += 1) {
    total += items[position]?.tokens ?? 0
  }
  return total
}

/** The largest index whose tokens before it are at most `target` — `0` when even the first is over. */
function lastIndexAtMost(items: readonly ContextCutItem[], target: number): number {
  let total = 0
  let index = 0
  while (index < items.length && total + (items[index]?.tokens ?? 0) <= target) {
    total += items[index]?.tokens ?? 0
    index += 1
  }
  return index
}

/**
 * Move a cut back to a position the strategy may build: the start of a turn, with no result left
 * behind whose call it clears.
 *
 * The same two rules {@link cutAtUserBoundary} applies, here on an index the stepping chose: a
 * tail has to begin at a `user.message`, and a call and the result that answers it may not be
 * separated by it (#306). A candidate that is neither walks back until it is both.
 */
function widenToSafeCut(items: readonly ContextCutItem[], index: number): number {
  const at = pairPositions(items)
  let cut = Math.min(index, items.length)
  let moved = true
  while (moved && cut > 0) {
    const before = cut
    while (cut > 0 && items[cut]?.role !== 'user') {
      cut -= 1
    }
    cut = Math.min(cut, splitByPair(items, at, cut))
    moved = cut < before
  }
  return cut
}

/**
 * The reminder texts a request carries besides the history (#331).
 *
 * The one place both the strategy and {@link estimateContextSize} build them, so the request that
 * is measured and the request that is built carry the same blocks. See {@link requestReminders}.
 */
function reminderTexts(
  events: readonly StoredEvent[],
  options: { readonly todoNudge?: boolean },
): readonly string[] {
  return requestReminders(events, options).texts
}

/** The reminders a request carries: the texts to send, and the record for its span (#331). */
interface RequestReminders {
  /** One block per reminder, in the order they are sent after the history. */
  readonly texts: readonly string[]
  /** What the loop records on the request's `span.model_request_start`. */
  readonly records: readonly RequestReminder[]
}

/**
 * Build the reminders a request carries after its history (#331).
 *
 * Three things, all rebuilt from the log per request and none of them stored as a message:
 *
 * - **The current todo list** (`readTodoList`), when the session has a non-empty one. The list
 *   lives only as the newest `todo_write` call's own input, so once a summary covers that call it
 *   would exist for the model only as prose; sending it every request is what keeps the plan in
 *   front of the model. An empty list — a model that cleared it — sends nothing.
 * - **The stuck reminder** a streak of identical calls earns ({@link stuckReminder}, #331).
 * - **The nudge** to write a list, when it is enabled and the session has neither a list nor a
 *   tool call yet — the moment before a task's first step, which is when a plan is worth asking
 *   for.
 */
function requestReminders(
  events: readonly StoredEvent[],
  options: { readonly todoNudge?: boolean },
): RequestReminders {
  const list = readTodoList(events)
  const texts: string[] = []
  const records: RequestReminder[] = []
  if (list !== null && list.length > 0) {
    const text = todoBlockText(list)
    texts.push(text)
    records.push({ kind: 'todo', tokens: estimateTokens(text) })
  } else if (options.todoNudge === true && !hasToolCall(events)) {
    texts.push(TODO_NUDGE)
    records.push({ kind: 'todo', tokens: estimateTokens(TODO_NUDGE) })
  }
  const stuck = stuckReminder(events)
  if (stuck !== null) {
    texts.push(stuck.text)
    records.push({ kind: 'stuck', tokens: estimateTokens(stuck.text) })
  }
  return { texts, records }
}

/** The block the model is shown of its current todo list (#331). */
function todoBlockText(list: TodoList): string {
  const lines = list.map(
    (item) =>
      `${item.status === 'done' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]'} ${item.content}`,
  )
  return [
    'Your current todo list (keep it up to date with todo_write as you work):',
    ...lines,
  ].join('\n')
}

/** The one-line nudge to write a list, sent only when the off-by-default setting is on (#331). */
const TODO_NUDGE =
  'If this task has several steps, call todo_write first to write the list down and track it.'

/** Whether the log holds any tool call at all — built-in or remote (#312). */
function hasToolCall(events: readonly StoredEvent[]): boolean {
  return events.some(isToolCallEvent)
}

/** The text of every conversation message after `afterSeq`, oldest first. */
function messageTextsAfter(
  events: readonly StoredEvent[],
  afterSeq: number,
  results: ToolResultPolicy,
  opaque: OpaqueTarget | null,
): string[] {
  return conversationAfter(events, afterSeq, results, opaque).messages.map((entry) =>
    textOfMessage(entry.message),
  )
}

/**
 * Everything the next request would be sent, when no baseline can describe it: the system
 * prompt, the summary in force, and the messages after it (K1/K2).
 */
function visibleHistoryTexts(
  events: readonly StoredEvent[],
  system: string | null,
  summary: ContextSummaryEvent | null,
  results: ToolResultPolicy,
  opaque: OpaqueTarget | null,
): string[] {
  const texts: string[] = []
  if (system !== null && system.length > 0) {
    texts.push(system)
  }
  if (summary !== null) {
    texts.push(summaryIntroduction(summary.summary))
  }
  texts.push(
    ...messageTextsAfter(events, summary === null ? 0 : summary.covers.to_seq, results, opaque),
  )
  return texts
}

/** Whether a `session.rewind` in `events` covers `seq`. */
function isSuperseded(events: readonly StoredEvent[], seq: number): boolean {
  for (const event of events) {
    if (
      event.type === EVENT_TYPES.sessionRewind &&
      seq >= event.supersedes.from_seq &&
      seq <= event.supersedes.to_seq
    ) {
      return true
    }
  }
  return false
}

/**
 * The newest summary no rewind has superseded, or `null` when the log has none (K1).
 *
 * A rewind that reaches back before a summary replaces it along with the rest of the tail it
 * covered, so the summary is not handed to the model. The range is read off the `session.rewind`
 * events in `events`; the store's replay read would normally have removed the covered events
 * already, and doing it here as well is what keeps the rule true whatever the caller passed.
 *
 * Exported because the compaction engine (C2) reads the same event: it updates the latest
 * summary rather than starting over, so "which summary is in force" has to have one answer.
 */
export function latestContextSummary(events: readonly StoredEvent[]): ContextSummaryEvent | null {
  const ranges: Supersedes[] = []
  for (const event of events) {
    if (event.type === EVENT_TYPES.sessionRewind) {
      ranges.push(event.supersedes)
    }
  }
  let latest: ContextSummaryEvent | null = null
  for (const event of events) {
    if (event.type !== EVENT_TYPES.sessionContextSummary) {
      continue
    }
    if (ranges.some((range) => event.seq >= range.from_seq && event.seq <= range.to_seq)) {
      continue
    }
    if (latest === null || event.seq > latest.seq) {
      latest = event
    }
  }
  return latest
}

/** One conversation message, with the `seq` of the event it came from — for K6's record. */
interface ConversationMessage {
  readonly message: ModelMessage
  readonly seq: number
}

/** One item of the visible conversation, as a cut rule sees it. */
export interface ContextCutItem {
  /** The `seq` of the event the text came from. */
  readonly seq: number
  /** The role the model reads it under; a tool result is `tool`, and carries `pairSeq`. */
  readonly role: 'user' | 'assistant' | 'tool'
  /** The message's text. */
  readonly text: string
  /** Its size, at {@link estimateTokens}. */
  readonly tokens: number
  /**
   * For a tool result, the `seq` of the `agent.tool_use` it answers (epic #303, X9): a cut never
   * leaves the two on opposite sides, because a request a provider accepts answers every call it
   * carries, in the message right behind it.
   */
  readonly pairSeq?: number
}

/**
 * Where may history be cut? Returns the index of the first item to keep verbatim; everything
 * before it is what a summary covers, and what a request clears old results before. An index of
 * `0` (or `items.length`) means "nowhere".
 *
 * This is K12's one replaceable function, and the whole of the answer to "what may the model be
 * told in summary instead of in full?". Two rules are the default's, not the caller's: keep a
 * recent tail of about `tailTokens`, and never split a model turn — nor, since #306, a tool call
 * from the result that answers it.
 */
export type ContextCutRule = (items: readonly ContextCutItem[], tailTokens: number) => number

/**
 * The default cut rule: the smallest recent tail that reaches `tailTokens`, widened to start at a
 * `user.message` and to keep every call with its result (K4; #306).
 *
 * A turn is a user message and the reply to it, so a cut that landed between the two would hand
 * the model an answer to a question it cannot see. Walking back from the newest item to the first
 * `user.message` is therefore not a refinement but the rule: the kept tail always begins with
 * what the user asked.
 *
 * A tool call and the result that answers it are one answer, split by neither cut nor block
 * boundary: a tail that began at the result of a call the covered part holds would make the
 * request that follows the summary one no provider accepts — a `tool` message answering a call
 * nothing introduced. So the cut is widened **back** to the call whenever the walk, or the
 * ascend, would leave a result behind and its call ahead. A steering message that arrived between
 * the two (a user message the log holds between a call and its answer) is exactly the case that
 * would otherwise become a cut point: the ascend stops on it, and this widening walks past it to
 * the call. The two rules alternate until neither moves, because widening can expose another
 * split.
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
  // Ascend to the user message that opens the turn the tail would otherwise start inside, and
  // widen back over a pair the ascend (or the walk) would have split — until neither moves.
  const pairStart = pairPositions(items)
  let moved = true
  while (moved && index > 0) {
    const before = index
    while (index > 0 && items[index]?.role !== 'user') {
      index -= 1
    }
    index = Math.min(index, splitByPair(items, pairStart, index))
    moved = index < before
  }
  return index
}

/** For every item, the position of the call it answers — what {@link splitByPair} reads. */
function pairPositions(items: readonly ContextCutItem[]): Map<number, number> {
  const at = new Map<number, number>()
  items.forEach((item, position) => at.set(item.seq, position))
  return at
}

/**
 * Move a cut back so it leaves no result behind whose call it keeps covered.
 *
 * `index` is where the tail would start; a result at or after it whose call sits before it is a
 * split — the request built from the tail would answer a call it does not carry — so the answer
 * is the position of the earliest such call.
 */
function splitByPair(
  items: readonly ContextCutItem[],
  at: ReadonlyMap<number, number>,
  index: number,
): number {
  let cut = index
  for (let position = index; position < items.length; position += 1) {
    const call = items[position]?.pairSeq
    if (call === undefined) {
      continue
    }
    const callAt = at.get(call)
    if (callAt !== undefined && callAt < cut) {
      cut = callAt
    }
  }
  return cut
}

/**
 * The visible conversation after `afterSeq`, as cut items: user and agent messages, the calls the
 * model made and the results it was answered with, oldest first.
 *
 * This is the log as a *reader* sees it — the strategy's `conversationAfter` with one item per
 * event rather than one message per turn — because the two questions asked of it are positional:
 * how big is this, and where may it be cut? A tool result names the call it answers in `pairSeq`,
 * which is what keeps a cut from separating them (#306).
 *
 * A result's item costs what a **request** would carry of it, capped by `cap` — not what the log
 * holds (X9). A stored result that is unbounded would otherwise stretch the tail walk over the
 * whole history, and a history nobody can cut is a history nobody can clear either: a session
 * dominated by one enormous old fetch would never summarize and never clear, which is the case
 * clearing exists for. The text an item carries is still the stored one, because that is what a
 * summarizer folds and what a cut's pair rule is about.
 *
 * @param events the session's log, as {@link readLog} handed it over
 * @param afterSeq the last `seq` already covered by a summary, or `0`
 * @param cap what one result may cost this request, by the tool it came from
 */
export function conversationItems(
  events: readonly StoredEvent[],
  afterSeq: number,
  cap: ToolResultCap,
): ContextCutItem[] {
  const calls = toolCallsOf(events)
  const items: ContextCutItem[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) {
      continue
    }
    let role: 'user' | 'assistant' | 'tool'
    let text: string
    let tool = ''
    let pairSeq: number | undefined
    if (event.type === EVENT_TYPES.userMessage || event.type === EVENT_TYPES.agentMessage) {
      role = event.type === EVENT_TYPES.userMessage ? 'user' : 'assistant'
      text = textOf(event.content)
    } else if (isToolCallEvent(event)) {
      role = 'assistant'
      text = toolCallText(toolCallOfferedName(event), toolCallInput(event))
    } else if (isToolResultEvent(event)) {
      // A built-in tool and a remote one read the same way: the pair is what a cut must keep
      // together, and the name is what the result's cap is keyed by (X9, #312).
      role = 'tool'
      const call = calls.get(toolResultCallId(event))
      pairSeq = call?.seq
      tool = call?.name ?? ''
      text = toolResultText(tool, textOf(event.content), toolResultIsError(event))
    } else {
      continue
    }
    if (text.length === 0) {
      // A message the model said nothing in (an empty `content`, the way a reply that carried
      // only calls is stored) is not history the summarizer can read, exactly as the strategy
      // leaves it out of the request.
      continue
    }
    const tokens = estimateTokens(text)
    items.push({
      seq: event.seq,
      role,
      text,
      tokens: role === 'tool' ? Math.min(tokens, cap(tool)) : tokens,
      ...(pairSeq === undefined ? {} : { pairSeq }),
    })
  }
  return items
}

/**
 * Every call in the log, by the event id that names it — built-in and remote alike, the name
 * being the one the model called the tool by (a remote tool's offered name, #312).
 */
function toolCallsOf(
  events: readonly StoredEvent[],
): Map<EventId, { readonly seq: number; readonly name: string }> {
  const calls = new Map<EventId, { readonly seq: number; readonly name: string }>()
  for (const event of events) {
    if (isToolCallEvent(event)) {
      calls.set(event.id, { seq: event.seq, name: toolCallOfferedName(event) })
    }
  }
  return calls
}

/** One tool call, as the summarizer reads it. */
function toolCallText(name: string, input: unknown): string {
  return `Tool call ${name}: ${JSON.stringify(input)}`
}

/** One tool result, as the summarizer reads it — what it was, and whether it failed. */
function toolResultText(name: string, text: string, isError: boolean): string {
  const tool = name.length === 0 ? 'a tool' : name
  return `Tool result from ${tool}${isError ? ' (error)' : ''}: ${
    text.length > 0 ? text : EMPTY_TOOL_RESULT
  }`
}

/**
 * What a request does with the tool results it carries (epic #303, X9; #306).
 *
 * Two transformations, chosen per result by where it sits and how big it is, and both invisible
 * to the log: the stored `agent.tool_result` keeps its body, and only the messages the model is
 * sent carry the shorter form. Deriving it from the log and the budget — rather than recording a
 * decision anywhere — is what lets {@link estimateContextSize} measure the same request the
 * strategy is about to build.
 */
interface ToolResultPolicy {
  /** The `seq` results older than which are cleared; `0` clears nothing. */
  readonly clearBefore: number
  /** The most one result may cost, by the tool it came from. */
  readonly capFor: (tool: string) => number
}

/**
 * The policy one request applies, read off the log it will be built from (X9; #331).
 *
 * The clearing boundary is decided by {@link clearingBoundary} — the soft threshold's gate and
 * the stepped cut — and handed in, so the same decision reaches the request that is measured and
 * the request that is built. "Old" is still the verbatim tail of K4: everything older than the
 * recent quarter of the budget, now cleared only once the context is past the soft threshold.
 */
function resultPolicy(
  events: readonly StoredEvent[],
  afterSeq: number,
  budget: number,
  tools: ToolRegistry | undefined,
  clearBefore: number,
): ToolResultPolicy {
  return { clearBefore, capFor: toolResultCap(tools, budget) }
}

/** What one tool result may cost a request: its tool's cap, under the budget's share (X9). */
export type ToolResultCap = (tool: string) => number

/**
 * How much of one result a request may carry (X9): the smaller of what its tool declares and the
 * share of the model's budget no single result may take.
 *
 * The declaration is the tool's own judgement about its output — a search's answer against a
 * fetch's page — and the budget share is the backstop that keeps a generous declaration from
 * overrunning a small model's window. A tool the registry does not hold (an id a rewind or a
 * summary took the call of) counts as one that declared nothing.
 *
 * Exported because the two places that measure a result have to give the same answer: the
 * strategy that caps one, and the compaction engine that decides where the verbatim tail begins
 * (the items both cut on are measured with it).
 */
export function toolResultCap(tools: ToolRegistry | undefined, budget: number): ToolResultCap {
  const share = Math.max(1, Math.floor(budget * TOOL_RESULT_BUDGET_RATIO))
  return (tool) => {
    const declared = tools?.get(tool)?.maxResultTokens ?? DEFAULT_TOOL_RESULT_TOKENS
    return Math.max(1, Math.min(declared, share))
  }
}

/** What one result becomes in a request, and what that cost the log's own text. */
interface PlannedToolResult {
  readonly text: string
  /** Set when the result was over its cap and was cut (X9). */
  readonly truncation?: ToolResultTruncation
  /** Set when the result was old and its body was cleared: what the body cost. */
  readonly cleared?: number
}

/**
 * Decide what one result's place in a request is (X9): cleared, capped, or as it was stored.
 *
 * Clearing comes first: a result old enough to be cleared is not worth capping, and the
 * placeholder is the smaller answer of the two. A result the tool said nothing in is reported as
 * {@link EMPTY_TOOL_RESULT} rather than as an empty text block, which a provider refuses.
 */
function planToolResult(
  policy: ToolResultPolicy,
  seq: number,
  tool: string,
  text: string,
): PlannedToolResult {
  const raw = text.length > 0 ? text : EMPTY_TOOL_RESULT
  const tokens = estimateTokens(raw)
  if (policy.clearBefore > 0 && seq < policy.clearBefore) {
    return { text: CLEARED_TOOL_RESULT(tokens), cleared: tokens }
  }
  const cap = policy.capFor(tool)
  if (tokens <= cap) {
    return { text: raw }
  }
  const capped = capResultText(raw, cap)
  return {
    text: capped,
    truncation: {
      seq,
      tool: tool.length === 0 ? 'unknown' : tool,
      tokens_before: tokens,
      tokens_after: estimateTokens(capped),
    },
  }
}

/** Everything the strategy builds, before it is turned into the result. */
function planRequest(
  events: readonly StoredEvent[],
  options: ContextStrategyOptions,
  summary: ContextSummaryEvent | null,
  budget: number,
  tools: ToolRegistry | undefined,
): ContextStrategyResult {
  const { system, tools } = options
  const systemMessages: ModelMessage[] = []
  if (system !== null && system.length > 0) {
    systemMessages.push({ role: 'system', content: system })
  }
  if (summary !== null) {
    systemMessages.push({ role: 'system', content: summaryIntroduction(summary.summary) })
  }
  // What the model is told about history it no longer sees, after the system prompt and before
  // the messages that follow it.
  const afterSeq = summary === null ? 0 : summary.covers.to_seq
  // What this request does with the tool results it carries (X9; #331): an old one's body is
  // cleared once the context is past the soft threshold, a fresh oversized one is capped.
  // Derived from the log and the budget, so the measurement the compaction trigger takes builds
  // the same request this does.
  const sizeOptions: ContextSizeOptions = {
    model: options.model.id,
    system,
    ...(tools === undefined ? {} : { tools }),
    budget,
    ...(options.clearThreshold === undefined ? {} : { clearThreshold: options.clearThreshold }),
    ...(options.todoNudge === undefined ? {} : { todoNudge: options.todoNudge }),
    ...(options.opaqueTarget === undefined ? {} : { opaqueTarget: options.opaqueTarget }),
  }
  const clearBefore = clearingBoundary(events, sizeOptions)
  const results = resultPolicy(events, afterSeq, budget, tools, clearBefore)
  const built = conversationAfter(events, afterSeq, results, options.opaqueTarget ?? null)

  const trimmed = trimToBudget(systemMessages, built.messages, budget)
  const capped = capNewest(trimmed, budget)
  const truncated = truncationRecord(capped.truncated, built.truncatedResults)
  // The reminders ride after the history: outside the trimmed turns, so the plan survives the
  // budget cut, and outside the log, so nothing here becomes a message (#331).
  const reminders = requestReminders(events, options)
  const messages = [...systemMessages, ...capped.messages.map((entry) => entry.message)]
  if (reminders.texts.length > 0) {
    messages.push({ role: 'user', content: reminders.texts.join('\n\n') })
  }
  return {
    messages,
    ...(truncated === null ? {} : { truncated }),
    ...(built.cleared.results === 0 ? {} : { cleared: built.cleared }),
    ...(reminders.records.length === 0 ? {} : { reminders: reminders.records }),
  }
}

/**
 * The one truncation record a request's span carries (K6; X9).
 *
 * The newest item the request shortened, and every tool result it capped. `capNewest` answers
 * the first when a message was capped — the record the span has always carried — and a request
 * that capped only tool results names the newest of them, so the record always names an event
 * and what it cost. Both halves together are the request's whole account of what it shortened:
 * a client reads `seq`/`tokens_before`/`tokens_after` for the notice it has always shown and
 * `results` for the ones the tools paid.
 */
function truncationRecord(
  newest: Truncation | null,
  results: readonly ToolResultTruncation[],
): Truncation | null {
  if (newest === null && results.length === 0) {
    return null
  }
  const capped = results.length === 0 ? {} : { results: [...results] }
  if (newest !== null) {
    return { ...newest, ...capped }
  }
  const last = results[results.length - 1]
  if (last === undefined) {
    return null
  }
  return {
    seq: last.seq,
    tokens_before: last.tokens_before,
    tokens_after: last.tokens_after,
    ...capped,
  }
}

/**
 * The conversation the log holds after `afterSeq`, as model messages.
 *
 * A tool step is three kinds of event and two messages. The assistant's turn is its
 * `agent.message` (the text it streamed) and its `agent.tool_use` events (the calls it made),
 * together in one assistant message — text parts first, then the calls, which is the order a
 * provider reads them in — and the answers are one `tool` message whose parts name the calls
 * they belong to.
 *
 * **The answers go directly behind the turn that made the calls**, even when the log put
 * something between them. It can: a steering message arrives while a tool is running, so the
 * log holds the call, then the user's message, then the result — and a provider refuses an
 * assistant turn whose calls are not answered by the very next message. Moving the result up
 * is the honest reading of the two: the call was answered before the model was asked anything
 * else, and the steering message is answered by the request after it, which is where the log
 * puts it too. A log that never interleaves is unaffected — the insertion point is where the
 * result already was.
 *
 * A turn with no calls keeps the plain `{ role: 'assistant', content: text }` shape it has
 * always had, so a log stored before tools existed replays as exactly the request it built
 * then.
 *
 * What a result *says* is the policy's to decide (X9): an old one carries
 * {@link CLEARED_TOOL_RESULT} instead of its body, and one over its tool's cap carries a head and
 * a tail with an omission marker between them. The log is untouched either way; what is collected
 * here is what the request had to do, which the caller returns for the request's span.
 *
 * ## The step's opaque parts (epic #303, X13; #334)
 *
 * An `agent.opaque_content` event's parts are re-attached to the assistant message of the step
 * that produced them, **in the order the provider wrote them** — a `thinking` block, then the
 * text, then the `tool_use` it reasoned about, then the text that reads its answer, which is the
 * order each part's own `text_before` offset records (epic #303, X14; #335) — and only when the
 * request goes to the family and model that produced them (`./opaque`). An entry that does not
 * replay is left out entirely, so a model or provider switch builds the assistant turn it built
 * before #334: no parts, the model's own text and calls; an entry whose parts carry no offset —
 * a log written before the order was recorded — lays them all ahead of the text, exactly as it
 * did then.
 *
 * **Every** matching step's parts are replayed, not only the newest turn's: the
 * OpenAI-compatible family needs the key on each assistant turn of a thinking-mode conversation
 * (`./opaque` has the whole of it), and keeping them all is the contiguous window Anthropic's
 * preserved-thinking check accepts — a block dropped from the middle is what it refuses.
 * Nothing here caps or clears a part: they are not text, and the log's own size cap dropped any
 * oversized one before it was stored.
 */
function conversationAfter(
  events: readonly StoredEvent[],
  afterSeq: number,
  results: ToolResultPolicy,
  opaque: OpaqueTarget | null,
): BuiltConversation {
  const messages: ConversationMessage[] = []
  const toolNames = toolNamesOf(events)
  // The provider-executed calls the log holds, by id (#335): neither they nor their answers
  // belong in a request — the step's opaque content carries them — so both are skipped below.
  const provider = providerCallIds(events)
  // Every call the user's answers have settled, by the event id that names it (#309). A call with
  // no result is one still waiting on the user: the turn that made it paused instead of asking
  // again (turn.ts), so a request never carries it, and this is what keeps that true here — a
  // provider refuses an assistant turn whose calls are not answered by the very next message, so
  // a pending call is left out rather than sent as a call nothing answers.
  const answered = answeredCalls(events)
  let assistant: AssistantTurn | null = null
  // Where the current turn's answers belong: right after the assistant message, or the end of
  // the list while no turn with calls has been closed. See the note above about interleaving.
  let answers: { index: number; seq: number; parts: ToolResultPart[] } | null = null
  // What the request had to do to the results it carries (X9), collected as they are built.
  const truncatedResults: ToolResultTruncation[] = []
  let cleared: ClearedResults = { results: 0, tokens: 0 }

  const closeAssistant = (): void => {
    if (assistant === null) {
      return
    }
    const { seq, text, calls, parts } = assistant
    assistant = null
    // A call still waiting on the user is not part of the request (see `answered` above).
    const settled = calls.filter((call) => answered.has(call.toolCallId))
    if (settled.length === 0 && parts.length === 0) {
      if (text.length > 0) {
        messages.push({ message: { role: 'assistant', content: text }, seq })
      }
      return
    }
    const content: AssistantContent = [...orderedAssistantParts(text, parts)]
    content.push(...settled)
    messages.push({ message: { role: 'assistant', content }, seq })
    if (settled.length > 0) {
      answers = { index: messages.length, seq, parts: [] }
    }
  }
  /** Put the pending answers where they belong, adding the `tool` message if it is there yet. */
  const flushAnswers = (): void => {
    if (answers === null || answers.parts.length === 0) {
      return
    }
    const at = answers.index
    const existing = at < messages.length ? messages[at] : undefined
    if (existing?.message.role === 'tool') {
      messages[at] = { message: { role: 'tool', content: answers.parts }, seq: answers.seq }
      return
    }
    messages.splice(at, 0, {
      message: { role: 'tool', content: answers.parts },
      seq: answers.seq,
    })
  }

  for (const event of events) {
    if (event.seq <= afterSeq) {
      continue
    }
    switch (event.type) {
      case EVENT_TYPES.userMessage: {
        closeAssistant()
        // Not flushed here: a call the user's message arrived in front of is still answered
        // behind it, and the `tool` message is inserted before the user message when it lands.
        const text = textOf(event.content)
        if (text.length > 0) {
          messages.push({ message: { role: 'user', content: text }, seq: event.seq })
        }
        break
      }
      case EVENT_TYPES.agentMessage: {
        flushAnswers()
        const text = textOf(event.content)
        if (assistant === null) {
          assistant = { seq: event.seq, text, calls: [], parts: [] }
        } else {
          assistant.text += text
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          if (toolCallSource(event) === 'provider') {
            // A call the provider ran inside its own request (epic #303, X14; #335). It is **not**
            // part of the request this builds: the provider's own call and answer are in the
            // step's `agent.opaque_content`, and replaying both would send the same call twice —
            // once as a `tool_use` of ours and once as the `server_tool_use` the provider
            // recognizes, which the provider refuses. The pair is a record for a reader; this is
            // where the request is told so.
            break
          }
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [], parts: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (event.type === EVENT_TYPES.agentOpaqueContent) {
          // The step's own opaque parts (X13; #334): the ones this request may carry back, each
          // with the place in the step's text the log recorded — it is the step's assistant
          // message they belong to, opened here when the step streamed no text at all, which is
          // exactly the tool-calling step this exists for.
          const parts = opaqueReplayParts(event, opaque)
          if (parts.length > 0) {
            assistant ??= { seq: event.seq, text: '', calls: [], parts: [] }
            assistant.parts.push(...parts)
          }
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          if (provider.has(callId)) {
            // The answer to a provider-executed call (X14; #335): like the call, it is already in
            // the step's opaque content, and a `tool_result` for a `tool_use` the request does
            // not carry is what every provider refuses.
            break
          }
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [], parts: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (event.type === EVENT_TYPES.agentOpaqueContent) {
          // The step's own opaque parts (X13; #334): the ones this request may carry back, and
          // it is the step's assistant message they belong to — opened here when the step
          // streamed no text at all, which is exactly the tool-calling step this exists for.
          const parts = opaqueReplayParts(event, opaque)
          if (parts.length > 0) {
            assistant ??= { seq: event.seq, text: '', calls: [], parts: [] }
            assistant.parts.push(...parts)
          }
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      default: {
        // A tool call or its answer, whichever pair it belongs to (#312): the request builder
        // reads them through the one abstraction so a remote call is a call like any other.
        if (isToolCallEvent(event)) {
          flushAnswers()
          assistant ??= { seq: event.seq, text: '', calls: [] }
          assistant.calls.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName: toolCallOfferedName(event),
            input: toolCallInput(event),
          })
        } else if (isToolResultEvent(event)) {
          const callId = toolResultCallId(event)
          closeAssistant()
          answers ??= { index: messages.length, seq: event.seq, parts: [] }
          const raw = textOf(event.content)
          const tool = toolNames.get(callId) ?? ''
          // What the request carries instead of the result exactly as it was stored (X9): an old
          // result's body is cleared, a fresh oversized one is capped. The pair is untouched
          // either way — the call stays answered, with a shorter answer.
          const planned = planToolResult(results, event.seq, tool, raw)
          answers.parts.push({
            type: 'tool-result',
            toolCallId: callId,
            toolName: tool,
            output: toolResultIsError(event)
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
          })
          if (planned.truncation !== undefined) {
            truncatedResults.push(planned.truncation)
          }
          if (planned.cleared !== undefined) {
            cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
          }
          flushAnswers()
        }
        break
      }
      case EVENT_TYPES.agentToolUse: {
        flushAnswers()
        assistant ??= { seq: event.seq, text: '', calls: [] }
        assistant.calls.push({
          type: 'tool-call',
          toolCallId: event.id,
          toolName: event.name,
          input: event.input,
        })
        break
      }
      case EVENT_TYPES.agentToolResult: {
        closeAssistant()
        answers ??= { index: messages.length, seq: event.seq, parts: [] }
        const raw = textOf(event.content)
        const tool = toolNames.get(event.tool_use_id) ?? ''
        // What the request carries instead of the result exactly as it was stored (X9): an old
        // result's body is cleared, a fresh oversized one is capped. The pair is untouched
        // either way — the call stays answered, with a shorter answer.
        const planned = planToolResult(results, event.seq, tool, raw)
        answers.parts.push({
          type: 'tool-result',
          toolCallId: event.tool_use_id,
          toolName: tool,
          output:
            event.is_error === true
              ? { type: 'error-text', value: planned.text }
              : { type: 'text', value: planned.text },
        })
        if (planned.truncation !== undefined) {
          truncatedResults.push(planned.truncation)
        }
        if (planned.cleared !== undefined) {
          cleared = { results: cleared.results + 1, tokens: cleared.tokens + planned.cleared }
        }
        flushAnswers()
        break
      }
      default:
        break
    }
  }
  closeAssistant()
  flushAnswers()
  return { messages, truncatedResults, cleared }
}

/** What building one request's conversation produced: the messages, and what it did to results. */
interface BuiltConversation {
  readonly messages: ConversationMessage[]
  /** The tool results the request capped, oldest first (X9). */
  readonly truncatedResults: readonly ToolResultTruncation[]
  /** How many results it cleared, and what they cost before (X9). */
  readonly cleared: ClearedResults
}

/** Every call's name, by the event id that names it — the log's whole set of calls, not a tail. */
function toolNamesOf(events: readonly StoredEvent[]): Map<EventId, string> {
  const names = new Map<EventId, string>()
  for (const event of events) {
    if (isToolCallEvent(event)) {
      names.set(event.id, toolCallOfferedName(event))
    }
  }
  return names
}

/** The ids of the calls the log answers — the calls a request may carry (see `conversationAfter`). */
function answeredCalls(events: readonly StoredEvent[]): Set<string> {
  const answered = new Set<string>()
  for (const event of events) {
    if (isToolResultEvent(event)) {
      answered.add(toolResultCallId(event))
    }
  }
  return answered
}

/** The provider-executed calls the log holds, by id (epic #303, X14; #335). */
function providerCallIds(events: readonly StoredEvent[]): Set<string> {
  const provider = new Set<string>()
  for (const event of events) {
    if (isToolCallEvent(event) && toolCallSource(event) === 'provider') {
      provider.add(event.id)
    }
  }
  return provider
}

/**
 * What a tool that said nothing is reported as.
 *
 * A provider refuses a text block with no text in it, and a `tool` message with no part at all
 * would leave its call unanswered — which is the one thing a provider refuses outright. A
 * result event whose content is empty (nothing this build produces, but a log is a log) is
 * therefore reported as this one sentence rather than as something that cannot be sent.
 */
const EMPTY_TOOL_RESULT = '(no output)'

/** An assistant message's content, as the parts `conversationAfter` builds. */
type AssistantContent = Extract<ModelMessage, { role: 'assistant' }>['content']

/**
 * One assistant turn being rebuilt: the `agent.message` text, the calls, and the opaque parts
 * an `agent.opaque_content` event contributed (X13; #334).
 */
interface AssistantTurn {
  readonly seq: number
  text: string
  readonly calls: ToolCallPart[]
  /**
   * The replayed opaque parts, in the provider's own order, each with the place in the text the
   * log recorded for it (X13; #334; the order: #335).
   */
  readonly parts: OpaqueReplayedPart[]
}

/**
 * The step's own blocks in the order the provider produced them: the text pieces it wrote
 * around its thinking and its provider-executed calls, and those parts between them (epic #303,
 * X13/X14; #334, #335).
 *
 * A provider requires its assistant content back in the order it wrote it — text, then the
 * `server_tool_use` it reasoned about, then the `web_search_tool_result` that answers it, then
 * the text that reads it — so each replayed part carries the character offset in the step's
 * text that came before it ({@link OpaqueReplayedPart}) and the text is split there. A part that
 * led the step carries `0`, and a log written before the offsets existed carries none on any
 * part, so every part is laid ahead of the whole text — the order #334 established, which is
 * what an old entry must keep replaying as.
 *
 * Nothing is added where the text is empty: a step that streamed none contributes its parts
 * alone, exactly as it did before there was an order to keep.
 */
function orderedAssistantParts(
  text: string,
  parts: readonly OpaqueReplayedPart[],
): readonly OpaqueMessagePart[] {
  const content: OpaqueMessagePart[] = []
  let cursor = 0
  for (const { part, textBefore } of parts) {
    // Clamped to the text this step really carries: an offset past its end — a log nothing this
    // build writes — puts the part after the text rather than inventing characters.
    const at = Math.min(Math.max(textBefore, cursor), text.length)
    if (at > cursor) {
      content.push({ type: 'text', text: text.slice(cursor, at) })
      cursor = at
    }
    content.push(part)
  }
  if (cursor < text.length) {
    content.push({ type: 'text', text: text.slice(cursor) })
  }
  return content
}

/** One call inside an assistant message. */
type ToolCallPart = Extract<
  Extract<AssistantContent, readonly unknown[]>[number],
  { type: 'tool-call' }
>

/** One answer inside a `tool` message. */
type ToolResultPart = Extract<
  Extract<ModelMessage, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>

/** A message's blocks joined into the string a model reads. */
function textOf(content: readonly { readonly text: string }[]): string {
  return content.map((block) => block.text).join('')
}

/**
 * Drop the oldest turns until the history fits `budget`, keeping every system message — the
 * session prompt and the summary alike — and the newest turn always. See
 * {@link createContextStrategy}.
 *
 * A **turn** is a `user` message and everything that answers it, tool calls and results
 * included, so the cut lands where a conversation can be read from and never between a call
 * and its result: a request whose `tool` message lost the `assistant` message that made the
 * calls names ids nothing introduced, which providers refuse. Anything before the first user
 * message is an answer to nothing — a summary cut or a rewind that took the question back —
 * and is dropped first.
 */
function trimToBudget(
  system: readonly ModelMessage[],
  conversation: readonly ConversationMessage[],
  budget: number,
): ConversationMessage[] {
  const tokensOf = (list: readonly ConversationMessage[]): number =>
    list.reduce((total, entry) => total + estimateTokens(textOfMessage(entry.message)), 0)
  const systemTokens = system.reduce(
    (total, message) => total + estimateTokens(textOfMessage(message)),
    0,
  )
  let turns = turnsOf(conversation)
  if (turns[0]?.[0]?.message.role !== 'user') {
    // A history that opens with a reply reads as an answer to nothing — a summary cut or a
    // rewind that took the question back — so it goes, budget or no budget.
    turns = turns.slice(1)
  }
  let total = systemTokens + tokensOf(flatten(turns))
  while (total > budget && turns.length > 1) {
    turns = turns.slice(1)
    total = systemTokens + tokensOf(flatten(turns))
  }
  return flatten(turns)
}

/**
 * The conversation cut into turns: each starts at a `user` message, and anything before the
 * first one is a turn of its own so that it can be dropped as the orphan it is.
 */
function turnsOf(
  conversation: readonly ConversationMessage[],
): readonly (readonly ConversationMessage[])[] {
  const turns: ConversationMessage[][] = []
  for (const entry of conversation) {
    if (entry.message.role === 'user' || turns.length === 0) {
      turns.push([])
    }
    turns[turns.length - 1]?.push(entry)
  }
  return turns
}

/** The messages of these turns, in order. */
function flatten(turns: readonly (readonly ConversationMessage[])[]): ConversationMessage[] {
  return turns.flatMap((turn) => [...turn])
}

/**
 * The marker a capped item carries where its middle was: how many tokens are not there (K6).
 *
 * @param tokens the tokens the marker stands for
 */
export function OMISSION_MARKER(tokens: number): string {
  return `[… ${tokens} tokens omitted …]`
}

/**
 * The text of one message, whatever shape its content has.
 *
 * It is the size measure the budget is kept in, so everything a provider is really sent is
 * counted: a tool call's arguments are counted as their JSON (the arguments a model wrote, and
 * what it wrote them into), a result as the text it carries, and an opaque part as its text and
 * its payload — a signature or an encrypted payload really is input tokens the request pays for
 * (epic #303, X13; K2). Counting only `text` parts would make a step of four calls look free and
 * let a history trim later than it should.
 */
function textOfMessage(message: ModelMessage): string {
  const content = message.content
  if (typeof content === 'string') {
    return content
  }
  let text = ''
  for (const part of content) {
    if (part.type === 'text') {
      text += part.text
    } else if (part.type === 'reasoning') {
      text += `${part.text}${part.providerOptions === undefined ? '' : JSON.stringify(part.providerOptions)}`
    } else if (part.type === 'tool-call') {
      text += `${part.toolName}${JSON.stringify(part.input)}`
    } else if (part.type === 'tool-result') {
      text += outputTextOf(part.output)
    }
  }
  return text
}

/** The text a tool result's output carries, whatever kind of output it is. */
function outputTextOf(output: ToolResultPart['output']): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'execution-denied':
      return output.reason ?? ''
    case 'content':
      return output.value.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  }
}

/** What capping the newest item produced: the messages, and the record (or `null`). */
interface CappedNewest {
  readonly messages: ConversationMessage[]
  readonly truncated: Truncation | null
}

/**
 * Cap the newest item to `budget` tokens when it alone is over it (K6).
 *
 * The newest message is the one item a request cannot do without — it is the question being
 * asked, or the reply the next one follows — so it is never dropped, only shortened: a head and
 * a tail of it, with {@link OMISSION_MARKER} between. The record says which event was cut and
 * what it cost, which is what the loop puts on the span for a client to show the user.
 *
 * The item is capped to the same budget the history is trimmed to, so the cap cannot itself be
 * what makes the request overflow.
 */
function capNewest(conversation: readonly ConversationMessage[], budget: number): CappedNewest {
  const newest = conversation[conversation.length - 1]
  if (newest === undefined) {
    return { messages: [...conversation], truncated: null }
  }
  // Only a message that is one block of text is capped. An assistant turn carrying tool calls
  // and a `tool` message answer calls by id, and shortening one part of either means deciding
  // which call's text to cut by how much — a decision this safety net must not make, because the
  // `tool` message answers calls the assistant message introduced and the two have to stay one
  // request. A tool result is capped **before** it gets here instead, at its tool's cap (X9,
  // #306): every result in a request is at most the share of the budget no single result may
  // take, so a `tool` message can no longer be the item that is over the whole budget, which is
  // why this rule has nothing left to do for one.
  if (typeof newest.message.content !== 'string') {
    return { messages: [...conversation], truncated: null }
  }
  const text = newest.message.content
  const tokensBefore = estimateTokens(text)
  if (tokensBefore <= budget) {
    return { messages: [...conversation], truncated: null }
  }
  const content = capText(text, budget, tokensBefore)
  const messages = [...conversation]
  messages[messages.length - 1] = {
    // A string-content message is a user or assistant one (`conversationAfter`), so the capping
    // preserves the role it found.
    message:
      newest.message.role === 'user' ? { role: 'user', content } : { role: 'assistant', content },
    seq: newest.seq,
  }
  return {
    messages,
    truncated: {
      seq: newest.seq,
      tokens_before: tokensBefore,
      tokens_after: estimateTokens(content),
    },
  }
}

/**
 * Cut one item's text to at most `budget` tokens, around an {@link OMISSION_MARKER} (K6).
 *
 * The same cut the strategy applies to an oversized newest message, exposed because the
 * compaction engine caps each item it feeds a summarizer with the same rule (K6): a single huge
 * message must not swallow a whole pass. The record a request's span carries is the strategy's
 * own business; this answers the text alone.
 *
 * @param text the item's text
 * @param budget the most tokens the result may cost, marker included
 */
export function capItemText(text: string, budget: number): string {
  return capText(text, budget, estimateTokens(text))
}

/**
 * Cut a **tool result** to at most `budget` tokens, keeping its **beginning** (X9; #314).
 *
 * A capped result is not a capped message, and the difference is where its meaning is. A
 * message is the reader's own words or the model's reply, and both ends of it carry what the
 * other side needs — the question and the constraint it ends with — which is why K6 keeps a head
 * *and* a tail. A tool result is what a tool said, in the order it said it: a `web_fetch` page's
 * main content, a search's hits, a list's first items. Its beginning is the part to keep, and a
 * tail kept at the beginning's expense is a fragment from the middle of a page that reads as if
 * it were the answer (#314: the ynet page's headline was cut away and the model was handed the
 * page's footer instead).
 */
function capResultText(text: string, budget: number): string {
  return capText(text, budget, estimateTokens(text), 'head')
}

/**
 * `text` cut to at most `budget` tokens, with {@link OMISSION_MARKER} where the rest went.
 *
 * What is kept is the caller's decision and it is the whole of the difference between the two
 * cuts: a **message** keeps a head and a tail (`both`), because both ends carry what the other
 * side needs, and a **tool result** keeps its beginning (`head`), because a tool said what it had
 * to say in the order it said it ({@link capResultText}).
 *
 * The marker's own size is reserved first, at the widest the count it will carry could be, so the
 * result is inside the budget whatever the omitted number turns out to be. A budget too small for
 * the marker alone gives the marker by itself — it is the smallest honest statement that text was
 * left out.
 *
 * @param text the text to cut
 * @param budget the most tokens the answer may cost, marker included
 * @param tokensBefore what `text` costs, in the same estimate
 * @param keep which end (or ends) of `text` survives
 */
function capText(
  text: string,
  budget: number,
  tokensBefore: number,
  keep: 'both' | 'head' = 'both',
): string {
  const reserved = estimateTokens(OMISSION_MARKER(tokensBefore))
  const keepChars = Math.max(0, budget - reserved) * CHARS_PER_TOKEN
  const headChars = keep === 'head' ? keepChars : Math.ceil(keepChars / 2)
  const tailChars = keep === 'head' ? 0 : Math.max(0, keepChars - headChars)
  const head = text.slice(0, headChars)
  const tail = tailChars === 0 ? '' : text.slice(text.length - tailChars)
  // The count the marker reports is what the item cost minus what is left of it — the marker's
  // own tokens included, since they are what replaced the middle. One pass is enough: the count's
  // digit width is all the second pass could change, and it is bounded by `reserved`.
  let omitted = Math.max(0, tokensBefore - estimateTokens(head + tail))
  let content = head + OMISSION_MARKER(omitted) + tail
  omitted = Math.max(0, tokensBefore - estimateTokens(content))
  content = head + OMISSION_MARKER(omitted) + tail
  return content
}
