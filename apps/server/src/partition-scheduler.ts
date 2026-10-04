import type { ContextStrategy, ModelFactory, RetryPolicy } from '@openharness/brain'
import { DEFAULT_PARTITION_COUNT, partitionOf, type SessionId } from '@openharness/protocol'
import {
  isFencedError,
  type PartitionLease,
  type PartitionSignal,
  type PartitionSignalKind,
  type SessionStore,
  type Unsubscribe,
} from '@openharness/session'

import type { ResolveSessionCredential } from './credentials'
import { PassQueue, type PassContext } from './pass-queue'
import { DEFAULT_DRAIN_TIMEOUT_MS, SessionRunner } from './runner'
import type { SessionScheduler, StopSchedulerOptions } from './scheduler'

/**
 * The scheduler for a server that is one of several: the sessions of the protocol's
 * `partitionOf(sessionId)` partitions are spread over the instances, each instance holding
 * the *lease* of the partitions it is responsible for, and every brain write is fenced with
 * that lease's `{ partition, epoch }`.
 *
 * ## What an instance does
 *
 * A heartbeat renews the leases this instance holds, takes over the partitions nobody holds
 * (free, or left behind by an instance that died), and gives up what it holds beyond its
 * share. Acquiring a partition is the moment it becomes this instance's work:
 *
 * 1. subscribe to the partition's signals (`store.onPartitionSignal`), so nothing that arrives
 *    from here on is missed;
 * 2. ask the log what needs doing in it — `findSessionsNeedingWork([partition])` — and queue
 *    those sessions, because the signals of a partition whose previous owner died are gone;
 * 3. run every turn under `fence: { partition, epoch }`, so a brain whose lease has been taken
 *    over stops at its first refused write instead of appending into somebody else's turn.
 *
 * `signal()` routes to the owner through the store: `store.signalPartition(partitionOf(…),
 * { sessionId, kind })` announces on the partition's channel, and every instance listening for
 * that partition hears it — including a partition's owner in another process. Signals are
 * hints, not a queue: one that nobody is listening for is dropped, which is why acquiring a
 * partition scans it and a slow sweep re-scans the ones this instance holds.
 *
 * ## Balancing
 *
 * Each instance is a member of the scheduler while it keeps heartbeating: every refresh
 * announces it in `scheduler_instances` and reads the members seen within one lease TTL back
 * (issue #122), so the space is divided by the *live members* —
 * `share = ceil(partitions / members)` each — rather than estimated from the leases this
 * instance failed to take:
 *
 * - A scan never steals: it takes free or expired partitions only, so no lease is ever taken
 *   away from a live owner, and it stops at the share. An instance that took more would only
 *   give the excess back at its next heartbeat; stopping at the share divides the space once
 *   instead of claiming it whole and rebalancing.
 * - An instance holding more than `share` gives the surplus up — finishing the turns running
 *   in it first, then releasing, so the peer that takes it over starts from a closed turn
 *   rather than a half-written one. Released partitions are left alone by this instance for a
 *   heartbeat, so the peer has a chance to take them instead of watching them bounce back.
 * - The membership ages out on its own: an instance that stops heartbeating is dropped from
 *   the count at the instant its leases stop being renewed — both windows are one lease TTL —
 *   so the survivors' shares grow and their scans take over what the dead instance held. An
 *   instance that stops gracefully deletes its row in `stop()`, so it stops being counted at
 *   once.
 *
 * Explicit membership is what makes a peer that holds *nothing* visible: it heartbeats all
 * the same, so an instance that lost the race for a fully-held space is one release away from
 * its share instead of being starved forever behind an estimate that cannot see it. A live
 * lease is still never taken and the fencing is unchanged; the membership table is
 * bookkeeping beside the log, like the leases themselves.
 *
 * ## Losing a lease
 *
 * A renewal that answers `false` means the partition is not this instance's any more, and so
 * does a `FencedError` out of one of its turns (a lease that expired between two heartbeats).
 * Either way the partition is dropped *at once*: its turns are aborted, its signal
 * subscription is ended, and no further work is started for it. A `FencedError` never escapes:
 * the runner reports the failed pass, and losing the lease is the scheduler's reaction to it.
 *
 * ## Stopping
 *
 * `stop()` stops the timers, drains the turns in flight within the drain timeout (they are
 * aborted, so a brain cuts its model request short and writes the partial reply, the closed
 * span and `session.status_idle`), *deletes its membership row* — so peers stop counting it
 * at once — and *releases* every lease it still holds, so the next instance takes the
 * partitions over at its next heartbeat instead of waiting for the TTL.
 */

