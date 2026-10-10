import type { AppendableEvent } from '@openharness/session'
import type {
  ContextSummaryCovers,
  ContextSummaryReason,
  EventId,
  ModeReference,
  ModelRequestPurpose,
  ModelUsage,
  ReasoningEffortRun,
  SessionCompactionOutcome,
  SessionError,
  SessionModelUsage,
  SpanError,
  Supersedes,
  TextBlock,
  ToolInput,
  ToolPermission,
  ToolReference,
  Truncation,
} from '@openharness/protocol'
import { EVENT_TYPES } from '@openharness/protocol'

/**
 * The events a turn appends, built in one place.
 *
 * Every event the loop writes carries only the fields the caller owns — the store assigns `id`,
 * `seq` and `processed_at` — so these builders are what keeps the wire shapes in one file
 * instead of spread over the loop's branches. The exact order they are written in is the
 * lifecycle the package documents; these are just the pieces.
 *
 * Since D9 (issue #46) three of the pieces carry more than their own payload: the span start
 * lists the user events it claims (`consumes`) and the model that served it, the chunks of a
 * reply are stored events of their own, and the event that finishes a reply `supersedes` the
 * chunk range it replaces.
 */

/** The agent started working. Opens a turn. */
export function statusRunning(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRunning }
}

/**
 * The agent finished its turn. Closes one, whatever the reason.
 *
 * `consumes` claims the queued user events the turn is ending on, when no other event did.
 * That is the `user.interrupt` events (P4): an interrupt that arrived with no model request
 * running — before the turn opened, between two requests, or during a backoff — has no span
 * start to claim it, so the `session.status_idle` that ends the turn does. It is also the
 * `user.message` events of a request that could not be made for lack of a provider credential
 * (epic #65, A5): that turn opens no span, so this idle event claims them — left queued, the
 * scheduler would run the same failing turn again. Omitted when the list is empty: a turn that
 * ends on its own claims nothing.
 */
export function statusIdle(consumes?: readonly EventId[]): AppendableEvent {
  return {
    type: EVENT_TYPES.sessionStatusIdle,
    stop_reason: { type: 'end_turn' },
    ...(consumes === undefined || consumes.length === 0 ? {} : { consumes: [...consumes] }),
  }
}

/** The turn hit a transient error and is waiting to be resumed. */
export function statusRescheduled(): AppendableEvent {
  return { type: EVENT_TYPES.sessionStatusRescheduled }
}

/** Something went wrong during the turn; `error.retry_status` says what happens next. */
export function sessionError(error: SessionError): AppendableEvent {
  return { type: EVENT_TYPES.sessionError, error }
}

/**
 * A model request started — and, since D9, the claim on the user events it answers.
 *
 * `consumes` is the append's claim: the ids of the pending `user.message` / `user.interrupt`
 * events this request folds in. The store records a claim per id in the same transaction, and
 * refuses the whole append (`ClaimConflictError`) when an id is not a pending user event of the
 * session — so two brains can never own the same message. `model` is the `provider/model` that
 * serves the request, recorded per request so a session that changes models keeps, for every
 * request, the model that actually ran.
 *
 * Every span start is a real model request: since P4 an interrupt is never claimed by a span of
 * its own, so there is no such thing as a span start without a request behind it.
 *
 * `reasoning_effort` records what the log asked the request to run with and what it ran with,
 * for the requests that were asked for an effort at all (#252). It is one value because it is
 * one fact about one request: `applied` is what the model actually took, and it is `null` when
 * the model takes none — an effort asked for and not applied is exactly what the log has to be
 * able to say.
 *
 * `mode` records the mode a request ran under and the name it had then (#245, M6). It is
 * written only when the session followed a mode, and the resolved model and effort are the
 * `model`/`reasoning_effort` above — so the two fields beside it say what the mode resolved to,
 * and a later rename or edit does not rewrite what this request ran.
 *
 * `truncated` records what the context strategy had to cap to fit the model's budget (epic
 * #277, K6), written only when the newest message alone was over it. The strategy answers the
 * record and the loop writes it, because the store is the loop's: see {@link SpanStartOptions}.
 *
 * @param consumes the ids of the pending user events this request answers; `[]` claims nothing
 * @param model the model id (`provider/model`) the request is made with
 * @param options what else the request ran with, each absent when it does not apply
 */
