import { EVENT_TYPES, newEventId } from '@openharness/protocol'
import type { EventId, ModelConfig, SessionId, StoredEvent } from '@openharness/protocol'
import type { LanguageModel } from 'ai'
import type { AppendableEvent, PartitionFence, SessionStore } from '@openharness/session'
import { SessionNotFoundError } from '@openharness/session'

import type { ContextStrategy } from './context'
import { DEFAULT_CONTEXT_STRATEGY } from './context'
import {
  agentMessage,
  sessionError,
  spanEnd,
  spanStart,
  statusIdle,
  statusRescheduled,
  statusRunning,
} from './events'
import { classifyModelError } from './errors'
import {
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
 * ```
 * no turn to run, nothing queued ................................ return noop
 *
 * START (an inherited turn, `getTurnState` is not idle)
 *   open span .......................... span.model_request_end { error: brain_lost }
 *   last status was rescheduled ........ session.status_running
 *   last status was running ............ (nothing: that turn already opened)
 * START (a fresh turn)
 *   ................................... session.status_running
 *
 * LOOP (per model request)
 *   1. an aborted signal, or a queued user.interrupt ......... INTERRUPT
 *   2. claim the queued user.message events (markProcessed)
 *   3. no unanswered message left ............................ session.status_idle, return idle
 *   4. ................................ span.model_request_start
 *   5. stream; publish event_start, then event_delta per chunk, under one sevt_ id
 *   6. text streamed .................. agent.message (that sevt_ id)
 *   7. ................................ span.model_request_end { model_usage }
 *   8. another user.message arrived .......................... loop from 1
 *   9. otherwise ............................................. session.status_idle, return idle
 *
 * INTERRUPT (an aborted signal, or a queued user.interrupt)
 *   partial text streamed ............. agent.message (that sevt_ id)
 *   a span is open .................... span.model_request_end { error: interrupted }
 *   queued user.interrupt events ...... markProcessed
 *   ................................... session.status_idle, return interrupted
 *
 * MODEL FAILURE (a retryable error, attempts left)
 *    .................................. span.model_request_end { error: model_error }
 *    .................................. session.error { retry_status: retrying }
 *    .................................. session.status_rescheduled
 *    backoff sleep, honoring the signal
 *    .................................. session.status_running, loop from 1
 *
 * MODEL FAILURE (terminal, or out of attempts)
 *   .................................. span.model_request_end { error: model_error }
 *   .................................. session.error { retry_status: exhausted | terminal }
 *   .................................. session.status_idle, return error
 * ```
 *
 * `FencedError` short-circuits all of it: another owner has taken the partition over, so the
 * turn stops at the first refused write and rethrows — see {@link runTurn}.
 */

/** What a turn did, for the scheduler that ran it. */
export type TurnOutcomeKind =
  /** The turn ran and ended with `session.status_idle`. */
  | 'idle'
  /** There was nothing to do: no open turn and nothing queued. Nothing was written. */
  | 'noop'
  /** The turn was cut short by an interrupt, by `signal` or by a queued `user.interrupt`. */
  | 'interrupted'
  /** The turn died on a model failure that was not retryable, or ran out of retries. */
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
   * Passed on every `appendEvents` and `markProcessed`, so a brain whose lease has been taken
   * over cannot write into the log its successor now owns. A refused write stops the turn
   * immediately and rethrows the `FencedError`.
   */
  readonly fence?: PartitionFence
  /** How the log becomes messages; defaults to `DEFAULT_CONTEXT_STRATEGY`. */
  readonly contextStrategy?: ContextStrategy
  /** How model failures are retried; see {@link RetryPolicy}. */
  readonly retry?: RetryPolicy
}

