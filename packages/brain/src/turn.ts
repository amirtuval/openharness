import { EVENT_TYPES, newEventId } from '@openharness/protocol'
import type {
  EventId,
  ModeId,
  ModeToolOverride,
  ModelConfig,
  ReasoningEffort,
  SessionCompactionOutcome,
  SessionId,
  StoredEvent,
  Supersedes,
  UserId,
} from '@openharness/protocol'
import type { AppendableEvent, PartitionFence, SessionStore } from '@openharness/session'
import { SessionNotFoundError } from '@openharness/session'
import type { ToolRegistry } from '@openharness/hands'

import type { LanguageModel } from 'ai'

import type { ContextStrategy } from './context'
import { DEFAULT_CONTEXT_STRATEGY, estimateContextSize } from './context'
import {
  agentMessage,
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
} from './events'
import { classifyModelError } from './errors'
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
  sessionApprovedTools,
} from './pausing'
import { pendingManualCompaction } from './manual'
import type { ModelFactory, ResolveCredential } from './model'
import {
  credentialSecrets,
  isUnsupportedProviderError,
  isUsableCredential,
  missingCredentialMessage,
  providerOf,
  streamModelRequest,
  ZERO_MODEL_USAGE,
} from './model'
import { planReasoning, type ReasoningSupportFor, requestedReasoningEffort } from './reasoning'
import { redactSecrets } from './redact'
import type { ToolSecretResolver, ToolSettingsResolver, ToolSupportFor } from './tools'
import {
  DEFAULT_MAX_TOOL_STEPS,
  lostExecutions,
  offeredTools,
  repairLostExecutions,
  runToolStep,
  toolSet,
  toolsFor,
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
 *                                    reasoning_effort, mode, truncated }
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
  const { store, model, resolveCredential, signal, fence } = options
  const strategy = options.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY
  const retry = resolveRetryPolicy(options.retry)
  const maxSteps = options.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS
  const writeOptions = fence === undefined ? undefined : { fence }

  // Read through a function: `signal.aborted` is a property TypeScript would otherwise treat
  // as frozen for the rest of the loop, and it is not — a signal aborts when the user says so.
  const isAborted = (): boolean => signal?.aborted === true

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
  const queued = await store.getPendingUserEvents(sessionId)
  const turnState = await store.getTurnState(sessionId)
  /**
   * Whether the log holds a call the user has answered whose turn has not run yet (#309).
   *
   * A `user.tool_confirmation` is not a queued user event — the server writes it, processed —
   * so a session a user has just answered looks idle to everything that reads the store's
   * pending list. The newest tool event is the cheap test: between a confirmation and the turn
   * it starts, nothing else writes one, so reading the newest of the three types answers it in
   * one page instead of walking the log on every idle sweep.
   */
  const answeredWaiting = async (): Promise<boolean> => {
    const page = await store.listEventsUnscoped(sessionId, {
      types: [
        EVENT_TYPES.agentToolUse,
        EVENT_TYPES.agentToolResult,
        EVENT_TYPES.userToolConfirmation,
      ],
      order: 'desc',
      limit: 1,
    })
    return page.data[0]?.type === EVENT_TYPES.userToolConfirmation
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
  if (turnState.state === 'idle' && queued.length === 0) {
    // An idle session with nothing queued is a no-op — unless something waiting in the log owes
    // this turn. Two things do, and neither is a user event, so neither shows up in `queued`:
    // a manual compaction (K8; #283), and a call the user has just answered (epic #303, #309).
    // A host that wired no compaction never looks for the first.
    const compactionPending =
      options.compaction !== undefined &&
      pendingManualCompaction(await readLog(store, sessionId)) !== null
    if (!compactionPending && !(await answeredWaiting())) {
      return { outcome: 'noop' }
    }
  }

  // ---- Start: open a turn, or take one over.
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
   */
  const releaseWaiting = async (): Promise<void> => {
    await resolveWaiting({ calls: awaitingUser(await readLog(store, sessionId)), append })
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
    // An interrupt that arrived before this request started — a queued user.interrupt covers
    // the one the user sent while no brain was running to abort.
    if (isAborted()) {
      return await endInterrupted()
    }
    const pending = await store.getPendingUserEvents(sessionId)
    if (pending.some(isUserInterrupt)) {
      return await endInterrupted()
    }
    // Steering: the queued messages are this request's to answer, and the append of the span
    // start below claims them — in the same transaction, or not at all. A message that arrives
    // after that append is not in its `consumes`, so it stays queued for the next request (and
    // `contextView` leaves it out of what this one answers).
    const claims = pending.filter(isUserMessage).map((event) => event.id)
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
    const requestSystem = withModePrompt(current.system, mode?.systemPromptAddition ?? null)
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
        registry: options.tools,
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
      if (claims.length === 0) {
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
        const sized = estimateContextSize(read, {
          model: requestModel.id,
          system: requestSystem,
        })
        const manualResult = await summarizeContext({
          chatModel: requestModel.id,
          reason: 'manual',
          events: read,
          system: requestSystem,
          estimatedTokens: sized,
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
    if (compaction !== null) {
      // The trigger (K2): the real size of the request this boundary is about to make, against
      // the threshold share of the **chat** model's budget. Over it, older history is summarized
      // before the request — which is what keeps the provider from refusing it — and the log is
      // re-read so the prompt below is built from the summary, not the history it replaced.
      const estimated = estimateContextSize(read, {
        model: requestModel.id,
        system: requestSystem,
      })
      const outcome = await summarizeContext({
        chatModel: requestModel.id,
        reason: 'threshold',
        events: read,
        system: requestSystem,
        estimatedTokens: estimated,
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
    const loggedEffort = requestedReasoningEffort(read)
    const requestedEffort =
      loggedEffort === undefined ? (mode?.reasoningEffort ?? null) : loggedEffort
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
    })
    // The tools this request offers (epic #303, X2/X4; #307), if any: a deployment with no
    // registry has nothing to offer, a model the registry marks as tool-less gets none, and a
    // user who turned every tool off gets none either — in each case the request is built
    // exactly as it was before tools existed. The settings are resolved here, once per request
    // and before the offer is built, because a disabled tool must not be in the offer at all;
    // the mode the request follows rides along, since a mode may force tools on or off. A host
    // that wired no resolver, or no registry, is never asked.
    const toolSettings =
      options.toolSettings === undefined || options.tools === undefined
        ? undefined
        : await options.toolSettings(current.owner_id, mode?.toolOverride ?? null)
    const toolRegistry = toolsFor(
      options.tools,
      options.toolSupportFor,
      toolSettings,
      requestModel.id,
      credential.type,
    )
    const [start] = await append([
      spanStart(claims, requestModel.id, {
        ...(reasoning.record === undefined ? {} : { reasoningEffort: reasoning.record }),
        ...(mode === null ? {} : { mode }),
        ...(context.truncated === undefined ? {} : { truncated: context.truncated }),
        ...(toolRegistry === undefined ? {} : { tools: offeredTools(toolRegistry) }),
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
      // calls back, because the loop that stores the call and runs it is this one.
      ...(toolRegistry === undefined ? {} : { tools: toolSet(toolRegistry) }),
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
      // Partial output is never stored, so the span end supersedes the chunks this attempt
      // streamed. The retry below mints a new message id and its own `event_start`.
      await append([
        spanEnd(start.id, ZERO_MODEL_USAGE, {
          error: { type: 'model_error', message },
          supersedes: range,
        }),
      ])
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
        const estimate = estimateContextSize(fresh, {
          model: requestModel.id,
          system: requestSystem,
        })
        const outcome = await summarizeContext({
          chatModel: requestModel.id,
          reason: 'overflow',
          events: fresh,
          system: requestSystem,
          estimatedTokens: estimate,
          config: compaction,
          model,
          resolveCredential,
          append,
          ...(signal === undefined ? {} : { signal }),
        })
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
      if (result.text.length > 0) {
        await append([agentMessage(eventId, result.text, range)])
        await append([spanEnd(start.id, result.usage), totals])
      } else {
        await append([spanEnd(start.id, result.usage, { supersedes: range }), totals])
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
        // The tools this chat has already agreed to (#309): a `remember: session` approval is
        // read back off the log it was written to, so a later call to that tool runs without
        // asking again. It comes from the same read the request was built from.
        approved: sessionApprovedTools(read),
        ...(secrets === undefined ? {} : { secrets }),
        ...(signal === undefined ? {} : { signal }),
        append,
      })
      if (isAborted()) {
        return await endInterrupted()
      }
      continue
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
