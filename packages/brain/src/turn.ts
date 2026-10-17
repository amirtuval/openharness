import {
  EVENT_TYPES,
  WEB_SEARCH_TOOL_NAME,
  newEventId,
  toolCallInput,
  toolCallName,
} from '@openharness/protocol'
import type {
  EventId,
  ModeId,
  ModeToolOverride,
  ModelConfig,
  ReasoningEffort,
  SessionCompactionOutcome,
  SessionId,
  SessionTaskStartedEvent,
  Source,
  StoredEvent,
  Supersedes,
  TaskId,
  TaskStatus,
  Timestamp,
  ToolCallEvent,
  UserId,
} from '@openharness/protocol'
import type { AppendableEvent, PartitionFence, SessionStore, Clock } from '@openharness/session'
import { SessionNotFoundError, systemClock } from '@openharness/session'
import type { ToolRegistry } from '@openharness/hands'

import type { LanguageModel, ToolSet } from 'ai'

import type { ContextStrategy } from './context'
import {
  DEFAULT_CONTEXT_STRATEGY,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateContextSize,
} from './context'
import {
  agentMessage,
  agentOpaqueContent,
  agentToolResult,
  agentToolUse,
  compactionOutcome,
  eventDelta,
  eventStart,
  sessionError,
  sessionUsage,
  spanEnd,
  spanStart,
  statusIdle,
  statusRescheduled,
  statusRunning,
  toolResultForCall,
} from './events'
import { classifyModelError } from './errors'
import { isHandoffAbort } from './handoff'
import { assertValidEvents, EventValidationError } from './validate'
import {
  chunkRangeAfter,
  contextView,
  isUserInterrupt,
  isUserMessage,
  lastStatusEventType,
  needsModelRequest,
  readLog,
  usageByModel,
  withRequestUsage,
} from './log'
import {
  answerConfirmations,
  answeredWaiting as answeredWaitingCalls,
  awaitingUser,
  confirmationsByCall,
  resolveWaiting,
  RESOLVED_BY_MESSAGE,
  sessionApprovedTools,
} from './pausing'
import {
  childTurnStart,
  deliverChildTurn,
  stopOrphanedTasks,
  withSubagentTools,
  type SubagentRuntime,
} from './agents'
import { withSubagentPrompt, type SubagentParent } from './subagent'
import type { McpListingFailure, McpToolProvider } from './mcp'
import { combineTools, resolveMcpTools } from './mcp'
import { pendingManualCompaction } from './manual'
import type { ModelFactory, ModelRequestResult, ModelSearchCall, ResolveCredential } from './model'
import {
  credentialSecrets,
  isUnsupportedProviderError,
  isUsableCredential,
  missingCredentialMessage,
  providerOf,
  streamModelRequest,
  ZERO_MODEL_USAGE,
} from './model'
import { nativeSearchFor, searchWasRejected, webSearchOffered } from './native-search'
import { captureOpaque, opaqueTargetOf } from './opaque'
import type { OpaqueTarget } from './opaque'
import { planReasoning, type ReasoningSupportFor, requestedReasoningEffort } from './reasoning'
import { redactSecrets } from './redact'
import { stuckEnd } from './stuck'
import {
  awaitingTasks,
  notificationResultText,
  deliverableNotifications,
  pendingNotifications,
  recordedWaitDeadline,
  settleTaskWaits,
  stillRunning,
  taskStatuses,
  taskStarts,
  taskWaitOf,
  taskWaitTimedOut,
} from './tasks'
import type { TaskWaitOutcome } from './tasks'
import type { ToolSecretResolver, ToolSettingsResolver, ToolSupportFor } from './tools'
import {
  DEFAULT_MAX_TOOL_STEPS,
  lostExecutions,
  offeredTools,
  repairLostExecutions,
  runToolStep,
  toolSet,
  toolsFor,
  withoutAskUser,
} from './tools'
import type { RetryPolicy } from './retry'
import { backoffDelay, resolveRetryPolicy } from './retry'
import type { ContextCompactionOption, SummarizeResult } from './summarize'
import { resolveContextCompaction, summarizeContext } from './summarize'

/**
 * The turn loop: read the log, call the model, append what happened.
 *
 * `runTurn` is the whole brain. It holds no state between calls — every turn rebuilds the
 * conversation from the session log, which is what lets a turn be resumed by another process
 * after a crash and what makes the log, not the process, the record of a run. It knows nothing
 * about scheduling, ownership, HTTP or storage: it is handed a `SessionStore`, a model and an
 * abort signal, and it appends events.
 *
 * ## Lifecycle
 *
 * Since D9 (issue #46) the log is immutable, and three things follow from that. The claim on
 * the user events a request answers *is* the append of its `span.model_request_start` (its
 * `consumes` list), so a claim cannot be taken by two brains and nothing rewrites
 * `processed_at`. The chunks of a streaming reply are stored events, appended as they arrive.
 * And the event that finishes a reply carries `supersedes` over the chunks it replaces, so
 * replay skips them and compaction can delete them later without changing what any reader sees.
 *
 * ```
 * no turn to run, nothing queued and nothing answered (X6) ..... return noop
 *
 * START (an inherited turn, `getTurnState` is not idle)
 *   an open span ................ span.model_request_end { error: brain_lost,
 *                                 supersedes: that span's chunks } → then re-run
 *   last status was rescheduled .. session.status_running
 *   last status was running ...... (nothing: that turn already opened)
 * START (a fresh turn)
 *   .............................. session.status_running
 *
 * LOOP (per model request)
 *   1. an aborted signal, or a queued user.interrupt ....... INTERRUPT
 *   1b. a call the user has answered (#309) ................ answer it — run it, deny it, or
 *      write the answers — then carry on from 1 with its result
 *   2. the turn has made OPENHARNESS_MAX_TOOL_STEPS requests . STEPS EXHAUSTED (below)
 *   3. a call the log holds with no answer and no user waiting on it .. `execution lost` (X3)
 *   3b. a call still waiting on the user (#309), no message beside it . PAUSE (below)
 *   4. no unanswered message left ........................... session.status_idle, return idle
 *   5. re-read the session; its CURRENT `model` (U3 — a `user.message` may have switched it,
 *      even while the previous request was streaming) is what this request runs, is recorded
 *      on its span and chooses the credential's provider. A session deleted meanwhile throws
 *      SessionNotFoundError and the turn stops, writing nothing (U5).
 *   6. no credential for the model's provider ............... session.error
 *                                                             { missing_provider_credential,
 *                                                               retry_status: exhausted }
 *                                                             session.status_idle
 *                                                             { consumes: the queued ids }
 *                                                             return error
 *   7. claim the queued user.message events; the claim is the append of the span start below
 *   7b. the request's tool settings resolved (#307): the host's resolver, asked with the
 *      session's owner and the mode's override; a tool turned off drops out of the offer
 *   8. ............. span.model_request_start { consumes, model,
 *                                    tools: the { name, source } of every tool offered,
 *                                    reasoning_effort, mode, truncated, cleared }
 *   9. stream ....... stored event_start (one sevt_ id), then one stored event_delta per chunk
 *  10. text streamed ......... agent.message { supersedes: the chunk range }
 *      no text ................................... (no message; the span end supersedes)
 *  11. .............................. span.model_request_end { model_usage }
 *                                      session.usage { the session's running totals, #247 }
 *  12. the step called tools ................................ TOOL STEP (below), loop from 1
 *  13. another user.message arrived .......................... loop from 1
 *  14. otherwise ............................................. session.status_idle, return idle
 *
 * TOOL STEP — one model request's calls, run and answered (epic #303, X2; #307)
 *   each call's permission read off the request's settings, else the tool's own declaration
 *   ................. agent.tool_use × N { name, input, evaluated_permission }
 *                      (one append, before anything runs: what the model asked for is in the
 *                       log whatever happens next)
 *   the calls run CONCURRENTLY through the registry — those the permission allowed; a refused
 *   one is answered without running, and one that waits on the user is not answered at all
 *   ................. agent.tool_result × N { tool_use_id, content, is_error }
 *                      (one append, in CALL ORDER, whatever order they finished in)
 *   then loop from 1: the answers are what owes the next request
 *
 *   A tool_result is `is_error: true` for everything that is not what the tool produced: a
 *   refusal (`Permission to use <name> has been denied.`), a timeout, an interrupt
 *   (`Interrupted by the user.`), the tool's own failure, or `execution lost` (below). A call
 *   waiting on the user has none yet — see PAUSE.
 *
 * STEPS EXHAUSTED — the turn has made OPENHARNESS_MAX_TOOL_STEPS model requests (X2)
 *   ........................................... session.error { tool_steps_exhausted_error,
 *                                                 retry_status: terminal }
 *   ........................................... session.status_idle, return error
 *
 *   A model that keeps calling tools is a loop, and this is what bounds it: the turn ends with
 *   a sentence a reader can act on rather than through a retry that would run out again. The
 *   session goes idle, so the next message starts a fresh turn with its own budget.
 *
 * EXECUTION LOST — a call the log holds with no result and no user waiting on it (X3)
 *   ................. agent.tool_result { is_error: true, "execution lost" }
 *
 *   A brain that finds one inherited it: the process that made the call died before storing
 *   its answer. The call is **never run again** — it may already have had an effect nobody
 *   recorded, and doing it twice is worse than not knowing — so the model is told the
 *   execution was lost and decides what to do about it. The one call this must not answer is
 *   one the user has not answered yet (#309): nothing is lost while the question is open, and a
 *   resumed brain keeps waiting.
 *
 *   This runs at the request boundary, before any request is built: an assistant turn whose
 *   calls have no answers is a request providers refuse.
 *
 * PAUSE — a call whose decision is "the user has to answer this" (epic #303, X6; #309)
 *   the user has answered it (a `user.tool_confirmation` in the log)
 *     ..................................... run it, write the denial, or write the answers as
 *                                           its `agent.tool_result` (one append, call order),
 *                                           then loop from 1 — the result owes a request
 *     the turn inherited an open turn, and the call is one the user *allowed*
 *     ..................................... agent.tool_result { is_error: true, "execution
 *                                           lost" }: the approval is in the log and nobody
 *                                           knows whether it ran, so it never runs again
 *   nothing has answered it, and no message arrived
 *     ..................................... session.status_idle
 *                                           { stop_reason: { type: requires_action,
 *                                                            event_ids: the calls } }
 *     ..................................... return paused
 *   a user.message arrived while it waited
 *     ..................................... agent.tool_result × N { is_error: true,
 *                                           "The user sent a message instead." }, then loop
 *                                           from 1 with the message
 *   an interrupt arrived while it waited ..... the same results, then INTERRUPT
 *
 *   A pause is a turn end, not a wait in the process: the calls are in the log, the session is
 *   idle, and nothing is held open. That is what makes it survive a restart — a resumed brain
 *   reads the same log and keeps waiting — and what makes the `requires_action` stop reason the
 *   whole of what a client needs to draw the question.
 *
 * MODEL FAILURE — no credential for the model's provider (epic #65, A5)
 *   The credential is resolved before the span start, so no span is opened for a request that
 *   was never made and no chunk exists to supersede — shown above as step 4. The messages the
 *   request would have answered are claimed by the idle event that ends the turn, the way an
 *   interrupt's are (P4): leaving them queued would make the scheduler run the same failing
 *   turn again. Nothing is retried.
 *
 * INTERRUPT (an aborted signal, or a queued user.interrupt)
 *   partial text streamed ............ agent.message { supersedes: the chunk range }
 *   a span is open ......... span.model_request_end { error: interrupted,
 *                            consumes: the interrupt ids }
 *                            (with `supersedes` too when no text was stored)
 *   nothing in flight ...... session.status_idle { consumes: the interrupt ids }
 *   ................................... return interrupted
 *
 * An interrupt is claimed by the event that ends the work it stopped (P4) — the open
 * request's span end, or the turn's idle event when nothing was running. No span is opened
 * for an interrupt, so no span exists without a real model request behind it.
 *
 * HANDOFF (the signal aborted with a `TurnHandoff` reason — #378, P1)
 *   ..................................... nothing is written: the turn stays OPEN
 *
 *   The scheduler said "this process should not be running this session any more" — a
 *   shutdown, a surplus partition given back, or a lease somebody else took over — and the
 *   turn is not the user's to lose. Whatever the turn had already written stays exactly as it
 *   is: the cut-off request's chunks are superseded by the next owner's `brain_lost` span end,
 *   the same way a crash's are. No `agent.message`, no span end, no `session.status_idle`, no
 *   child-to-parent delivery, and no answer to a call that was still waiting. The next owner
 *   finds the open turn with `findSessionsNeedingWork` and finishes it with the inherited-turn
 *   START above. The abort is observed only at a boundary between appends, so the handoff never
 *   splits a step's writes: a tool step that was cut off still has its calls stored (the next
 *   owner answers them `execution lost`), and a reply that was fully streamed may be re-issued
 *   once more rather than closed from here.
 *
 * MODEL FAILURE (a retryable error, attempts left)
 *    ............ span.model_request_end { error: model_error, supersedes: the chunks }
 *    ................................... session.error { retry_status: retrying }
 *    ................................... session.status_rescheduled
 *    backoff sleep, honoring the signal
 *    ................................... session.status_running, loop from 1 (new message id)
 *
 * MODEL FAILURE (terminal, or out of attempts)
 *   ............ span.model_request_end { error: model_error, supersedes: the chunks }
 *   ................................... session.error { retry_status: exhausted | terminal }
 *   ................................... session.status_idle, return error
 *
 * AN EVENT THE PROTOCOL DOES NOT ACCEPT (an event shaped by the model's report fails validation)
 *   the span closes ...... span.model_request_end { error: model_error, usage: 0,
 *                           supersedes: the chunks }
 *   ................................... session.error { type: unknown_error, retry_status: terminal }
 *   ................................... session.status_idle, return error
 * ```
 *
 * `FencedError` and `ClaimConflictError` short-circuit all of it: the partition is somebody
 * else's, or another owner claimed the user events this request was about to answer, so the
 * turn stops at the refused write and rethrows — see {@link runTurn}.
 */

