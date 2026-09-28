/**
 * The turn loop's retry policy: how many times a retryable model failure may be attempted
 * again, how long to wait in between, and the sleeping itself.
 *
 * Both halves are injectable, which is the point: a test that retries three times and asserts
 * the exact event order must not spend the real time three exponential backoffs would take.
 * Pass `sleep` to observe (or skip) the waiting, and `jitter` to make the delays deterministic.
 */

/** A pause of `ms` milliseconds that gives up early when `signal` aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

/**
 * How the turn loop retries a retryable model failure.
 *
 * Every field is optional; {@link resolveRetryPolicy} fills in the defaults. The policy is
 * consulted per model request, not per turn: a request that fails, retries and then succeeds
 * leaves the next request with a fresh budget of `maxRetries`.
 */
export interface RetryPolicy {
  /** Attempts after the first failure. Default {@link DEFAULT_MAX_RETRIES}. */
  readonly maxRetries?: number
  /** The delay before the first retry, doubled per further retry. Default {@link DEFAULT_BASE_DELAY_MS}. */
  readonly baseDelayMs?: number
  /** The ceiling a doubled delay is clamped to. Default {@link DEFAULT_MAX_DELAY_MS}. */
  readonly maxDelayMs?: number
  /** The pause; defaults to {@link abortableSleep}. Inject one in tests. */
  readonly sleep?: Sleep
  /** A random number in `[0, 1)`, for the jitter; defaults to `Math.random`. */
  readonly jitter?: () => number
}

/** A {@link RetryPolicy} with every field resolved. */
export interface ResolvedRetryPolicy {
  readonly maxRetries: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly sleep: Sleep
  readonly jitter: () => number
}

/** Retries after the first failure, unless a policy says otherwise. */
export const DEFAULT_MAX_RETRIES = 3

/** The delay before the first retry, unless a policy says otherwise. */
export const DEFAULT_BASE_DELAY_MS = 500

/** The delay ceiling, unless a policy says otherwise. */
export const DEFAULT_MAX_DELAY_MS = 8_000

/** Fill a {@link RetryPolicy} in, so the loop reads one shape. */
export function resolveRetryPolicy(policy: RetryPolicy = {}): ResolvedRetryPolicy {
  return {
    maxRetries: policy.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    sleep: policy.sleep ?? abortableSleep,
    jitter: policy.jitter ?? Math.random,
  }
}

/**
 * How long to wait before retry number `attempt` (1 for the first retry).
 *
 * The delay doubles per attempt — `baseDelayMs * 2 ** (attempt - 1)` — and is clamped to
 * `maxDelayMs`. Half of it is fixed and half is jitter, the shape AWS calls "equal jitter":
 * with a stream of clients failing at once, the fixed half keeps a floor under the wait while
 * the jittered half spreads the retries out, instead of every client returning at the same
 * instant.
 *
 * @param attempt which retry this is, counting from `1`
 * @param policy the resolved policy, for the base, the ceiling and the jitter
 */
export function backoffDelay(attempt: number, policy: ResolvedRetryPolicy): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  const fixed = ceiling / 2
  const jittered = ceiling - fixed
  return Math.floor(fixed + policy.jitter() * jittered)
}

/**
 * The default {@link Sleep}: a real timer that resolves early when the signal aborts.
 *
 * Resolving rather than rejecting is deliberate — a caller sleeping between retries checks the
 * signal itself afterwards, and an aborted turn that had to catch an exception to notice would
 * be a second way to end the same turn.
 */
export const abortableSleep: Sleep = (ms, signal) => {
  if (signal?.aborted === true) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}