export function spanStart(
  consumes: readonly EventId[],
  model: string,
  options: SpanStartOptions = {},
): AppendableEvent {
  const { reasoningEffort, mode, truncated, purpose, tools } = options
  return {
    type: EVENT_TYPES.modelRequestStart,
    consumes: [...consumes],
    model,
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(mode === undefined ? {} : { mode: { id: mode.id, name: mode.name } }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools: [...tools] }),
  }
}

/** What {@link spanStart} carries beyond the messages the request claims. */
export interface SpanStartOptions {
  /**
   * The effort the log asked this request for and what it ran with (#252), or `undefined` when
   * nothing was asked — which is every request of a session that never set one.
   */
  readonly reasoningEffort?: ReasoningEffortRun
  /**
   * The mode this request ran under — its id and current name (#245, M6), or `undefined` for a
   * request that ran without one.
   */
  readonly mode?: ModeReference
  /**
   * What the context strategy had to cap to fit the model's budget (epic #277, K6), or
   * `undefined` when the newest message fit. The strategy answers it; the loop is the one that
   * can write it, which is why it travels here rather than being written by the strategy.
   */
  readonly truncated?: Truncation
  /**
   * Why this request was made, when it is not the chat's own (epic #277, C2): `'summary'` marks
   * a request the compaction engine made. Omitted for every ordinary request, and the field the
   * size accounting reads to refuse a summary request as a baseline (K2).
   */
  readonly purpose?: ModelRequestPurpose
  /**
   * The tools this request offered the model (epic #303, X1), or `undefined` when it offered
   * none — a deployment with no registry, a model that cannot call tools, or a request the
   * compaction engine made. The offer is what the span records, so a step that called nothing
   * still says what it could have called.
   */
  readonly tools?: readonly ToolReference[]
}

/**
 * The compaction engine started a pass: how many are done and how many the plan holds (C2,
 * #279).
 *
 * Stored, not stream-only — everything a client is shown goes in the log (D9) — so a client that
 * reconnects mid-compaction sees the same progress as one that was watching, and a reader of the
 * session later can tell that a summary took more than one call.
 *
 * @param pass the pass that is starting, counting from 1
 * @param passes how many passes the plan holds for the model doing the work
 */
export function contextSummaryProgress(pass: number, passes: number): AppendableEvent {
  return { type: EVENT_TYPES.sessionContextSummaryProgress, pass, passes }
}

/**
 * The older history, summarized (epic #277, K1; C2).
 *
 * Supersedes nothing: the log, transcript and replay stay whole, and the only reader is the
 * context strategy. `covers.to_seq` is the last event the summary replaces **for the model**, so
 * the next request is built from the summary and the events after it. See the protocol's
 * `ContextSummaryEventSchema` for what each field records.
 *
 * @param summary the summary text
 * @param covers the last event the summary replaces for the model, inclusive
 * @param reason why it was made — the trigger, or the provider's refusal (K2)
 * @param record the model, prompt version, pass count and fallback the engine produced it with
 */
export function contextSummary(
  summary: string,
  covers: ContextSummaryCovers,
  reason: ContextSummaryReason,
  record: ContextSummaryRecord,
): AppendableEvent {
  return {
    type: EVENT_TYPES.sessionContextSummary,
    summary,
    covers,
    reason,
    tokens_before: record.tokensBefore,
    summary_model: record.summaryModel,
    prompt_version: record.promptVersion,
    passes: record.passes,
    ...(record.fallbackReason === undefined ? {} : { fallback_reason: record.fallbackReason }),
  }
}