/** What a turn did, for the scheduler that ran it. */
export type TurnOutcomeKind =
  /** The turn ran and ended with `session.status_idle`. */
  | 'idle'
  /** There was nothing to do: no open turn and nothing queued. Nothing was written. */
  | 'noop'
  /**
   * The turn ended because it is waiting on the user (epic #303, X6; #309): the session is idle
   * with `stop_reason: { type: 'requires_action' }`, and one `user.tool_confirmation` starts the
   * turn that carries on. Nothing is retried and nothing is lost — the calls are in the log.
   */
  | 'paused'
  /**
   * The turn ended because the model asked to wait for background tasks (epic #340, S5; #343):
   * the session is idle with `stop_reason: { type: 'waiting_on_tasks' }`, and it resumes on a
   * `session.task_notification` for one of them, on the deadline, or on a `user.message`. The
   * same kind of pause as `paused` — written down, holding no lease and no slot — and the
   * scheduler arms a timer from {@link TurnOutcome.waiting} rather than polling for it.
   */
  | 'waiting'
  /**
   * The turn was **handed off** rather than ended (#378, P1): the scheduler aborted it because
   * this process is shutting down, gave the partition up as surplus, or lost its lease. The
   * turn wrote nothing after the abort and left itself **open** — no partial message, no span
   * end, no `session.status_idle` — so the partition's next owner finds it with
   * `findSessionsNeedingWork`, closes the inherited span as `brain_lost` and runs the request
   * again. The scheduler must stop the pass and must not look for more local work.
   */
  | 'handed_off'
  /** The turn was cut short by an interrupt, by `signal` or by a queued `user.interrupt`. */
  | 'interrupted'
  /**
   * The turn died on a model failure that was not retryable, on retries that ran out, on a
   * model request with no credential to make it, or on an event the protocol would not accept
   * — all four end with `session.error`.
   */
  | 'error'

/** The summary {@link runTurn} resolves to. */
export interface TurnOutcome {
  /** Which way the turn ended. */
  readonly outcome: TurnOutcomeKind
  /**
   * What a `waiting` turn waits for (epic #340, S5; #343): the tasks, and the instant its
   * deadline falls on.
   *
   * Carried out of the turn because the deadline is a *timer* the host owns: nothing in the log
   * wakes a session at an instant, so the scheduler reads this and asks for a turn when it
   * passes. The deadline is the log's (the `stop_reason` of the idle event just written), so a
   * turn that resumed for another reason and went back to waiting reports the same one.
   */
  readonly waiting?: TaskWaitState
}

/** What a turn waiting on tasks waits for, and until when. */
export interface TaskWaitState {
  /** The tasks it waits for; empty means any task of this session. */
  readonly taskIds: readonly TaskId[]
  /** The instant its deadline falls on, as the timestamp the log recorded. */
  readonly deadline: Timestamp
}

/** How {@link runTurn} is called. */
export interface RunTurnOptions {
  /** The session's log: the only thing the turn reads, and the only thing it writes. */
  readonly store: SessionStore
  /**
   * The model to stream from. The id it is called with is the session's **current**
   * `model.id` (issue #93, #94), re-read at every request boundary — so a `user.message`
   * that switched the model mid-turn applies from the next request (epic #116, U3).
   */
  readonly model: ModelFactory
  /**
   * Where the credential for each model request comes from — the session owner's own provider
   * key, resolved per request (epic #65, A5).
   *
   * The brain holds no provider key of its own and never reads one from the environment: a
   * request is made only with a credential this resolver answered, and an owner who has none
   * for the model's provider ends the turn with `missing_provider_credential` rather than
   * letting the provider package fall back to `OPENAI_API_KEY` and friends.
   */
  readonly resolveCredential: ResolveCredential
  /**
   * The turn's time source, for the one thing it does with time (epic #340, S5; #343): a task
   * wait's deadline is compared against it, so a wait that has outlived its time is answered as
   * timed out even when the host's timer for it never fired (a restart, a lost partition).
   *
   * The same injectable clock the stores take, and `systemClock` when the host passes none.
   */
  readonly now?: Clock
  /** Aborting this ends the turn at the next safe point; see the lifecycle above. */
  readonly signal?: AbortSignal
  /**
   * The partition lease this turn writes under.
   *
   * Passed on every `appendEvents`, so a brain whose lease has been taken over cannot write
   * into the log its successor now owns. A refused write stops the turn immediately and
   * rethrows the `FencedError`.
   */
  readonly fence?: PartitionFence
  /** How the log becomes messages; defaults to `DEFAULT_CONTEXT_STRATEGY`. */
  readonly contextStrategy?: ContextStrategy
  /**
   * Which reasoning efforts the model of a request takes, asked once per request — the same
   * injected-resolver seam as the context budget's `tokenBudgetFor` (#252's follow-up).
   *
   * Omitted, no model is known to take an effort and every request keeps its provider's default.
   * The server builds one from its models.dev registry
   * (`apps/server/src/catalog/reasoning-support.ts`); see {@link ReasoningSupportFor}.
   */
  readonly reasoningSupportFor?: ReasoningSupportFor
  /**
   * Where a mode's current definition comes from, asked once per request with the mode the
   * session follows (#245, M6) — the same injected-resolver seam as `reasoningSupportFor` and
   * the context budget's `tokenBudgetFor`.
   *
   * It is a resolver rather than a value because a chat **follows its mode live**: the next
   * request uses the mode as it is now, so an edit applies from the next request on exactly as
   * a model switch does. The host (the server) owns the modes — they live in its database, not
   * the log — so it answers with the resolved model, effort and prompt addition, or `null` for
   * a mode it no longer knows (one that was deleted), which leaves the request on the session's
   * own model. A host that injects none is the same as one that never knows a mode: a session
   * on a mode runs its own model.
   */
  readonly resolveMode?: ModeResolver
  /** How model failures are retried; see {@link RetryPolicy}. */
  readonly retry?: RetryPolicy
  /**
   * Context compaction (epic #277, C2; issue #279; per-user controls: C3, #282): summarize
   * older history when its context fills, instead of letting the strategy trim it away.
   *
   * **Absent means off** — a host that wires none gets exactly the behaviour of #278, and the
   * brain's own tests run no model calls they did not script. Either one configuration for
   * every owner, or a {@link ContextCompactionResolver} the loop asks once per request with the
   * session's owner, so a host that stores the threshold, the summary model and the pass limit
   * per user (C3) can answer for the one whose chat this is. The server always passes the
   * resolver (`main.ts`, from `OPENHARNESS_COMPACTION_THRESHOLD`, the owner's preferences and
   * the registry's limits), which is where the epic's 70% default applies. See
   * {@link ContextCompactionConfig}.
   */
  readonly compaction?: ContextCompactionOption
  /**
   * The tools this turn's requests may offer (epic #303, X4), or `undefined` for a chat with
   * none — which is every host before #304, and every model whose registry entry says it cannot
   * call tools.
   *
   * The registry is the host's: `@openharness/hands` runs a tool, and this package decides
   * when. A call runs in-process, with the per-user values the host resolved
   * ({@link RunTurnOptions.resolveToolSecrets}) and nothing else — no environment, no
   * database — so the same registry serves two users without ever holding either's secret.
   */
  readonly tools?: ToolRegistry
  /**
   * The tool settings in force for this request (epic #303, X3/X4; the per-user settings and
   * the mode's override: issue #307), asked **once per request** with the session's owner and
   * the tool override the request's mode imposes.
   *
   * A resolver rather than a value for the reason the credential resolver is one: the settings
   * belong to the session's owner and live in the host's store, and nothing in this package
   * reads a database. Per request rather than per call, because the offered set has to exist
   * before the request is built — a tool the user turned off is left out of the offer entirely
   * — and because an edit then applies from the next request on, exactly as a model switch
   * does. A host that injects none gets each tool's own declared permission. `allow` and `deny`
   * are honoured; `ask` pauses the turn until the user answers (epic #303, #309), and a
   * `remember: session` approval is read back off the log from then on.
   */
  readonly toolSettings?: ToolSettingsResolver
  /**
   * Whether a model can call tools at all (epic #303, X2), asked once per request with the
   * credential type the request was resolved with — the same injected-resolver seam as
   * `reasoningSupportFor`, and the server builds it from its models.dev snapshot
   * (`tool_call`).
   *
   * `false` means no tools are offered and the request is built exactly as it was before tools
   * existed; `undefined` — a model the registry does not know — means offer them. A host that
   * injects no resolver at all is the same as one that knows nothing: every model may call
   * tools, because a host that wired a registry meant it.
   */
  readonly toolSupportFor?: ToolSupportFor
  /**
   * Where the per-user values a tool may need come from (epic #303, X4), asked once per step
   * with the session's owner — the same seam as {@link ModeResolver}.
   *
   * The server owns them (a service's key, an MCP server's token, #311); nothing here reads an
   * environment variable or a store. Absent means there are none, and a tool is handed an empty
   * map. A value resolved here is scrubbed out of whatever a tool returns before it is stored
   * (`@openharness/hands`), so a tool cannot leak one into the log.
   */
  readonly resolveToolSecrets?: ToolSecretResolver
  /**
   * The most model requests one turn may make (epic #303, X2); {@link DEFAULT_MAX_TOOL_STEPS}
   * when absent. A turn that reaches it ends with a `tool_steps_exhausted_error` notice and
   * goes idle rather than retrying.
   */
  readonly maxToolSteps?: number
  /**
   * // extension: the share of the chat model's budget at which old tool results are cleared
   * (#331); {@link DEFAULT_CLEAR_THRESHOLD} when absent.
   *
   * The soft threshold before the compaction one: below it a request carries its old tool results
   * as they were stored (still capped, X9), at or above it the oldest are cleared to a placeholder.
   * It is handed to both the context strategy and the size estimate, so the request that is
   * measured and the request that is built clear on the same condition. The server wires it from
   * `OPENHARNESS_CLEAR_THRESHOLD`, next to the compaction controls (#282).
   */
  readonly clearThreshold?: number
  /**
   * // extension: whether to nudge the model to write a todo list before its first tool call
   * (#331). `false` — the default — means no nudge, which is where the study leaves it: the
   * benefit is real but small, and a line on every session's first request is not free.
   */
  readonly todoNudge?: boolean
  /**
   * Where this request's remote MCP tools come from (epic #303, X10; #312), asked once per
   * request with the session's owner and the tool override of the mode the request resolved to
   * — the same answer {@link RunTurnOptions.toolSettings} is asked with.
   *
   * A resolver rather than a registry, because MCP tools are not the deployment's: which servers
   * are in force is the session owner's settings, their credentials live in the host's vault,
   * and listing a server's tools is a network call nothing in this package makes. Asked per
   * request so that a server switched off, removed or connected applies from the next request
   * on; the host is expected to keep that cheap with a short cache, and the span records what
   * each request really offered.
   *
   * A server that cannot be listed is a **failure**, not an error: the turn continues without
   * its tools and the user is told through a `session.error`. Absent means this host has no MCP
   * at all, which is a request that offers only the deployment's own tools.
   */
  readonly mcpTools?: McpToolProvider
  /**
   * // extension: what this deployment knows about subagents (epic #340, S5/S6; #344) — the
   * types a parent may start, the depth and live-task limits, and how the host is signalled.
   *
   * Absent means the deployment has none, which is what a host that never wired a type resolver
   * wants: the five tools are offered to nobody, so nothing can promise a helper the deployment
   * cannot start. Present, the request boundary adds this session's tools to the offer (the
   * parent side under the depth cap, `message_parent` to a child) and the loop does the rest —
   * a child's turn reports its status and its result to the parent, and a session whose child's
   * registration a rewind took back stops it.
   */
  readonly subagents?: SubagentRuntime
}

