/**
 * Small async primitives the client and the fake client both need.
 *
 * Everything here uses Web APIs only (`setTimeout`, `AbortSignal`), so it works in a browser
 * and in Node.
 */

/**
 * A promise that resolves after `ms` milliseconds, or as soon as `signal` aborts.
 *
 * Aborting does not reject: callers check `signal.aborted` themselves, which keeps the
 * reconnect loop of the event stream free of try/catch noise.
 *
 * @param ms milliseconds to wait
 * @param signal cancels the wait; when omitted, the wait always runs to the end
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * An unbounded FIFO queue consumed from an async loop: `next()` resolves with the oldest
 * item, waits for one, or returns `null` once the queue is closed and drained.
 *
 * {@link AsyncQueue.close} is what ends a consumer's `for await` loop, so closing it is how
 * the fake client stops a stream — on unsubscribe, and when the caller aborts.
 */
export class AsyncQueue<T> {
  readonly #items: T[] = []
  readonly #waiters: Array<(value: T | null) => void> = []
  #closed = false

  /** Append `value`; a waiting consumer is woken up. Ignored after {@link close}. */
  push(value: T): void {
    if (this.#closed) {
      return
    }
    const waiter = this.#waiters.shift()
    if (waiter === undefined) {
      this.#items.push(value)
    } else {
      waiter(value)
    }
  }

  /** Stop accepting items and end every pending and future {@link next} call with `null`. */
  close(): void {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter(null)
    }
  }

  /** Whether {@link close} has been called. */
  get closed(): boolean {
    return this.#closed
  }

  /** The oldest item, or `null` when the queue is closed and empty. */
  async next(): Promise<T | null> {
    const item = this.#items.shift()
    if (item !== undefined) {
      return item
    }
    if (this.#closed) {
      return null
    }
    return new Promise<T | null>((resolve) => {
      this.#waiters.push(resolve)
    })
  }
}
