import { EVENT_TYPES, readTodoList, totalCost, usageCost } from '@openharness/protocol'
import type {
  AgentMessageEvent,
  AgentToolResultEvent,
  AgentToolUseEvent,
  ContextSummaryEvent,
  ContextSummaryReason,
  ModelCost,
  ModelRequestEndEvent,
  ModelRequestStartEvent,
  ModelUsage,
  SessionUsageEvent,
  StreamEvent,
  StoredEvent,
  ToolReference,
  ToolSource,
  UserMessageEvent,
  RetryStatusType,
  SessionCompactionOutcome,
  SessionErrorType,
  SessionRewindEvent,
  SessionStatus,
  TodoList,
  TotalCost,
  UserToolConfirmationEvent,
  ToolConfirmationRemember,
  ToolConfirmationResult,
  AskUserAnswer,
} from '@openharness/protocol'

import { contextAfterSummary } from './compaction'
import { clearedResultsFrom, searchCount, toolCallStatus, truncatedResultsFrom } from './tools'
import type {
  ClearedToolResults,
  ToolCallResult,
  TranscriptToolCall,
  TruncatedToolResult,
} from './tools'

/**
 * The transcript: session events in, UI state out.
 *
 * One pure reducer, shared by the web app and the TUI, so the two render the same conversation
 * from the same events. It is written for a live stream but reads history just as well — a
 * reload loads the log with `sessions.events.list` and feeds it through the same function, then
 * continues from `lastSeq`:
 *
 * ```ts
 * const transcript = createTranscript()
 * for await (const event of client.sessions.events.iterate(sessionId)) transcript.apply(event)
 * for await (const event of client.sessions.events.stream(sessionId, { deltas: true, afterSeq: transcript.getState().lastSeq })) {
 *   transcript.apply(event)
 * }
 * ```
 *
 * Messages are keyed by the `sevt_` id of the event that wrote them, and every message has a
 * sort position ({@link TranscriptMessage.position}). A reply's chunks and the reply itself
 * share an id, so the reply replaces the accumulated chunks — wherever the client picked the
 * reply up — and sorts where the reply started. A message a client never saw the chunks of (a
 * reload, a join mid-reply, a log whose chunks were already superseded) still sorts in the
 * same place: the `supersedes` range the stored reply carries says where its chunks were. The
 * whole conversation therefore renders identically however much of a reply a client witnessed.
 *
 * The state is plain data — arrays, strings, numbers — so a framework can hold it in a store,
 * snapshot it, or send it to a devtool. Nothing here knows about React.
 *
 * Since epic #277's visibility work (#280) it also carries what the compaction is doing and how
 * full the context is: the `session.context_summary` dividers, the in-flight progress, the last
 * real request's prompt size, and the newest-item truncation notice. `./compaction` turns those
 * facts into the meter both frontends draw.
 */

/**
 * A message's text — the one part type v1 stores (epic #201, X1).
 *
 * A user message carries one per content block, the agent's reply one per block it produced
 * and a streaming preview one per block its deltas extend.
 */
export interface TextPart {
  readonly type: 'text'
  /** The text of this part. */
  readonly text: string
}

/**
 * One part of a message (epic #201, X1).
 *
 * A discriminated union on `type`. A frontend renders {@link TranscriptMessage.parts} through
 * a lookup from `type` to a renderer, so a new kind of part is a new member here and a new
 * entry there — never a change to how a message is laid out.
 *
 * Only `text` is implemented today. The members the next phases add, in the shape the epic
 * agreed, are:
 *
 * - `thinking` — the model's reasoning;
 * - `question` — an `ask_user` question waiting for the user (#310);
 * - `approval` — a tool call waiting for the user's approval (#310).
 *
 * They are named here and deliberately not implemented: the protocol has no event for them
 * yet, and the union is what they extend when it does. A message's `text` stays the
 * concatenation of its text parts, so a caller that only wants the words keeps working.
 *
 * **A tool call is not a message part** (epic #303, X1; #308). The model's calls and their
 * results are events of their own — one call is not text the model produced, and a step that
 * made four calls and wrote no words is four calls and no message — so they live in
 * {@link TranscriptState.toolCalls} and reach a renderer as their own {@link TranscriptEntry}
 * (`kind: 'tool'`), interleaved with the messages by position. #310 draws its approval prompt
 * from a call's `waiting` status, and #313's MCP calls are the same shape with
 * `source: 'mcp'`.
 */
export type MessagePart = TextPart

/**
 * The tokens a reply used, summed over the model requests it took (epic #201, U1).
 *
 * `total` is `input + output`: the two numbers a reader thinks in. The cache counters are
 * carried too — they are not part of that headline, and they are what a price is computed
 * from — because they are what the log reported and nothing else can recover them (epic #245,
 * #247).
 */
export interface TranscriptUsage {
  readonly input: number
  readonly output: number
  /** Tokens written to the prompt cache, summed. */
  readonly cacheCreation: number
  /** Tokens read from the prompt cache, summed. */
  readonly cacheRead: number
  /** `input + output` — the headline number, which the cache counters are not part of. */
  readonly total: number
}

/**
 * The session's tokens, broken down by model (epic #245, A2; issue #247).
 *
 * A session may switch models mid-conversation (epic #116, U3), so its usage is a per-model
 * question: the totals are the sum of `models`, and a cost is per model because the rates are.
 */
export interface SessionUsage {
  /** Every request the session made, summed. */
  readonly totals: SessionUsageTotals
  /** The same totals per model, in the order the models first ran. */
  readonly models: readonly SessionModelUsage[]
}

/** The four counters a session's usage is summed in — the protocol's `ModelUsage`, in camelCase. */
export interface SessionUsageTotals {
  readonly input: number
  readonly output: number
  readonly cacheCreation: number
  readonly cacheRead: number
}

/** One model's share of a session's tokens. */
export interface SessionModelUsage {
  /** The `provider/model` the requests named. */
  readonly model: string
  /** What those requests reported, summed. */
  readonly usage: SessionUsageTotals
  /**
   * How many requests ran on this model (epic #245, A2; #247).
   *
   * A `session.usage` event carries the count per model, and the derivation from a transcript's
   * replies sets it to how many replies named the model. It is what lets {@link sessionCost}
   * count the requests a model nobody prices leaves unpriced, rather than the model alone.
   */
  readonly requests: number
}

/**
 * A model's list price by `provider/model` id, or `null` when nobody publishes one — the
 * `cost` of a `ModelEntry` from the catalog (epic #245, A2).
 *
 * The frontends price what they show with this: the catalog is the one place prices reach a
 * client, and a model it does not price reports tokens and no cost rather than a guess.
 */
export type ModelPriceLookup = (modelId: string) => ModelCost | null

/**
 * What a reply cost, read off the turn's span events (epic #201, X1).
 *
 * A field is **absent when the log does not say — never `0`**. A log with no span events at
 * all (a pre-#201 session, a session whose request never opened a span) leaves the whole
 * `meta` off the message; a request whose span start named no model leaves `model` off; a
 * request whose span end never arrived leaves `durationMs` and `usage` off. `0` is a number a
 * model really did report, and a UI must be able to tell that from "unknown".
 */
export interface TranscriptMessageMeta {
  /** The model that served the reply: the last one the turn's requests named. */
  readonly model?: string
  /**
   * How long the reply took, in milliseconds: the turn's first request start to its last
   * request end.
   *
   * A retried reply therefore reports the time a reader actually waited — the failed attempt,
   * the backoff between the two requests and the retry — not just the request that answered.
   */
  readonly durationMs?: number
  /** The tokens the reply's requests reported, summed. */
  readonly usage?: TranscriptUsage
}

/**
 * One message in the transcript.
 *
 * User and agent messages look the same on purpose: a UI renders a list, not two lists.
 */
export interface TranscriptMessage {
  /** The `sevt_` id of the event. A preview is identified by the event it previews. */
  readonly id: string
  /** Who said it. */
  readonly role: 'user' | 'agent'
  /** The message's text: its text parts, joined. What a UI shows. */
  readonly text: string
  /** The message's content, as it has arrived. `text` is this list's text parts, joined. */
  readonly parts: readonly MessagePart[]
  /**
   * What the reply cost, when the log says (epic #201, U1). Agent messages only.
   *
   * Built from the turn's `span.model_request_start` / `span.model_request_end` events: the
   * span start names the model, the span end the tokens, and the two timestamps the duration.
   * A reply that took several requests (the brain retried) adds them all up, which is why a
   * reply's metadata arrives with the *last* span end — see {@link TranscriptState.pendingRequests}.
   */
  readonly meta?: TranscriptMessageMeta
  /**
   * A user message the brain has not reached yet.
   *
   * True while the stored event's `processed_at` is `null`, and also for a message that was
   * queued while a turn was running — the `consumes` list on the next model request, or a
   * request starting at all on a server too old to write one, is what says the queue has been
   * picked up.
   */
  readonly pending: boolean
  /** An `agent.message` being previewed by `event_delta`s, not yet stored. */
  readonly streaming: boolean
  /**
   * Where the message sorts, in the log's own numbering. `messages` is kept in this order.
   *
   * Everything is a stored event since P4, so every position is a real `seq`: a user message
   * at its own, a reply at the `from_seq` of the chunk range it supersedes — which is where
   * the reply started — and a reply whose chunks were never stored (a log from before D9) at
   * its own `seq`, or at the position of the preview it replaces. See
   * {@link reduceTranscript}.
   */
  readonly position: number
  /**
   * The model this message switched the session to, when it switched one (epic #116, U1).
   *
   * A `user.message` carrying a `model` whose id differs from the model the log last said
   * switches the session, and a UI renders this message as the marker. The **first** model a
   * message carries is not a change — {@link TranscriptState.model} is `null` until then, and
   * the message sets it silently — and a message naming the model already in effect is not a
   * change either. Absent on every other message.
   */
  readonly modelChangedTo?: string
}

/** The latest `session.error`, as the UI shows it. */
export interface TranscriptError {
  /** The error kind, e.g. `model_overloaded_error`. */
  readonly type: SessionErrorType
  /** The server's human-readable message. */
  readonly message: string
  /** What the server is doing about it: `retrying`, `exhausted` or `terminal`. */
  readonly retryStatus: RetryStatusType
}

/**
 * One model request the transcript is still accounting for (epic #201, U1).
 *
 * Bookkeeping for {@link TranscriptMessage.meta}, not something a UI renders. A
 * `span.model_request_start` opens one — the model it named, when it started — and its
 * `span.model_request_end` closes it with the tokens it used and when it ended. The reply the
 * requests produced takes them all as its metadata; a request that produced no reply (a failed
 * attempt the brain retried) stays here until the reply that follows picks it up, which is
 * what makes a retried reply's tokens add up. Each one is erased as it is used: once its end
 * has been folded into its reply, and all of them when the turn ends.
 */