/**
 * A mode, as the host resolved it for one request (#245, M6): the id and name to record, and
 * the model, effort and system-prompt addition the request is built with.
 *
 * The model is a `provider/model` id — a mode's "my default model" is resolved by the host,
 * which holds the user's preferences, before it answers. The effort is the mode's own, and the
 * addition is appended after the session's system prompt rather than in place of it.
 */
export interface ResolvedMode {
  /** The `mode_` id the session follows, recorded on the request's span. */
  readonly id: ModeId
  /** The mode's name as it is now, recorded beside the id. */
  readonly name: string
  /** The `provider/model` this request runs. */
  readonly model: string
  /** The mode's reasoning effort, or `null` for the provider's default. */
  readonly reasoningEffort: ReasoningEffort | null
  /** Appended after the session's system prompt, or `null` for no addition. */
  readonly systemPromptAddition: string | null
  /**
   * Which built-in tools this mode forces on or off, or `null` for a mode that says nothing
   * about tools (issue #307) — the host has the mode row, so it answers this from it.
   *
   * It is handed to {@link RunTurnOptions.toolSettings} with the owner rather than applied
   * here, because a mode **overrides** a user's settings and the host is where both live: the
   * loop never merges the two itself. A mode may not touch a permission, so nothing about a
   * call's `evaluated_permission` depends on this field.
   */
  readonly toolOverride: ModeToolOverride | null
}

/**
 * Where a mode's current definition comes from (#245, M6): the owner it belongs to and the id
 * the session follows, answered with the mode as it is now — or `null` for one that is gone.
 */
export type ModeResolver = (ownerId: UserId, modeId: ModeId) => Promise<ResolvedMode | null>

/** What the loop knows about a reply it has to finish storing. */
interface PartialReply {
  /** The id the chunks were stored under — the id the message will be stored under. */
  readonly id: EventId
  /** The text streamed so far. */
  readonly text: string
  /** The `span.model_request_start` the request's span end points at. */
  readonly spanId: EventId
  /** The chunk range the reply covers; see `SupersedesSchema` in the protocol. */
  readonly range: Supersedes
}

/**
 * Run one turn of a session to the point where it is idle again — or to the point where an
 * interrupt or a failure ended it.
 *
 * Reads the whole log, answers whatever the user is waiting on, and appends events as it goes.
 * It never throws for a model failure: a failure is part of the turn's story, and the log
 * records it (`span.model_request_end`, `session.error`, `session.status_idle`). It does throw
 * for a `FencedError` — the one failure the turn must not write anything about, because the log
 * is not the writer's any more — for a `ClaimConflictError`, which means another owner claimed
 * the user events this request was about to answer, and for a `SessionNotFoundError` — which
 * includes a session hard-deleted while the turn was running (epic #116, U5): the turn stops
 * at the next request boundary and writes nothing more.
 *
 * Each request is made with a credential `resolveCredential` answered for the provider of the
 * session's **current** model — re-read at that request's boundary (epic #116, U3), so a
 * model switch mid-turn changes which provider is asked from the next request on — and with
 * no other credential: an owner who has none ends the turn with `missing_provider_credential`
 * before a span is opened — the provider keys of the environment are never a fallback (epic
 * #65, A5).
 *
 * @param sessionId the session to run; a `sesn_` id
 * @param options the store, the model factory, the credential resolver, and the turn's knobs
 */
export async function runTurn(sessionId: SessionId, options: RunTurnOptions): Promise<TurnOutcome> {
  const outcome = await runTurnInner(sessionId, options)
  await deliverTurnToParent(sessionId, options, outcome)
  return outcome
}

/**
 * What a **child**'s finished turn owes its parent (epic #340, S4; #344).
 *
 * The wrapper rather than a call at each of the loop's endings: a turn ends in several places —
 * idle, interrupted, an error, a pause, a wait — and what the parent has to be told is one thing
 * about one of them, so it is asked once, of the outcome. Only a turn that **ended** is
 * announced: a wait and a pause are the child still working (`./agents`' `childTurnDelivery`
 * decides from the log, and this only decides whether to ask at all), and a `noop` turn never
 * opened anything.
 *
 * The delivery itself is idempotent (the notification is keyed by the child's turn), so a
 * process that dies between the turn and its announcement costs nothing: the turn the store's
 * work scan starts for that child next delivers it, which is the `noop` guard below.
 */
async function deliverTurnToParent(
  sessionId: SessionId,
  options: RunTurnOptions,
  outcome: TurnOutcome,
): Promise<void> {
  const runtime = options.subagents
  if (runtime === undefined || !ENDED_TURNS.has(outcome.outcome)) {
    return
  }
  const session = await options.store.getSessionUnscoped(sessionId)
  if (session === null) {
    return
  }
  await deliverChildTurn(options.store, session, runtime)
}

/** The outcomes that mean a turn is over rather than paused, waiting, or never opened. */
const ENDED_TURNS: ReadonlySet<TurnOutcomeKind> = new Set(['idle', 'interrupted', 'error'])