/** What {@link contextSummary} carries beside the text: how and by whom it was written. */
export interface ContextSummaryRecord {
  /** The context size when the summary was made, on the chat model (K10). */
  readonly tokensBefore: number
  /** The `provider/model` that wrote the summary — the summary model, or the fallback. */
  readonly summaryModel: string
  /** The version of the prompt that produced it (K7). */
  readonly promptVersion: string
  /** How many passes it took (K5). */
  readonly passes: number
  /** Why the chat model summarized instead of the chosen summary model, if it did (K3/K5). */
  readonly fallbackReason?: string
}

/** What {@link compactionOutcome} carries beside the outcome itself. */
export interface CompactionOutcomeRecord {
  /** The request's guidance, echoed when it carried any (K8), so the log records it was used. */
  readonly instructions?: string
  /** For `summarized`, the `seq` of the `session.context_summary` that was written. */
  readonly summarySeq?: number
  /** For `nothing_to_summarize` or `failed`, a sentence a client can show. */
  readonly message?: string
}

/**
 * The brain's answer to a manual compaction request (`/compact [instructions]`; epic #277, K8).
 *
 * Written once per pending `session.compact`, whatever came of it. It supersedes nothing and
 * claims nothing — the request is not a user event — and it is what makes the request no longer
 * pending, so a client reads the outcome from the log or the stream. See the protocol's
 * `SessionCompactionEventSchema` for what each field records.
 *
 * @param outcome what came of the compaction
 * @param record the guidance used, the summary's `seq` when one was written, and why not
 */
export function compactionOutcome(
  outcome: SessionCompactionOutcome,
  record: CompactionOutcomeRecord = {},
): AppendableEvent {
  return {
    type: EVENT_TYPES.sessionCompaction,
    outcome,
    ...(record.instructions === undefined ? {} : { instructions: record.instructions }),
    ...(record.summarySeq === undefined ? {} : { summary_seq: record.summarySeq }),
    ...(record.message === undefined ? {} : { message: record.message }),
  }
}

/** What {@link spanEnd} carries beyond the request it closes. */
export interface SpanEndOptions {
  /**
   * Why the request ended without a reply. Written with `is_error: true`; omitted for a
   * request that completed normally.
   */
  readonly error?: SpanError
  /**
   * The chunk range this span end replaces, when the request left stored chunks behind that
   * no `agent.message` will replace — an interrupt before any text was stored, a failure
   * mid-stream, a crash a recovering brain is closing. Replay skips the orphaned range (see
   * {@link agentMessage}).
   */
  readonly supersedes?: Supersedes
  /**
   * The `user.interrupt` events this span end claims (P4): an interrupt that cut the request
   * short is answered by the request's end — no model was called for it — so its ids are
   * claimed here rather than by a span of their own. Omitted (or empty) claims nothing.
   */
  readonly consumes?: readonly EventId[]
}

/**
 * A model request finished — always written, whatever happened to the request.
 *
 * See {@link SpanEndOptions} for what the call can carry beyond the usage: the error that
 * closed the span, the chunk range it supersedes, and the interrupts it claims.
 */
