import type { SessionId } from '@openharness/protocol'
import type { PartitionFence } from '@openharness/session'

import { DEFAULT_DRAIN_TIMEOUT_MS, withTimeout } from './runner'
import type { SessionRunner } from './runner'

/**
 * The half of scheduling that does not depend on *why* a session runs: at most
 * `maxConcurrentSessions` sessions run at once, a session that is already running is woken
 * rather than started twice, and the passes already in flight can be waited for.
 *
 * Why a session is asked to run is the scheduler's business — {@link LocalScheduler} owns
 * every partition, and `PostgresPartitionScheduler` owns the ones whose lease it holds — but
 * the queue that decision feeds is the same in both. So is the way a pass learns what it
 * writes under: {@link PassQueueOptions.contextFor} answers with the fence and the stop
 * signal of the moment, which is what makes a pass belonging to a partition this instance no
 * longer owns write nothing at all.
 *
 * Nothing here decides *when* a pass should run for a session that is not running: a caller
 * {@link PassQueue.request}s one, and the queue starts it as soon as there is a slot.
 */

/**
 * What a pass runs under: the lease it writes with, and the signal that tells it to stop.
 *
 * Both are optional. A scheduler that owns everything in-process (a {@link LocalScheduler})
 * passes neither; a partition's owner passes its lease's {@link PartitionFence} and a signal
 * that is aborted when that lease is gone.
 */
export interface PassContext {
  /** The partition lease this pass writes under; `runTurn` refuses a write without it. */
  readonly fence?: PartitionFence
  /** Aborting this stops the pass: the lease was given up, or the process is shutting down. */
  readonly signal?: AbortSignal
}

/** What {@link PassQueue} is built from. */
export interface PassQueueOptions {
  /** The runner that owns the per-session turn loop. */
  readonly runner: SessionRunner
  /** How many sessions may have a pass in flight at once; defaults to 4. */
  readonly maxConcurrentSessions?: number
  /** How long {@link PassQueue.stop} waits for the passes in flight; defaults to 5000 ms. */
  readonly drainTimeoutMs?: number
  /** Called when a pass rejects — a fenced write, an unexpected failure. Never throws. */
  readonly onError?: (error: unknown, sessionId: SessionId) => void
  /**
   * The fence and stop signal a pass for `sessionId` runs under, read every time the queue
   * starts one.
   *
   * Reading it at start time rather than at `request` time is what makes ownership changes
   * safe: a session queued while its partition was ours, but started after the lease went
   * away, is asked to run under a signal that is already aborted — and a pass whose signal is
   * aborted writes nothing and answers `noop`.
   */
  readonly contextFor?: (sessionId: SessionId) => PassContext
}

/** How many sessions run at once when the caller does not say. */
export const DEFAULT_MAX_CONCURRENT_PASSES = 4

/**
 * The queue of sessions waiting for a slot, and the passes in flight.
 *
 * `H` sessions run at once (`maxConcurrentSessions`) and the rest wait their turn, oldest
 * first. A session that is already running is not queued but *woken*, so the pass in flight
 * looks at the log again before it finishes — that is what keeps a signal that arrives during
 * a turn from being lost. `request` never blocks and never throws: it is called from a signal
 * handler, where being slow is a latency problem rather than a failure, because the work is in
 * the log either way.
 */
export class PassQueue {
  readonly #runner: SessionRunner

  readonly #maxConcurrentSessions: number

  readonly #drainTimeoutMs: number

  readonly #onError: ((error: unknown, sessionId: SessionId) => void) | undefined

  readonly #contextFor: ((sessionId: SessionId) => PassContext) | undefined

  /** Sessions waiting for a slot, oldest request first. */
  readonly #waiting: SessionId[] = []

  /** The same set as {@link waiting}, for O(1) "is it already queued?". */
  readonly #queued = new Set<SessionId>()

  /** The passes in flight, by session; the size is what the concurrency limit counts. */
  readonly #active = new Map<SessionId, Promise<void>>()