export interface PendingModelRequest {
  /** The `sevt_` id of the `span.model_request_start`. */
  readonly id: string
  /** The `provider/model` the span named that served the request; a pre-D9 span names none. */
  readonly model?: string
  /** When the request started, in epoch milliseconds, from the span's `processed_at`. */
  readonly startedAt?: number
  /** When it ended, in epoch milliseconds, from the span end's `processed_at`. */
  readonly endedAt?: number
  /** The tokens it reported, as {@link TranscriptMessageMeta.usage} sums them. */
  readonly usage?: TranscriptUsage
  /** The reply the request has been attributed to, once one has been stored. */
  readonly messageId?: string
  /**
   * Whether the compaction engine made the request to write a summary (epic #277, C2; #280).
   *
   * A summary request answers nothing and measures the summarizer's prompt rather than the
   * chat's, so it is kept out of a reply's metadata and out of the context meter — it is tracked
   * only so its span end can be recognised and dropped rather than folded into the next reply.
   */
  readonly summary?: boolean
}

/**
 * A summary the transcript draws a divider for (epic #277, K10; #280).
 *
 * One per `session.context_summary` that is still in the conversation. A summary supersedes
 * **nothing** — the history above it stays on screen — so the divider sits where the model stops
 * reading verbatim, at the last `seq` the summary covers, and the summary text is what the
 * divider expands to. Only a `session.rewind` takes one back, exactly as it takes back the
 * messages it replaced.
 */
export interface TranscriptSummary {
  /** The `sevt_` id of the summary event. */
  readonly id: string
  /** The summary text: what the model was told instead of the history it covers. */
  readonly summary: string
  /** Why it was made: `threshold` (drawn as "automatic"), `overflow` or `manual`. */
  readonly reason: ContextSummaryReason
  /** The `provider/model` that wrote it. */
  readonly model: string
  /** How many passes the summary took. */
  readonly passes: number
  /** The context size when it was made, in tokens, before it replaced anything. */
  readonly tokensBefore: number
  /** Why the chat's own model wrote it rather than the chosen summary model, when that happened. */
  readonly fallbackReason?: string
  /** Where the divider draws: the `seq` of the last event the summary replaced for the model. */
  readonly position: number
  /**
   * The `seq` of the summary event itself.
   *
   * The event, not `position`: the divider is *at* the range it covers, but whether a rewind
   * took the summary back is a question about where the event is — the range a rewind records
   * reaches to the end of the log as it stood, which is where a summary written before it sits.
   */
  readonly seq: number
}

/**
 * A summary being written, as its progress events report it (epic #277, C2/K10; #280).
 *
 * The newest `session.context_summary_progress` between the compaction engine's request and the
 * summary it produces — what "Summarizing… 3 of 7" is drawn from. It is cleared by the summary
 * landing, by the chat's own request starting (the engine runs to completion or failure before
 * that request is built), by a `session.error` and by the turn ending, so it cannot outlive the
 * compaction it describes.
 */
export interface TranscriptSummarizing {
  /** Which pass is running, counting from 1. */
  readonly pass: number
  /** How many passes the plan holds. */
  readonly passes: number
  /** The `seq` of the progress event — the rewind test, as {@link TranscriptSummary.seq}. */
  readonly seq: number
}

/**
 * How full the context was at the last **real** model request (epic #277, K2/K10; #280).
 *
 * `tokens` is that request's real prompt size: the three input-side counters of its
 * `span.model_request_end.model_usage` summed, which is `promptTokensOf` in the brain. A request
 * the compaction engine made (`purpose: 'summary'`) measures the summarizer's prompt, so it is
 * never the baseline; a request that reported no prompt tokens at all (a failed attempt, which
 * closes its span with a zero usage) measured nothing either.
 *
 * `estimated` is the after-summary case: a summary landed, so the history it replaced is no
 * longer in the prompt, and until the next real request measures itself the transcript answers
 * the estimate `contextAfterSummary` builds from the summary and the messages it covers. The
 * first real request that reports a size replaces it.
 */
export interface TranscriptContext {
  /** The prompt size in tokens, or the estimate of one right after a summary. */
  readonly tokens: number
  /** Whether that number is an estimate rather than a measurement. */
  readonly estimated: boolean
}

/**
 * One entry of the transcript as a frontend draws it: a message, a tool call, or a summary
 * divider (epic #277, K10; #280; epic #303, X5; #308).
 *
 * Both frontends render the conversation, the tool calls and the dividers from one ordered list
 * ({@link selectTranscriptEntries}), so a divider or a call line lands in the same place on the
 * web and in the terminal — which is the whole reason the order is decided here rather than in
 * each renderer.
 */
export type TranscriptEntry =
  | { readonly kind: 'message'; readonly message: TranscriptMessage }
  | { readonly kind: 'tool'; readonly call: TranscriptToolCall }
  | { readonly kind: 'summary'; readonly summary: TranscriptSummary }

/**
 * What the reader decided about a call that was waiting on them (epic #303, X6; issues #309,
 * #310).
 *
 * The `user.tool_confirmation` is the log's own record of the answer — the server writes it
 * only once it has checked the call really was waiting, so one in the log is a decision that
 * happened — and the transcript keeps it so a call can be shown as **how** it was allowed:
 * "Allowed once", "Allowed for this chat", "Always allowed". The tool's own result cannot say
 * that (it is what the tool answered, not what the reader decided), and an `ask_user` call's
 * answers *are* its result, so those need no line of their own.
 *
 * It is kept beside the calls rather than on one, because it is an event: a `session.rewind`
 * past a confirmation takes it back with the branch, exactly as it takes back the call the
 * confirmation answered.
 */
export interface TranscriptConfirmation {
  /** The call this answers — its id, the `agent.tool_use` event's own. */
  readonly toolUseId: string
  /** What the reader decided: `allow` ran the call, `deny` refused it. */
  readonly result: ToolConfirmationResult
  /** How long the approval is remembered; absent means `once`. */
  readonly remember?: ToolConfirmationRemember
  /** Why the call was refused, when the reader said so. */
  readonly denyMessage?: string
  /** The answers to an `ask_user` call, when this confirmation carried them. */
  readonly answers?: readonly AskUserAnswer[]
  /** Where the event sits in the log: the rewind test, as for a call. */
  readonly seq: number
}

/**
 * The newest item a request had to shorten to fit the model (epic #277, K6/K10; #280).
 *
 * The newest message alone was over the chat model's budget, so the request carried it capped to
 * a head and a tail around an omission marker, and the span said so — "your message was too long
 * for this model and was shortened". It reflects the newest real request: one that capped
 * nothing clears it, so the notice cannot outlive the turn it was about, and a rewind that takes
 * the message back takes the notice with it.
 */
export interface TranscriptTruncation {
  /** The `seq` of the event whose text was shortened. */
  readonly seq: number
  /** What the item cost before it was cut, in tokens. */
  readonly tokensBefore: number
  /** What the truncated item costs, in tokens. */
  readonly tokensAfter: number
  /** The `seq` of the span that recorded it — the rewind test. */
  readonly recordedAt: number
}

/**
 * A manual compaction the log has asked for, as the conversation shows it (epic #277, K8; #283).
 *
 * The newest of the `session.compact` / `session.compaction` pair the transcript has folded in —
 * the same two events the *server* reads to answer "is a compaction waiting?", so the client and
 * the route agree about what pending means without a second source of truth. A request with no
 * answer yet is {@link TranscriptManualCompaction.pending}: the UI says "Compacting…" until the
 * brain's outcome lands, which is the state a reader who ran `/compact` needs (the ask is stored
 * and answered asynchronously, and a silent gap looks like nothing happened).
 *
 * The outcome is kept rather than cleared, because a `nothing_to_summarize` or `failed` result is
 * the *clear, stored answer* the epic asks for: the reader must be told there was nothing to
 * summarize or that the summarizer failed, and the brain's own `message` is what says so.
 * `summarized` needs no notice — the divider C5 draws is the outcome — which is why
 * {@link manualCompactionNotice} answers `null` for it.
 */
export interface TranscriptManualCompaction {
  /** Whether the newest of the pair is a request nobody has answered yet. */
  readonly pending: boolean
  /** What came of the request, or `null` while it is pending. */
  readonly outcome: SessionCompactionOutcome | null
  /** The brain's sentence for a `nothing_to_summarize` or `failed` outcome, when it sent one. */
  readonly message?: string
  /**
   * The `seq` of the newest of the pair.
   *
   * The event's own position, not where its divider would draw — the test a `session.rewind`
   * makes, exactly as {@link TranscriptSummary.seq} is for a summary.
   */
  readonly seq: number
}

/** Everything a UI needs to render a session. */
export interface TranscriptState {
  /** The conversation, in order (`position`). */
  readonly messages: readonly TranscriptMessage[]
  /** Whether the agent is working. */
  readonly status: SessionStatus
  /** The most recent `session.error`, until a reply supersedes it. */
  readonly lastError: TranscriptError | null
  /**
   * The `seq` of the last stored event the transcript has seen.
   *
   * Feed it back as `afterSeq` when reconnecting: it is exactly where the transcript got to.
   * Stored chunks carry a `seq` like any other event, so a client that disconnects mid-reply
   * resumes mid-reply.
   */
  readonly lastSeq: number
  /**
   * Whether the session was deleted (#111, epic #116 U5).
   *
   * A `session.deleted` event — the stream-only last event of a deleted session — sets this
   * once and for all: it is a terminal end state a UI can react to (close the view, stop
   * offering to send) rather than the end of an iteration. A log read back from the server
   * never carries the event, because deletion removes the log.
   */
  readonly deleted: boolean
  /**
   * The model the session is running, as the log last said it (epic #116, U1).
   *
   * The id a `user.message` carrying a `model` switched the session to, or the model the
   * newest `span.model_request_start` names — whichever the log says last — seeded initially
   * from the session's own model ({@link TranscriptSeed}). It is what tells a model
   * **change** — a message whose id differs from it, marked with
   * {@link TranscriptMessage.modelChangedTo} — from a message that names the model already in
   * effect.
   */
  readonly model: string | null
  /**
   * The model requests of the turn in progress, for the reply's metadata (epic #201, U1).
   *
   * Bookkeeping the reducer keeps for {@link TranscriptMessage.meta} — a UI renders messages,
   * not these. A request is dropped once its span end has been folded into the reply it
   * belongs to, and the list is emptied when the turn ends (`session.status_idle`), so it
   * never outlives the turn that opened the requests.
   */
  readonly pendingRequests: readonly PendingModelRequest[]

  /**
   * The session's running totals as the log last reported them (epic #245, A2; issue #247).
   *
   * The newest `session.usage` event the reducer has folded in, or `null` for a session whose
   * log holds none — one stored before the event existed, or one nothing has run on yet.
   * {@link selectSessionUsage} is what a UI reads: it answers this when it is there and
   * derives the same totals from the transcript's replies when it is not, so the two agree.
   */
  readonly usage: SessionUsage | null

