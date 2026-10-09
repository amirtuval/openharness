import {
  type ContextStrategy,
  type ModeResolver,
  type ModelFactory,
  type ReasoningSupportFor,
  type RetryPolicy,
  type TurnOutcome,
  runTurn,
} from '@openharness/brain'
import type { SessionId } from '@openharness/protocol'
import { SessionNotFoundError, type PartitionFence, type SessionStore } from '@openharness/session'

import type { ResolveSessionCredential } from './credentials'

/**
 * The piece of scheduling that is the same however a session is owned: run its turns, one at
 * a time, until there is nothing left to do.
 *
 * The brain is stateless — one `runTurn` answers whatever the log is waiting on — so keeping a
 * session moving is a loop: run a turn, then look at the log again. That loop, and the rule
 * that a session never has two turns in flight, is what {@link SessionRunner} owns. What it
 * does *not* own is why the session runs at all: a scheduler decides that, and so does the
 * ownership a partition lease gives it.
 *
 * ```ts
 * const runner = new SessionRunner({ store, model, resolveCredential })
 * await runner.run(sessionId)                       // LocalScheduler: every session is ours
 * await runner.run(sessionId, { fence })            // #11: only while we hold the partition
 * ```
 *
 * Everything a `runTurn` can be told is passed through: the model factory, the retry policy
 * and the context strategy come from the runner's options, and the fence comes from the call,
 * because the lease that fences a turn is the caller's to hold.
 */

/** What the runner is configured with; all of it reaches `runTurn` unchanged. */
export interface SessionRunnerOptions {
  /** The session log the turns read and write. */
  readonly store: SessionStore
  /** How a session's `model.id` becomes a model to stream from (issue #93). */
  readonly model: ModelFactory
  /**
   * Where each model request's provider credential comes from (epic #65, A5).
   *
   * Session-bound: the brain asks `(provider) => …` once per request, and the runner is what
   * knows which session the request belongs to — so it reads the session's owner's stored
   * key, which is what this resolver looks up. The server holds no provider key of its own
   * and the brain never reads one from the environment: a turn made without a credential
   * this resolver answered ends with `missing_provider_credential` instead. The mock model
   * ignores what it is handed, so the test paths resolve a placeholder.
   */
  readonly resolveCredential: ResolveSessionCredential
  /** How model failures are retried; `runTurn`'s own default when omitted. */
  readonly retry?: RetryPolicy
  /** How the log becomes model messages; `runTurn`'s own default when omitted. */
  readonly contextStrategy?: ContextStrategy
  /**
   * Which reasoning efforts a model takes, asked per request (#252's follow-up); `runTurn`'s own
   * default when omitted, which is "no model is known to take one".
   */
  readonly reasoningSupportFor?: ReasoningSupportFor
  /**
   * What a mode resolves to, asked per request (#245, M6); `runTurn`'s own default when omitted,
   * which is "a session on a mode runs its own model". The server builds it from the mode store,
   * the mode owner's preferences and their credentials — see `modes.ts`.
   */
  readonly resolveMode?: ModeResolver
}

/** What one call to {@link SessionRunner.run} adds to the runner's configuration. */
export interface RunSessionOptions {
  /**
   * The partition lease this pass writes under, passed to every `runTurn` it makes.
   *
   * A partition's owner fences its writes with it (#11); a `LocalScheduler`, which owns every
   * partition in-process, leaves it out and writes unfenced.
   */
  readonly fence?: PartitionFence
  /**
   * An external abort — a server shutting down, or a partition lease given up — merged with
   * the interrupt signal.
   *
   * It means "this process should not be running this session any more". A pass whose signal
   * is already aborted writes nothing and answers `noop`; one aborted while a turn is running
   * lets that turn end the way an interrupt does (the partial reply, the closed span, the
   * session idle) and then stops instead of looking for more work. Either way the work is not
   * lost: it is in the log, and whoever owns the session next finds it with
   * `findSessionsNeedingWork`.
   */
  readonly signal?: AbortSignal
}

/** The outcome of a pass that found nothing to do. */
const NOOP: TurnOutcome = { outcome: 'noop' }