async function runTurnInner(sessionId: SessionId, options: RunTurnOptions): Promise<TurnOutcome> {
  const { store, model, resolveCredential, signal, fence } = options
  const strategy = options.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY
  const retry = resolveRetryPolicy(options.retry)
  const maxSteps = options.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS
  const writeOptions = fence === undefined ? undefined : { fence }

  // Read through a function: `signal.aborted` is a property TypeScript would otherwise treat
  // as frozen for the rest of the loop, and it is not — a signal aborts when the user says so.
  const isAborted = (): boolean => signal?.aborted === true
  // The scheduler's abort, as opposed to the user's (#378, P1): a shutdown, a partition given
  // up, or a lease lost. It leaves the turn open instead of ending it — see HANDOFF above.
  const handedOff = (): boolean => isHandoffAbort(signal)

  // The turn's time source, for the one thing it does with time: a task wait's deadline.
  const clock = options.now ?? systemClock
  const append = async (events: AppendableEvent[]): Promise<StoredEvent[]> => {
    if (events.length === 0) {
      return []
    }
    // Every append goes through here, so this is where the protocol gets its say: an event in
    // a shape the protocol does not describe is a log no client can read back (see `validate`).
    assertValidEvents(events)
    return store.appendEvents(sessionId, events, writeOptions)
  }

  // Unscoped on purpose: a turn runs for a session, not for a user, and the store's named
  // unscoped read is what makes that explicit (epic #65, A4).
  const session = await store.getSessionUnscoped(sessionId)
  if (session === null) {
    throw new SessionNotFoundError(sessionId)
  }
  // Already handed off before this turn began: the scheduler does not want this process to
  // run the session at all, so nothing is opened and nothing is written. The work is in the
  // log, and whoever owns the partition next finds it (a shutdown's drain may still land here
  // when a pass was queued just before the signal arrived).
  if (handedOff()) {
    return { outcome: 'handed_off' }
  }
  const queued = await store.getPendingUserEvents(sessionId)
  const turnState = await store.getTurnState(sessionId)
  /**
   * Whether the log holds a call the user has answered whose turn has not run yet (#309).
   *
   * A `user.tool_confirmation` is not a queued user event — the server writes it, processed —
   * so a session a user has just answered looks idle to everything that reads the store's
   * pending list. The newest tool event is the cheap test: between a confirmation and the turn
   * it starts, nothing else writes one, so reading the newest of the tool types answers it in
   * one page instead of walking the log on every idle sweep. The MCP pair is here too (#312): a
   * remote call is a call, and the confirmation that answers one is the same event.
   */
  const answeredWaiting = async (): Promise<boolean> => {
    const page = await store.listEventsUnscoped(sessionId, {
      types: [
        EVENT_TYPES.agentToolUse,
        EVENT_TYPES.agentToolResult,
        EVENT_TYPES.agentMcpToolUse,
        EVENT_TYPES.agentMcpToolResult,
        EVENT_TYPES.userToolConfirmation,
      ],
      order: 'desc',
      limit: 1,
    })
    return page.data[0]?.type === EVENT_TYPES.userToolConfirmation
  }
  /**
   * Whether the log's last turn ended waiting on tasks (epic #340, S5; #343).
   *
   * The other thing a session that looks idle can be sitting on, and the same cheap shape: the
   * newest status event is the test, because a wait is resumed by a turn rather than by a queued
   * event. A wait whose answer has already landed is not this — resolving one writes its result
   * and carries the turn on, so a later status event follows.
   */
  const waitingOnTasks = async (): Promise<boolean> => {
    const page = await store.listEventsUnscoped(sessionId, {
      types: [
        EVENT_TYPES.sessionStatusRunning,
        EVENT_TYPES.sessionStatusIdle,
        EVENT_TYPES.sessionStatusRescheduled,
      ],
      order: 'desc',
      limit: 1,
    })
    const newest = page.data[0]
    return (
      newest?.type === EVENT_TYPES.sessionStatusIdle &&
      newest.stop_reason.type === 'waiting_on_tasks'
    )
  }
  /**
   * Whether this turn took over an open turn rather than opening one (X3).
   *
   * It matters for exactly one decision (#309): a call the user approved but whose execution the
   * log never recorded is answered `execution lost` by a turn that **inherited** someone else's —
   * whatever it allowed may already have run — while a turn that opens on an idle session is the
   * one the confirmation started, and runs it. Nothing in the log tells the two apart; the turn
   * state at the moment this call began does.
   */
  const recovered = turnState.state !== 'idle'
  /**
   * Whether this turn is only here to claim an interrupt (#371).
   *
   * An idle session whose whole queue is `user.interrupt` events is not being asked to do
   * anything: the loop's first check ends the turn on the interrupt, and the only other thing
   * it does is write the results of the calls that were waiting when it arrived. So it must not
   * announce a start — a child would tell its parent it is working when nothing will run — and
   * its end is not a turn that ended when the window it leaves is empty.
   */
  const claimsOnlyInterrupt =
    turnState.state === 'idle' && queued.length > 0 && queued.every(isUserInterrupt)
  // A **child** that owes its parent the news of a finished turn hands it over before anything
  // else this turn does (epic #340, S4; #344), and **whether or not something else is queued
  // for it** (#365). The delivery is idempotent — the notification is keyed by the child's
  // turn — so a process that died between a turn's end and its announcement is repaired by the
  // next turn on that child, which is the turn the store's work scan starts. It must not be
  // skipped when a `user.message` is already queued (an `agent_message`, the user steering it):
  // the turn about to run is a *new* one that will announce its own end, and the older turn's
  // key is never written again — its result, the answer to the prompt the parent wrote, would
  // be lost for good. Nothing is written to this log: the turn exists to hand the news over.
  if (
    turnState.state === 'idle' &&
    options.subagents !== undefined &&
    session.parent_session_id !== null
  ) {
    const child = await store.getSessionUnscoped(sessionId)
    if (child !== null) {
      await deliverChildTurn(store, child, options.subagents)
    }
  }
  if (turnState.state === 'idle' && queued.length === 0) {
    // An idle session with nothing queued is a no-op — unless something waiting in the log owes
    // this turn. Three things do, and none is a user event, so none shows up in `queued`: a
    // manual compaction (K8; #283), a call the user has just answered (epic #303, #309), and a
    // notification a background task wrote (epic #340, S4; #343). A host that wired no
    // compaction never looks for the first.
    const compactionPending =
      options.compaction !== undefined &&
      pendingManualCompaction(await readLog(store, sessionId)) !== null
    // The notification read is the store's, not the log's: this guard is consulted on every
    // idle sweep, and the store's answer is one indexed query rather than a whole replay.
    const notified = (await store.getPendingTaskNotifications(sessionId)).length > 0
    if (
      !compactionPending &&
      !notified &&
      !(await waitingOnTasks()) &&
      !(await answeredWaiting())
    ) {
      return { outcome: 'noop' }
    }
  }

  // ---- Start: open a turn, or take one over.
  //
  // Two things happen here rather than later, because both belong to a turn that really opens
  // (a `noop` above writes neither): a **child** tells its parent it is working (S4) — the
  // status a card follows without either side polling — and a chat whose `agent` call a
  // `session.rewind` took back stops the helper that call started (S7; #344), because this is
  // the first turn that can tell what the rewind covered.
  if (options.subagents !== undefined) {
    // A turn that is only here to claim an interrupt does no work, so a **child** must not tell
    // its parent it started working (S4; #371): `session.task_status { running }` is a claim
    // about work, and the loop's first check ends this turn before anything runs. Announcing it
    // would flip a card that had already finished — the very flip the empty turn's delivery is
    // no longer allowed to make (see `./agents`' `childTurnDelivery`).
    if (session.parent_session_id !== null && !claimsOnlyInterrupt) {
      await childTurnStart(store, session)
    }
    await stopOrphanedTasks(store, session, options.subagents)
  }
  if (turnState.state === 'idle') {
    await append([statusRunning()])
  } else {
    const inherited = await readLog(store, sessionId)
    if (turnState.openSpan !== null) {
      // The span the dead brain left open. Its request will not report usage — nobody saw it
      // end — and the chunks it streamed are orphaned: nothing will ever store the message
      // they previewed, so this span end supersedes them and replay skips them.
      const range = chunkRangeAfter(inherited, turnState.openSpan.seq)
      await append([
        spanEnd(turnState.openSpan.id, ZERO_MODEL_USAGE, {
          error: {
            type: 'brain_lost',
            message: 'The brain that opened this model request is gone.',
          },
          supersedes: range ?? undefined,
        }),
      ])
    }
    if (lastStatusEventType(inherited) === EVENT_TYPES.sessionStatusRescheduled) {
      // The inherited turn was waiting to be resumed; resuming it is what a status_running says.
      await append([statusRunning()])
    }
  }

  /**
   * The ids of the queued `user.interrupt` events, for the event that ends the turn to claim.
   *
   * The claim on a user event is the `consumes` list of the event that answers it, and an
   * interrupt is answered by the turn ending — there is no model request for it (P4). The
   * event that carries the list is the one that closes what the interrupt stopped: a span end
   * for an open request, and the `session.status_idle` when nothing was in flight.
   */
  const pendingInterruptIds = async (): Promise<EventId[]> =>
    (await store.getPendingUserEvents(sessionId)).filter(isUserInterrupt).map((event) => event.id)

  /**
   * Answer the calls that are still waiting on the user, because the user did something else.
   *
   * A `user.message` that arrives while calls wait resolves them — the reader chose to say
   * something rather than to answer — and so does an interrupt (epic #303, X6; #309). Either way
   * the model is told what happened (`The user sent a message instead.`) rather than left with a
   * call that never came back.
   *
   * A **task wait** is released the same way and in the same words (epic #340, S5; #343): the
   * session's log is what the reader moved on in, and a wait with no result is a call no
   * provider would accept in a request. What it was waiting for is not lost: the notifications
   * stay queued and reach the model as steering.
   */
  const releaseWaiting = async (): Promise<void> => {
    const read = await readLog(store, sessionId)
    await resolveWaiting({
      calls: [...awaitingUser(read), ...awaitingTasks(read)],
      append,
    })
  }

  /** End the turn the way an interrupt does, whatever it interrupted. */
  const endInterrupted = async (partial?: PartialReply): Promise<TurnOutcome> => {
    await releaseWaiting()
    const interrupts = await pendingInterruptIds()
    if (partial !== undefined) {
      // A request is open, so its span end is what ends the work the interrupt stopped — and
      // it carries the claim (P4). No model request is opened for an interrupt.
      if (partial.text.length > 0) {
        // The partial reply is kept, superseding the chunks it was streamed as.
        await append([agentMessage(partial.id, partial.text, partial.range)])
        await append([
          spanEnd(partial.spanId, ZERO_MODEL_USAGE, {
            error: { type: 'interrupted', message: 'Interrupted by the user.' },
            consumes: interrupts,
          }),
        ])
      } else {
        // Nothing was stored as a message, so the span end supersedes the chunks itself.
        await append([
          spanEnd(partial.spanId, ZERO_MODEL_USAGE, {
            error: { type: 'interrupted', message: 'Interrupted by the user.' },
            supersedes: partial.range,
            consumes: interrupts,
          }),
        ])
      }
      // The span end took the claim, so the turn's idle event carries none.
      await append([statusIdle()])
      return { outcome: 'interrupted' }
    }
    // Nothing was in flight: the turn ends on the interrupt, and its idle event carries the
    // claim on the interrupt events that arrived while nothing was running.
    await append([statusIdle({ consumes: interrupts })])
    return { outcome: 'interrupted' }
  }

  /**
   * End a turn whose own event was not the protocol's shape, instead of storing it.
   *
   * The error path is the terminal model failure's, one step earlier: the span closes (with no
   * usage — there is none to trust — and superseding the chunks, which will never become a
   * stored message), the reason goes into the log as a `session.error`, and the session goes
   * idle. Nothing is retried: rebuilding the same event would fail the same way.
   */
  const endInvalidEvent = async (
    error: EventValidationError,
    spanId: EventId,
    range: Supersedes,
  ): Promise<TurnOutcome> => {
    await append([
      spanEnd(spanId, ZERO_MODEL_USAGE, {
        error: { type: 'model_error', message: error.message },
        supersedes: range,
      }),
    ])
    await append([
      sessionError({
        type: 'unknown_error',
        message: error.message,
        retry_status: { type: 'terminal' },
      }),
      statusIdle(),
    ])
    return { outcome: 'error' }
  }

  // ---- Loop: one iteration per model request.
  let retriesUsed = 0
  // The compaction engine's one overflow retry (K2, C2): a request a provider refused as too
  // long is compacted with tighter caps and tried once more, and a second refusal ends the turn
  // with a clear error rather than looping. Once **per turn**, not per request, is what bounds
  // it however many requests the turn makes.
  let overflowRetried = false
  // Whether the provider refused the native search tool this turn offered (#335). Once it has,
  // no later request of the turn offers it again: a provider that does not know the tool does
  // not learn it, and the retry is the request minus the tool.
  let searchRejected = false
  // The MCP servers this turn has already told the user about (epic #303, X10; #312). The
  // listing is per request, so a server that is down would otherwise write the same
  // `session.error` once per step; one notice per server per turn is what a reader wants, and
  // the next turn reports again if it is still unreachable.
  const reportedMcpFailures = new Set<string>()

  /**
   * Tell the user about the servers this request could not list, once each (epic #303, #312).
   *
   * A failure is a notice, never a stop: the turn carries on with the servers that did answer,
   * and `session.error` is the one event in the protocol that carries a sentence for the user.
   * `terminal` is the retry status for the same reason `tool_steps_exhausted_error` uses it —
   * nothing will retry this on its own — and the message says the chat goes on without the
   * server, so a client shows a warning rather than an ending.
   */
  const reportMcpFailures = async (failures: readonly McpListingFailure[]): Promise<void> => {
    const fresh = failures.filter((failure) => !reportedMcpFailures.has(failure.serverName))
    if (fresh.length === 0) {
      return
    }
    for (const failure of fresh) {
      reportedMcpFailures.add(failure.serverName)
    }
    await append(
      fresh.map((failure) =>
        sessionError({
          type:
            failure.kind === 'authentication'
              ? 'mcp_authentication_failed_error'
              : 'mcp_connection_failed_error',
          message:
            `The MCP server ${JSON.stringify(failure.serverName)} could not be used: ` +
            `${failure.message} This chat continues without its tools.`,
          retry_status: { type: 'terminal' },
        }),
      ),
    )
  }
  // The model requests this turn has made (epic #303, X2). A turn makes one per step — and a
  // step that called a tool owes the next one — so a model that keeps calling tools would
  // otherwise loop until it chose to stop. Counted per answered request: a retry is the same
  // step made again, and `retry` is what bounds that.
  let steps = 0
  // What the host wired, resolved below once per request: the one configuration for every
  // owner, or the resolver the per-user controls (C3, #282) live behind. Held unresolved here
  // because a resolver has to be asked with the owner, which the request boundary reads.
  const compactionOption = options.compaction
  for (;;) {
    // A handoff that arrived before this request started writes nothing at all and leaves the
    // turn as it is; the next owner carries on from the log. It is checked before the user's
    // interrupt so a shutdown never claims an interrupt that was queued behind it — that
    // event stays pending, and the next owner answers it.
    if (handedOff()) {
      return { outcome: 'handed_off' }
    }
    // An interrupt that arrived before this request started — a queued user.interrupt covers
    // the one the user sent while no brain was running to abort.
    if (isAborted()) {
      return await endInterrupted()
    }
    const pending = await store.getPendingUserEvents(sessionId)
    if (pending.some(isUserInterrupt)) {
      return await endInterrupted()
    }
    // Steering: the queued events are this request's to answer, and the append of the span
    // start below claims them — in the same transaction, or not at all. A message — or a
    // background task's notification (epic #340, S4; #343) — that arrives after that append is
    // not in its `consumes`, so it stays queued for the next request (and `contextView` leaves
    // it out of what this one answers). The notification read is the store's, deliberately: it
    // is the same indexed query the no-op guard and the work scan make, and taking it from the
    // log would mean reading the whole log again at every step. A notification is in `claims`
    // only because the request folds it in: it is **not** what the user's pause below waits for
    // — nothing a task says answers a question a person was asked (#363).
    let claims = [
      ...pending.filter(isUserMessage).map((event) => event.id),
      ...(await store.getPendingTaskNotifications(sessionId)).map((event) => event.id),
    ]
    // Per request, not per turn (epic #116, U3): a `user.message` carrying a `model` switched
    // `session.model` in the append transaction, and re-reading here is what makes the switch
    // — including one that arrived while the previous request was streaming — apply from this
    // request on, across providers, since each request is built from the current id alone. A
    // session deleted while the turn ran is gone for good: the turn stops here, before this
    // request claims anything, so the delete is the last thing written (U5).
    const current = await store.getSessionUnscoped(sessionId)
    if (current === null) {
      throw new SessionNotFoundError(sessionId)
    }
    // The compaction this request runs with (epic #277, C2/C3; #279/#282): the trigger's share,
    // the summary model and the pass limit are the **owner's** preferences, so a resolver is
    // asked here, at the request boundary, exactly as the mode resolver is — an edit to the
    // settings applies from the next request on, and another user's choice never reaches this
    // chat. Absent means off, as before: no trigger and no overflow handling.
    const compaction =
      compactionOption === undefined
        ? null
        : resolveContextCompaction(
            typeof compactionOption === 'function'
              ? await compactionOption(current.owner_id)
              : compactionOption,
          )
    // The mode this request follows, if the session is on one (#245, M6). The session holds
    // the mode's id; the host resolves it as it is now, so an edit applies from this request on
    // — the "live follow" a mode is for. A mode the host no longer knows (it was deleted)
    // answers `null`, and the request falls back to the session's own model, which the delete
    // left as the model the chat last ran. The resolved model is what this request runs and
    // what its span records, not the session's stored one.
    const mode =
      current.mode === null
        ? null
        : ((await options.resolveMode?.(current.owner_id, current.mode)) ?? null)
    const requestModel: ModelConfig = mode === null ? current.model : { id: mode.model }
    // The system prompt this request is built with: the session's own, with the mode's addition
    // appended after it (#245, M6). Computed here, before the compaction engine runs, because
    // both the engine and the trigger measure the context the strategy will build from it and
    // the two have to agree on what the prompt is.
    const withMode = withModePrompt(current.system, mode?.systemPromptAddition ?? null)
    // A **child** runs with the subagent prompt appended after whatever its own prompt is (S2):
    // it has to be told it is a helper, that it cannot ask the user, and that its final message
    // is the whole of what the parent receives — none of which it could read off its own
    // conversation. A top-level chat is unchanged.
    const requestSystem =
      current.parent_session_id === null ? withMode : withSubagentPrompt(withMode)
    // The remote tools this boundary may offer (epic #303, X10; #312), listed once here — before
    // the user's answers are acted on, because an approved remote call has to be runnable, and
    // before the request is measured, because a remote tool's declaration is what caps its own
    // result. A server that cannot be listed is a notice, never a failure: the turn goes on
    // without its tools (`./mcp`).
    const mcp = await resolveMcpTools(
      options.mcpTools,
      options.tools,
      current.owner_id,
      mode?.toolOverride ?? null,
    )
    await reportMcpFailures(mcp.failures)
    // One registry for this request, this build's tools and the remote ones together: everything
    // downstream is keyed by a tool's name and knows nothing about where it came from — and, for
    // a non-interactive session, `ask_user` is not in it at all (epic #340, S1). The session's
    // own flag decides, because it is fixed at creation: the request is built without the
    // question tool, the span records an offer without it, and a call to it is answered by the
    // registry as one naming a tool this step was not handed.
    const available = await withSubagentTools(
      withoutAskUser(combineTools(options.tools, mcp.registry), session.interactive),
      {
        store,
        session: current,
        runtime: options.subagents,
        // Asked when an `agent` call runs, not now: the effort in force is read off the log a
        // few lines below, and the answer belongs to the request the call was made in.
        parent: async (): Promise<SubagentParent> => ({
          model: requestModel.id,
          reasoningEffort: effortInForce(
            await readLog(store, sessionId),
            mode?.reasoningEffort ?? null,
          ),
          toolOverride: mode?.toolOverride ?? null,
          modeId: current.mode,
        }),
      },
    )
    // How big the request this boundary is about to make is (K2/K6/X9), measured with the two
    // numbers the strategy's own caps are read against: the chat model's history budget, from the
    // same resolver the engine plans with (#246) — the strategy resolves its budget from the
    // configuration it was built with, and the server hands both the same resolver, so the
    // measurement and the request agree about what a result may cost and what is old enough to
    // clear — and the registry, whose declarations carry the per-tool cap.
    const contextBudget =
      compaction === null
        ? DEFAULT_CONTEXT_TOKEN_BUDGET
        : (compaction.tokenBudgetFor?.(requestModel.id) ?? DEFAULT_CONTEXT_TOKEN_BUDGET)
    // `opaqueTarget` is this request's own replay target (epic #303, X13; #334), known once the
    // credential is resolved — which is below the manual-compaction size taken here, so that one
    // call measures a request without opaque parts (see `ContextSizeOptions.opaqueTarget`).
    const sizeOf = (events: readonly StoredEvent[], opaqueTarget?: OpaqueTarget): number =>
      estimateContextSize(events, {
        model: requestModel.id,
        system: requestSystem,
        budget: contextBudget,
        ...(available === undefined ? {} : { tools: available }),
        ...(options.clearThreshold === undefined ? {} : { clearThreshold: options.clearThreshold }),
        ...(options.todoNudge === undefined ? {} : { todoNudge: options.todoNudge }),
        ...(opaqueTarget === undefined ? {} : { opaqueTarget }),
      })
    let read = await readLog(store, sessionId)
    // ---- The user's answers, and the calls still waiting on them (epic #303, X6; #309).
    //
    // Three questions, all asked of the same log and settled in this order, because each one
    // changes what the next means:
    //
    // 1. the calls the user has answered since the last request. They are answered here — the
    //    tool runs, or the denial is written, or the answers become the result — because the
    //    request below has to see a result for every call it is told about.
    const confirmations = confirmationsByCall(read)
    const answeredByUser = answeredWaitingCalls(read)
    if (answeredByUser.length > 0) {
      const secrets =
        options.resolveToolSecrets === undefined
          ? undefined
          : await options.resolveToolSecrets(current.owner_id)
      await answerConfirmations({
        calls: answeredByUser,
        confirmations,
        // The whole offer this boundary resolved, remote tools included: an approved call to a
        // remote tool is run through the registry that holds it (#312), and one whose server has
        // since been removed is answered by the registry's own "not registered" result.
        registry: available,
        ...(secrets === undefined ? {} : { secrets }),
        ...(signal === undefined ? {} : { signal }),
        recovered,
        append,
      })
      read = await readLog(store, sessionId)
    }
    // 2. The crash rule (X3): a call the log holds with no answer and no user waiting on it is
    //    one this brain inherited — the turn that made it died before storing its result — so it
    //    is answered with `execution lost` and the model decides what to do. **Never re-run**:
    //    whatever the call did may already have happened, and doing it twice is worse than not
    //    knowing. A call still waiting on the user is not one of these — nothing is lost, the
    //    question is open — so it is answered by the user or not at all.
    if (lostExecutions(read).length > 0) {
      await repairLostExecutions(read, append)
      read = await readLog(store, sessionId)
    }
    // 3. The calls still waiting on the user. Nothing times out and nothing is held open: the
    //    session goes idle with `requires_action` naming them, and the pause survives a restart
    //    by having been written down. A message that arrived while they waited — or an
    //    interrupt, which the top of the loop already ended the turn on — resolves them instead,
    //    and this turn carries on with the message.
    const waiting = awaitingUser(read)
    if (waiting.length > 0) {
      // What resolves the user's pause is a **message**, not "something queued". `claims` holds
      // a background task's news too, because the request below folds it in as steering — and a
      // notification is news for the model, not the reader moving on (#363): a call waiting on
      // the user must not be answered "The user sent a message instead." because a helper
      // finished. The pause stands, the notification stays pending, and the turn the user's own
      // answer starts is the one that carries it — which is why the store's work scan does not
      // call a pending notification work while a session sits on an `ask` either (`./session`).
      if (!pending.some(isUserMessage)) {
        await append([
          statusIdle({
            stopReason: {
              type: 'requires_action',
              event_ids: waiting.map((call) => call.id),
            },
          }),
        ])
        return { outcome: 'paused' }
      }
      await resolveWaiting({ calls: waiting, append })
      read = await readLog(store, sessionId)
    }
    // 4. The waits for background tasks (epic #340, S5; #343). A call to `agent_wait` is the
    //    same kind of pause as a question and a different thing to resolve: what answers it is
    //    a notification for one of its tasks, its deadline, or — like the user's pause — the
    //    reader doing something else instead. A turn never makes a request while one of its
    //    calls has no answer (a provider refuses that), so every open wait is settled here
    //    before the request below, and a wait nothing has answered ends the turn.
    const openWaits = awaitingTasks(read)
    if (openWaits.length > 0) {
      const starts = taskStarts(read)
      // News from a task this log no longer names is not news — a rewind took its start back
      // (S7; #344), so a wait is not resolved by it either.
      const notifications = deliverableNotifications(pendingNotifications(read), starts)
      // A message the user sent while the wait was open resolves it, exactly as it resolves a
      // question: the reader chose to say something rather than to wait. Only a message counts
      // — a notification for some other task is news, not the reader moving on.
      const endedByMessage = pending.some(isUserMessage)
      const nowMs = clock()
      // One notification is claimed by **one** result (#363): two open waits resolved by the
      // same news would each name it in `consumes`, and the store refuses that append whole —
      // the turn would wedge with the news undelivered. So the share-out happens first, here.
      const outcomes = settleTaskWaits({
        calls: openWaits,
        notifications,
        endedByMessage,
        recordedDeadline: (call) => recordedWaitDeadline(read, call),
        nowMs,
      })
      const stillWaiting = outcomes.filter(
        (outcome): outcome is Extract<TaskWaitOutcome, { kind: 'waiting' }> =>
          outcome.kind === 'waiting',
      )
      const results = openWaits.flatMap((call, index) => {
        const outcome = outcomes[index]
        if (outcome === undefined || outcome.kind === 'waiting') {
          return []
        }
        return [taskWaitResult(call, outcome, starts, taskStatuses(read))]
      })
      if (results.length > 0) {
        await append(results)
        read = await readLog(store, sessionId)
        // A result that answered a wait with news **is** that news, and claims it: the request
        // below must not claim the same notification a second time (the store refuses that, and
        // it would tell the model the same thing twice).
        const consumed = new Set(
          results.flatMap((result) => ('consumes' in result ? (result.consumes ?? []) : [])),
        )
        claims = claims.filter((id) => !consumed.has(id))
      }
      if (stillWaiting.length > 0) {
        // Nothing has answered at least one wait and its deadline is ahead: the turn ends with
        // the pause, holding nothing — no lease, no slot, and no timer of its own beyond the
        // one the host arms from the outcome below. The task set is the union of the calls
        // still waiting and the deadline the earliest of them, so a session that goes back to
        // waiting for something else wakes no later than it asked to.
        const taskIds = [
          ...new Set(
            openWaits.flatMap(
              (call) =>
                taskWaitOf({ name: toolCallName(call), input: toolCallInput(call) })?.taskIds ?? [],
            ),
          ),
        ]
        const deadlineMs = Math.min(...stillWaiting.map((outcome) => outcome.deadlineMs))
        const deadline = new Date(deadlineMs).toISOString()
        await append([
          statusIdle({ stopReason: { type: 'waiting_on_tasks', task_ids: taskIds, deadline } }),
        ])
        return { outcome: 'waiting', waiting: { taskIds, deadline } }
      }
    }
    // The manual request first (K8; #283). A `/compact [instructions]` is handled at a request
    // boundary — this one — whether or not a message is waiting beside it, because a summary
    // changes what every request after it is built from. `pendingManualCompaction` reads it off
    // the log, where it lives as a `session.compact` (it is not a queued user event), and the
    // `session.compaction` written here is what makes it no longer pending. An idle session
    // reaches this too: the no-op guard above lets a session with a pending request open a turn
    // that answers it and nothing else.
    if (compaction !== null) {
      const manual = pendingManualCompaction(read)
      if (manual !== null) {
        const sized = sizeOf(read)
        const manualResult = await summarizeContext({
          chatModel: requestModel.id,
          reason: 'manual',
          events: read,
          system: requestSystem,
          estimatedTokens: sized,
          ...(available === undefined ? {} : { tools: available }),
          config: compaction,
          guidance: manual.instructions,
          model,
          resolveCredential,
          append,
          ...(signal === undefined ? {} : { signal }),
        })
        // The outcome is written whatever came of the run — that is what "not a silent no-op"
        // means, and it is also what stops the same request being answered twice.
        const written = manualCompactionOutcome(manualResult)
        await append([
          compactionOutcome(written.outcome, {
            ...(manual.instructions === null ? {} : { instructions: manual.instructions }),
            ...(manualResult.summarySeq === undefined
              ? {}
              : { summarySeq: manualResult.summarySeq }),
            ...(written.message === undefined ? {} : { message: written.message }),
          }),
        ])
        if (handedOff()) {
          return { outcome: 'handed_off' }
        }
        if (isAborted()) {
          return await endInterrupted()
        }
        read = await readLog(store, sessionId)
      }
    }
    if (claims.length === 0) {
      const answered = contextView(read)
      if (!needsModelRequest(answered)) {
        // Recovery, with the reply already in the log: the request that produced it was answered
        // before the brain died, and asking again would store a second reply. An idle turn that
        // ran only a manual compaction lands here too: it has nothing to answer, so it closes.
        await append([statusIdle()])
        return { outcome: 'idle' }
      }
    }
    // A model repeating one failing call is a loop the step limit would only catch at fifty
    // (epic #303, X2; #331). A run of the newest calls in the turn with the same name and the
    // same arguments, all failing — a policy or user denial and an interrupt do not count as
    // failures — ends the turn here with the step limit's shape: a notice carrying a sentence for
    // the user, the session idle, and no retry, because the same call would fail the same way.
    const stuck = stuckEnd(read)
    if (stuck !== null) {
      await append([
        sessionError({
          type: 'tool_loop_stuck_error',
          message:
            `The model called ${stuck.name} with the same arguments ${stuck.length} times ` +
            'and it failed every time, so the turn was ended. Send a message with a different ' +
            'instruction or approach to carry on.',
          retry_status: { type: 'terminal' },
        }),
        statusIdle(),
      ])
      return { outcome: 'error' }
    }
    if (steps >= maxSteps) {
      // A request is due and the turn has no budget left for it (epic #303, X2). This is a
      // notice, not a failure to retry: the model looped — every step's calls prompted another
      // — and the log says so rather than the scheduler running the same loop again. The turn
      // ends idle, so a message the user sends next starts a fresh turn with a fresh budget.
      await append([
        sessionError({
          type: 'tool_steps_exhausted_error',
          message:
            `This turn reached its limit of ${maxSteps} model requests before the model ` +
            'finished, so it was ended. Send a message to carry on.',
          retry_status: { type: 'terminal' },
        }),
        statusIdle(),
      ])
      return { outcome: 'error' }
    }
    // The credential this request is made with, asked for before anything is claimed. A
    // request that cannot be made opens no span — every span start is a real model request,
    // and this one has none — and streams nothing, so there is no chunk range to supersede.
    // The turn still ends on it, and its idle event claims the messages it could not answer;
    // leaving them queued would make the scheduler that finds work in the log run the same
    // failing turn again, and again (epic #65, A5).
    const provider = providerOf(requestModel.id)
    const credential = await resolveCredential(provider)
    if (!isUsableCredential(credential)) {
      await append([
        sessionError({
          type: 'missing_provider_credential',
          message: missingCredentialMessage(provider),
          retry_status: { type: 'exhausted' },
        }),
        statusIdle({ consumes: claims }),
      ])
      return { outcome: 'error' }
    }
    // The model for this one request, built with the id and the credential just resolved. Both
    // are read at this request's boundary and neither is held between requests, so a switch or
    // a key added mid-turn is picked up by the next one. A build that cannot happen at all —
    // the id names a provider this build has no client for — ends the turn here, before the
    // span: every span start is a real model request, and this one would have none (see
    // `UnsupportedProviderError`).
    let agentModel: LanguageModel
    try {
      agentModel = model(requestModel.id, credential)
    } catch (error) {
      if (!isUnsupportedProviderError(error)) {
        throw error
      }
      await append([
        sessionError({
          type: 'model_request_failed_error',
          message: error.message,
          retry_status: { type: 'exhausted' },
        }),
        statusIdle({ consumes: claims }),
      ])
      return { outcome: 'error' }
    }
    // Where this request's provider-opaque content may be replayed (epic #303, X13; #334): the
    // client family its model and credential make, and the model itself. Both are read at this
    // request's boundary like the model and the credential are, so a switch — provider or model
    // — drops every entry the request can no longer send, and `null` builds the request exactly
    // as it was built before #334.
    const opaqueTarget = opaqueTargetOf(requestModel.id, credential.type)
    if (compaction !== null) {
      // The trigger (K2): the real size of the request this boundary is about to make, against
      // the threshold share of the **chat** model's budget. Over it, older history is summarized
      // before the request — which is what keeps the provider from refusing it — and the log is
      // re-read so the prompt below is built from the summary, not the history it replaced.
      const estimated = sizeOf(read, opaqueTarget ?? undefined)
      const outcome = await summarizeContext({
        chatModel: requestModel.id,
        reason: 'threshold',
        events: read,
        system: requestSystem,
        estimatedTokens: estimated,
        ...(available === undefined ? {} : { tools: available }),
        config: compaction,
        model,
        resolveCredential,
        append,
        ...(signal === undefined ? {} : { signal }),
      })
      if (outcome.outcome === 'summarized') {
        read = await readLog(store, sessionId)
      } else if (outcome.outcome === 'failed') {
        // Nothing to build the prompt differently from, but the failed passes wrote spans the
        // running totals have to include (#247): the fold below reads the log again rather than
        // reporting totals that a later event already moved past.
        read = await readLog(store, sessionId)
      }
    }
    // The log as this request will see it, read once: the effort comes from it, the prompt is
    // built from it, and the running totals below are folded from it (#247). It is the read
    // *before* the claim, with the messages this request is about to claim admitted into the
    // view (`contextView`) — the prompt has to exist before the span start, because the span
    // start carries the truncation record the strategy produced (K6), and the record cannot be
    // written after the fact. The claim itself still lands atomically in the append below.
    //
    // The effort lives in the log while the model this request runs lives on the session
    // (`getSessionUnscoped`, above), and the two cannot be one read: the session is where
    // `system` and the model projection are, the log is where a message's effort is, and the
    // store has no method that answers both. Folding the effort into the model read would mean
    // projecting it onto the session, a `packages/protocol`/`packages/session` change that a
    // per-message field deliberately avoids (see the module note in `reasoning.ts`).
    //
    // What this request runs with (#252): the newest effort the log asks for, read at this
    // request's boundary like the model. A message that set one applies from here on — one that
    // arrived while the previous request was streaming was appended before this read, so it is
    // this request's, and one that arrives after it belongs to the next — and the read is the
    // replay read, so an effort an edit took back is already gone from it. The record rides the
    // span below, which is the only place the log says what a request ran with. The effort, in
    // precedence order: an explicit effort the newest message carried wins (the reader asked for
    // it on that message, #252), and otherwise the mode's own effort applies (#245, M6) — a mode
    // bundles one, and that is what a chat on the mode runs unless a message overrides it.
    // `undefined` is "no message carried one", which is what lets the mode's effort through; an
    // explicit `null` is "the provider's default" and wins.
    const requestedEffort = effortInForce(read, mode?.reasoningEffort ?? null)
    const reasoning = planReasoning(
      requestModel.id,
      credential.type,
      requestedEffort,
      options.reasoningSupportFor,
    )
    const answered = contextView(read, new Set(claims))
    const context = strategy(answered, {
      model: requestModel,
      system: requestSystem,
      // Every tool the request may offer, not `toolRegistry` below: a result an earlier step
      // stored is capped and cleared by its tool's declaration whatever this request offers
      // (X9), and a remote tool declares its own cap (X9; #312).
      ...(available === undefined ? {} : { tools: available }),
      // The soft clearing threshold and the todo nudge (#331), handed to the strategy as they
      // are to the size estimate above, so the request measured and the request built agree.
      ...(options.clearThreshold === undefined ? {} : { clearThreshold: options.clearThreshold }),
      ...(options.todoNudge === undefined ? {} : { todoNudge: options.todoNudge }),
      // The request's own replay target (X13; #334), the same value the size estimate was given.
      ...(opaqueTarget === null ? {} : { opaqueTarget }),
    })
    // The tools this request offers (epic #303, X2/X4; #307), if any: a deployment with no
    // registry has nothing to offer, a model the registry marks as tool-less gets none, and a
    // user who turned every tool off gets none either — in each case the request is built
    // exactly as it was before tools existed. The settings are resolved here, once per request
    // and before the offer is built, because a disabled tool must not be in the offer at all;
    // the mode the request follows rides along, since a mode may force tools on or off. A host
    // that wired no resolver, or no registry, is never asked.
    const toolSettings =
      options.toolSettings === undefined || available === undefined
        ? undefined
        : await options.toolSettings(current.owner_id, mode?.toolOverride ?? null)
    const toolRegistry = toolsFor(
      available,
      options.toolSupportFor,
      toolSettings,
      requestModel.id,
      credential.type,
    )
    // The request's own provider's search tool, when the model has one and the settings in force
    // leave it on (epic #303, X14; issue #335). It is not a registry tool: nothing of ours runs
    // it, and it is attached for exactly one request — the provider runs the search inside it.
    // It is offered only where the request offers tools at all: a host that wired no registry,
    // and a model the registry says cannot call tools, get the request they always got — the
    // native tool is an addition to the offer, never a way round "this chat has no tools".
    const offersTools =
      available !== undefined &&
      options.toolSupportFor?.(requestModel.id, credential.type) !== false
    // A host that registers a tool of its own under the name keeps it: attaching the provider's
    // would shadow it in the offer, and the tool a user configured is the one they meant.
    const search =
      offersTools &&
      toolRegistry?.get(WEB_SEARCH_TOOL_NAME) === undefined &&
      webSearchOffered(requestModel.id, credential.type, toolSettings) &&
      !searchRejected
        ? nativeSearchFor(requestModel.id, credential.type)
        : null
    const tools: ToolSet = {
      ...(toolRegistry === undefined ? {} : toolSet(toolRegistry)),
      ...(search?.tools ?? {}),
    }
    const [start] = await append([
      spanStart(claims, requestModel.id, {
        ...(reasoning.record === undefined ? {} : { reasoningEffort: reasoning.record }),
        ...(mode === null ? {} : { mode }),
        ...(context.truncated === undefined ? {} : { truncated: context.truncated }),
        ...(context.cleared === undefined ? {} : { cleared: context.cleared }),
        ...(context.reminders === undefined ? {} : { reminders: context.reminders }),
        ...(toolRegistry === undefined && search === null
          ? {}
          : {
              tools: offeredTools(toolRegistry, mcp.refs, search === null ? [] : [search.name]),
            }),
      }),
    ])
    if (start === undefined) {
      throw new Error('the store did not return the span it was asked to append')
    }
    const messages = context.messages

    // The reply's chunks are stored as they arrive, under one pre-minted id: the stored
    // `event_start` announces the id the `agent.message` will be stored under, and every
    // `event_delta` carries it, so a client matches what it accumulated to what was stored.
    const eventId = newEventId()
    const [chunkOpen] = await append([eventStart(eventId)])
    if (chunkOpen === undefined) {
      throw new Error('the store did not return the event_start it was asked to append')
    }
    let lastChunkSeq = chunkOpen.seq
    // One model per request, built above with this request's model id and credential.
    const result = await streamModelRequest({
      model: agentModel,
      messages,
      // The definitions carry no `execute`: the SDK must stop after this step and hand the
      // calls back, because the loop that stores the call and runs it is this one. The native
      // search tool (#335) is the opposite: the provider runs it inside this request, so it is
      // attached with nothing of ours behind it, and its calls come back as opaque content.
      ...(Object.keys(tools).length === 0 ? {} : { tools }),
      providerOptions: reasoning.providerOptions,
      signal,
      onTextDelta: async (text) => {
        // One append per chunk, awaited: a chunk that could not be stored ends the request the
        // way it used to end the stream — the reply is never stored half-way.
        const [delta] = await append([eventDelta(eventId, text)])
        if (delta !== undefined) {
          lastChunkSeq = delta.seq
        }
      },
    })
    const range: Supersedes = { from_seq: chunkOpen.seq, to_seq: lastChunkSeq }

    // A handoff that stopped the stream is not an interrupt (#378, P1). The request's chunks
    // stay exactly where they are — nothing supersedes them here — and the next owner closes
    // this span as `brain_lost` with that range, which is the crash shape every reader already
    // understands. The check is here, before the first write of the step's ending, so a step is
    // never left with a stored reply and no span end or the other way round.
    if (handedOff()) {
      return { outcome: 'handed_off' }
    }

    if (result.aborted) {
      return await endInterrupted({
        id: eventId,
        text: result.text,
        spanId: start.id,
        range,
      })
    }

    if (result.error !== undefined) {
      const classification = classifyModelError(result.error)
      // A provider that rejected the key may quote it back in the error text (a 401 naming
      // the key it did not like); it is scrubbed before the message reaches the log, and the
      // rest of what the provider said is kept.
      const message = redactSecrets(classification.message, credentialSecrets(credential))
      // The provider does not know the search tool it was handed — its own models vary, and
      // models.dev records nothing about which have one (X14; #335). Dropping it and asking once
      // more is the answer: the request is otherwise the same, and a chat that cannot search is
      // a working chat. Once per turn, and recorded on the span of the request that was refused.
      const rejectedSearch = search !== null && !searchRejected && searchWasRejected(result.error)
      if (rejectedSearch) {
        searchRejected = true
      }
      // Partial output is never stored, so the span end supersedes the chunks this attempt
      // streamed. The retry below mints a new message id and its own `event_start`.
      await append([
        spanEnd(start.id, ZERO_MODEL_USAGE, {
          error: { type: 'model_error', message },
          supersedes: range,
          ...(rejectedSearch ? { searchRejected: true as const } : {}),
        }),
      ])
      if (rejectedSearch) {
        // The tool was the whole of what was wrong, so this is not the ordinary retry budget's
        // business: the request is different now, and the model is owed a plain answer.
        await append([
          sessionError({
            type: classification.type,
            message,
            retry_status: { type: 'retrying' },
          }),
          statusRescheduled(),
        ])
        if (handedOff()) {
          return { outcome: 'handed_off' }
        }
        if (isAborted()) {
          return await endInterrupted()
        }
        await append([statusRunning()])
        continue
      }
      // The provider refused the request for being too long (K2, C2). That is not a retry — the
      // same request fails the same way — and not a plain terminal error either: the engine
      // compacts with tighter caps and the turn tries once more. Once per turn, so a context
      // that cannot be made to fit ends in a clear error rather than a loop.
      if (classification.contextOverflow && compaction !== null) {
        if (overflowRetried) {
          // The retry was refused for the same reason: the turn ends with an error that says
          // what was tried rather than trying the same request a third time.
          await append([
            sessionError({
              type: classification.type,
              message: `${message} (the context was compacted and the request still did not fit)`,
              retry_status: { type: 'exhausted' },
            }),
            statusIdle(),
          ])
          return { outcome: 'error' }
        }
        overflowRetried = true
        await append([
          sessionError({
            type: classification.type,
            message,
            retry_status: { type: 'retrying' },
          }),
          statusRescheduled(),
        ])
        const fresh = await readLog(store, sessionId)
        const estimate = sizeOf(fresh, opaqueTarget ?? undefined)
        const outcome = await summarizeContext({
          chatModel: requestModel.id,
          reason: 'overflow',
          events: fresh,
          system: requestSystem,
          estimatedTokens: estimate,
          ...(available === undefined ? {} : { tools: available }),
          config: compaction,
          model,
          resolveCredential,
          append,
          ...(signal === undefined ? {} : { signal }),
        })
        if (handedOff()) {
          return { outcome: 'handed_off' }
        }
        if (isAborted()) {
          return await endInterrupted()
        }
        if (outcome.outcome === 'summarized') {
          await append([statusRunning()])
          continue
        }
        // The tighter compaction could not be made (K11's failure path, or the trigger found
        // nowhere to cut): the retry would be the same request again, so the turn ends here
        // with an error that says what was tried. It was **not** compacted — the summary was
        // skipped or failed, which is why nothing was retried — so the message says which of
        // the two it was rather than claiming a compaction that never happened.
        const notCompacted =
          outcome.outcome === 'failed'
            ? 'summarizing the history failed'
            : 'there was no older history to summarize'
        await append([
          sessionError({
            type: classification.type,
            message: `${message} (${notCompacted})`,
            retry_status: { type: 'exhausted' },
          }),
          statusIdle(),
        ])
        return { outcome: 'error' }
      }
      if (classification.retryable && retriesUsed < retry.maxRetries) {
        retriesUsed += 1
        await append([
          sessionError({
            type: classification.type,
            message,
            retry_status: { type: 'retrying' },
          }),
          statusRescheduled(),
        ])
        // The backoff is where an interrupt lands next: nothing is in flight, so honoring the
        // signal here closes the turn the same way an abort mid-stream does.
        await retry.sleep(backoffDelay(retriesUsed, retry), signal)
        if (handedOff()) {
          return { outcome: 'handed_off' }
        }
        if (isAborted()) {
          return await endInterrupted()
        }
        await append([statusRunning()])
        continue
      }
      await append([
        sessionError({
          type: classification.type,
          message,
          retry_status: { type: classification.retryable ? 'exhausted' : 'terminal' },
        }),
        statusIdle(),
      ])
      return { outcome: 'error' }
    }

    // A request that produced no text stores no message: an empty `agent.message` would be a
    // reply the model did not make. The span still records that it ran, superseding the
    // `event_start` so the orphaned chunk does not outlive the request.
    try {
      // The session's running totals ride in the same append as the span end (#247): the store
      // assigns both a `seq` in one transaction, so a reader never sees the request finished
      // and the totals lagging behind it. Only a request that reported usage writes one — a
      // request that failed or was interrupted closes its span with nothing to add, and the
      // running total it would carry is already in the log.
      const totals = sessionUsage(
        withRequestUsage(usageByModel(read), requestModel.id, result.usage),
      )
      // What this step produced that only its own provider can read back (epic #303, X13;
      // #334), written beside the reply — before the span end, so it sits inside the step's
      // assistant turn and the context strategy re-attaches it to that turn. A step that
      // produced none, and every step of a model whose client reads none back, writes nothing:
      // the log keeps the shape it always had.
      const opaque = opaqueTarget === null ? null : captureOpaque(opaqueTarget, result.opaque)
      const stored =
        opaque === null || (opaque.parts.length === 0 && opaque.dropped === 0)
          ? undefined
          : agentOpaqueContent(opaque.provider, opaque.model, opaque.parts, opaque.dropped)
      if (result.text.length > 0) {
        // The reply, its opaque content, the span end and the totals are **one** append: a
        // handoff (or a crash) can then never leave a stored reply whose span is still open,
        // or a closed span whose usage totals never landed. The order inside the append is
        // the lifecycle's — message, opaque content, span end, usage — exactly as before.
        await append([
          agentMessage(eventId, result.text, range),
          ...(stored === undefined ? [] : [stored]),
          spanEnd(start.id, result.usage, searchSpan(result)),
          totals,
        ])
      } else {
        await append([
          ...(stored === undefined ? [] : [stored]),
          spanEnd(start.id, result.usage, { supersedes: range, ...searchSpan(result) }),
          totals,
        ])
      }
      // The searches the provider ran inside this request, as the readable pair a client draws
      // and a transcript keeps (epic #303, X14; #335). It is written **after** the reply and its
      // opaque content, so the step's assistant turn is complete before the lines that describe
      // it, and it is a reading and nothing more: the request is rebuilt from the opaque content
      // above, never from this (`./context`).
      for (const search of result.searchCalls) {
        await storeProviderSearch(search, result.sources, append)
      }
      if (result.paused) {
        // The provider paused the turn itself (#335): Anthropic's server-side search loop hit
        // its own limit, and the answer is to send the assistant turn back unchanged as the next
        // request — which is what the loop does, because the step is in the log and the context
        // strategy rebuilds it from the opaque content it stored. The step counts against the
        // turn's budget like any other, so a provider that kept pausing ends the turn rather
        // than looping.
        if (handedOff()) {
          return { outcome: 'handed_off' }
        }
        if (isAborted()) {
          return await endInterrupted()
        }
        continue
      }
    } catch (error) {
      // The events a model's report shapes are the ones that can turn out not to be protocol
      // events — a usage the protocol refuses is the case issue #39 shipped. Ending the turn is
      // the loud failure: nothing malformed is stored, and the log says why.
      if (!(error instanceof EventValidationError)) {
        throw error
      }
      return await endInvalidEvent(error, start.id, range)
    }
    // A request that answered gets a fresh retry budget; the next one is a new question, and it
    // counts against the turn's budget of requests (X2).
    retriesUsed = 0
    steps += 1

    // The step's calls: resolved, stored, run concurrently and answered in call order
    // (epic #303, X2/X4). They are what owes the next request, so the loop continues without
    // waiting for anything else — and a turn that was interrupted while they ran ends the way
    // an interrupt always does, with every call answered.
    if (toolRegistry !== undefined && result.toolCalls.length > 0) {
      const secrets =
        options.resolveToolSecrets === undefined
          ? undefined
          : await options.resolveToolSecrets(current.owner_id)
      await runToolStep({
        calls: result.toolCalls,
        registry: toolRegistry,
        ...(toolSettings === undefined ? {} : { settings: toolSettings }),
        // Which of this request's offered tools are remote, and which server and tool each
        // stands for: what the call event is written from (#312). A name this map does not
        // carry is a built-in, whose call is the `agent.tool_use` of #304.
        ...(mcp.refs.size === 0 ? {} : { mcp: mcp.refs }),
        // The tools this chat has already agreed to (#309): a `remember: session` approval is
        // read back off the log it was written to, so a later call to that tool runs without
        // asking again. It comes from the same read the request was built from.
        approved: sessionApprovedTools(read),
        // Whether a person is on the other end (epic #340, S1): a call evaluated as `ask` is
        // denied at once rather than pausing a turn nobody will answer.
        interactive: session.interactive,
        ...(secrets === undefined ? {} : { secrets }),
        ...(signal === undefined ? {} : { signal }),
        append,
      })
      if (handedOff()) {
        // The calls are in the log with no answers. They are left that way on purpose: a tool
        // may already have had an effect nobody recorded, so the next owner answers them
        // `execution lost` (X3) rather than this turn inventing an answer or a re-run.
        return { outcome: 'handed_off' }
      }
      if (isAborted()) {
        return await endInterrupted()
      }
      continue
    }

    // A handoff that landed after the last step but before the turn's idle event leaves the
    // turn open rather than closing it here: the next owner reads the same log, finds the
    // reply already stored, and writes the idle itself. Nothing is decided twice.
    if (handedOff()) {
      return { outcome: 'handed_off' }
    }
    const arrived = await store.getPendingUserEvents(sessionId)
    if (arrived.length > 0) {
      continue
    }
    await append([statusIdle()])
    return { outcome: 'idle' }
  }
}

