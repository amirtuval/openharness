import { Client, type ClientConfig } from 'pg'

/**
 * The one connection a store listens on.
 *
 * `LISTEN` is a property of a connection, not of a pool, so a store keeps a single dedicated
 * client for every channel it cares about: `LISTEN` once per channel when the first
 * subscriber for it arrives, `UNLISTEN` when the last one leaves. Using a pooled connection
 * per subscription would spend a backend per subscriber, and the subscription would die with
 * whatever pooled connection it happened to borrow.
 *
 * ## Loss and reconnection
 *
 * A dropped connection silently stops delivering notifications, so this class watches for it
 * and reconnects with backoff. After a reconnect it re-issues `LISTEN` for every channel that
 * is still wanted and then calls {@link ListenConnectionOptions.onReconnect}, which is where
 * the store catches up on whatever arrived while it was not listening: a notification is a
 * hint about a log that is the real record, so missing one is recoverable rather than fatal.
 *
 * The client's own error and end events are the only signal Postgres gives that something
 * went wrong — `pg` surfaces a connection failure as an `error` event on the client.
 */
export class ListenConnection {
  readonly #clientConfig: ClientConfig

  readonly #onNotification: (channel: string, payload: string) => void

  readonly #onReconnect: () => Promise<void>

  readonly #onError: ((error: Error) => void) | undefined

  /** Every channel that should be listened to, whether or not a connection is up. */
  readonly #channels = new Set<string>()

  #client: Client | null = null

  /** The in-flight connect attempt, so concurrent subscribers share one connection. */
  #connecting: Promise<void> | null = null

  /** Bumped on every connect, so a handler from a superseded client is ignored. */
  #generation = 0

  #everConnected = false

  #retryDelayMs = INITIAL_RETRY_MS

  #timer: ReturnType<typeof setTimeout> | null = null

  #closed = false

  constructor(options: ListenConnectionOptions) {
    this.#clientConfig = options.clientConfig
    this.#onNotification = options.onNotification
    this.#onReconnect = options.onReconnect
    this.#onError = options.onError
  }

  /** Whether a connection is currently up; for tests and diagnostics. */
  get connected(): boolean {
    return this.#client !== null
  }

  /**
   * Listen on `channel`, connecting first if needed.
   *
   * Resolves once the `LISTEN` has been issued, so a caller that subscribes after this can
   * rely on notifications for the channel arriving — not on anything that was published
   * before it.
   *
   * @throws when the connection cannot be established; the store surfaces that to the
   *   subscriber instead of pretending the subscription exists
   */
  async listen(channel: string): Promise<void> {
    this.#channels.add(channel)
    const client = await this.#connected()
    await client.query(`listen ${quoteIdentifier(channel)}`)
  }

  /**
   * Stop listening on `channel`, when the last subscriber for it has gone.
   *
   * Best effort by design: dropping the last subscriber must not fail, and after a
   * reconnect the channel is not re-listened either way.
   */
  async unlisten(channel: string): Promise<void> {
    this.#channels.delete(channel)
    if (this.#client !== null) {
      await this.#client.query(`unlisten ${quoteIdentifier(channel)}`)
    }
  }

  /**
   * Give up the connection: stop reconnecting, `UNLISTEN` everything and close the client.
   *
   * Idempotent, and safe to call while a connect attempt is in flight — the attempt notices
   * that the connection was closed and ends the client it opened.
   */
  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    this.#channels.clear()
    const client = this.#client
    this.#client = null
    if (client !== null) {
      // `end()` on a connection that already died rejects; closing must not.
      await client.end().catch(() => undefined)
    }
  }

  /** The live client, connecting (once, shared by concurrent callers) if there is none. */
  async #connected(): Promise<Client> {
    if (this.#closed) {
      throw new Error('the listen connection is closed')
    }
    if (this.#client === null) {
      this.#connecting ??= this.#connect().finally(() => {
        this.#connecting = null
      })
      await this.#connecting
    }
    const client = this.#client
    if (client === null) {
      throw new Error('the listen connection could not be established')
    }
    return client
  }

  /** Open a client, re-`LISTEN` every wanted channel, and catch up after a reconnection. */
  async #connect(): Promise<void> {
    const generation = (this.#generation += 1)
    const client = new Client(this.#clientConfig)
    client.on('notification', (message) => {
      if (generation !== this.#generation) {
        return
      }
      if (typeof message.channel === 'string' && typeof message.payload === 'string') {
        this.#onNotification(message.channel, message.payload)
      }
    })
    client.on('error', (error: Error) => {
      this.#lost(generation, error)
    })
    client.on('end', () => {
      this.#lost(generation)
    })
    try {
      await client.connect()
    } catch (error) {
      // No connection to lose, but a later subscriber should still be able to try again.
      this.#scheduleReconnect()
      throw error
    }
    if (this.#closed || generation !== this.#generation) {
      await client.end().catch(() => undefined)
      return
    }
    this.#client = client
    this.#retryDelayMs = INITIAL_RETRY_MS
    for (const channel of this.#channels) {
      await client.query(`listen ${quoteIdentifier(channel)}`)
    }
    if (this.#everConnected) {
      // Everything published between the loss and this reconnect has to be fetched, not
      // notified: the store knows each session's last delivered seq.
      await this.#onReconnect()
    }
    this.#everConnected = true
  }

  /** React to a client dying: forget it and reconnect after a growing delay. */
  #lost(generation: number, error?: Error): void {
    if (this.#closed || generation !== this.#generation || this.#client === null) {
      return
    }
    this.#client = null
    if (error !== undefined) {
      this.#onError?.(error)
    }
    this.#scheduleReconnect()
  }

  /** Retry a connect after a backoff, unless one is already scheduled or the store closed. */
  #scheduleReconnect(): void {
    if (this.#closed || this.#timer !== null) {
      return
    }
    const delay = this.#retryDelayMs
    this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, MAX_RETRY_MS)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#reconnect()
    }, delay)
    // A store that is merely idle must not hold the process open.
    this.#timer.unref()
  }

  async #reconnect(): Promise<void> {
    try {
      await this.#connected()
    } catch (error) {
      this.#onError?.(error instanceof Error ? error : new Error(String(error)))
      this.#scheduleReconnect()
    }
  }
}

/** Everything {@link ListenConnection} takes. */
export interface ListenConnectionOptions {
  /** How to reach Postgres; the store hands it the pool's own configuration. */
  readonly clientConfig: ClientConfig
  /**
   * Called for every notification on a listened channel. Runs on the connection's event
   * loop turn, so an implementation that has to await something should queue it rather than
   * block here.
   */
  readonly onNotification: (channel: string, payload: string) => void
  /** Called after a reconnect, to catch up on what the connection missed while it was gone. */
  readonly onReconnect: () => Promise<void>
  /** Called when a connection is lost or cannot be re-established, for diagnostics. */
  readonly onError?: (error: Error) => void
}

/** First reconnect delay; doubles up to {@link MAX_RETRY_MS}. */
const INITIAL_RETRY_MS = 50

/** Longest reconnect delay. */
const MAX_RETRY_MS = 5_000

/**
 * A channel name as a quoted identifier.
 *
 * Channel names are generated (see `schema.ts`), never caller-supplied, but quoting keeps
 * them out of the identifier rules: `LISTEN` case-folds an unquoted name, `pg_notify()`
 * does not.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}