/** What a pass in flight keeps: its abort controller, its promise, and what it has been told. */
interface TurnHandle {
  /** Aborting this ends the turn in flight at its next safe point. */
  controller: AbortController
  /** Resolves when the whole pass — every turn it ran — has finished. */
  pass: Promise<TurnOutcome> | null
  /** Set when someone asked for another look at the log before the pass ends. */
  woken: boolean
  /**
   * Set by {@link SessionRunner.stopSession}: the turn in flight ends, and the pass does not
   * start another one — the session is being deleted, so there is nothing left to run.
   */
  stopRequested: boolean
  /** The fence the next turn writes under; the newest one a caller passed wins. */
  fence: PartitionFence | undefined
  /** The external abort signal, if any. */
  signal: AbortSignal | undefined
}

/**
 * Runs sessions: at most one turn at a time each, re-running while the log still has work.
 *
 * A pass — one call to {@link run} — runs `runTurn` again and again until the log says there
 * is nothing left, or a turn comes back `noop`. What "nothing left" means is the store's
 * answer, not a guess: queued user events (`getPendingUserEvents`) or a turn that is still
 * open (`getTurnState`, which is what a crashed brain leaves behind). A `noop` ends the pass
 * whatever else is true, which is what keeps a session that cannot make progress from
 * spinning.
 *
 * While a pass is in flight, {@link run} does not start a second one: it marks the pass as
 * needing another look (`wake`) and answers with the outcome of the pass already running.
 * That is the whole concurrency story — the sessions that run in parallel are decided one
 * level up, by whoever calls `run`, and this class is what makes concurrent calls for the
 * *same* session safe.
 */
export class SessionRunner {
  readonly #store: SessionStore

  readonly #model: ModelFactory

  readonly #resolveCredential: ResolveSessionCredential

  readonly #retry: RetryPolicy | undefined

  readonly #contextStrategy: ContextStrategy | undefined

  readonly #reasoningSupportFor: ReasoningSupportFor | undefined

  readonly #resolveMode: ModeResolver | undefined

  readonly #turns = new Map<SessionId, TurnHandle>()

  #stopped = false

  constructor(options: SessionRunnerOptions) {
    this.#store = options.store
    this.#model = options.model
    this.#resolveCredential = options.resolveCredential
    this.#retry = options.retry
    this.#contextStrategy = options.contextStrategy
    this.#reasoningSupportFor = options.reasoningSupportFor
    this.#resolveMode = options.resolveMode
  }

  /** Whether the runner has been told to stop and no longer starts passes. */
  get stopped(): boolean {
    return this.#stopped
  }