/**
 * The result one open wait is answered with, whatever resolved it (epic #340, S5; #343).
 *
 * Four endings, and three of them are a sentence the model reads:
 *
 * - **the notifications that answer it** — written as the call's result, and **claimed** by it
 *   (`consumes`): the result *is* what they said, so the next request must not also be handed
 *   them as steering;
 * - **the reader moved on** — `The user sent a message instead.`, an `is_error` result, the same
 *   sentence and the same shape an unanswered question gets (#309);
 * - **the deadline passed** — the timeout notice, naming the tasks the log still says are
 *   running, as an ordinary result rather than a failure: the model asked to wait, and this is
 *   the answer.
 */
function taskWaitResult(
  call: ToolCallEvent,
  outcome: Exclude<TaskWaitOutcome, { readonly kind: 'waiting' }>,
  starts: ReadonlyMap<TaskId, SessionTaskStartedEvent>,
  statuses: ReadonlyMap<TaskId, TaskStatus>,
): AppendableEvent {
  if (outcome.kind === 'message') {
    return toolResultForCall(call, [{ type: 'text', text: RESOLVED_BY_MESSAGE }], true)
  }
  if (outcome.kind === 'timed_out') {
    const request = taskWaitOf({ name: toolCallName(call), input: toolCallInput(call) })
    return toolResultForCall(
      call,
      [{ type: 'text', text: taskWaitTimedOut(stillRunning(request?.taskIds ?? [], statuses)) }],
      false,
    )
  }
  const ids = outcome.notifications.map((notification) => notification.id)
  return toolResultForCall(
    call,
    [{ type: 'text', text: notificationResultText(outcome.notifications, starts) }],
    false,
    ids,
  )
}