  /**
   * The summaries the conversation still holds, in the order they were written (epic #277, K10;
   * #280).
   *
   * One per `session.context_summary` a `session.rewind` has not taken back. Each carries where
   * its divider draws ({@link TranscriptSummary.position}) and everything the divider says, so a
   * transcript that renders messages by position can interleave the two from this one list. The
   * newest summary is the one the model is reading from; the older ones are the marks of where it
   * used to start.
   */
  readonly summaries: readonly TranscriptSummary[]

  /** The summary being written right now, or `null` (epic #277, C2; #280). */
  readonly summarizing: TranscriptSummarizing | null

  /** How full the context was at the last real model request, or `null` (epic #277, #280). */
  readonly context: TranscriptContext | null

  /** The newest item a request had to shorten, or `null` (epic #277, K6; #280). */
  readonly truncation: TranscriptTruncation | null

  /** The manual compaction the log last asked for, or `null` (epic #277, K8; #283). */
  readonly manualCompaction: TranscriptManualCompaction | null

  /**
   * The tool calls the conversation holds, in position order (epic #303, X1/X5; #308).
   *
   * One per `agent.tool_use` a `session.rewind` has not taken back, each paired with its
   * `agent.tool_result` when one has landed. Both frontends interleave these with the messages
   * through {@link selectTranscriptEntries}, so a call draws where it was made.
   */
  readonly toolCalls: readonly TranscriptToolCall[]

  /** The tool results the newest real request had to shorten, or `[]` (epic #303, X9; #306; #308). */
  readonly truncatedToolResults: readonly TruncatedToolResult[]

  /**
   * The decisions the reader made about calls that waited on them, in log order
   * (epic #303, X6; #309; #310).
   *
   * One per `user.tool_confirmation` a `session.rewind` has not taken back. A call the reader
   * allowed can then say **how** it was allowed ({@link confirmationSummary} in
   * `./approvals`), which the call's own result cannot.
   */
  readonly confirmations: readonly TranscriptConfirmation[]

  /** The old tool results the newest real request cleared, or `null` (epic #303, X9; #306; #308). */
  readonly clearedToolResults: ClearedToolResults | null

  /**
   * The task list the model last wrote with `todo_write`, or `null` (epic #303, X5; #305; #308).
   *
   * Read with the protocol's own `readTodoList` over the calls the log holds, so the list a
   * frontend draws is exactly the one the brain and any other reader of the log compute: the
   * newest successful `todo_write` call's own input, and nothing when none has taken effect. An
   * empty array is a model clearing a list it no longer needs, and is told apart from `null`.
   */
  readonly todos: TodoList | null

  /**
   * Where the tools a request offered come from, keyed by name — bookkeeping (epic #303, X1).
   *
   * A UI renders messages and calls, not this. It is read once, when an `agent.tool_use` lands,
   * to stamp the call's {@link TranscriptToolCall.source} from the request's own
   * `span.model_request_start.tools` record; it is never cleared, because a tool's source does
   * not change and a call may be replayed long after the request that offered it.
   */
  readonly toolSources: Readonly<Record<string, ToolSource>>

  /**
   * The tool events the todo list is read from, in log order — bookkeeping (epic #303, #308).
   *
   * `readTodoList` is the one reading of the list a log holds, and it takes whole events; keeping
   * the `agent.tool_use` / `agent.tool_result` events here (and no others) is what lets the
   * transcript call it rather than restate its rule. A rewind drops the ones its range covers, so
   * the list follows the branch the same way the messages do.
   */
  readonly todoEvents: readonly StoredEvent[]
}

/**
 * What a transcript is seeded with where it is built (#268).
 *
 * `model` is the model the session runs **before the client has seen a single event** — the
 * `model` of the session resource it opened. It is what makes the *first* mid-chat switch a
 * change a frontend can draw a marker for: without it the transcript has nothing to compare a
 * message's model against until one carries a model, so a chat started from a model marks its
 * first switch not at all. The log is self-correcting — every `span.model_request_start` names
 * the model its request ran — so what a replayed session ends up with is the same baseline a
 * client that followed it live started from, whatever it was seeded with.
 */
export interface TranscriptSeed {
  /** The model the session runs before the log says otherwise; absent is the same as `null`. */
  readonly model?: string | null
}

/**
 * The state for a session with no events yet.
 *
 * `lastSeq` is `0`, the protocol's "from the start": passing it as `afterSeq` replays the
 * whole log. `deleted` is `false`: nothing has happened yet. `model` is `null` unless a
 * {@link TranscriptSeed} names one — which is how a frontend that opened a session tells the
 * transcript which model its first message is a continuation of (#268).
 *
 * @param seed the session's model, when the caller knows it; see {@link TranscriptSeed}
 */
export function initialTranscriptState(seed: TranscriptSeed = {}): TranscriptState {
  return {
    messages: [],
    status: 'idle',
    lastError: null,
    lastSeq: 0,
    deleted: false,
    model: seed.model ?? null,
    pendingRequests: [],
    usage: null,
    summaries: [],
    summarizing: null,
    context: null,
    truncation: null,
    manualCompaction: null,
    toolCalls: [],
    truncatedToolResults: [],
    confirmations: [],
    clearedToolResults: null,
    toolSources: {},
    todos: null,
    todoEvents: [],
  }
}

/**
 * Fold one event into the transcript.
 *
 * Pure: the state that comes back is a new object, and the one that went in is untouched — an
 * incoming event is only ever read, never written — so a framework can compare states by
 * reference and a caller can hand over a shared, frozen event.
 *
 * Events are idempotent — an event at or below `state.lastSeq` is dropped — which is what lets
 * history and a resumed stream overlap without doubling a message. Since D9 the streamed chunks
 * of a reply are stored events too (`event_start` / `event_delta` with a `seq`), so they take
 * the same path: they are deduplicated by `seq`, they advance `lastSeq`, and a client that
 * resumes mid-reply gets the rest of the chunks rather than skipping them. The pre-D9
 * stream-only previews — a chunk with no envelope — were removed in phase P4: apart from the
 * stream-only `session.deleted` (handled below), every event this reducer takes is a
 * `StoredEvent`.
 *
 * The rules, in one place:
 *
 * - **A delta appends to its message's preview**, creating the preview if the client missed
 *   (`event_delta` carries the id of the message being previewed). A delta for a message that
 *   is already stored is ignored: the stored event is the record.
 * - **A stored `agent.message` replaces whatever the transcript holds for its id** — a whole
 *   preview, a partial one, or nothing at all. It never merges.
 * - **A stored preview sits where its chunks started**: at its `event_start`'s `seq`, or at
 *   its first delta's `seq` when the start was skipped (a client that joined mid-reply).
 * - **A finished reply sits where it started.** An `agent.message` that carries `supersedes`
 *   sorts at `from_seq`, whether or not the client saw the chunks, so a steer sent mid-reply
 *   stays behind the reply in every view. A reply with no range — a log stored before D9 —
 *   keeps the position of the preview it replaces, or, with no preview to replace, its own
 *   `seq`.
 * - **Unfinished previews are dropped when the turn moves on**: `span.model_request_end` and
 *   `session.status_idle` discard previews still streaming (#40), which since D9 includes the
 *   previews of a chunk range a span end supersedes. An interrupt is not this case: its
 *   partial reply is stored as an `agent.message` before the span closes.
 * - **`pending` clears on the claim.** The event that answers a user message names it in its
 *   `consumes`: a `span.model_request_start` claims the messages its request folds in (P3),
 *   and a `span.model_request_end` or `session.status_idle` claims the interrupts it ends on
 *   (P4). A claim event with no list at all — a log stored before D9 — keeps the old reading:
 *   a span start says everything pending was picked up, and a span end or an idle says
 *   nothing.
 * - **`session.deleted` is terminal, seq-less and idempotent.** It has no `seq` (it is
 *   stream-only), so it is folded in *before* the dedupe below — a replayed log has no
 *   position for it — and the only thing it does is set `deleted` to `true`. The stream ends
 *   after it, so a UI can react to the state rather than to the end of an iteration, and a
 *   second one changes nothing.
 * - **A `session.rewind` drops the conversation it replaced** (#238). Editing a message
 *   restarts the session from it: the rewind carries the range it replaces — from the edited
 *   message through the last event before it — and everything a client is showing from there
 *   on belongs to a branch the session is no longer on. A client that followed the log live
 *   has all of it on screen (a reload would never have shown it, since replay skips the
 *   range), so the rewind drops those messages, the error it replaced, and the requests of
 *   the turn it replaced. The test is each message's {@link TranscriptMessage.position}: a
 *   user message sits at its own `seq` and a reply at the `from_seq` of the chunks it
 *   replaced, so everything at or after the range's `from_seq` is inside it.
 * - **A `user.message` carrying a `model` may switch the session's model.** When its id
 *   differs from `state.model`, the message carries `modelChangedTo` so a UI can draw the
 *   marker, and `state.model` becomes the new id. `state.model` starts at the seed a frontend
 *   gave it — the session's own model — so a chat started from a model marks its first switch
 *   (#268), and a message naming the model already in effect changes nothing. A message with
 *   no `model` leaves `state.model` alone. The model a `span.model_request_start` names is
 *   taken as `state.model` too: the log says which model each request really ran, which is
 *   what keeps a resumed chat's markers identical to the live view's.
 * - **A reply carries what it cost** (epic #201, U1). Its {@link TranscriptMessage.meta}
 *   comes from the turn's spans: a `span.model_request_start` names the model and opens a
 *   tracked request, its `span.model_request_end` reports the tokens and closes it, and the
 *   reply takes them all. Since the span end follows the reply, the metadata is written
 *   twice — the model when the reply lands, the tokens and the duration when the end arrives
 *   — and a reply the brain retried takes the request that failed too, so its tokens add up.
 *   Nothing the log does not say is invented: an absent field is `undefined`, never `0`, and
 *   a turn that ends (`session.status_idle`) drops the requests no reply claimed.
 * - **A summary is a mark, not a cut** (epic #277, K1/K10; #280). A `session.context_summary`
 *   supersedes nothing: the messages stay exactly as they were, the divider is added at the last
 *   `seq` the summary covers, and only a `session.rewind` takes one back — the same rule the
 *   messages it replaced get. A `session.context_summary_progress` sets the summary-in-flight the
 *   transcript shows as "Summarizing… N of M", and the summary landing, the chat's own request
 *   starting, a `session.error` and a turn ending all clear it, so a compaction is never
 *   reported after it is over. The summary also moves the **context meter**: it replaces the
 *   history it covers, so from there until the next real request reports its own prompt size the
 *   meter is an estimate ({@link TranscriptContext.estimated}). A request the compaction engine
 *   made (`purpose: 'summary'`) measures the summarizer's prompt, so it names no reply's model,
 *   adds no tokens to one, and never becomes the meter's baseline.
 * - **A request that had to shorten its newest item says so.** Its
 *   `span.model_request_start.truncated` becomes {@link TranscriptState.truncation} — "your
 *   message was too long for this model and was shortened" — and the newest real request
 *   replaces it, so a request that capped nothing clears the notice rather than leaving it on
 *   screen for the life of the session.
 *
 * @param state the transcript so far
 * @param event the next event, from `iterate`, `stream`, or anywhere else
 */
