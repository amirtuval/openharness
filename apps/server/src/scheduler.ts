import type { ContextStrategy, ModelFactory, RetryPolicy } from '@openharness/brain'
import { DEFAULT_PARTITION_COUNT, type SessionId } from '@openharness/protocol'
import type { PartitionSignalKind, SessionStore } from '@openharness/session'

import { DEFAULT_DRAIN_TIMEOUT_MS, SessionRunner } from './runner'

/**
 * Who runs a session's brain.
 *
 * A route never runs a turn: it appends what the user sent and calls
 * {@link SessionScheduler.signal} — `work` for a new message, `interrupt` for a
 * `user.interrupt` — and the scheduler decides what that means. That indirection is the
 * whole reason the interface exists: the API layer must not know whether the server is the
 * only instance running (today) or one of several owning partitions between them (#11).
 *
 * | implementation                  | how a signal reaches the owner                                                    |
 * | ------------------------------- | --------------------------------------------------------------------------------- |
 * | {@link LocalScheduler}          | in-process: this instance owns every partition                                     |
 * | `PostgresPartitionScheduler` #11 | `store.signalPartition` to the partition's channel, `store.onPartitionSignal` on the owner's side, while it holds the partition's lease |
 *
 * Both reuse {@link SessionRunner}, which owns the per-session "one turn at a time, look
 * again while there is work" loop; a scheduler only decides *which* sessions it owns and
 * *when* to run them. #11 adds one thing to the call: the lease's fence, passed as
 * `runner.run(sessionId, { fence })`.
 *
 * Signals are hints, never the record. A `signal` may arrive while the session is busy
 * (handled), or not arrive at all (the next pass, or the next boot's
 * `findSessionsNeedingWork`, finds the work anyway). Nothing is only reachable through a
 * signal.
 */
export interface SessionScheduler {
  /**
   * Start running: recover whatever needs work, then follow signals.
   *
   * Recovery is a read of the log — `findSessionsNeedingWork` — not a replay of signals, so a
   * server that was killed while a turn was running picks that turn up here.
   */
  start(): Promise<void>

  /**
   * Stop: accept no new work, abort the turns in flight, and let them finish writing (up to a
   * drain timeout) before returning.
   */
  stop(options?: StopSchedulerOptions): Promise<void>

  /** The user (or a test) says this session needs something; see {@link PartitionSignalKind}. */
  signal(sessionId: SessionId, kind: PartitionSignalKind): void
}

/** Options of {@link SessionScheduler.stop}. */
export interface StopSchedulerOptions {
  /** How long a turn in flight is given to write its last events; defaults to 5000 ms. */
  readonly drainTimeoutMs?: number
}

/** What {@link LocalScheduler} is built from. */
export interface LocalSchedulerOptions {
  /** The log the turns read and write. */
  readonly store: SessionStore
  /** How a session's `agent.model.id` becomes a model to stream from. */
  readonly model: ModelFactory
  /**
   * The runner to run passes with. Omitted, one is built from `store` and `model`; #11 passes
   * a runner it shares with its own partition logic.
   */
  readonly runner?: SessionRunner
  /** How many sessions may have a turn in flight at once; defaults to 4. */
  readonly maxConcurrentSessions?: number
  /** How long `stop()` waits for a turn in flight by default; defaults to 5000 ms. */
  readonly drainTimeoutMs?: number
  /** How model failures are retried, passed to every turn. */
  readonly retry?: RetryPolicy
  /** How the log becomes model messages, passed to every turn. */
  readonly contextStrategy?: ContextStrategy
  /** Called when a pass rejects — a fenced write, an unexpected failure. Never throws. */
  readonly onError?: (error: unknown, sessionId: SessionId) => void
}

/** How many sessions run at once when the caller does not say. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 4

/**
 * The scheduler for a server that owns every partition: a session needs work, so this process
 * runs it.
 *
 * It is a small queue. `H` sessions run at once (`maxConcurrentSessions`, 4 by default) and
 * the rest wait their turn; a session that is already running is not queued but *woken*, so
 * the running pass looks at the log again before it finishes. `signal` never blocks and never
 * throws: it is called from a request handler that has already answered the user, and a
 * scheduler that could not keep up is a latency problem, not a request failure — the event is
 * in the log either way, and `findSessionsNeedingWork` is the safety net.
 *
 * On `start()` it recovers: every session with pending user events or an open turn is queued,
 * which is how a turn interrupted by a restart is finished rather than left open.
 */
export class LocalScheduler implements SessionScheduler {
  readonly #store: SessionStore

  readonly #runner: SessionRunner

  readonly #maxConcurrentSessions: number

  readonly #drainTimeoutMs: number

  readonly #onError: ((error: unknown, sessionId: SessionId) => void) | undefined

  /** Sessions waiting for a slot, oldest enqueue first. */
  readonly #waiting: SessionId[] = []

  /** The same set as {@link waiting}, for O(1) "is it already queued?". */
  readonly #queued = new Set<SessionId>()

  /** The passes in flight, by session; the size is what the concurrency limit counts. */
  readonly #active = new Map<SessionId, Promise<void>>()

  #stopped = false

  constructor(options: LocalSchedulerOptions) {
    this.#store = options.store
    this.#runner =
      options.runner ??
      new SessionRunner({
        store: options.store,
        model: options.model,
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        ...(options.contextStrategy === undefined
          ? {}
          : { contextStrategy: options.contextStrategy }),
      })
    this.#maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    this.#onError = options.onError
  }

  /** The runner that owns the per-session turn loop; #11 shares one with its partitions. */
  get runner(): SessionRunner {
    return this.#runner
  }

  async start(): Promise<void> {
    const sessions = await this.#store.findSessionsNeedingWork(partitions())
    for (const sessionId of sessions) {
      this.#enqueue(sessionId)
    }
  }

  async stop(options: StopSchedulerOptions = {}): Promise<void> {
    if (this.#stopped) {
      return
    }
    this.#stopped = true
    this.#waiting.length = 0
    this.#queued.clear()
    await this.#runner.stop({
      drainTimeoutMs: options.drainTimeoutMs ?? this.#drainTimeoutMs,
    })
  }

  signal(sessionId: SessionId, kind: PartitionSignalKind): void {
    if (kind === 'interrupt') {
      // A turn in flight is aborted; its pass looks at the log again afterwards, which is
      // where a message queued behind the interrupt gets its turn.
      if (this.#runner.abort(sessionId)) {
        return
      }
      // Nothing to abort: there is still a queued `user.interrupt` in the log for the brain
      // to claim, so a turn is started for it.
    }
    this.#enqueue(sessionId)
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
  #enqueue(sessionId: SessionId): void {
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
      const pass = this.#runner.run(sessionId).then(
        () => undefined,
        (error: unknown) => {
          this.#report(error, sessionId)
        },
      )
      this.#active.set(sessionId, pass)
      void pass.then(() => {
        // Only if this pass is still the one on record. The runner lets go of a session a
        // microtask before this runs, so a signal in that window can start the next pass for
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

/** Every partition this scheduler owns: a `LocalScheduler` owns all of them. */
export function partitions(count: number = DEFAULT_PARTITION_COUNT): number[] {
  return Array.from({ length: count }, (_, partition) => partition)
}