  /** The sessions with a pass in flight, in no particular order. */
  runningSessions(): SessionId[] {
    return [...this.#turns.keys()]
  }

  /** Whether a pass is in flight for `sessionId`. */
  isRunning(sessionId: SessionId): boolean {
    return this.#turns.has(sessionId)
  }

  /**
   * Ask the pass in flight for `sessionId` to look at the log again before it ends.
   *
   * This is how a signal that arrives while a turn is running is not lost: the turn itself
   * may already have read the log, but the pass will read it once more before it stops.
   *
   * @returns whether a pass was in flight — `false` means the caller has to start one
   */
  wake(sessionId: SessionId): boolean {
    const handle = this.#turns.get(sessionId)
    if (handle === undefined) {
      return false
    }
    handle.woken = true
    return true
  }

  /**
   * Abort the turn in flight for `sessionId`.
   *
   * The turn ends the way an interrupt does — partial text stored, span closed, session
   * idle — because the brain is handed an aborted `AbortSignal`, not because the runner
   * writes anything itself.
   *
   * @returns whether a pass was in flight — `false` means there was nothing to abort
   */
  abort(sessionId: SessionId): boolean {
    const handle = this.#turns.get(sessionId)
    if (handle === undefined) {
      return false
    }
    handle.controller.abort()
    return true
  }

  /**
   * Stop the pass in flight for `sessionId` — abort its turn, do not start another — and wait
   * (bounded by `drainTimeoutMs`) for it to finish writing.
   *
   * This is the abort {@link SessionRunner.abort} cannot be for a session that is about to be
   * deleted (epic #116, U5): an `abort` ends the turn the way an interrupt does and the pass
   * then *looks for more work*, which would answer a queued message for a session that is
   * gone. Here the pass stops after the aborted turn, so once this resolves nothing more will
   * be written for the session — which is what lets the caller delete it (`store.deleteSession`)
   * knowing the log is quiet. A session with no pass in flight resolves at once.
   *
   * @returns whether a pass was in flight — `false` means there was nothing to stop
   */
  async stopSession(
    sessionId: SessionId,
    options: { readonly drainTimeoutMs?: number } = {},
  ): Promise<boolean> {
    const handle = this.#turns.get(sessionId)
    if (handle === undefined) {
      return false
    }
    handle.stopRequested = true
    handle.controller.abort()
    if (handle.pass !== null) {
      // The pass may reject (a fenced write); that is the caller-of-`run`'s news, not this
      // method's — here it only means there is nothing left to wait for.
      await withTimeout(
        handle.pass.then(
          () => undefined,
          () => undefined,
        ),
        options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      )
    }
    return true
  }

  /**
   * Run a pass for `sessionId`: turns until the log has nothing left for it.
   *
   * Called while a pass is already in flight, it does not start a second one — it wakes the
   * one running and answers with its outcome, so `run` can be called as often as a signal
   * arrives without ever putting two turns on one session.
   *
   * A rejected pass means `runTurn` threw: a fenced write, or an unexpected failure. Model
   * failures are not rejections — they are part of the turn's story and end in the log — and
   * neither is a session that is gone: `SessionNotFoundError` ends the pass quietly (the
   * session was hard-deleted, U5), so a deleted session can never become a crash loop.
   *
   * @param sessionId the session to run
   * @param options the fence and the external abort signal, if any
   */
  run(sessionId: SessionId, options: RunSessionOptions = {}): Promise<TurnOutcome> {
    if (this.#stopped) {
      // Shutting down: the caller's work is not lost, it is simply not this process's to do.
      return Promise.resolve(NOOP)
    }
    const existing = this.#turns.get(sessionId)
    if (existing !== undefined) {
      existing.woken = true
      if (options.fence !== undefined) {
        existing.fence = options.fence
      }
      if (options.signal !== undefined) {
        existing.signal = options.signal
      }
      return existing.pass ?? Promise.resolve(NOOP)
    }
    const handle: TurnHandle = {
      controller: new AbortController(),
      pass: null,
      woken: false,
      stopRequested: false,
      fence: options.fence,
      signal: options.signal,
    }
    this.#turns.set(sessionId, handle)
    // The pass reads its handle back from the map, so it is only started once the handle is
    // there: nothing can observe the pass without the lock that makes it the only one.
    const pass = this.#pass(sessionId)
    handle.pass = pass
    return pass
  }

  /**
   * Stop: no pass starts after this, every turn in flight is aborted, and the passes already
   * running are given `drainTimeoutMs` to write their last events.
   *
   * The abort is what makes a drain quick — a model request is cut short, and the brain
   * stores what the user needs to see (the partial reply, a closed span, `session.status_idle`)
   * before it stops. The timeout is the ceiling: a pass that does not finish in time is left
   * behind, because a shutdown that cannot finish is worse than a turn that does not.
   *
   * @param options.drainTimeoutMs how long to wait for the passes in flight; defaults to 5000
   */
  async stop(options: { drainTimeoutMs?: number } = {}): Promise<void> {
    this.#stopped = true
    const passes: Promise<TurnOutcome>[] = []
    for (const sessionId of this.runningSessions()) {
      const handle = this.#turns.get(sessionId)
      if (handle === undefined) {
        continue
      }
      handle.controller.abort()
      if (handle.pass !== null) {
        passes.push(handle.pass)
      }
    }
    if (passes.length === 0) {
      return
    }
    const drained = Promise.allSettled(passes).then(() => undefined)
    await withTimeout(drained, options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS)
  }

  /**
   * The pass itself: turns for one session, one after another.
   *
   * The loop, in order:
   *
   * 1. aborted controller — the interrupt was for the turn that just ended, so this turn gets
   *    a fresh one. Without that, a message queued behind an interrupt could never run: the
   *    brain would see an aborted signal and interrupt again, forever.
   * 2. `runTurn` — one turn.
   * 3. `noop` — nothing was waiting and nothing was written; stop, or the loop would spin.
   * 4. anything else — ask the log whether more work is waiting, and run again if it is, or
   *    if a signal came in while the turn was running.
   */
  async #pass(sessionId: SessionId): Promise<TurnOutcome> {
    const handle = this.#turns.get(sessionId)
    if (handle === undefined) {
      return NOOP
    }
    let outcome = NOOP
    try {
      for (;;) {
        if (this.#stopping(handle)) {
          break
        }
        if (handle.controller.signal.aborted) {
          handle.controller = new AbortController()
        }
        try {
          outcome = await runTurn(sessionId, {
            store: this.#store,
            model: this.#model,
            // The brain's resolver is provider-only; the session is bound here, where it is
            // known, so the credential lookup is the owner's own key for this session (A5).
            resolveCredential: (provider) => this.#resolveCredential(sessionId, provider),
            signal: abortSignalFor(handle),
            ...(handle.fence === undefined ? {} : { fence: handle.fence }),
            ...(this.#retry === undefined ? {} : { retry: this.#retry }),
            ...(this.#contextStrategy === undefined
              ? {}
              : { contextStrategy: this.#contextStrategy }),
            ...(this.#reasoningSupportFor === undefined
              ? {}
              : { reasoningSupportFor: this.#reasoningSupportFor }),
            ...(this.#resolveMode === undefined ? {} : { resolveMode: this.#resolveMode }),
          })
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            // The session was deleted while this pass was running (epic #116, U5) — or
            // between the signal that queued it and this turn. There is nothing to answer,
            // nothing to report and nothing to retry: a pass for a session nobody has is
            // over, and the next boot's recovery will not find it either.
            break
          }
          throw error
        }
        // A `noop` means this turn found nothing to do, which is a reason to stop — unless a
        // wake arrived while it was looking. A signal for an event appended in that window
        // (the brain reads the log before it decides) is exactly the case the flag exists for,
        // and dropping it would leave the work unclaimed until the process restarted.
        if (outcome.outcome === 'noop' && !handle.woken) {
          break
        }
        // Read the log first, then the flag: a `wake` that lands during the read is seen by
        // the check below, and one that lands after it cannot, because nothing can run
        // between that check and the map entry going away.
        const more = this.#stopping(handle) ? false : await this.#hasMoreWork(sessionId)
        if (!this.#stopping(handle) && (more || handle.woken)) {
          handle.woken = false
          continue
        }
        break
      }
    } finally {
      if (this.#turns.get(sessionId) === handle) {
        this.#turns.delete(sessionId)
      }
    }
    return outcome
  }

  /**
   * Whether this pass should stop rather than start another turn.
   *
   * Either the runner is shutting down, or the caller's own signal — a lease lost, a process
   * going away — has been aborted. The second matters for the same reason the first does: an
   * aborted signal ends a turn as an interrupt, and a pass that kept looking for work with an
   * aborted signal would interrupt its way round the loop forever.
   */
  #stopping(handle: TurnHandle): boolean {
    return this.#stopped || handle.stopRequested || handle.signal?.aborted === true
  }

  /**
   * Whether the log has more for this session: user events nobody has claimed, or a turn that
   * is still open.
   *
   * Both are the store's answers, and both are what `findSessionsNeedingWork` looks at — a
   * pass that ends here would leave exactly the work recovery would later pick up.
   */
  async #hasMoreWork(sessionId: SessionId): Promise<boolean> {
    try {
      const pending = await this.#store.getPendingUserEvents(sessionId)
      if (pending.length > 0) {
        return true
      }
      const turn = await this.#store.getTurnState(sessionId)
      return turn.state !== 'idle'
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        // Deleted while this pass was between two turns (U5): there is no more work, ever.
        return false
      }
      throw error
    }
  }
}

/** How long {@link SessionRunner.stop} waits for the passes in flight by default. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5000

/** The interrupt signal and the external one, as the single signal `runTurn` takes. */
function abortSignalFor(handle: TurnHandle): AbortSignal {
  if (handle.signal === undefined) {
    return handle.controller.signal
  }
  return AbortSignal.any([handle.controller.signal, handle.signal])
}

/**
 * Resolve when `work` does, or after `timeoutMs` — whichever comes first.
 *
 * The ceiling every drain in this package is written with: a pass that does not finish in
 * time is left behind rather than allowed to hold up a shutdown (or a lease this instance is
 * giving up).
 */
export async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) {
    return
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
