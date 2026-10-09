import type { SessionStore } from '@openharness/session'

import type { Logger } from './types'

/**
 * The periodic compaction of superseded chunks (D9, issue #46).
 *
 * Since D9 a reply is stored twice while it streams: as its chunks, and as the message that
 * supersedes them. Replay already skips the superseded chunks, so deleting them changes what no
 * reader sees — the retention window only keeps the raw chunks around for debugging and keeps
 * deletes off the append path. This job is what does the deleting: once per interval it calls
 * `SessionStore.compact` — the one method that ever deletes from a log — with the retention
 * cutoff.
 *
 * Every instance runs it. Compaction is idempotent and safe from several instances at once
 * (whoever deletes a row first owns it), so there is nothing to coordinate: a server that runs
 * it twice, or two servers that run it together, delete fewer rows the second time and nothing
 * else.
 *
 * ## The timer
 *
 * `start()` schedules a `setInterval` that is `unref`'d, so a process whose only remaining work
 * is this job can still exit; `stop()` clears it and waits for a run that is in flight, which is
 * what shutdown calls before it closes the store. A tick that arrives while the previous run is
 * still going is skipped rather than queued — a store slower than the interval should see fewer,
 * not overlapping, deletes. A failing run is logged and the next tick tries again: a database
 * that is briefly unreachable must not take the server down.
 */

/** How long superseded chunks are kept before they are deleted: one hour. */
export const DEFAULT_DELTA_RETENTION_MS = 3_600_000

/** How often compaction runs: every five minutes. */
export const DEFAULT_COMPACT_INTERVAL_MS = 300_000

/** What {@link DeltaCompactor} is built from. */
export interface DeltaCompactorOptions {
  /** The store to compact. */
  readonly store: SessionStore
  /** The retention window, in milliseconds; {@link DEFAULT_DELTA_RETENTION_MS} by default. */
  readonly retentionMs?: number
  /**
   * How often to run, in milliseconds; {@link DEFAULT_COMPACT_INTERVAL_MS} by default. `0`
   * disables the job — `start()` schedules nothing, and only an explicit {@link
   * DeltaCompactor.run} compacts.
   */
  readonly intervalMs?: number
  /** Where the run's count and its failures are logged. */
  readonly logger?: Logger
  /** The clock, for tests; `Date.now` by default. */
  readonly now?: () => number
}

/**
 * The compaction job: a timer around `store.compact`; see the module doc for the rules.
 */
export class DeltaCompactor {
  readonly #store: SessionStore

  readonly #retentionMs: number

  readonly #intervalMs: number

  readonly #logger: Logger | undefined

  readonly #now: () => number

  #timer: NodeJS.Timeout | null = null

  /** The run in flight, or `null`; what {@link DeltaCompactor.stop} waits for. */
  #inFlight: Promise<void> | null = null

  constructor(options: DeltaCompactorOptions) {
    this.#store = options.store
    this.#retentionMs = options.retentionMs ?? DEFAULT_DELTA_RETENTION_MS
    this.#intervalMs = options.intervalMs ?? DEFAULT_COMPACT_INTERVAL_MS
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
  }

  /** Whether the timer is scheduled. */
  get running(): boolean {
    return this.#timer !== null
  }

  /** Schedule the job; an interval of `0` schedules nothing. Starting twice is a no-op. */
  start(): void {
    if (this.#intervalMs <= 0 || this.#timer !== null) {
      return
    }
    const timer = setInterval(() => {
      void this.#tick()
    }, this.#intervalMs)
    // A job that only deletes old rows must never be the reason a process stays alive.
    timer.unref()
    this.#timer = timer
  }

  /**
   * Stop the timer, and wait for a run that is already going.
   *
   * The wait is what makes shutdown clean: the store is closed after this returns, and a run
   * still in flight would otherwise meet a closed pool.
   */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    await this.#inFlight
  }

  /**
   * Compact once, now: delete the stored chunks a supersession covers that are older than the
   * retention window, and answer how many went.
   *
   * This is the whole job; the timer is only its schedule, and a test can call it directly.
   */
  async run(): Promise<number> {
    return await this.#store.compact({ olderThan: this.#now() - this.#retentionMs })
  }

  /** One scheduled run: skip if the last one is still going, log what it did. */
  async #tick(): Promise<void> {
    if (this.#inFlight !== null) {
      return
    }
    const inFlight = this.#compact().finally(() => {
      this.#inFlight = null
    })
    this.#inFlight = inFlight
    await inFlight
  }

  /** A run whose failure belongs in the log, not in an unhandled rejection. */
  async #compact(): Promise<void> {
    try {
      const deleted = await this.run()
      this.#logger?.debug(`compaction deleted ${deleted} superseded chunk(s)`)
    } catch (error) {
      this.#logger?.error('compaction failed', error)
    }
  }
}
