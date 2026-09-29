/**
 * Waiting for something the server does on its own time.
 *
 * A turn runs in the background: the API answers `POST …/events` immediately and the events
 * arrive afterwards, so a test's job is mostly to wait for a fact to become true — an event
 * to appear in the log, a session to go idle, a process to write a line. The helpers here do
 * that polling, and they fail with **what they were waiting for** and what they saw instead,
 * which is the difference between a test that explains itself and one that says "timed out".
 */

/** How long a wait lasts before it fails, unless a caller says otherwise. */
export const DEFAULT_WAIT_MS = 30_000

/** How often a wait looks again. */
const POLL_INTERVAL_MS = 25

/** A pause of `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Poll `check` until it answers anything but `undefined`.
 *
 * `check` may be async — a wait on the API is a request per attempt — and an `undefined`
 * answer means "not yet", which keeps the caller's condition in one place.
 *
 * @param what what is being waited for, for the failure message
 * @param check the condition; `undefined` means it is not true yet
 * @param options how long to wait, and what to report when it runs out
 * @returns what `check` answered
 */
export async function waitFor<T>(
  what: string,
  check: () => T | undefined | Promise<T | undefined>,
  options: { readonly timeoutMs?: number; readonly describe?: () => string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined) {
      return value
    }
    if (Date.now() > deadline) {
      const seen = options.describe === undefined ? '' : `\nwhat it saw: ${options.describe()}`
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${seen}`)
    }
    await sleep(POLL_INTERVAL_MS)
  }
}