/**
 * Run one turn of a session to the point where it is idle again — or to the point where an
 * interrupt or a failure ended it.
 *
 * Reads the whole log, answers whatever the user is waiting on, and appends events as it goes.
 * It never throws for a model failure: a failure is part of the turn's story, and the log
 * records it (`span.model_request_end`, `session.error`, `session.status_idle`). It does throw
 * for a `FencedError` from the store — the one failure the turn must not write anything about,
 * because the log is not the writer's any more — and for a `SessionNotFoundError`.
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
    return store.appendEvents(sessionId, events, writeOptions)
  }
  const markProcessed = async (eventIds: EventId[]): Promise<void> => {
    if (eventIds.length === 0) {
      return
    }
    await store.markProcessed(sessionId, eventIds, writeOptions)
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
      // The span the dead brain left open. Its request will not report usage: nobody saw it end.
      await append([
        spanEnd(turnState.openSpan.id, ZERO_MODEL_USAGE, {
          type: 'brain_lost',
          message: 'The brain that opened this model request is gone.',
        }),
      ])
    }
    if (lastStatusEventType(inherited) === EVENT_TYPES.sessionStatusRescheduled) {
      // The inherited turn was waiting to be resumed; resuming it is what a status_running says.
      await append([statusRunning()])
    }
  }

  /** End the turn the way an interrupt does, whatever it interrupted. */
  const endInterrupted = async (partial?: {
    readonly id: EventId
    readonly text: string
    readonly spanId: EventId
  }): Promise<TurnOutcome> => {
    if (partial !== undefined && partial.text.length > 0) {
      await append([agentMessage(partial.id, partial.text)])
    }
    if (partial !== undefined) {
      await append([
        spanEnd(partial.spanId, ZERO_MODEL_USAGE, {
          type: 'interrupted',
          message: 'Interrupted by the user.',
        }),
      ])
    }
    const interrupts = (await store.getPendingUserEvents(sessionId)).filter(isUserInterrupt)
    await markProcessed(interrupts.map((event) => event.id))
    await append([statusIdle()])
    return { outcome: 'interrupted' }
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
    const interrupts = pending.filter(isUserInterrupt)
    if (interrupts.length > 0) {
      return await endInterrupted()
    }
    // Steering: claim the queued messages first, and answer the log as it stands after that
    // claim. `contextView` is the other half of it — a message still queued afterwards was not
    // claimed here and belongs to the next request, not this one — and claiming is what makes
    // the events this call took part of what the view now includes.
    await markProcessed(pending.filter(isUserMessage).map((event) => event.id))
    const answered = contextView(await readLog(store, sessionId))
    if (!needsModelRequest(answered)) {
      // Recovery, with the reply already in the log: the request that produced it was answered
      // before the brain died, and asking again would store a second reply.
      await append([statusIdle()])
      return { outcome: 'idle' }
    }
    const messages = strategy(answered, { model: agentModel, system: session.agent.system })

    const [start] = await append([spanStart()])
    if (start === undefined) {
      throw new Error('the store did not return the span it was asked to append')
    }
    const eventId = newEventId()
    await store.publishEphemeral(sessionId, {
      type: EVENT_TYPES.eventStart,
      event: { type: EVENT_TYPES.agentMessage, id: eventId },
    })
    const result = await streamModelRequest({
      model: requestModel(),
      messages,
      signal,
      onTextDelta: async (text) => {
        await store.publishEphemeral(sessionId, {
          type: EVENT_TYPES.eventDelta,
          event_id: eventId,
          delta: { type: 'content_delta', index: 0, content: { type: 'text', text } },
        })
      },
    })

    if (result.aborted) {
      return await endInterrupted({ id: eventId, text: result.text, spanId: start.id })
    }

    if (result.error !== undefined) {
      const classification = classifyModelError(result.error)
      await append([
        spanEnd(start.id, ZERO_MODEL_USAGE, {
          type: 'model_error',
          message: classification.message,
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
    // reply the model did not make. The span and the status still record that it ran.
    if (result.text.length > 0) {
      await append([agentMessage(eventId, result.text)])
    }
    await append([spanEnd(start.id, result.usage)])
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