/** What a completed request's span end says about the searches it ran (epic #303, X14; #335).
 *
 * Absent when the request searched not at all, which is the shape every span had before the
 * field existed — a count of nothing is the absence of the field, not a zero.
 */
function searchSpan(result: ModelRequestResult): { readonly searches?: number } {
  return result.searches === 0 ? {} : { searches: result.searches }
}

/**
 * Store one provider-executed search as the readable pair a client draws (epic #303, X14;
 * #335): the `web_search` call, with `source: 'provider'`, and the result that answers it.
 *
 * Written by the turn rather than run, so the two appends are adjacent and the call is answered
 * in the same turn that made it — and the call is `provider`, which is what tells every reader
 * that nothing of ours ran it: the crash rule leaves it alone (`./tools`), and the request
 * carries it through `agent.opaque_content` instead of through this pair (`./context`).
 *
 * The call's `input` is what the step said the search asked for (`./model`), and the result's
 * content is the reading of what it found — the same text a provider switch replays — beside the
 * normalized `sources` a client renders as the reply's citations. A search the provider cited
 * nothing for streams no `source` parts, so the reading is `''`; the readable block says the
 * search ran instead, because the protocol refuses an empty text block and an empty one here
 * ended the turn (issue #339). The reading a switch replays stays empty — there is nothing to
 * tell another provider — and it is this block, not the log's only record, that gets the
 * sentence.
 */