export function reduceTranscript(state: TranscriptState, event: StreamEvent): TranscriptState {
  if (event.type === EVENT_TYPES.sessionDeleted) {
    // A terminal, stream-only event with no `seq` (#111): folded in before the position
    // dedupe — which cannot apply to it — and idempotent, so a client that sees it twice
    // keeps the same state.
    return state.deleted ? state : { ...state, deleted: true }
  }
  if (event.type === EVENT_TYPES.sessionRewind) {
    // A rewind is applied wherever it arrives (#238). A client that sent the edit applies the
    // stored message the moment the request answers, and the rewind the stream echoes behind
    // it carries the *lower* `seq` of the range it replaced — the ordinary dedupe would throw
    // away the one event that takes the replaced branch off the screen. Applying it twice
    // changes nothing, and it never moves `lastSeq` back.
    const reduced = reduceStoredEvent(state, event)
    if (reduced === state && event.seq <= state.lastSeq) {
      return state
    }
    return { ...reduced, lastSeq: Math.max(state.lastSeq, event.seq) }
  }
  if (event.seq <= state.lastSeq) {
    // Already folded in: a resumed stream replaying from before where we got to, or the
    // same history loaded twice. A value that did not come from the protocol's schemas and
    // carries no `seq` compares false and is folded in; the switch below drops what it
    // cannot read.
    return state
  }
  const reduced = reduceStoredEvent(state, event)
  return { ...reduced, lastSeq: event.seq }
}

/**
 * Fold a whole sequence into the transcript: history, or every event of a stream.
 *
 * @param state the transcript so far
 * @param events the events, in order
 */
export function reduceTranscriptAll(
  state: TranscriptState,
  events: Iterable<StreamEvent>,
): TranscriptState {
  let next = state
  for (const event of events) {
    next = reduceTranscript(next, event)
  }
  return next
}

/** The stored-event half of {@link reduceTranscript}. */
function reduceStoredEvent(state: TranscriptState, event: StoredEvent): TranscriptState {
  switch (event.type) {
    case EVENT_TYPES.userMessage:
      return fromUserMessage(state, event)

    case EVENT_TYPES.agentMessage:
      return fromAgentMessage(state, event)

    case EVENT_TYPES.userInterrupt:
      // An interrupt is not something anyone said: it cuts a reply short, and what is left of
      // that reply arrives as an `agent.message` right behind it.
      return state

    case EVENT_TYPES.agentToolUse:
      // A call the model made (epic #303, X1/X5; #308): a line of its own in the conversation,
      // interleaved with the messages by position. The event's id **is** the call's id, which
      // the result that answers it names.
      return fromToolUse(state, event)

    case EVENT_TYPES.agentToolResult:
      // What answered the call, and the status the line moves to (epic #303, X1; #308).
      return fromToolResult(state, event)

    case EVENT_TYPES.userToolConfirmation:
      // The reader's decision about a call that was waiting on them (epic #303, X6; #309; #310).
      // The event itself is the record — the server stores it only after checking the call was
      // really waiting, and the brain reads it back off the log to learn what a `session`
      // approval allows — so the transcript keeps it to draw how a call came to run.
      return recordConfirmation(state, event)

    case EVENT_TYPES.eventStart:
      // The reply's chunks are log events (D9), so a client that resumes mid-reply meets
      // them here. The preview opens where the reply started — this event's `seq`.
      return startPreview(state, event.event.id, event.seq)

    case EVENT_TYPES.eventDelta:
      return appendDelta(
        state,
        event.event_id,
        event.delta.index,
        event.delta.content.text,
        event.seq,
      )

    case EVENT_TYPES.sessionStatusRunning:
    case EVENT_TYPES.sessionStatusRescheduled:
      // A rescheduled session is retrying, which is not idle: only `status_idle` is. A call with
      // no result on a working turn is out (`running`) rather than lost (epic #303, #308).
      return { ...state, status: 'running', toolCalls: refreshToolStatuses(state, 'running') }

    case EVENT_TYPES.sessionStatusIdle:
      // A turn that has ended cannot have a reply still streaming: the stored `agent.message`
      // precedes this, so a preview still open is one nothing will ever replace. That is the
      // same statement as the span end below, and it is the backstop for the case where the
      // span end never arrived at all — a stored event this client cannot parse is skipped
      // (`events/stream.ts`), and a preview no longer watched by anything would otherwise stay
      // streaming for the life of the session, drawing an empty bubble in a frontend that
      // renders it (#40). An idle that ended a turn on an interrupt also carries that
      // interrupt's claim (P4).
      //
      // The turn's model requests go with it (epic #201, U1): a request no reply ever claimed
      // belongs to a reply that never happened, and leaving it behind would fold its tokens
      // into the *next* turn's reply.
      return clearClaimedPending(
        {
          ...state,
          status: 'idle',
          messages: withoutPreviews(state.messages),
          pendingRequests: [],
          // A compaction cannot outlive the turn it ran in (epic #277, K10): whatever happened to
          // it — the summary landed, a pass failed, the write was refused — the turn is over.
          summarizing: null,
          // A call with no result on a turn that has ended is one nothing answered: the brain
          // writes a result for every call it stores, so its absence is `execution lost`
          // (epic #303, X3; #308). A call waiting on the reader keeps `waiting` — its permission
          // is `ask` — because a pause is exactly a turn ending with the question open.
          toolCalls: refreshToolStatuses(state, 'idle'),
        },
        event.consumes,
      )

    case EVENT_TYPES.sessionUsage:
      // The session's running totals, as the writer folded them (#247). It replaces what the
      // state held — the totals are cumulative, so the newest one is the whole answer — and a
      // session stored before the event existed simply never gets one, which is what
      // `selectSessionUsage` reads as "derive it from the replies".
      return { ...state, usage: usageFromEvent(event) }

    case EVENT_TYPES.sessionRewind:
      return dropRewound(state, event)

    case EVENT_TYPES.sessionError:
      return {
        ...state,
        lastError: {
          type: event.error.type,
          message: event.error.message,
          retryStatus: event.error.retry_status.type,
        },
        // An error ends whatever the turn was doing — including a compaction whose passes were
        // still going (epic #277, K10).
        summarizing: null,
      }

    case EVENT_TYPES.sessionCompact:
      // The reader asked for a compaction (`/compact`, epic #277 K8; #283) and the brain has not
      // answered yet: the state is "pending" until the `session.compaction` below lands, which is
      // what the UI's "Compacting…" says. Nothing else changes — the request carries no reply and
      // no claim — so this is the whole of it.
      return {
        ...state,
        manualCompaction: { pending: true, outcome: null, seq: event.seq },
      }

    case EVENT_TYPES.sessionCompaction:
      // The brain's answer, whether or not a summary came of it. `summarized` clears the pending
      // state and needs no notice (the divider is the outcome); the other two carry the sentence
      // the reader is owed, so the outcome and the message are kept for the UI to show.
      return {
        ...state,
        manualCompaction: {
          pending: false,
          outcome: event.outcome,
          ...(event.message === undefined ? {} : { message: event.message }),
          seq: event.seq,
        },
      }

    case EVENT_TYPES.sessionContextSummary:
      return fromContextSummary(state, event)

    case EVENT_TYPES.sessionContextSummaryProgress:
      return {
        ...state,
        summarizing: { pass: event.pass, passes: event.passes, seq: event.seq },
      }

    case EVENT_TYPES.modelRequestStart:
      // A request the compaction engine made to write a summary is not the chat's own (epic
      // #277, C2): it answers nothing, claims nothing, and its usage measures the summarizer's
      // prompt. It is tracked as a summary request — so its span end can be dropped rather than
      // folded into the next reply — and nothing else here applies to it.
      //
      // Every other request is the chat's: the brain folds every queued user message into the
      // request it is about to make, and since D9 the request says which ones — its `consumes`
      // list. That is where "queued" becomes "delivered", and a message sent while the turn was
      // running stays pending until the request that claims it. A span start with no list at all
      // is a log from before the claims existed (or one written before P4, whose writer claimed
      // out of band), and keeps the older reading: everything pending when a request starts has
      // just been picked up.
      //
      // The request itself is tracked for the reply's metadata (epic #201, U1): it names the
      // model that serves the reply and, through its `processed_at`, when the reply began. The
      // model it names is also the log's word on what the session is running (#268), and it is
      // taken as the state's — so a log a client replays (a resumed chat, whose session
      // resource only carries the model it is on *now*) settles on the same baseline the model
      // switches were recorded against, and the markers it draws match a live view's. Its
      // `truncated` record, when it carries one, is what the transcript's notice says (epic #277,
      // K6): the newest item was too long for the model and was shortened, and a request that
      // capped nothing clears the notice the last one may have left.
      if (event.purpose === 'summary') {
        return {
          ...state,
          pendingRequests: [...state.pendingRequests, { ...openedRequest(event), summary: true }],
        }
      }
      return clearClaimedPending(
        {
          ...state,
          ...(event.model === undefined ? {} : { model: event.model }),
          pendingRequests: [...state.pendingRequests, openedRequest(event)],
          // The chat's own request follows the engine's passes, whether or not they wrote a
          // summary — so its start is where a progress line that outlived a failed compaction
          // goes (epic #277, C2/K10).
          summarizing: null,
          truncation:
            event.truncated === undefined
              ? null
              : {
                  seq: event.truncated.seq,
                  tokensBefore: event.truncated.tokens_before,
                  tokensAfter: event.truncated.tokens_after,
                  recordedAt: event.seq,
                },
          // What the request offered, so a call it produces can say where its tool came from
          // (epic #303, X1; #308). The record is the request's own, so reading it now is what
          // keeps a replayed session's calls as well-described as a live one's.
          toolSources: event.tools === undefined ? state.toolSources : sourcesFrom(event.tools),
          // The tool results this request had to shorten, and the old ones it cleared
          // (epic #303, X9; #306; #308). The newest real request replaces both records, so a
          // request that capped and cleared nothing clears the notices rather than leaving them
          // on screen for the life of the session.
          truncatedToolResults:
            event.truncated === undefined ? [] : truncatedResultsFrom(event.truncated),
          clearedToolResults:
            event.cleared === undefined ? null : clearedResultsFrom(event.cleared),
        },
        event.consumes,
        { absentMeansAll: true },
      )

    case EVENT_TYPES.modelRequestEnd:
      // A preview that was never replaced by its stored event belongs to a request that
      // failed, was interrupted before a reply could be stored, or was closed by a recovering
      // brain; there is nothing to keep. (A reconciled preview is no longer `streaming`, so
      // it survives.) A span end that carries `supersedes` says the same about a specific
      // range — the previews of the chunks it replaces sit inside it — and those previews are
      // streaming, so this is the rule that drops them. A span end that ended a request on an
      // interrupt also carries that interrupt's claim (P4).
      return closeRequest(
        clearClaimedPending(
          { ...state, messages: withoutPreviews(state.messages) },
          event.consumes,
        ),
        event,
      )

    default:
      return state
  }
}