export function spanEnd(
  modelRequestStartId: EventId,
  modelUsage: ModelUsage,
  options: SpanEndOptions = {},
): AppendableEvent {
  const { error, supersedes, consumes } = options
  return {
    type: EVENT_TYPES.modelRequestEnd,
    model_request_start_id: modelRequestStartId,
    model_usage: modelUsage,
    is_error: error === undefined ? null : true,
    ...(error === undefined ? {} : { error }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(consumes === undefined || consumes.length === 0 ? {} : { consumes: [...consumes] }),
  }
}

/**
 * The session's running totals, after a request that reported usage (epic #245, A2; #247).
 *
 * Written by the brain rather than derived by the reader: the fold over the log's spans is
 * something the writer already has in hand, and storing it means a client watching a long turn
 * reads the session's cost off the stream instead of re-deriving it from every span end.
 *
 * It is **cumulative**, not per request — `models` is the session's whole history per model, each
 * entry with the token counters and how many requests produced them. It carries no cost: cost is
 * computed when it is read, from these tokens and the model catalog's prices, and is never written
 * into the log (epic #245). The request counts are a fact about the log rather than about money —
 * they say nothing about prices — which is what lets a reader of the running totals count the
 * requests a model nobody prices leaves unpriced (#247).
 *
 * @param models the session's tokens per model, as {@link usageByModel} folds them
 */
export function sessionUsage(models: readonly SessionModelUsage[]): AppendableEvent {
  const sum = (pick: (usage: ModelUsage) => number): number =>
    models.reduce((total, entry) => total + pick(entry.usage), 0)
  return {
    type: EVENT_TYPES.sessionUsage,
    input_tokens: sum((usage) => usage.input_tokens),
    output_tokens: sum((usage) => usage.output_tokens),
    cache_creation_input_tokens: sum((usage) => usage.cache_creation_input_tokens),
    cache_read_input_tokens: sum((usage) => usage.cache_read_input_tokens),
    models: models.map((entry) => ({
      model: entry.model,
      usage: { ...entry.usage },
      requests: entry.requests,
    })),
  }
}

/**
 * The agent's reply, under the id its `event_start` chunk announced.
 *
 * `id` is the `sevt_` id the stored `event_start` and every `event_delta` carried, which is how
 * a client matches what it accumulated against what was stored: `appendEvents` stores a
 * caller-supplied id exactly as given, so the chunk announcing the message and the message are
 * one id throughout.
 *
 * `supersedes` is the range of the reply's own chunks — its `event_start` through its last
 * `event_delta`, inclusive. Replay skips that range, so a client resuming by `seq` sees the
 * reply once, whole, however far into the stream it was when it disconnected.
 */
export function agentMessage(id: EventId, text: string, supersedes?: Supersedes): AppendableEvent {
  return {
    type: EVENT_TYPES.agentMessage,
    id,
    content: [{ type: 'text', text }],
    ...(supersedes === undefined ? {} : { supersedes }),
  }
}

/**
 * The model asked for a tool — one event per call (epic #303, X1).
 *
 * The store assigns the id, which **is** the call's id: `agentToolResult` names it in
 * `tool_use_id`, and a recovering brain pairs a call with its answer by it. `input` is the
 * arguments the model produced, already coerced to the JSON object the protocol stores
 * ({@link ToolInput}); `permission` is what the policy in force said about this call.
 *
 * @param name the tool's name, as it was offered to the model
 * @param input the arguments, as a JSON object
 * @param permission what the policy in force said about this call
 */
export function agentToolUse(
  name: string,
  input: ToolInput,
  permission: ToolPermission,
): AppendableEvent {
  return {
    type: EVENT_TYPES.agentToolUse,
    name,
    input,
    evaluated_permission: permission,
  }
}

/**
 * What a tool call produced — always written, by the loop that ran it (epic #303, X1).
 *
 * A result the model should read as a failure is `isError: true` with the reason as its text:
 * a refusal under a `deny` policy, a timeout, an interrupt, the tool's own failure, or the
 * `execution lost` a turn that died before running the call leaves for its successor (X3).
 *
 * @param toolUseId the `agent.tool_use` this answers — its event id
 * @param content the blocks the model is shown
 * @param isError whether the call failed
 */
export function agentToolResult(
  toolUseId: EventId,
  content: readonly TextBlock[],
  isError: boolean,
): AppendableEvent {
  return {
    type: EVENT_TYPES.agentToolResult,
    tool_use_id: toolUseId,
    content: [...content],
    is_error: isError,
  }
}

/**
 * A reply started streaming: the stored chunk that opens the range an `agent.message` will
 * replace.
 *
 * Stored, not ephemeral (D9): the chunk is an ordinary event with a `seq`, so a reply in flight
 * is part of the log and a client reconnecting mid-reply resumes by position like anywhere
 * else.
 */
export function eventStart(messageId: EventId): AppendableEvent {
  return {
    type: EVENT_TYPES.eventStart,
    event: { type: EVENT_TYPES.agentMessage, id: messageId },
  }
}

/** One streamed fragment of that reply, as a stored event of the same range. */
export function eventDelta(messageId: EventId, text: string): AppendableEvent {
  return {
    type: EVENT_TYPES.eventDelta,
    event_id: messageId,
    delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
  }
}