async function storeProviderSearch(
  search: ModelSearchCall,
  sources: readonly Source[],
  append: (events: AppendableEvent[]) => Promise<StoredEvent[]>,
): Promise<void> {
  const [call] = await append([agentToolUse(search.name, search.input, 'allow', 'provider')])
  if (call === undefined) {
    return
  }
  const text = search.text.length > 0 ? search.text : UNCITED_SEARCH_RESULT
  await append([agentToolResult(call.id, [{ type: 'text', text }], search.isError, sources)])
}

/**
 * What the readable result of a provider-executed search says when the provider cited no pages
 * this build could read (issue #339).
 *
 * A sentence rather than `''`: an `agent.tool_result`'s content is text blocks, and the protocol
 * refuses a block with no text in it — the append would fail validation and end the turn.
 */
const UNCITED_SEARCH_RESULT = 'The provider ran a web search and cited no pages.'

/**
 * The system prompt a request is built with: the session's own, with the mode's addition
 * appended after it (#245, M6).
 *
 * Appended, never substituted: a mode tunes the session's prompt rather than replacing it. The
 * two are joined by a blank line, and either side may be absent — an addition with no session
 * prompt is the whole prompt, and a mode with no addition (or no mode) leaves the session's
 * prompt exactly as it was, so a chat without a mode builds the same request it always did.
 */