/**
 * Drop the conversation a `session.rewind` replaced (#238).
 *
 * The message at the range's `from_seq`, its reply, and everything after them are what the
 * reader took back: they are no longer part of what the session is. A client that watched the
 * log live is showing them, so this is where the two views agree — a client that loads the
 * session later never receives them at all, because replay skips the range.
 *
 * The turn's requests go with them, for the reason `session.status_idle` drops them: a
 * request no reply ever claimed would otherwise fold its tokens into the next turn's reply.
 * The error goes too: whatever it was about was inside the range.
 *
 * `position` is the test — a message's own `seq` for a user message, the `from_seq` of the
 * chunks it replaced for a reply — so a message the reader saw before the edit stays exactly
 * where it was.
 */
function dropRewound(state: TranscriptState, event: SessionRewindEvent): TranscriptState {
  const { from_seq, to_seq } = event.supersedes
  // The range, not "everything from `from_seq` on": the message that *follows* the rewind in
  // the log — the edit itself — sits past `to_seq`, and a client that already showed it (its
  // own send applies the stored message before the stream echoes the rewind) must keep it.
  const inRange = (seq: number): boolean => seq >= from_seq && seq <= to_seq
  const messages = state.messages.filter(
    (message) => message.position < from_seq || message.position > to_seq,
  )
  // A summary the edit took back goes with the branch (epic #277, K10; #280): its range covers
  // the log from the edited message on, so a summary written before the rewind is inside it, and
  // the model is no longer told what it said — which is exactly the rule `dropRewound` already
  // applies to the messages. The test is the summary *event's* `seq`, not the position its
  // divider draws at: the range reaches to the end of the log as it stood, which is where the
  // event sits, while its divider sits back at the history it covered.
  const summaries = state.summaries.filter((summary) => !inRange(summary.seq))
  const progress = state.summarizing
  const summarizing = progress !== null && inRange(progress.seq) ? null : progress
  const notice = state.truncation
  const truncation = notice !== null && inRange(notice.recordedAt) ? null : notice
  // A manual compaction inside the range goes with the branch too (#283): its request, and the
  // outcome it was answered with, are events the edit took back. The test is the event's `seq`,
  // as it is for a summary.
  const compaction = state.manualCompaction
  const manualCompaction = compaction !== null && inRange(compaction.seq) ? null : compaction
  // A tool call the edit took back goes with the branch, like the messages around it
  // (epic #303, #308): the call sits at its own `agent.tool_use` event's `seq`, so the range
  // test is the same one. The newest request's result notices go too — they describe a request
  // inside the branch a rewind just took back, and the next request writes fresh ones.
  const toolCalls = state.toolCalls.filter((call) => !inRange(call.position))
  // The tool events the todo list is read from go with the branch too, so a list a rewound call
  // wrote stops being current (epic #303, #308).
  const todoEvents = state.todoEvents.filter((event) => !inRange(event.seq))
  // A confirmation inside the range goes with it (epic #303, X6; #310): the decision is part of
  // the branch the edit took back, and the brain's own reading of the log — the tools this chat
  // has been told to allow — takes it back with the branch, so the two stay one answer.
  const confirmations = state.confirmations.filter((confirmation) => !inRange(confirmation.seq))
  if (
    messages.length === state.messages.length &&
    summaries.length === state.summaries.length &&
    summarizing === state.summarizing &&
    truncation === state.truncation &&
    manualCompaction === state.manualCompaction &&
    toolCalls.length === state.toolCalls.length &&
    todoEvents.length === state.todoEvents.length &&
    confirmations.length === state.confirmations.length &&
    state.truncatedToolResults.length === 0 &&
    state.clearedToolResults === null &&
    state.lastError === null &&
    state.pendingRequests.length === 0 &&
    state.usage === null &&
    state.context === null
  ) {
    return state
  }
  // The running totals go with the branch (#247): the newest `session.usage` the state holds
  // counted the requests the edit took back, so it is stale by definition — and the derivation
  // from the replies that survived is the right answer until the next request writes a fresh
  // one. The context measurement goes the same way (epic #277, #280): it is the prompt size of a
  // request inside the range, and a meter drawn from a branch nobody is on would be a lie. The
  // next request measures itself, and until then the meter is simply absent.
  return {
    ...state,
    messages,
    summaries,
    summarizing,
    truncation,
    manualCompaction,
    toolCalls,
    truncatedToolResults: [],
    clearedToolResults: null,
    todoEvents,
    confirmations,
    todos: readTodoList(todoEvents),
    lastError: null,
    pendingRequests: [],
    usage: null,
    context: null,
  }
}

/**
 * Clear the `pending` flag of the messages a claim reaches.
 *
 * The claim is the event's `consumes` list — a `span.model_request_start` naming the messages
 * its request folds in, or a `span.model_request_end` / `session.status_idle` naming the
 * interrupts it ended on (P4). Only what the list names is cleared, and a message that is
 * already delivered is left alone, so the state keeps its identity when nothing changes.
 *
 * `absentMeansAll` is the pre-D9 fallback, for a log whose writer claimed out of band: a span
 * start with no list says everything pending when a request starts has just been picked up,
 * which is how every message was read before the claims existed. For the other two event
 * types an absent list claims nothing — their older form never claimed anything.
 *
 * @param state the transcript so far
 * @param consumes the ids the event claims, or `undefined` when it carries no list
 * @param options.absentMeansAll what a missing list means; `false` by default
 */
function clearClaimedPending(
  state: TranscriptState,
  consumes: readonly string[] | undefined,
  options: { readonly absentMeansAll?: boolean } = {},
): TranscriptState {
  if (consumes === undefined && options.absentMeansAll !== true) {
    return state
  }
  const claimed = consumes === undefined ? null : new Set(consumes)
  let changed = false
  const messages = state.messages.map((message) => {
    if (!message.pending || (claimed !== null && !claimed.has(message.id))) {
      return message
    }
    changed = true
    return { ...message, pending: false }
  })
  return changed ? { ...state, messages } : state
}

/**
 * The messages that outlive a reply that is not coming: everything that is not still a preview.
 *
 * A preview the log never reconciled has no text anyone stored, so there is nothing to keep —
 * what it stood in for did not happen.
 */
function withoutPreviews(messages: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
  return messages.filter((message) => !message.streaming)
}

/** The name → source map a request's offered-tools record becomes (epic #303, X1; #308). */
function sourcesFrom(tools: readonly ToolReference[]): Readonly<Record<string, ToolSource>> {
  const sources: Record<string, ToolSource> = {}
  for (const tool of tools) {
    sources[tool.name] = tool.source
  }
  return sources
}

/**
 * Fold an `agent.tool_use` in: one call line, at the event's own `seq` (epic #303, X1; #308).
 *
 * The status is derived rather than stored in the log: a call whose policy is `ask` is
 * `waiting` (nothing runs it until the reader answers), and any other call is `running` while
 * the turn is working — or `lost` once the turn is over and nothing has answered it, which only
 * a call the brain never got to run can be.
 */
function fromToolUse(state: TranscriptState, event: AgentToolUseEvent): TranscriptState {
  return withTodoEvents(
    upsertToolCall(state, {
      id: event.id,
      name: event.name,
      input: event.input,
      permission: event.evaluated_permission,
      source: state.toolSources[event.name] ?? 'builtin',
      status: toolCallStatus(event.evaluated_permission, undefined, {
        waiting: false,
        running: state.status === 'running',
      }),
      position: event.seq,
    }),
    event,
  )
}

/**
 * Fold an `agent.tool_result` in: what answered the call, and the status it moves to
 * (epic #303, X1; #308).
 *
 * The result names its call in `tool_use_id`; a result for a call this client never saw — it
 * joined mid-step, or a rewind took the call back — has nothing to attach to and is dropped.
 */
function fromToolResult(state: TranscriptState, event: AgentToolResultEvent): TranscriptState {
  const index = state.toolCalls.findIndex((call) => call.id === event.tool_use_id)
  if (index === -1) {
    return state
  }
  const existing = state.toolCalls[index] as TranscriptToolCall
  const result: ToolCallResult = {
    content: event.content.map((block) => block.text).join(''),
    isError: event.is_error,
  }
  const call: TranscriptToolCall = {
    ...existing,
    result,
    status: toolCallStatus(existing.permission, result, {
      waiting: false,
      running: state.status === 'running',
    }),
  }
  const toolCalls = state.toolCalls.slice()
  toolCalls[index] = call
  return withTodoEvents({ ...state, toolCalls }, event)
}

/**
 * Keep the reader's decision about a waiting call (epic #303, X6; #309; #310).
 *
 * The stored `user.tool_confirmation` is the record, so this is a plain append keyed by the
 * call it names: the newest confirmation for a call is the answer, exactly as the brain's
 * `confirmationsByCall` reads it. A confirmation for a call the transcript never saw — it
 * joined mid-step — is still kept: the decision happened, and the call it names may arrive
 * later in the same replay.
 */
function recordConfirmation(
  state: TranscriptState,
  event: UserToolConfirmationEvent,
): TranscriptState {
  const confirmation: TranscriptConfirmation = {
    toolUseId: event.tool_use_id,
    result: event.result,
    ...(event.remember === undefined ? {} : { remember: event.remember }),
    ...(event.deny_message === undefined ? {} : { denyMessage: event.deny_message }),
    ...(event.answers === undefined ? {} : { answers: event.answers }),
    seq: event.seq,
  }
  const replaceable = state.confirmations.findIndex(
    (current) => current.seq === event.seq || current.toolUseId === confirmation.toolUseId,
  )
  if (replaceable === -1) {
    return { ...state, confirmations: [...state.confirmations, confirmation] }
  }
  const confirmations = state.confirmations.slice()
  confirmations[replaceable] = confirmation
  return { ...state, confirmations }
}

/**
 * Record a tool event for the todo list, and recompute the list it holds (epic #303, #308).
 *
 * Only `todo_write`'s own calls matter to {@link readTodoList}, but keeping every tool event is
 * what lets the protocol's rule — the newest successful call wins, a failed or unanswered one
 * counts for nothing — be the one that runs, rather than a restatement of it here. The list is
 * recomputed from the events, so a call and the result that answers it move it in one step.
 */
function withTodoEvents(state: TranscriptState, event: StoredEvent): TranscriptState {
  const todoEvents = [...state.todoEvents, event]
  return { ...state, todoEvents, todos: readTodoList(todoEvents) }
}

/**
 * Recompute every call's status for a turn that started or ended (epic #303, #308).
 *
 * Only the calls a result never answered change: one is `running` while the turn works and
 * `lost` once it is over, while a call waiting on the reader keeps `waiting` (its permission is
 * `ask`). Returns the list it was given when nothing changed, so the state keeps its identity.
 */
