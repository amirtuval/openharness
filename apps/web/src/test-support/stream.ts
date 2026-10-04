import type { FakeClient } from '@openharness/client/testing'
import type { StreamEvent } from '@openharness/protocol'
import { act } from '@testing-library/react'

/**
 * A fake session stream the **test** releases, one event at a time.
 *
 * The fake's replies run on the event loop, so asserting "the reply is on screen while it is
 * still a prefix of the whole" against a wall-clock delay is a race: on a loaded runner the
 * reply finishes before the assertion runs (#105, P2). This helper takes the clock out of it
 * — the app's stream is wrapped in a gate, the fake's events queue up behind it, and
 * {@link GatedStream.next} hands over exactly one event (and lets React apply it) before
 * returning. Nothing is asserted between two ticks of anything.
 *
 * The app's history load is untouched: `iterate` still answers immediately, and the gate only
 * holds what the live stream delivers. Its calls are recorded so a test can pin the options
 * the hook opened it with (`deltas: true`, `afterSeq` at the last folded seq).
 */

/** One `events.stream` call the app made, as the gate saw it. */
export interface GatedStreamCall {
  readonly sessionId: string
  readonly deltas: boolean
  readonly afterSeq: number | undefined
}

/** The gate: build it, then drive the app's stream from the test. */
export interface GatedStream {
  /** The stream calls the app made, in order. */
  readonly calls: readonly GatedStreamCall[]
  /** The event types released to the app, in order. */
  readonly released: readonly string[]
  /** Release the next event the fake produced, and let React apply it. */
  next(): Promise<void>
  /**
   * Release events until `condition` is true, checking before each release.
   *
   * Throws when the fake produces nothing for too long, or 500 releases do not get there —
   * a failure that names the condition rather than timing out inside an assertion.
   */
  until(condition: () => boolean, what?: string): Promise<void>
}

/** How long `next` waits for an event the app should have received before giving up. */
const DELIVERY_TIMEOUT_MS = 5000

/** How many releases `until` will spend before calling it a failure. */
const MAX_RELEASES = 500

/** The queue behind the gate. */
class Gate {
  #produced: StreamEvent[] = []
  #permits = 0
  #delivered = 0
  #producedWaiter: (() => void) | null = null
  #permitWaiter: (() => void) | null = null
  #deliveryWaiters: Array<{ target: number; resolve: () => void }> = []
  readonly deliveredTypes: string[] = []

  /** Wrap `source`: events are held here until {@link next} releases them. */
  stream(source: AsyncIterable<StreamEvent>): AsyncIterable<StreamEvent> {
    return this.#gated(source)
  }

  async *#gated(source: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
    const inner = source[Symbol.asyncIterator]()
    // Drain the fake's subscription into the queue in the background; the app only ever
    // sees what the test lets through.
    void (async () => {
      for (;;) {
        const step = await inner.next()
        if (step.done === true) {
          return
        }
        this.#produced.push(step.value)
        this.#producedWaiter?.()
        this.#producedWaiter = null
      }
    })()

    for (;;) {
      await this.#waitProduced()
      await this.#waitPermit()
      const event = this.#produced.shift()
      if (event === undefined) {
        continue
      }
      this.deliveredTypes.push(event.type)
      yield event
      // The consumer resumed: the app has folded this event in, and the caller of `next`
      // may look at the screen.
      this.#delivered += 1
      for (const waiter of [...this.#deliveryWaiters]) {
        if (this.#delivered >= waiter.target) {
          this.#deliveryWaiters.splice(this.#deliveryWaiters.indexOf(waiter), 1)
          waiter.resolve()
        }
      }
    }
  }

  /** Release one event. */
  async next(what?: string): Promise<void> {
    const target = this.#delivered + 1
    const waiter = this.#permitWaiter
    if (waiter === null) {
      this.#permits += 1
    } else {
      this.#permitWaiter = null
      waiter()
    }
    const delivered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `gateStream: no event was delivered within ${DELIVERY_TIMEOUT_MS}ms while waiting for ${what ?? 'the next event'} (${this.#produced.length} produced, ${this.#delivered} delivered so far) — is the fake still running?`,
          ),
        )
      }, DELIVERY_TIMEOUT_MS)
      this.#deliveryWaiters.push({
        target,
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
      })
    })
    await act(async () => {
      await delivered
    })
  }

  #waitProduced(): Promise<void> {
    if (this.#produced.length > 0) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.#producedWaiter = resolve
    })
  }

  #waitPermit(): Promise<void> {
    if (this.#permits > 0) {
      this.#permits -= 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.#permitWaiter = resolve
    })
  }
}

/** Wrap the fake's session stream in a gate the test drives; see {@link GatedStream}. */
export function gateStream(fake: FakeClient): GatedStream {
  const gate = new Gate()
  const calls: GatedStreamCall[] = []
  const source = fake.sessions.events.stream.bind(fake.sessions.events)

  fake.sessions.events.stream = (sessionId, options) => {
    calls.push({ sessionId, deltas: options?.deltas === true, afterSeq: options?.afterSeq })
    return gate.stream(source(sessionId, options))
  }

  return {
    calls,
    released: gate.deliveredTypes,
    next: () => gate.next(),
    until: async (condition: () => boolean, what = 'the condition'): Promise<void> => {
      for (let released = 0; released < MAX_RELEASES; released += 1) {
        if (condition()) {
          return
        }
        await gate.next(what)
      }
      throw new Error(`gateStream: released ${MAX_RELEASES} events and ${what} never happened.`)
    },
  }
}
