import {
  type ContextStrategy,
  type ModelFactory,
  type RetryPolicy,
  type TurnOutcome,
  runTurn,
} from '@openharness/brain'
import type { SessionId } from '@openharness/protocol'
import type { PartitionFence, SessionStore } from '@openharness/session'

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
 * const runner = new SessionRunner({ store, model })
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
  /** How a session's `agent.model.id` becomes a model to stream from. */
  readonly model: ModelFactory
  /** How model failures are retried; `runTurn`'s own default when omitted. */
  readonly retry?: RetryPolicy
  /** How the log becomes model messages; `runTurn`'s own default when omitted. */
  readonly contextStrategy?: ContextStrategy
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

  readonly #retry: RetryPolicy | undefined

  readonly #contextStrategy: ContextStrategy | undefined

  readonly #turns = new Map<SessionId, TurnHandle>()

  #stopped = false

  constructor(options: SessionRunnerOptions) {
    this.#store = options.store
    this.#model = options.model
    this.#retry = options.retry
    this.#contextStrategy = options.contextStrategy
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
   * Run a pass for `sessionId`: turns until the log has nothing left for it.
   *
   * Called while a pass is already in flight, it does not start a second one — it wakes the
   * one running and answers with its outcome, so `run` can be called as often as a signal
   * arrives without ever putting two turns on one session.
   *
   * A rejected pass means `runTurn` threw: a fenced write, or a session that is gone. Model
   * failures are not rejections — they are part of the turn's story and end in the log (see
   * `packages/brain`).
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
        outcome = await runTurn(sessionId, {
          store: this.#store,
          model: this.#model,
          signal: abortSignalFor(handle),
          ...(handle.fence === undefined ? {} : { fence: handle.fence }),
          ...(this.#retry === undefined ? {} : { retry: this.#retry }),
          ...(this.#contextStrategy === undefined
            ? {}
            : { contextStrategy: this.#contextStrategy }),
        })
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
    return this.#stopped || handle.signal?.aborted === true
  }

  /**
   * Whether the log has more for this session: user events nobody has claimed, or a turn that
   * is still open.
   *
   * Both are the store's answers, and both are what `findSessionsNeedingWork` looks at — a
   * pass that ends here would leave exactly the work recovery would later pick up.
   */
  async #hasMoreWork(sessionId: SessionId): Promise<boolean> {
    const pending = await this.#store.getPendingUserEvents(sessionId)
    if (pending.length > 0) {
      return true
    }
    const turn = await this.#store.getTurnState(sessionId)
    return turn.state !== 'idle'
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

/** Resolve when `work` does, or after `timeoutMs` — whichever comes first. */
async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
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