function refreshToolStatuses(
  state: TranscriptState,
  status: SessionStatus,
): readonly TranscriptToolCall[] {
  let changed = false
  const toolCalls = state.toolCalls.map((call) => {
    const next = toolCallStatus(call.permission, call.result, {
      waiting: false,
      running: status === 'running',
    })
    if (next === call.status) {
      return call
    }
    changed = true
    return { ...call, status: next }
  })
  return changed ? toolCalls : state.toolCalls
}

/**
 * Put `call` in the transcript: replacing the call with the same id, or inserting it by
 * position, exactly as {@link upsertMessage} does for messages.
 */
function upsertToolCall(state: TranscriptState, call: TranscriptToolCall): TranscriptState {
  const existing = state.toolCalls.find((candidate) => candidate.id === call.id)
  if (existing !== undefined && isSameToolCall(existing, call)) {
    return state
  }
  const rest = state.toolCalls.filter((candidate) => candidate.id !== call.id)
  const index = rest.findIndex((candidate) => candidate.position > call.position)
  const toolCalls =
    index === -1 ? [...rest, call] : [...rest.slice(0, index), call, ...rest.slice(index)]
  return { ...state, toolCalls }
}

/** Whether an upsert would change nothing, so the state can keep its identity. */
function isSameToolCall(current: TranscriptToolCall, next: TranscriptToolCall): boolean {
  return (
    current.name === next.name &&
    current.permission === next.permission &&
    current.source === next.source &&
    current.status === next.status &&
    current.position === next.position &&
    sameJson(current.input, next.input) &&
    current.result?.content === next.result?.content &&
    current.result?.isError === next.result?.isError
  )
}

/** Whether two JSON inputs are the same value, compared structurally. */
function sameJson(current: unknown, next: unknown): boolean {
  return JSON.stringify(current) === JSON.stringify(next)
}

/**
 * Fold a stored `user.message` in, applying the model-switch rule (epic #116, U1).
 *
 * A message that carries a `model` switches the session to it: the state's `model` moves to
 * the new id, and the message carries {@link TranscriptMessage.modelChangedTo} when that id
 * differs from the one already in effect — a change a UI marks. What is "already in effect" is
 * whatever `state.model` held: the session's own model when the frontend seeded it (#268), the
 * model the last request ran, or the `null` of a transcript nothing has told anything. A
 * message naming the model already in effect is left unmarked.
 */
function fromUserMessage(state: TranscriptState, event: UserMessageEvent): TranscriptState {
  const model = event.model?.id
  const parts = textParts(event.content.map((block) => block.text))
  const message: TranscriptMessage = {
    id: event.id,
    role: 'user',
    parts,
    text: joinedText(parts),
    pending: event.processed_at === null,
    streaming: false,
    position: event.seq,
    ...(model !== undefined && state.model !== null && model !== state.model
      ? { modelChangedTo: model }
      : {}),
  }
  return { ...upsertMessage(state, message), model: model ?? state.model }
}

/**
 * Fold a stored `agent.message` in: the reply, plus the model requests it answers (epic #201,
 * U1).
 *
 * The reply takes every request the turn has opened and no earlier reply claimed — the failed
 * attempt a retry followed, and the retry itself — as its {@link TranscriptMessage.meta}. The
 * requests keep the message's id, so the span ends still to come know which reply to add their
 * tokens and their duration to: the span end of a reply arrives *after* the reply itself.
 */
function fromAgentMessage(state: TranscriptState, event: AgentMessageEvent): TranscriptState {
  // A summary request answers nothing, so it is never what the reply ran on (epic #277, C2):
  // the reply takes the chat's own requests, and the summarizer's model and tokens stay out of
  // its metadata. The request stays tracked until the turn ends, like one no reply claimed.
  const claimed = state.pendingRequests.filter(
    (request) => request.messageId === undefined && request.summary !== true,
  )
  const message = messageFromAgentEvent(
    event,
    agentMessagePosition(state, event),
    metaFrom(claimed),
  )
  const pendingRequests = [
    // A request an earlier reply already took keeps its attribution until its end lands.
    ...state.pendingRequests.filter((request) => request.messageId !== undefined),
    ...claimed.map((request) => ({ ...request, messageId: event.id })),
  ]
  return { ...upsertMessage(state, message), lastError: null, pendingRequests }
}

/**
 * Fold a stored `session.context_summary` in: the divider, and the reduced context it leaves
 * behind (epic #277, K10; #280).
 *
 * The summary supersedes nothing, so the messages stay exactly as they were — the divider is a
 * mark *in* the conversation, at the last `seq` the summary covers, and the history above it
 * stays on screen. What changes is what the meter measures: from here until the next real
 * request reports its own size, the context is an estimate (`contextAfterSummary`) built from
 * the summary and the messages it replaced.
 *
 * The progress line goes with it: the compaction this event is the end of is over.
 */
function fromContextSummary(state: TranscriptState, event: ContextSummaryEvent): TranscriptState {
  const summary: TranscriptSummary = {
    id: event.id,
    summary: event.summary,
    reason: event.reason,
    model: event.summary_model,
    passes: event.passes,
    tokensBefore: event.tokens_before,
    ...(event.fallback_reason === undefined ? {} : { fallbackReason: event.fallback_reason }),
    position: event.covers.to_seq,
    seq: event.seq,
  }
  return {
    ...state,
    summaries: [...state.summaries.filter((each) => each.seq !== event.seq), summary],
    summarizing: null,
    context: contextAfterSummaryEvent(state, event),
  }
}

/**
 * The context size a summary leaves: the last measured prompt less what the summary replaced,
 * plus the summary's own text (epic #277, K10; #280).
 *
 * The baseline is the last real request's measurement when the transcript has one — it is a
 * measurement of the same conversation, which is what makes subtracting from it meaningful — and
 * the summary's own `tokens_before` when it does not (a session whose first request is the one
 * the summary was made for). The covered text comes from the messages the transcript holds, at
 * the same estimate; the framing the real prompt paid for is not in it, so the estimate errs
 * high rather than low.
 */
function contextAfterSummaryEvent(
  state: TranscriptState,
  event: ContextSummaryEvent,
): TranscriptContext {
  const coveredText = state.messages
    .filter((message) => message.position <= event.covers.to_seq)
    .map((message) => message.text)
    .join('\n')
  return {
    tokens: contextAfterSummary({
      baseline: state.context?.tokens ?? event.tokens_before,
      summary: event.summary,
      coveredText,
    }),
    estimated: true,
  }
}

/** The transcript message for a stored `agent.message`, reconciled with any preview of it. */
function messageFromAgentEvent(
  event: AgentMessageEvent,
  position: number,
  meta: TranscriptMessageMeta | undefined,
): TranscriptMessage {
  const parts = textParts(event.content.map((block) => block.text))
  return {
    id: event.id,
    role: 'agent',
    parts,
    text: joinedText(parts),
    pending: false,
    streaming: false,
    position,
    ...(meta === undefined ? {} : { meta }),
  }
}

/** The text parts of a stored message: v1's content blocks are text only. */
function textParts(blocks: readonly string[]): readonly MessagePart[] {
  return blocks.map((text): MessagePart => ({ type: 'text', text }))
}

/** A message's text: its text parts, joined. */
function joinedText(parts: readonly MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/** The request a `span.model_request_start` opens (epic #201, U1). */
function openedRequest(event: ModelRequestStartEvent): PendingModelRequest {
  const startedAt = epochMs(event.processed_at)
  return {
    id: event.id,
    ...(event.model === undefined ? {} : { model: event.model }),
    ...(startedAt === undefined ? {} : { startedAt }),
  }
}

/**
 * Close the request a `span.model_request_end` names, and fold what it reported into the reply
 * it belongs to (epic #201, U1).
 *
 * The span end arrives *after* the reply it produced, which is why the metadata is written
 * here rather than when the reply lands: the end carries the tokens and the time. A request
 * that no reply has claimed yet — a failed attempt the brain then retried — is only marked
 * ended here; it stays tracked so the reply the retry produces sums both requests. A span end
 * whose start the client never saw (it joined mid-request) still opens an entry, so a reply
 * the turn stores after it takes those tokens; one stored *before* it is left alone, because
 * the end names the request that opened it and a client that missed that event has nothing to
 * tie the end to.
 */
function closeRequest(state: TranscriptState, event: ModelRequestEndEvent): TranscriptState {
  const existing = state.pendingRequests.find(
    (request) => request.id === event.model_request_start_id,
  )
  const endedAt = epochMs(event.processed_at)
  const closed: PendingModelRequest = {
    ...(existing ?? { id: event.model_request_start_id }),
    ...(endedAt === undefined ? {} : { endedAt }),
    usage: usageFrom(event.model_usage),
  }
  // The chat's own request just measured its prompt (epic #277, K2; #280): the three input-side
  // counters summed is the real prompt size, and it is what the context meter draws. Two
  // requests do not measure the chat's context, so neither moves the meter: a summary request,
  // whose usage is the summarizer's prompt, and a request that reported no input tokens at all —
  // which is how a failed attempt closes its span (a zero usage), and measuring the chat as empty
  // would be worse than not measuring it. A span end whose start the client never saw (it joined
  // mid-compaction) cannot be told apart from the chat's, and is read as one.
  const measured = existing?.summary === true ? null : promptTokens(closed.usage)
  const measured_ =
    measured === null ? state : { ...state, context: { tokens: measured, estimated: false } }
  const requests =
    existing === undefined
      ? [...state.pendingRequests, closed]
      : state.pendingRequests.map((request) => (request.id === closed.id ? closed : request))
  const messageId = closed.messageId
  if (messageId === undefined) {
    return { ...measured_, pendingRequests: requests }
  }
  // The reply takes the tokens of every request attributed to it — this one included, which is
  // why the metadata is read before the request is dropped.
  const attributed = requests.filter((request) => request.messageId === messageId)
  return withMeta(
    { ...measured_, pendingRequests: requests.filter((request) => request.id !== closed.id) },
    messageId,
    metaFrom(attributed),
  )
}

/**
 * The real prompt size a request reported, or `null` when it reported none.
 *
 * The three input-side counters summed — the same measure the brain's `promptTokensOf` takes
 * (epic #277, K2), because the four counters are disjoint. A sum of zero is not a measurement:
 * a prompt is never empty, so a zero is a failed attempt's placeholder.
 */
function promptTokens(usage: TranscriptUsage | undefined): number | null {
  if (usage === undefined) {
    return null
  }
  const tokens = usage.input + usage.cacheCreation + usage.cacheRead
  return tokens > 0 ? tokens : null
}

/** Write `meta` onto the reply `id`, when it is a message the transcript holds. */
function withMeta(
  state: TranscriptState,
  id: string,
  meta: TranscriptMessageMeta | undefined,
): TranscriptState {
  const message = meta === undefined ? undefined : state.messages.find((each) => each.id === id)
  return message === undefined ? state : upsertMessage(state, { ...message, meta })
}

/**
 * The metadata a set of model requests adds up to, or `undefined` when they say nothing.
 *
 * The model is the last one they named — a reply that took several requests ran on the model
 * that finally answered it — and the duration runs from the first request's start to the last
 * one's end, so a retried reply reports the time it really took. Tokens are summed over the
 * requests that reported any, which is how a retried reply's cost includes the attempt that
 * failed before it.
 */
function metaFrom(requests: readonly PendingModelRequest[]): TranscriptMessageMeta | undefined {
  const model = requests.reduce<string | undefined>(
    (last, request) => request.model ?? last,
    undefined,
  )
  const usage = summedUsage(requests)
  const durationMs = spanMs(requests)
  if (model === undefined && usage === undefined && durationMs === undefined) {
    return undefined
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/** The tokens the requests reported, summed; `undefined` when not one of them reported any. */
function summedUsage(requests: readonly PendingModelRequest[]): TranscriptUsage | undefined {
  let input = 0
  let output = 0
  let cacheCreation = 0
  let cacheRead = 0
  let reported = false
  for (const request of requests) {
    if (request.usage === undefined) {
      continue
    }
    input += request.usage.input
    output += request.usage.output
    cacheCreation += request.usage.cacheCreation
    cacheRead += request.usage.cacheRead
    reported = true
  }
  return reported ? { input, output, cacheCreation, cacheRead, total: input + output } : undefined
}

/**
 * How long the requests took, from the earliest start to the latest end.
 *
 * `undefined` when the log does not say — a client that joined after the start, a request
 * whose span end never arrived — and for a negative span: `processed_at` is not monotonic
 * across a crash (D9), and a reply that took less than no time is not a duration a UI can
 * print.
 */
function spanMs(requests: readonly PendingModelRequest[]): number | undefined {
  const starts = requests.flatMap((request) =>
    request.startedAt === undefined ? [] : [request.startedAt],
  )
  const ends = requests.flatMap((request) =>
    request.endedAt === undefined ? [] : [request.endedAt],
  )
  if (starts.length === 0 || ends.length === 0) {
    return undefined
  }
  const elapsed = Math.max(...ends) - Math.min(...starts)
  return elapsed < 0 ? undefined : elapsed
}

/** The tokens a `span.model_request_end` reported, in the shape a message's metadata takes. */
function usageFrom(usage: ModelUsage): TranscriptUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    total: usage.input_tokens + usage.output_tokens,
  }
}

/** A `session.usage` event in the shape the transcript keeps (#247). */
function usageFromEvent(event: SessionUsageEvent): SessionUsage {
  return {
    totals: totalsOf(event),
    models: event.models.map((entry) => ({
      model: entry.model,
      usage: totalsOf(entry.usage),
      requests: entry.requests,
    })),
  }
}

/** The four counters of a usage report, in the transcript's spelling. */
function totalsOf(usage: ModelUsage): SessionUsageTotals {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
  }
}