  #stopped = false

  constructor(options: PassQueueOptions) {
    this.#runner = options.runner
    this.#maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_PASSES
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    this.#onError = options.onError
    this.#contextFor = options.contextFor
  }

  /** The runner that owns the per-session turn loop. */
  get runner(): SessionRunner {
    return this.#runner
  }

  /** Whether the queue has been stopped and accepts no more work. */
  get stopped(): boolean {
    return this.#stopped
  }

  /** The sessions with a pass in flight; what the concurrency limit counts. */
  activeSessions(): SessionId[] {
    return [...this.#active.keys()]
  }

  /**
   * Ask for a pass on `sessionId`, respecting the limit.
   *
   * A session that is already running is woken instead of queued: two passes for one session
   * is exactly what {@link SessionRunner} exists to prevent.
   */
  request(sessionId: SessionId): void {
    if (this.#stopped) {
      return
    }
    if (this.#runner.isRunning(sessionId)) {
      this.#runner.wake(sessionId)
      return
    }
    if (this.#queued.has(sessionId)) {
      return
    }
    this.#queued.add(sessionId)
    this.#waiting.push(sessionId)
    this.#pump()
  }

  /** Forget the sessions still waiting for a slot; the passes in flight are left alone. */
  clearWaiting(): void {
    this.#waiting.length = 0
    this.#queued.clear()
  }

  /**
   * Wait for the passes in flight for `sessionIds` to end — without aborting them.
   *
   * This is how a lease that is being given up is drained: its turns are allowed to finish
   * writing first, and only then is the lease released. The caller passes its own timeout,
   * because what is a reasonable wait depends on why it is giving the partition up.
   *
   * @returns when the passes ended, or when `timeoutMs` passed — whichever came first
   */
  async drain(sessionIds: readonly SessionId[], timeoutMs: number): Promise<void> {
    const passes = sessionIds.flatMap((sessionId) => {
      const pass = this.#active.get(sessionId)
      return pass === undefined ? [] : [pass]
    })
    if (passes.length === 0) {
      return
    }
    await withTimeout(
      Promise.allSettled(passes).then(() => undefined),
      timeoutMs,
    )
  }

  /**
   * Stop: accept no more work, abort the passes in flight, and give them `drainTimeoutMs` to
   * write their last events.
   */
  async stop(options: { readonly drainTimeoutMs?: number } = {}): Promise<void> {
    this.#stopped = true
    this.clearWaiting()
    await this.#runner.stop({
      drainTimeoutMs: options.drainTimeoutMs ?? this.#drainTimeoutMs,
    })
  }

  /** Start passes until the limit is reached or the queue is empty. */
  #pump(): void {
    while (!this.#stopped && this.#active.size < this.#maxConcurrentSessions) {
      const sessionId = this.#waiting.shift()
      if (sessionId === undefined) {
        return
      }
      this.#queued.delete(sessionId)
      if (this.#runner.isRunning(sessionId)) {
        this.#runner.wake(sessionId)
        continue
      }
      const pass = this.#runner.run(sessionId, this.#contextFor?.(sessionId) ?? {}).then(
        () => undefined,
        (error: unknown) => {
          this.#report(error, sessionId)
        },
      )
      this.#active.set(sessionId, pass)
      void pass.then(() => {
        // Only if this pass is still the one on record. The runner lets go of a session a
        // microtask before this runs, so a request in that window can start the next pass for
        // it — and deleting *that* pass's slot would let the next `#pump` start one session
        // more than the limit allows.
        if (this.#active.get(sessionId) === pass) {
          this.#active.delete(sessionId)
        }
        this.#pump()
      })
    }
  }

  /** Report a failed pass without ever letting it escape: the reporter is the only listener. */
  #report(error: unknown, sessionId: SessionId): void {
    try {
      this.#onError?.(error, sessionId)
    } catch {
      // A reporter that throws is not worth losing the scheduler over.
    }
  }
}
