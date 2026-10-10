import type {
  ContextSummaryEvent,
  EventId,
  ModelConfig,
  ModelRequestPurpose,
  ModelUsage,
  StoredEvent,
  Supersedes,
  Truncation,
} from '@openharness/protocol'
import { EVENT_TYPES } from '@openharness/protocol'
import type { ModelMessage } from 'ai'

import { lastModelRequest } from './log'

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
 */

/**
 * Build the messages for one model request out of the session's log.
 *
 * Called once per model request, with the log as that request will answer it — the pending user
 * events the request is about to claim are already part of the view (see
 * {@link ContextStrategyOptions}). It answers the messages to send **and** what it had to cut to
 * fit: the truncation record cannot be written by the strategy (the store is the loop's), so the
 * loop carries it onto the request's `span.model_request_start` (K6).
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
   * absent when nothing had to be cut. The loop records it on the request's span so a client can
   * tell the user their message was shortened rather than silently dropped.
   */
  readonly truncated?: Truncation
}

/** What a {@link ContextStrategy} is told about the session it is building a context for. */
export interface ContextStrategyOptions {
  /** The model the session runs, `{ id: 'provider/model' }`. What to budget for. */
  readonly model: ModelConfig
  /** The session's system prompt, or `null` when it has none. */
  readonly system: string | null
}

/** Characters per token in {@link estimateTokens}. Rough, and deliberately so. */
export const CHARS_PER_TOKEN = 4

/**
 * The history budget {@link createContextStrategy} trims to when a model has no budget of its
 * own. Conservative for a chat agent: it leaves room under a modern model's window for the
 * system prompt, the reply and the estimate's own error.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 32_768

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
 * verbatim — so it is not dropped but **capped** to a head and a tail with an
 * {@link OMISSION_MARKER} between them, and the record of what was cut is returned for the span.
 * The newest user message is never dropped, so nothing is silently lost.
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
    return planRequest(events, options.system, summary, budget)
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
 * messages after its `covers.to_seq`.
 *
 * The result is a token count, not a decision: the trigger that compares it against a share of
 * the chat model's budget is the compaction engine's (C2).
 *
 * @param events the session's log, as {@link readLog} handed it over
 * @param options the model the next request runs, and the session's system prompt
 */
export function estimateContextSize(
  events: readonly StoredEvent[],
  options: ContextSizeOptions,
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
  const since =
    usable && baseline !== null
      ? messageTextsAfter(events, baseline.seq)
      : visibleHistoryTexts(events, options.system, summary)
  return estimateNextRequestTokens({
    model: options.model,
    previous: usable ? previous : null,
    since,
  })
}

/** The text of every conversation message after `afterSeq`, oldest first. */
function messageTextsAfter(events: readonly StoredEvent[], afterSeq: number): string[] {
  return conversationAfter(events, afterSeq).map((entry) => textOfMessage(entry.message))
}

/**
 * Everything the next request would be sent, when no baseline can describe it: the system
 * prompt, the summary in force, and the messages after it (K1/K2).
 */
function visibleHistoryTexts(
  events: readonly StoredEvent[],
  system: string | null,
  summary: ContextSummaryEvent | null,
): string[] {
  const texts: string[] = []
  if (system !== null && system.length > 0) {
    texts.push(system)
  }
  if (summary !== null) {
    texts.push(summaryIntroduction(summary.summary))
  }
  texts.push(...messageTextsAfter(events, summary === null ? 0 : summary.covers.to_seq))
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

/** Everything the strategy builds, before it is turned into the result. */
function planRequest(
  events: readonly StoredEvent[],
  system: string | null,
  summary: ContextSummaryEvent | null,
  budget: number,
): ContextStrategyResult {
  const systemMessages: ModelMessage[] = []
  if (system !== null && system.length > 0) {
    systemMessages.push({ role: 'system', content: system })
  }
  if (summary !== null) {
    systemMessages.push({ role: 'system', content: summaryIntroduction(summary.summary) })
  }
  // What the model is told about history it no longer sees, after the system prompt and before
  // the messages that follow it.
  const conversation = conversationAfter(events, summary === null ? 0 : summary.covers.to_seq)

  const trimmed = trimToBudget(systemMessages, conversation, budget)
  const capped = capNewest(trimmed, budget)
  return {
    messages: [...systemMessages, ...capped.messages.map((entry) => entry.message)],
    ...(capped.truncated === null ? {} : { truncated: capped.truncated }),
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
 */
function conversationAfter(
  events: readonly StoredEvent[],
  afterSeq: number,
): ConversationMessage[] {
  const messages: ConversationMessage[] = []
  const toolNames = new Map<EventId, string>()
  let assistant: { seq: number; text: string; calls: ToolCallPart[] } | null = null
  // Where the current turn's answers belong: right after the assistant message, or the end of
  // the list while no turn with calls has been closed. See the note above about interleaving.
  let answers: { index: number; seq: number; parts: ToolResultPart[] } | null = null

  const closeAssistant = (): void => {
    if (assistant === null) {
      return
    }
    const { seq, text, calls } = assistant
    assistant = null
    if (calls.length === 0) {
      if (text.length > 0) {
        messages.push({ message: { role: 'assistant', content: text }, seq })
      }
      return
    }
    const content: AssistantContent = []
    if (text.length > 0) {
      content.push({ type: 'text', text })
    }
    content.push(...calls)
    messages.push({ message: { role: 'assistant', content }, seq })
    answers = { index: messages.length, seq, parts: [] }
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
          assistant = { seq: event.seq, text, calls: [] }
        } else {
          assistant.text += text
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
        toolNames.set(event.id, event.name)
        break
      }
      case EVENT_TYPES.agentToolResult: {
        closeAssistant()
        answers ??= { index: messages.length, seq: event.seq, parts: [] }
        const text = textOf(event.content)
        answers.parts.push({
          type: 'tool-result',
          toolCallId: event.tool_use_id,
          toolName: toolNames.get(event.tool_use_id) ?? '',
          output:
            event.is_error === true
              ? { type: 'error-text', value: text.length > 0 ? text : EMPTY_TOOL_RESULT }
              : { type: 'text', value: text.length > 0 ? text : EMPTY_TOOL_RESULT },
        })
        flushAnswers()
        break
      }
      default:
        break
    }
  }
  closeAssistant()
  flushAnswers()
  return messages
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
 * what it wrote them into), and a result as the text it carries. Counting only `text` parts
 * would make a step of four calls look free and let a history trim later than it should.
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
  // and a `tool` message answer calls by id — shortening their parts means deciding which
  // call's result to shorten by how much, which is the tool-aware capping of #306 rather than
  // this safety net. A request that is over budget because of a tool result is still sent: the
  // trimming above has already dropped every older turn, and a provider that refuses it ends
  // the turn with the overflow path's clear error rather than a request nobody can read.
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
 * `text` cut to a head and a tail that together cost at most `budget` tokens, with
 * {@link OMISSION_MARKER} for the middle.
 *
 * The marker's own size is reserved first, at the widest the count it will carry could be, so the
 * result is inside the budget whatever the omitted number turns out to be. A budget too small for
 * the marker alone gives the marker by itself — it is the smallest honest statement that text was
 * left out.
 */
function capText(text: string, budget: number, tokensBefore: number): string {
  const reserved = estimateTokens(OMISSION_MARKER(tokensBefore))
  const keepChars = Math.max(0, budget - reserved) * CHARS_PER_TOKEN
  const headChars = Math.ceil(keepChars / 2)
  const tailChars = Math.max(0, keepChars - headChars)
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