/** A timestamp as epoch milliseconds, or `undefined` when it is not a date at all. */
function epochMs(timestamp: string): number | undefined {
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Where a stored `agent.message` sorts.
 *
 * `supersedes.from_seq` when it carries the range: that is where the reply started, whatever
 * the client saw of its chunks — a client that joined mid-reply, one whose chunks were
 * deleted, and one that watched every delta all sort the reply identically (D9). With no
 * range — a server from before D9, or a reply whose chunks were never stored — it keeps the
 * position of the preview it replaces, where the bubble opened; and a message that replaces
 * nothing lands at its own `seq`.
 */
function agentMessagePosition(state: TranscriptState, event: AgentMessageEvent): number {
  if (event.supersedes !== undefined) {
    return event.supersedes.from_seq
  }
  return state.messages.find((message) => message.id === event.id)?.position ?? event.seq
}

/**
 * Open the preview of `id` at `position`, unless a message with that id is already final.
 */
function startPreview(state: TranscriptState, id: string, position: number): TranscriptState {
  // A preview may only touch a message that is still being previewed: once the stored event
  // has landed, it is the record, and a late preview cannot rewrite it.
  return isPreviewable(state, id) ? upsertMessage(state, emptyPreview(id, position)) : state
}

/**
 * Whether a preview may still write to the message `id`.
 *
 * True when nothing carries that id yet, or when what does is itself still a preview.
 */
function isPreviewable(state: TranscriptState, id: string): boolean {
  const existing = state.messages.find((message) => message.id === id)
  return existing === undefined || existing.streaming
}

/** A preview of `id` with no text yet, so a UI can show that the reply has started. */
function emptyPreview(id: string, position: number): TranscriptMessage {
  return { id, role: 'agent', parts: [], text: '', pending: false, streaming: true, position }
}

/**
 * Put `message` in the transcript: replacing the message with the same id, or inserting it
 * among the others by position.
 *
 * Replacing is what reconciles a preview with the stored event that supersedes it, and what
 * makes a re-delivered event a no-op rather than a duplicate. `messages` stays sorted by
 * position, so a stored reply that carries `supersedes` moves back to where it started —
 * ahead of a steering message it was interleaved with — and every client renders the same
 * conversation whether it followed the reply's chunks or joined afterwards.
 */
function upsertMessage(state: TranscriptState, message: TranscriptMessage): TranscriptState {
  const existing = state.messages.find((candidate) => candidate.id === message.id)
  if (existing !== undefined && isSameMessage(existing, message)) {
    return state
  }
  const rest = state.messages.filter((candidate) => candidate.id !== message.id)
  const index = rest.findIndex((candidate) => candidate.position > message.position)
  const messages =
    index === -1 ? [...rest, message] : [...rest.slice(0, index), message, ...rest.slice(index)]
  return { ...state, messages }
}

/**
 * Whether an upsert would change nothing, so the state can keep its identity.
 *
 * `text` is compared through `parts` — it is their text, joined — so a message whose metadata
 * a span end filled in is a change and one a replayed event restates is not.
 */
function isSameMessage(current: TranscriptMessage | undefined, next: TranscriptMessage): boolean {
  return (
    current !== undefined &&
    sameParts(current.parts, next.parts) &&
    current.pending === next.pending &&
    current.streaming === next.streaming &&
    current.position === next.position &&
    current.role === next.role &&
    sameMeta(current.meta, next.meta)
  )
}

/** Whether two part lists render the same. */
function sameParts(current: readonly MessagePart[], next: readonly MessagePart[]): boolean {
  return (
    current.length === next.length &&
    current.every((part, index) => {
      const other = next[index]
      return other !== undefined && other.type === part.type && other.text === part.text
    })
  )
}

/** Whether two replies report the same metadata. */
function sameMeta(
  current: TranscriptMessageMeta | undefined,
  next: TranscriptMessageMeta | undefined,
): boolean {
  if (current === next) {
    return true
  }
  return (
    current !== undefined &&
    next !== undefined &&
    current.model === next.model &&
    current.durationMs === next.durationMs &&
    current.usage?.input === next.usage?.input &&
    current.usage?.output === next.usage?.output &&
    current.usage?.cacheCreation === next.usage?.cacheCreation &&
    current.usage?.cacheRead === next.usage?.cacheRead &&
    current.usage?.total === next.usage?.total
  )
}

/**
 * Extend a preview with a delta.
 *
 * Deltas carry the index of the content block they extend, so they accumulate per index and
 * `text` is the parts in order — the same string the stored event will carry once it
 * replaces the preview. A delta for an event whose `event_start` was missed (a connection
 * that opened mid-reply) still lands: it opens the preview itself, at `createPosition` —
 * the delta's own `seq`. A delta for a message that is already stored changes nothing.
 *
 * @param state the transcript so far
 * @param eventId the id of the event being previewed
 * @param index the content block the delta extends
 * @param text the fragment to append
 * @param createPosition where to open the preview, if there is none yet
 */
function appendDelta(
  state: TranscriptState,
  eventId: string,
  index: number,
  text: string,
  createPosition: number,
): TranscriptState {
  if (!isPreviewable(state, eventId)) {
    return state
  }
  const current =
    state.messages.find((message) => message.id === eventId) ??
    emptyPreview(eventId, createPosition)
  const parts = current.parts.slice()
  // A block's deltas extend its part; the block a delta names is text until the protocol has
  // another block type to stream (a `tool_use` input, say), which is when this becomes a
  // switch rather than an append.
  parts[index] = { type: 'text', text: (parts[index]?.text ?? '') + text }
  return upsertMessage(state, {
    ...current,
    parts,
    text: joinedText(parts),
    streaming: true,
  })
}

/** The messages, in order. */
export function selectMessages(state: TranscriptState): readonly TranscriptMessage[] {
  return state.messages
}

/** Whether the agent is working. */
export function selectIsRunning(state: TranscriptState): boolean {
  return state.status === 'running'
}

/** The last message, or `null` in an empty transcript. */
export function selectLastMessage(state: TranscriptState): TranscriptMessage | null {
  return state.messages.at(-1) ?? null
}

/** The `agent.message` being previewed right now, or `null`. */
export function selectStreamingMessage(state: TranscriptState): TranscriptMessage | null {
  return state.messages.find((message) => message.streaming) ?? null
}

/**
 * The summaries the conversation still holds, in the order they were written (epic #277, K10;
 * #280).
 *
 * Each one's {@link TranscriptSummary.position} is where its divider belongs among the messages,
 * so a transcript that renders both can interleave them from this list alone.
 */
export function selectSummaries(state: TranscriptState): readonly TranscriptSummary[] {
  return state.summaries
}

/**
 * The conversation and its summary dividers as one ordered list (epic #277, K10; #280).
 *
 * The order is by position, and a divider draws **after** the message it covers — a summary
 * marks where the model stops reading verbatim, which is past the event at `covers.to_seq`, not
 * before it. `messages` and `summaries` are both kept in ascending position by the reducer, so
 * this is one merge walk.
 *
 * A frontend renders this through a lookup on `kind` (the shape `PART_RENDERERS` has), so a
 * transcript cannot end up drawing its dividers in a different place from the other frontend's.
 */
export function selectTranscriptEntries(state: TranscriptState): readonly TranscriptEntry[] {
  return transcriptEntries(state.messages, state.summaries, state.toolCalls)
}

/**
 * The same merge, for a caller that holds the lists without a transcript around them.
 *
 * A tie goes to the message, then to the tool call, then to the divider: a summary draws
 * **after** the event it covers, and a call is drawn where its own event sits — never at a
 * position a message already occupies, since every event has one `seq` of its own.
 *
 * @param messages the conversation, in position order
 * @param summaries the dividers, in position order
 * @param toolCalls the calls, in position order
 */
export function transcriptEntries(
  messages: readonly TranscriptMessage[],
  summaries: readonly TranscriptSummary[],
  toolCalls: readonly TranscriptToolCall[] = [],
): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  let messageIndex = 0
  let summaryIndex = 0
  let toolIndex = 0
  while (
    messageIndex < messages.length ||
    summaryIndex < summaries.length ||
    toolIndex < toolCalls.length
  ) {
    const message = messages[messageIndex]
    const summary = summaries[summaryIndex]
    const call = toolCalls[toolIndex]
    const nextMessage = message?.position ?? Number.POSITIVE_INFINITY
    const nextTool = call?.position ?? Number.POSITIVE_INFINITY
    const nextSummary = summary?.position ?? Number.POSITIVE_INFINITY
    const min = Math.min(nextMessage, nextTool, nextSummary)
    if (nextMessage === min) {
      entries.push({ kind: 'message', message: message as TranscriptMessage })
      messageIndex += 1
      continue
    }
    if (nextTool === min) {
      entries.push({ kind: 'tool', call: call as TranscriptToolCall })
      toolIndex += 1
      continue
    }
    entries.push({ kind: 'summary', summary: summary as TranscriptSummary })
    summaryIndex += 1
  }
  return entries
}