/** How long a partition lease lasts before it has to be renewed; 30 seconds by default. */
export const DEFAULT_LEASE_TTL_MS = 30_000

/** How often held leases are renewed and free partitions are taken; 10 seconds by default. */
export const DEFAULT_HEARTBEAT_MS = 10_000

/** How often owned partitions are re-scanned for missed work; 60 seconds by default. */
export const DEFAULT_SWEEP_MS = 60_000

/** What {@link PostgresPartitionScheduler} is built from. */
export interface PostgresPartitionSchedulerOptions {
  /** The store the leases live in, and the log every turn reads and writes. */
  readonly store: SessionStore
  /** How a session's `model.id` becomes a model to stream from (issue #93). */
  readonly model: ModelFactory
  /**
   * Where each model request's provider credential comes from (epic #65, A5); see
   * `SessionRunnerOptions.resolveCredential`.
   */
  readonly resolveCredential: ResolveSessionCredential
  /**
   * This instance's id, stable for its lifetime — what the lease table records as the owner.
   * Two live instances sharing one id would fence each other's writes, so it must be unique.
   */
  readonly instanceId: string
  /** How many partitions the session space is divided into; the protocol's 64 by default. */
  readonly partitions?: number
  /** How long a lease lasts before it has to be renewed; 30 seconds by default. */
  readonly ttlMs?: number
  /** How often leases are renewed and free partitions taken; 10 seconds by default. */
  readonly heartbeatMs?: number
  /** How often owned partitions are re-scanned for missed work; 60 seconds by default. */
  readonly sweepMs?: number
  /**
   * The runner to run passes with. Omitted, one is built from `store`, `model` and
   * `resolveCredential`; a host that runs several schedulers against the same store passes its
   * own.
   */
  readonly runner?: SessionRunner
  /** How many sessions may have a turn in flight at once; defaults to 4. */
  readonly maxConcurrentSessions?: number
  /**
   * How long `stop()` — and giving up a partition — waits for the turns in flight; defaults to
   * 5000 ms.
   */
  readonly drainTimeoutMs?: number
  /** How model failures are retried, passed to every turn. */
  readonly retry?: RetryPolicy
  /** How the log becomes model messages, passed to every turn. */
  readonly contextStrategy?: ContextStrategy
  /**
   * Called when a pass rejects, and when a background tick fails. Never throws.
   *
   * `sessionId` is `undefined` for a failure that is not about one session — a lease that
   * could not be renewed, a scan that could not reach the store.
   */
  readonly onError?: (error: unknown, sessionId: SessionId | undefined) => void
  /** Called with a line about what the scheduler is doing; for a host that wants to log it. */
  readonly onNotice?: (message: string) => void
}

/** What a pass runs under, resolved from the lease this instance holds for its partition. */
const STOPPED_CONTEXT = { signal: AbortSignal.abort() }

/**
 * The multi-instance {@link SessionScheduler}: partitions, leases, epochs and recovery.
 *
 * See the class-level documentation above for the balancing rule, what happens when a lease is
 * lost, and how shutdown releases what this instance holds.
 */
export class PostgresPartitionScheduler implements SessionScheduler {
  readonly #store: SessionStore

  readonly #instanceId: string

  readonly #partitions: number

  readonly #ttlMs: number

  readonly #heartbeatMs: number

  readonly #sweepMs: number

  readonly #drainTimeoutMs: number

  readonly #onError: ((error: unknown, sessionId: SessionId | undefined) => void) | undefined

  readonly #onNotice: ((message: string) => void) | undefined

  readonly #queue: PassQueue

  /** The leases this instance holds, by partition. */
  readonly #held = new Map<number, PartitionLease>()

  /** The held partitions in the order they were taken; the newest go first when giving up. */
  #order: number[] = []

  /** The end of the signal subscription of each held partition. */
  readonly #subscriptions = new Map<number, Unsubscribe>()

