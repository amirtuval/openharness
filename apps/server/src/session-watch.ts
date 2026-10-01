import type { AuthSessionId, SessionStore, Unsubscribe } from '@openharness/session'

import type { Logger } from './types'

/**
 * Watching the auth session behind a long-lived response (epic #65, A2; issue #76).
 *
 * `/v1` authenticates a request once, when it arrives — which is fine for a request and wrong
 * for an SSE stream, because a stream is *one* request that can outlive the session that
 * opened it. Two mechanisms close that gap, and this module is both:
 *
 * - {@link SessionRevocations} — the registry of open responses keyed by the Better Auth
 *   session they were opened with. A revocation notification (the store's
 *   `onAuthSessionRevoked`; on Postgres a `NOTIFY` every instance hears) closes the matching
 *   responses within about a second, whichever instance handled the sign-out.
 * - {@link startSessionRecheck} — the periodic backstop. Every open response re-validates its
 *   session (`auth.api.getSession` — the row still exists, it has not expired) every
 *   {@link DEFAULT_SESSION_RECHECK_MS} at most, which covers an expired session and any
 *   notification that was missed (published before the subscription was up, or while a
 *   listening connection was reconnecting — revocations are hints, not a queue).
 *
 * Neither mechanism ever sees the session *token*: responses are keyed by the session **id**,
 * which is not a credential, and the re-check re-sends the caller's own request headers
 * without recording them.
 */

/**
 * How often an open response re-validates its session, by default.
 *
 * "At most 30 s", and equal to the SSE keepalive: a stream that receives no events still
 * wakes on that cadence, and one that is busy checks at its first wake past the deadline.
 */
export const DEFAULT_SESSION_RECHECK_MS = 15_000

/** What {@link createSessionRevocations} is built from. */
export interface SessionRevocationsOptions {
  /** The store whose revocation channel is the cross-instance half of the closure. */
  readonly store: SessionStore
  /** Where a failed subscription is reported; silent by default. */
  readonly logger?: Logger
}

/**
 * The open responses a revocation closes, keyed by the auth session that opened them.
 *
 * One registry per app. An SSE stream (or the AI SDK adapter's response) registers its close
 * hook with {@link SessionRevocations.open} under the id of the session the request
 * authenticated with, and unregisters when it ends; a revocation for that id closes every hook
 * registered under it, in no particular order.
 */
export interface SessionRevocations {
  /**
   * Track an open response: `close` runs when the auth session behind it is revoked.
   *
   * @returns the function that stops tracking — call it when the response ends, however it
   *   ended, so a later revocation does not close something that is already gone (closing
   *   twice is harmless, but holding a dead response's closure is a leak).
   */
  open(authSessionId: AuthSessionId, close: () => void): Unsubscribe
  /**
   * Close every response opened with this auth session. Idempotent: a hook registered under
   * an already-closed stream is a no-op, and a repeated notification closes nothing twice.
   *
   * Exposed so the notification path and tests share one implementation of "what a revocation
   * does".
   */
  closeFor(authSessionId: AuthSessionId): void
}

/**
 * Build the registry and subscribe it to the store's revocation channel.
 *
 * The subscription is opened once, when the app is built — before the listener accepts
 * requests — and lives as long as the app does; it is released when the store is closed
 * (`PostgresSessionStore.close` drops its listening connection). A subscription that cannot
 * be established is logged and swallowed: the store may be down at boot, the server still
 * has to come up, and the periodic re-check remains.
 */
export function createSessionRevocations(options: SessionRevocationsOptions): SessionRevocations {
  const open = new Map<AuthSessionId, Set<() => void>>()

  const closeFor = (authSessionId: AuthSessionId): void => {
    const closing = open.get(authSessionId)
    if (closing === undefined) {
      return
    }
    open.delete(authSessionId)
    for (const close of [...closing]) {
      try {
        close()
      } catch (error) {
        // One response that cannot be closed must not keep the others open.
        options.logger?.error('closing a response for a revoked session failed', error)
      }
    }
  }

  void options.store
    .onAuthSessionRevoked((authSessionId) => {
      closeFor(authSessionId)
    })
    .catch((error: unknown) => {
      options.logger?.error('listening for revoked sessions failed', error)
    })

  return {
    open(authSessionId, close) {
      const closing = open.get(authSessionId) ?? new Set<() => void>()
      closing.add(close)
      open.set(authSessionId, closing)
      let tracked = true
      return () => {
        if (!tracked) {
          return
        }
        tracked = false
        closing.delete(close)
        if (closing.size === 0) {
          open.delete(authSessionId)
        }
      }
    },
    closeFor,
  }
}

/** What {@link startSessionRecheck} is built from. */
export interface SessionRecheckOptions {
  /** How often to re-validate; the first check runs one interval after the start. */
  readonly intervalMs: number
  /**
   * Whether the session is still good: it exists and has not expired. A rejection counts as
   * invalid — an unanswered question on a security boundary closes the response, and the
   * client's own reconnect decides what happens next.
   */
  readonly revalidate: () => Promise<boolean>
  /** Called when the session turns out to be invalid; expected to end the response. */
  readonly onInvalid: () => void
}

/** A running re-check; {@link SessionRecheck.stop} ends it without another check. */
export interface SessionRecheck {
  /** Stop checking. Idempotent, and safe before the first check has run. */
  stop(): void
}

/**
 * Re-validate a session on a timer while a response is open (epic #65, A2; issue #76).
 *
 * The timer is `unref`'d — a response that outlives its process's work must not be what keeps
 * the process alive — and a check is never stacked on itself: a tick that lands while the
 * previous query is still in flight is skipped, and the next one is scheduled from the end of
 * the check that ran.
 */
export function startSessionRecheck(options: SessionRecheckOptions): SessionRecheck {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let running = false

  const schedule = (delayMs: number): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      void check()
    }, delayMs)
    timer.unref()
  }

  const check = async (): Promise<void> => {
    if (stopped || running) {
      return
    }
    running = true
    // A rejection counts as invalid — failing closed, see SessionRecheckOptions.revalidate.
    const valid = await options.revalidate().catch(() => false)
    running = false
    if (stopped) {
      return
    }
    if (!valid) {
      stopped = true
      options.onInvalid()
      return
    }
    schedule(options.intervalMs)
  }

  schedule(options.intervalMs)

  return {
    stop() {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