/**
 * The tool calls the conversation holds, in position order (epic #303, X5; #308).
 *
 * A frontend that renders {@link selectTranscriptEntries} gets them interleaved with the
 * messages; this is for one that wants the calls on their own (a count, a "waiting" badge).
 */
export function selectToolCalls(state: TranscriptState): readonly TranscriptToolCall[] {
  return state.toolCalls
}

/**
 * The decisions the reader made about calls that waited on them, in log order (epic #303,
 * X6; #309; #310).
 *
 * A frontend reads {@link selectConfirmation} for one call's own answer; this is for one that
 * wants them all (a count, an audit line).
 */
export function selectConfirmations(state: TranscriptState): readonly TranscriptConfirmation[] {
  return state.confirmations
}

/**
 * The reader's decision about one call, or `null` (epic #303, X6; #309; #310).
 *
 * The newest confirmation naming the call is the answer, which is the same rule the brain
 * reads a `remember: session` approval back with — one lookup, so a UI and the brain cannot
 * disagree about what was decided.
 *
 * @param state the transcript
 * @param toolUseId the call's id, the `agent.tool_use` event's own
 */
export function selectConfirmation(
  state: TranscriptState,
  toolUseId: string,
): TranscriptConfirmation | null {
  let found: TranscriptConfirmation | null = null
  for (const confirmation of state.confirmations) {
    if (confirmation.toolUseId === toolUseId) {
      found = confirmation
    }
  }
  return found
}

/**
 * The tool results the newest real request had to shorten (epic #303, X9; #306; #308).
 *
 * Empty when the request capped nothing — which is every turn that did not fill a tool's head
 * room, and every log stored before #306.
 */
export function selectTruncatedToolResults(state: TranscriptState): readonly TruncatedToolResult[] {
  return state.truncatedToolResults
}

/** The old tool results the newest real request cleared, or `null` (epic #303, X9; #306; #308). */
export function selectClearedToolResults(state: TranscriptState): ClearedToolResults | null {
  return state.clearedToolResults
}

/**
 * How many searches this chat's calls add up to (epic #303, X5; #305; #308).
 *
 * The same count the usage routes report, for a screen that already holds the calls — so the
 * chat header can say what the chat searched for without a second request. `searchCount` is
 * where the counting rule lives, shared with whatever else draws it.
 */
export function selectSearchCount(state: TranscriptState): number {
  return searchCount(state.toolCalls)
}

/**
 * The task list the model last wrote with `todo_write`, or `null` (epic #303, X5; #305; #308).
 *
 * Both frontends draw it while a chat has one — a pinned panel on the web, a compact block in
 * `oh` — and it updates live, because it is recomputed from the calls as they land. `null` is "no
 * list has ever been written"; an empty array is a model clearing the one it had.
 */
export function selectTodos(state: TranscriptState): TodoList | null {
  return state.todos
}

/** The summary being written right now, or `null` (epic #277, C2/K10; #280). */
export function selectSummarizing(state: TranscriptState): TranscriptSummarizing | null {
  return state.summarizing
}

/**
 * How full the context was at the last real model request, or `null` (epic #277, K2/K10; #280).
 *
 * What {@link contextMeter} turns into the number a frontend draws, together with the current
 * model's budget and the caller's threshold.
 */
export function selectContext(state: TranscriptState): TranscriptContext | null {
  return state.context
}

/** The newest item a request had to shorten to fit, or `null` (epic #277, K6/K10; #280). */
export function selectTruncation(state: TranscriptState): TranscriptTruncation | null {
  return state.truncation
}

/**
 * The manual compaction the log last asked for, or `null` (epic #277, K8; #283).
 *
 * What a frontend draws the ask and its outcome from: `pending` is the "Compacting…" state, and
 * the outcome is a notice for the two results a reader has to be told about
 * ({@link manualCompactionNotice} turns it into the words).
 */
export function selectManualCompaction(state: TranscriptState): TranscriptManualCompaction | null {
  return state.manualCompaction
}

/**
 * The session's usage: the running totals the log reported, or the same totals derived from
 * its replies (epic #245, A2; issue #247).
 *
 * **A session stored before `session.usage` existed derives its totals here**, which is what
 * makes a replay equal a live stream: the newest event's totals are exactly what a fold over
 * the stored `span.model_request_end` events produces, and the fold is what a transcript built
 * from those spans already holds. The event is preferred when there is one because it is the
 * whole answer in one place — and because it also counts a request that produced no reply.
 *
 * The derivation attributes each reply to the model its metadata names. A reply whose model
 * the log does not name — a client that joined mid-request — contributes to no entry, so the
 * totals are always the models' sum and a reader never sees a total it cannot break down.
 */
export function selectSessionUsage(state: TranscriptState): SessionUsage {
  return state.usage ?? sessionUsageOf(state.messages)
}

/**
 * The totals a transcript's replies add up to, per model.
 *
 * The derivation {@link selectSessionUsage} falls back to; exported for a caller that holds
 * messages without a transcript around them.
 *
 * @param messages the conversation, in order
 */
export function sessionUsageOf(messages: readonly TranscriptMessage[]): SessionUsage {
  const models = new Map<string, SessionUsageTotals>()
  const requests = new Map<string, number>()
  let totals = emptyTotals()
  for (const message of messages) {
    const model = message.meta?.model
    const usage = message.meta?.usage
    if (model === undefined || usage === undefined) {
      continue
    }
    totals = plus(totals, usage)
    models.set(model, plus(models.get(model) ?? emptyTotals(), usage))
    // One reply is one entry in the derivation: a reply the log retried carries the failed
    // attempt's tokens in the same metadata, so its request count is the reply's, not the
    // attempts'. The event's own count is exact; this is the best a transcript can say.
    requests.set(model, (requests.get(model) ?? 0) + 1)
  }
  return {
    totals,
    models: [...models].map(([model, usage]) => ({
      model,
      usage,
      requests: requests.get(model) ?? 0,
    })),
  }
}

/**
 * What a session's tokens cost: the sum of the requests that could be priced, and how many could
 * not (epic #245, A2; #247, decided 2026-10-09).
 *
 * `prices` is the model catalog's (`ModelEntry.cost`). A model it does not price makes its
 * requests — all of them, which the totals count per model — unpriced rather than free: the cost
 * is the priced part, and `unpriced_requests` names the rest, which is what a frontend renders as
 * "+ N unpriced". The cost is `null` only when nothing in the session could be priced, which is
 * what "—" means.
 *
 * @param usage the session's totals, as {@link selectSessionUsage} answers them
 * @param prices the price of a `provider/model` id, or `null` for one nobody publishes
 */
export function sessionCost(usage: SessionUsage, prices: ModelPriceLookup): TotalCost {
  // An unpriced model stands for every request that ran on it, so the count `totalCost` reports
  // is requests — the same unit the usage routes count — rather than models.
  const parts = usage.models.flatMap((entry) => {
    const cost = totalsCost(entry.usage, prices(entry.model))
    return cost === null ? Array<number | null>(entry.requests).fill(null) : [cost]
  })
  return totalCost(parts)
}

/**
 * What one reply cost, in USD — or `null` when the log or the catalog cannot say (epic #245,
 * A2; issue #247).
 *
 * A reply with no metadata, no model, or no tokens has no cost to report: `null`, which a
 * frontend draws as "—" beside the tokens it does have.
 *
 * @param meta the reply's metadata, from {@link TranscriptMessage.meta}
 * @param prices the price of a `provider/model` id, or `null` for one nobody publishes
 */
export function replyCost(
  meta: TranscriptMessageMeta | undefined,
  prices: ModelPriceLookup,
): number | null {
  if (meta?.usage === undefined) {
    return null
  }
  return totalsCost(meta.usage, meta.model === undefined ? null : prices(meta.model))
}

/** The cost of a set of counters at one model's rates, via the protocol's arithmetic. */
function totalsCost(usage: SessionUsageTotals, cost: ModelCost | null): number | null {
  return usageCost(
    {
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_creation_input_tokens: usage.cacheCreation,
      cache_read_input_tokens: usage.cacheRead,
    },
    cost,
  )
}

/** The four counters at zero. */
function emptyTotals(): SessionUsageTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }
}

/** A reply's tokens added into a running total, counter by counter. */
function plus(into: SessionUsageTotals, usage: TranscriptUsage): SessionUsageTotals {
  return {
    input: into.input + usage.input,
    output: into.output + usage.output,
    cacheCreation: into.cacheCreation + usage.cacheCreation,
    cacheRead: into.cacheRead + usage.cacheRead,
  }
}

/** The stateful wrapper {@link createTranscript} hands out. */
export interface Transcript {
  /** The current state. Stable between changes, so a framework can compare by reference. */
  getState(): TranscriptState

  /** Fold one event in, notify subscribers, and return the new state. */
  apply(event: StreamEvent): TranscriptState

  /** Fold a sequence in — history, or a batch of stream events — and return the new state. */
  applyAll(events: Iterable<StreamEvent>): TranscriptState

  /**
   * Start over from {@link initialTranscriptState}, seeded by `seed` when one is given, and
   * notify subscribers.
   *
   * A frontend that opened a session on the way to building its transcript calls this with the
   * session's model before it replays the log, which is what seeds the first-switch marker
   * (#268).
   */
  reset(seed?: TranscriptSeed): TranscriptState

  /**
   * Watch the state.
   *
   * Framework-free, and shaped for the ones that ask for this: React's
   * `useSyncExternalStore(subscribe, getState)` takes exactly this pair.
   *
   * @param listener called with the new state after every change
   * @returns unsubscribe
   */
  subscribe(listener: (state: TranscriptState) => void): () => void
}

/**
 * Create a transcript store.
 *
 * The reducer functions are exported on their own for callers that would rather hold the
 * state themselves (a reducer in a framework, a test asserting on one event); this is the
 * wrapper that keeps it.
 *
 * @param initial starting state; defaults to {@link initialTranscriptState}
 */
export function createTranscript(initial: TranscriptState = initialTranscriptState()): Transcript {
  let state = initial
  const listeners = new Set<(state: TranscriptState) => void>()

  const setState = (next: TranscriptState): TranscriptState => {
    state = next
    for (const listener of listeners) {
      listener(state)
    }
    return state
  }

  return {
    getState: () => state,
    apply: (event) => setState(reduceTranscript(state, event)),
    applyAll: (events) => setState(reduceTranscriptAll(state, events)),
    reset: (seed) => setState(initialTranscriptState(seed)),
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