function withModePrompt(system: string | null, addition: string | null): string | null {
  const base = system !== null && system.length > 0 ? system : null
  const extra = addition !== null && addition.length > 0 ? addition : null
  if (extra === null) {
    return base
  }
  return base === null ? extra : `${base}\n\n${extra}`
}

/**
 * The reasoning effort in force for a session's next request (#252; #245, M6).
 *
 * One reading, used twice: the request the loop builds, and the `agent` tool's answer to "what
 * does the parent run" — a `general-purpose` child is the parent continued, so it has to run
 * what this returns rather than a second reading of the same log that could drift from it.
 *
 * An explicit effort the newest message carried wins — the reader asked for it on that message —
 * and otherwise the mode's own applies. `undefined` from the walk is "no message carried one",
 * which is what lets the mode's effort through; an explicit `null` is "the provider's default"
 * and wins.
 */
function effortInForce(
  events: readonly StoredEvent[],
  modeEffort: ReasoningEffort | null,
): ReasoningEffort | null {
  const logged = requestedReasoningEffort(events)
  return logged === undefined ? modeEffort : logged
}

/**
 * The `session.compaction` outcome a manual run's engine result becomes (epic #277, K8; #283).
 *
 * The engine answers `summarized | skipped | failed`; the log records those as
 * `summarized | nothing_to_summarize | failed`, because "skipped" is the engine's word for "there
 * was nowhere to cut" and the log owes the reader a sentence rather than an internal enum. A
 * `failed` run already closed its span with the reason (K11); the message here is the one line a
 * client shows, and the detail stays on the span for anyone who wants it.
 */
function manualCompactionOutcome(outcome: SummarizeResult): {
  readonly outcome: SessionCompactionOutcome
  readonly message?: string
} {
  if (outcome.outcome === 'summarized') {
    return { outcome: 'summarized' }
  }
  if (outcome.outcome === 'failed') {
    return { outcome: 'failed', message: 'The summary could not be written.' }
  }
  return { outcome: 'nothing_to_summarize', message: 'There was no older history to summarize.' }
}