  /** Aborted to stop the work of a partition whose lease is gone. */
  readonly #stoppers = new Map<number, AbortController>()

  /** When each partition we gave up was released, so a scan leaves it for a peer first. */
  readonly #releasedAt = new Map<number, number>()

  /**
   * How many instances the last membership read saw — this one included — and so what the
   * share divides the space by; see "Balancing" (issue #122). One until the first read, which
   * is the truth for an instance that has just started announcing itself.
   */
  #liveMembers = 1

  /** Where a scan starts, so instances do not all walk the space in the same order. */
  #cursor: number

  #heartbeat: NodeJS.Timeout | undefined

  #sweep: NodeJS.Timeout | undefined

  /** The refresh in flight, so a heartbeat that fires while one runs does not start another. */
  #refreshing: Promise<void> | null = null

  #started = false

  #stopping: Promise<void> | null = null

  #stopped = false

  #paused = false

  constructor(options: PostgresPartitionSchedulerOptions) {
    this.#store = options.store
    this.#instanceId = options.instanceId
    this.#partitions = options.partitions ?? DEFAULT_PARTITION_COUNT
    this.#ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.#sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
    this.#onError = options.onError
    this.#onNotice = options.onNotice
    if (!Number.isInteger(this.#partitions) || this.#partitions < 1) {
      throw new RangeError(`partitions must be a positive integer, got ${this.#partitions}`)
    }
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs <= 0) {
      throw new RangeError(`ttlMs must be a positive number, got ${this.#ttlMs}`)
    }
    if (!Number.isFinite(this.#heartbeatMs) || this.#heartbeatMs <= 0) {
      throw new RangeError(`heartbeatMs must be a positive number, got ${this.#heartbeatMs}`)
    }
    if (this.#heartbeatMs >= this.#ttlMs) {
      // A heartbeat slower than the lease means the lease lapses between two renewals, which
      // is a partition handing itself over every cycle rather than a configuration.
      throw new Error(
        `heartbeatMs (${this.#heartbeatMs}) must be smaller than ttlMs (${this.#ttlMs})`,
      )
    }
    this.#cursor = hashOffset(options.instanceId, this.#partitions)
    this.#queue = new PassQueue({
      runner:
        options.runner ??
        new SessionRunner({
          store: options.store,
          model: options.model,
          resolveCredential: options.resolveCredential,
          ...(options.retry === undefined ? {} : { retry: options.retry }),
          ...(options.contextStrategy === undefined
            ? {}
            : { contextStrategy: options.contextStrategy }),
        }),
      ...(options.maxConcurrentSessions === undefined
        ? {}
        : { maxConcurrentSessions: options.maxConcurrentSessions }),
      ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
      onError: (error, sessionId) => {
        this.#passFailed(error, sessionId)
      },
      contextFor: (sessionId) => this.#contextFor(sessionId),
    })
  }

  /** The id this instance leases partitions under. */
  get instanceId(): string {
    return this.#instanceId
  }

  /** How many partitions the session space is divided into. */
  get partitionCount(): number {
    return this.#partitions
  }

  /** The partitions this instance currently holds a lease on, in acquisition order. */
  heldPartitions(): number[] {
    return [...this.#order]
  }

  /** The sessions with a pass in flight, in no particular order. */
  activeSessions(): SessionId[] {
    return this.#queue.activeSessions()
  }

  /** The partition a session belongs to — the one whose lease gates its writes. */
  partitionOf(sessionId: SessionId): number {
    return partitionOf(sessionId, this.#partitions)
  }

  /**
   * Start running: claim what is free, recover what comes with it, then follow the heartbeats.
   *
   * The first scan runs before this resolves, so a server that has just started is already
   * responsible for its partitions — and the sessions in them that need work — by the time the
   * API is taking requests.
   */
  async start(): Promise<void> {
    if (this.#started) {
      return
    }
    this.#started = true
    await this.#refresh()
    this.#installTimers()
    this.#notice(
      `instance ${this.#instanceId} holds partitions ${describePartitions(this.heldPartitions())}`,
    )
  }

  async stop(options: StopSchedulerOptions = {}): Promise<void> {
    this.#stopping ??= this.#stop(options)
    return this.#stopping
  }

  /**
   * Route a signal to the partition's owner through the store.
   *
   * Nothing here looks at what this instance holds: the signal goes to the partition's channel
   * and whoever holds the lease is listening. A signal nobody hears is dropped, which is why
   * every owner scans a partition when it acquires it and the sweep re-scans it later.
   */
  signal(sessionId: SessionId, kind: PartitionSignalKind): void {
    if (this.#stopped) {
      return
    }
    const partition = this.partitionOf(sessionId)
    void this.#store.signalPartition(partition, { sessionId, kind }).catch((error: unknown) => {
      // The event is in the log and the owner will find it; failing to announce it is a
      // latency problem, not a request failure, so it is reported and dropped.
      this.#report(error, sessionId)
    })
  }

  /**
   * Stop renewing and claiming, without giving anything up.
   *
   * This is what an instance that stops responding looks like from the outside — a process
   * that is wedged, or being paused by an operator: its turns keep running, but nothing is
   * renewed, so the leases expire and the partitions move to whoever is still awake. Tests use
   * it to make a zombie on purpose.
   */
  pause(): void {
    this.#paused = true
    this.#clearTimers()
  }

  /** Start the timers again after {@link pause}. Leases lost meanwhile are re-claimed. */
  resume(): void {
    if (!this.#paused) {
      return
    }
    this.#paused = false
    if (this.#started && !this.#stopped) {
      this.#installTimers()
    }
  }

  // ------------------------------------------------------------------ the heartbeat

  /** Renew, give up what is surplus, then take what is free. One refresh at a time. */
  #tick(): Promise<void> {
    const running = this.#refreshing
    if (running !== null) {
      return running
    }
    const next = this.#refresh().catch((error: unknown) => {
      this.#report(error, undefined)
    })
    this.#refreshing = next
    void next.then(() => {
      if (this.#refreshing === next) {
        this.#refreshing = null
      }
    })
    return next
  }

  async #refresh(): Promise<void> {
    if (this.#stopped || this.#paused) {
      return
    }
    await this.#announce()
    if (this.#stopped || this.#paused) {
      return
    }
    await this.#renewHeld()
    if (this.#stopped || this.#paused) {
      return
    }
    await this.#releaseSurplus()
    if (this.#stopped || this.#paused) {
      return
    }
    await this.#scan()
  }

  /**
   * Say this instance is alive, and read who else is: the membership row is upserted first, so
   * the list this instance reads back contains itself (issue #122).
   *
   * That list is what the share is computed from — `ceil(partitions / members)` — and it is
   * the difference from the old inferred balancing: a peer that holds *nothing* still
   * heartbeats, so it is counted the moment it starts, and an instance that lost the race for
   * a fully-held space gets its share at the winner's next release instead of being invisible
   * forever. A failed announce or read fails the tick and is reported like any other store
   * failure; the next heartbeat tries again.
   */
  async #announce(): Promise<void> {
    await this.#store.heartbeatInstance(this.#instanceId)
    if (this.#stopped) {
      // A stop raced this announce — the refresh that issued it had already begun when the
      // stop ran, and its write landed after the stop's delete. The row must not outlive the
      // instance: delete it again, now that the write has committed. (The same shape as
      // `#adopt` releasing the lease of a stop that raced an acquire.)
      await this.#store.removeInstance(this.#instanceId)
      return
    }
    const members = await this.#store.listLiveInstances(this.#ttlMs)
    // The floor of one is paranoia about a store that answered an empty list: this instance
    // has just announced itself, so the list contains it, and the share divides by at least
    // the one member there always is.
    this.#liveMembers = Math.max(1, members.length)
  }

  /** Extend every lease; one that cannot be extended is not ours any more. */
  async #renewHeld(): Promise<void> {
    const leases = [...this.#held.values()]
    const renewed = await Promise.all(
      leases.map(async (lease) => ({
        lease,
        still: await this.#store.renewPartition(
          lease.partition,
          this.#instanceId,
          lease.epoch,
          this.#ttlMs,
        ),
      })),
    )
    for (const { lease, still } of renewed) {
      if (!still) {
        this.#lose(lease.partition, 'the lease could not be renewed')
      }
    }
  }

  /**
   * Walk the partition space and take free partitions until this instance holds its share.
   *
   * Free and expired partitions only: a live lease held by another instance is left alone — a
   * lease is never taken away from a live owner. The walk stops at the share, because a
   * partition taken beyond it would only be given back at the next heartbeat; with the
   * membership known the space divides once instead of being claimed whole and rebalanced.
   */
  async #scan(): Promise<void> {
    for (let step = 0; step < this.#partitions; step += 1) {
      if (this.#stopped || this.#paused) {
        return
      }
      if (this.#held.size >= this.#share()) {
        break
      }
      const partition = (this.#cursor + step) % this.#partitions
      if (this.#held.has(partition) || this.#cooling(partition)) {
        continue
      }
      const lease = await this.#store.acquirePartition(partition, this.#instanceId, this.#ttlMs)
      if (lease === null) {
        continue
      }
      await this.#adopt(lease)
    }
    this.#cursor = (this.#cursor + 1) % this.#partitions
  }

  /**
   * Take a partition over: subscribe to its signals *first*, then recover its sessions.
   *
   * The order matters. A signal that arrives between the acquire and the subscription is gone
   * forever — signals are hints, not a queue — so listening starts before anything else, and
   * whatever was already waiting in the log is found by the scan that follows.
   */
  async #adopt(lease: PartitionLease): Promise<void> {
    const partition = lease.partition
    this.#held.set(partition, lease)
    this.#order.push(partition)
    this.#releasedAt.delete(partition)
    this.#stoppers.set(partition, new AbortController())
    const unsubscribe = await this.#store.onPartitionSignal(partition, (signal) => {
      this.#handleSignal(signal)
    })
    if (!this.#held.has(partition) || this.#stopped) {
      // The lease went away while the subscription was being set up — or this instance began
      // stopping: either way, drop the partition again, so nothing is held that has no
      // listener of its own. If the lease is still this instance's (a `stop()` that raced
      // this acquire), it is *released* on the way out: a stopping instance must not leave a
      // live lease behind, or the next instance waits out the whole TTL for a partition
      // nobody is running. A lease that is no longer ours — it expired and somebody else
      // took it — makes the release a no-op.
      unsubscribe()
      this.#forget(partition)
      try {
        await this.#store.releasePartition(partition, this.#instanceId, lease.epoch)
      } catch (error: unknown) {
        // A lease that cannot be released expires; the TTL is what makes that safe.
        this.#report(error, undefined)
      }
      return
    }
    this.#subscriptions.set(partition, unsubscribe)
    this.#notice(`acquired partition ${partition} at epoch ${lease.epoch}`)
    await this.#recover(partition)
  }

  /** Queue every session of a partition that the log says needs work. */
  async #recover(partition: number): Promise<void> {
    const sessions = await this.#store.findSessionsNeedingWork([partition])
    for (const sessionId of sessions) {
      if (!this.#held.has(partition)) {
        return
      }
      this.#queue.request(sessionId)
    }
  }

  /**
   * Give up the leases this instance holds beyond its share, newest tenure first.
   *
   * "Gracefully" is the point: the turns running in the partition are allowed to finish
   * writing (up to the drain timeout) before the lease is released, so the instance that takes
   * it over inherits a closed turn rather than a half-written one. A turn that is still
   * running when the timeout passes is aborted first — a released lease fences its writes
   * anyway, and an abort is the version that leaves the log closed.
   */
  async #releaseSurplus(): Promise<void> {
    let surplus = this.#held.size - this.#share()
    if (surplus <= 0) {
      return
    }
    // Newest first: the partitions this instance took last are the ones it needs least.
    const giving: PartitionLease[] = []
    const stoppers: AbortController[] = []
    for (const partition of [...this.#order].reverse()) {
      if (surplus <= 0 || this.#stopped) {
        break
      }
      const lease = this.#held.get(partition)
      if (lease === undefined) {
        continue
      }
      surplus -= 1
      giving.push(lease)
      const stopper = this.#forget(partition)
      if (stopper !== undefined) {
        stoppers.push(stopper)
      }
      this.#releasedAt.set(partition, Date.now())
    }
    if (giving.length === 0) {
      return
    }
    // Gracefully, and once for the whole batch: the turns running in the partitions being
    // given up are allowed to finish writing (up to the drain timeout) rather than being cut
    // off — so whoever takes the partitions over inherits closed turns.
    await this.#queue.drain(
      giving.flatMap((lease) => this.#sessionsOf(lease.partition)),
      this.#drainTimeoutMs,
    )
    // Whatever is still running is aborted first: a released lease fences its writes anyway,
    // and an abort is the version that leaves the log closed.
    for (const stopper of stoppers) {
      stopper.abort()
    }
    await Promise.all(
      giving.map((lease) =>
        this.#store.releasePartition(lease.partition, this.#instanceId, lease.epoch),
      ),
    )
    this.#notice(`gave up ${giving.length} partition(s) (above this instance's share)`)
  }

  /**
   * Drop a partition whose lease is gone: abort its work and stop listening.
   *
   * Nothing is released: the lease is not this instance's any more, and `releasePartition` on
   * a lease somebody else holds is a no-op anyway.
   */
  #lose(partition: number, reason: string): void {
    if (!this.#held.has(partition)) {
      return
    }
    this.#forget(partition)?.abort()
    this.#notice(`lost partition ${partition}: ${reason}`)
  }

  /**
   * Stop counting a partition as held: unsubscribe from its signals and forget its stopper.
   *
   * @returns the abort controller the partition's passes were running under, so the caller can
   *   end them — they write nothing either way, because {@link #contextFor} refuses a session
   *   whose partition is not held any more.
   */
  #forget(partition: number): AbortController | undefined {
    this.#held.delete(partition)
    this.#order = this.#order.filter((held) => held !== partition)
    const unsubscribe = this.#subscriptions.get(partition)
    this.#subscriptions.delete(partition)
    unsubscribe?.()
    const stopper = this.#stoppers.get(partition)
    this.#stoppers.delete(partition)
    return stopper
  }

  /** The sessions of a partition that have a pass in flight right now. */
  #sessionsOf(partition: number): SessionId[] {
    return this.#queue
      .activeSessions()
      .filter((sessionId) => this.partitionOf(sessionId) === partition)
  }

  /** Whether a partition we gave up was released too recently to take back. */
  #cooling(partition: number): boolean {
    const releasedAt = this.#releasedAt.get(partition)
    if (releasedAt === undefined) {
      return false
    }
    if (Date.now() - releasedAt < this.#heartbeatMs) {
      return true
    }
    this.#releasedAt.delete(partition)
    return false
  }

  /** How many partitions this instance should hold: the space over the live members (#122). */
  #share(): number {
    return Math.max(1, Math.ceil(this.#partitions / this.#liveMembers))
  }

  /** The fence and stop signal a pass for `sessionId` runs under — right now, not at request. */
  #contextFor(sessionId: SessionId): PassContext {
    const partition = this.partitionOf(sessionId)
    const lease = this.#held.get(partition)
    if (lease === undefined) {
      // Not ours — any more. The pass writes nothing and answers `noop`.
      return STOPPED_CONTEXT
    }
    const stopper = this.#stoppers.get(partition)
    return {
      fence: { partition, epoch: lease.epoch },
      ...(stopper === undefined ? {} : { signal: stopper.signal }),
    }
  }

  /** A signal from the store: wake the session's pass, or abort it — if the partition is ours. */
  #handleSignal(signal: PartitionSignal): void {
    if (this.#stopped || !this.#held.has(signal.partition)) {
      return
    }
    if (signal.kind === 'interrupt') {
      // A turn in flight is aborted; its pass looks at the log again afterwards, which is
      // where a message queued behind the interrupt gets its turn.
      if (this.#queue.runner.abort(signal.sessionId)) {
        return
      }
      // Nothing to abort: the queued `user.interrupt` still has to be claimed by a turn.
    }
    this.#queue.request(signal.sessionId)
  }

  /**
   * The slow safety net: re-scan the partitions this instance holds. Signals that were missed
   * — a dropped notification, a message appended while the partition had no owner — are found
   * here, the same way a new owner finds them when it takes a partition over.
   */
  async #sweepOwned(): Promise<void> {
    if (this.#stopped || this.#paused) {
      return
    }
    for (const partition of [...this.#order]) {
      if (this.#stopped || !this.#held.has(partition)) {
        continue
      }
      try {
        await this.#recover(partition)
      } catch (error: unknown) {
        this.#report(error, undefined)
      }
    }
  }

  /** A pass rejected: a fenced write means the lease is gone; either way it is reported. */
  #passFailed(error: unknown, sessionId: SessionId): void {
    this.#report(error, sessionId)
    if (isFencedError(error)) {
      // The store refused the write because this instance's lease is not current any more —
      // which is the same news as a refused renewal, arriving the other way round. The pass is
      // already over, so this only stops the *next* pass from starting: the partition, and
      // whatever else it was going to run, is somebody else's work now.
      const partition = this.partitionOf(sessionId)
      this.#lose(partition, `a write was fenced at epoch ${String(error.currentEpoch)}`)
    }
  }

  async #stop(options: StopSchedulerOptions): Promise<void> {
    this.#stopped = true
    this.#clearTimers()
    // The membership row goes first: peers stop counting this instance the moment it is
    // stopping, so the share they divide grows and the partitions released below are taken
    // over at their next heartbeat instead of after the row ages out (issue #122). A delete
    // that fails is reported and dropped — the row then ages out after one TTL, exactly as a
    // crash's would — and it never keeps the shutdown from finishing.
    try {
      await this.#store.removeInstance(this.#instanceId)
    } catch (error: unknown) {
      this.#report(error, undefined)
    }
    // The turns in flight are aborted and given the drain timeout to write their last events,
    // exactly like a single-process shutdown.
    await this.#queue.stop({
      drainTimeoutMs: options.drainTimeoutMs ?? this.#drainTimeoutMs,
    })
    // Then the leases go, so whoever is waiting takes over at its next heartbeat instead of
    // sitting out the whole TTL.
    const released = [...this.#held.values()]
    for (const lease of released) {
      this.#forget(lease.partition)?.abort()
      try {
        await this.#store.releasePartition(lease.partition, this.#instanceId, lease.epoch)
      } catch (error: unknown) {
        // A lease that cannot be released expires; the TTL is what makes that safe.
        this.#report(error, undefined)
      }
    }
    if (released.length > 0) {
      this.#notice(`released ${released.length} partition lease(s) on shutdown`)
    }
  }

  #installTimers(): void {
    this.#clearTimers()
    if (this.#stopped || this.#paused) {
      return
    }
    this.#heartbeat = setInterval(() => {
      void this.#tick()
    }, this.#heartbeatMs)
    this.#heartbeat.unref?.()
    this.#sweep = setInterval(() => {
      void this.#sweepOwned()
    }, this.#sweepMs)
    this.#sweep.unref?.()
  }

  #clearTimers(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat)
      this.#heartbeat = undefined
    }
    if (this.#sweep !== undefined) {
      clearInterval(this.#sweep)
      this.#sweep = undefined
    }
  }

  /** Report a failure without ever letting it escape: the reporter is the only listener. */
  #report(error: unknown, sessionId: SessionId | undefined): void {
    try {
      this.#onError?.(error, sessionId)
    } catch {
      // A reporter that throws is not worth losing the scheduler over.
    }
  }

  /** Say what the scheduler is doing, if the host asked to hear it. */
  #notice(message: string): void {
    try {
      this.#onNotice?.(message)
    } catch {
      // Same as above: a noisy host must not be able to stop the scheduler.
    }
  }
}

/** A partition list as a range-ish summary, for a log line: `0-31 (32)`. */
export function describePartitions(owned: readonly number[]): string {
  if (owned.length === 0) {
    return 'none'
  }
  const sorted = [...owned].sort(ascending)
  const first = sorted[0] ?? 0
  const last = sorted[sorted.length - 1] ?? 0
  return first === last ? `${first}` : `${first}-${last} (${owned.length})`
}

/** Where a scan of this instance starts: its own slice of the space, spread by its id. */
function hashOffset(instanceId: string, partitions: number): number {
  let hash = 0
  for (let index = 0; index < instanceId.length; index += 1) {
    hash = (hash * 31 + instanceId.charCodeAt(index)) % partitions
  }
  return hash
}

function ascending(left: number, right: number): number {
  return left - right
}
