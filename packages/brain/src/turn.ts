import { EVENT_TYPES, newEventId } from '@openharness/protocol'
import type {
  EventId,
  ModelConfig,
  SessionId,
  StoredEvent,
  Supersedes,
} from '@openharness/protocol'
import type { LanguageModel } from 'ai'
import type { AppendableEvent, PartitionFence, SessionStore } from '@openharness/session'
import { SessionNotFoundError } from '@openharness/session'

import type { ContextStrategy } from './context'
import { DEFAULT_CONTEXT_STRATEGY } from './context'
import {
  agentMessage,
  eventDelta,
  eventStart,
  sessionError,
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
} from './log'
import type { ModelFactory } from './model'
import { streamModelRequest, ZERO_MODEL_USAGE } from './model'
import type { RetryPolicy } from './retry'
import { backoffDelay, resolveRetryPolicy } from './retry'

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
 * no turn to run, nothing queued ................................ return noop
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
 *   2. claim the queued user.message events; the claim is the append of the span start below
 *   3. no unanswered message left ........................... session.status_idle, return idle
 *   4. ............. span.model_request_start { consumes, model }
 *   5. stream ....... stored event_start (one sevt_ id), then one stored event_delta per chunk
 *   6. text streamed ......... agent.message { supersedes: the chunk range }
 *      no text ................................... (no message; the span end supersedes)
 *   7. .............................. span.model_request_end { model_usage }
 *   8. another user.message arrived .......................... loop from 1
 *   9. otherwise ............................................. session.status_idle, return idle
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
  /** The turn was cut short by an interrupt, by `signal` or by a queued `user.interrupt`. */
  | 'interrupted'
  /**
   * The turn died on a model failure that was not retryable, on retries that ran out, or on an
   * event the protocol would not accept — all three end with `session.error`.
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
  /** The model to stream from, resolved by the session's `agent.model.id`. */
  readonly model: ModelFactory
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
  /** How model failures are retried; see {@link RetryPolicy}. */
  readonly retry?: RetryPolicy
}

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
 * the user events this request was about to answer, and for a `SessionNotFoundError`.
 *
 * @param sessionId the session to run; a `sesn_` id
 * @param options the store, the model factory, and the turn's knobs
 */
export async function runTurn(sessionId: SessionId, options: RunTurnOptions): Promise<TurnOutcome> {
  const { store, model, signal, fence } = options
  const strategy = options.contextStrategy ?? DEFAULT_CONTEXT_STRATEGY
  const retry = resolveRetryPolicy(options.retry)
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

  const session = await store.getSession(sessionId)
  if (session === null) {
    throw new SessionNotFoundError(sessionId)
  }
  const agentModel: ModelConfig = session.agent.model
  const queued = await store.getPendingUserEvents(sessionId)
  const turnState = await store.getTurnState(sessionId)
  if (turnState.state === 'idle' && queued.length === 0) {
    return { outcome: 'noop' }
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

  /** End the turn the way an interrupt does, whatever it interrupted. */
  const endInterrupted = async (partial?: PartialReply): Promise<TurnOutcome> => {
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
    await append([statusIdle(interrupts)])
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
  let languageModel: LanguageModel | undefined
  const requestModel = (): LanguageModel => (languageModel ??= model(agentModel.id))
  let retriesUsed = 0
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
    if (claims.length === 0) {
      const answered = contextView(await readLog(store, sessionId))
      if (!needsModelRequest(answered)) {
        // Recovery, with the reply already in the log: the request that produced it was answered
        // before the brain died, and asking again would store a second reply.
        await append([statusIdle()])
        return { outcome: 'idle' }
      }
    }
    const [start] = await append([spanStart(claims, agentModel.id)])
    if (start === undefined) {
      throw new Error('the store did not return the span it was asked to append')
    }
    // Read the log again: the claim just landed, and what this request answers is the log as it
    // stands after it — the messages it consumes, in order, and nothing still queued.
    const answered = contextView(await readLog(store, sessionId))
    const messages = strategy(answered, { model: agentModel, system: session.agent.system })

    // The reply's chunks are stored as they arrive, under one pre-minted id: the stored
    // `event_start` announces the id the `agent.message` will be stored under, and every
    // `event_delta` carries it, so a client matches what it accumulated to what was stored.
    const eventId = newEventId()
    const [chunkOpen] = await append([eventStart(eventId)])
    if (chunkOpen === undefined) {
      throw new Error('the store did not return the event_start it was asked to append')
    }
    let lastChunkSeq = chunkOpen.seq
    const result = await streamModelRequest({
      model: requestModel(),
      messages,
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
      // Partial output is never stored, so the span end supersedes the chunks this attempt
      // streamed. The retry below mints a new message id and its own `event_start`.
      await append([
        spanEnd(start.id, ZERO_MODEL_USAGE, {
          error: { type: 'model_error', message: classification.message },
          supersedes: range,
        }),
      ])
      if (classification.retryable && retriesUsed < retry.maxRetries) {
        retriesUsed += 1
        await append([
          sessionError({
            type: classification.type,
            message: classification.message,
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
          message: classification.message,
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
      if (result.text.length > 0) {
        await append([agentMessage(eventId, result.text, range)])
        await append([spanEnd(start.id, result.usage)])
      } else {
        await append([spanEnd(start.id, result.usage, { supersedes: range })])
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
    // A request that answered gets a fresh retry budget; the next one is a new question.
    retriesUsed = 0

    const arrived = await store.getPendingUserEvents(sessionId)
    if (arrived.length > 0) {
      continue
    }
    await append([statusIdle()])
    return { outcome: 'idle' }
  }
}
