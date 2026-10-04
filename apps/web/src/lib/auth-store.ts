import { ApiError, AuthenticationError, type Client } from '@openharness/client'
import type { User } from '@openharness/protocol'

import type { BrowserAuthClient } from './auth-client'

/**
 * Who the app is signed in as, and the one rule about it: **a 401 means sign in again**.
 *
 * The session lives in a cookie (epic #65, A2), so the app never has a token to keep — it
 * finds out who it is by asking `client.me()`, and it finds out a session has ended the same
 * way every request does: an {@link AuthenticationError}. This store is where both are
 * turned into what the shell renders, so a 401 from *any* call — the startup read, a list, a
 * stream, an agent update — lands the user on the sign-in page, not on a screen of broken
 * panels.
 *
 * It is a module-level store rather than React state because the callers are not components:
 * `use-session`, `use-sessions`, `use-models` and the credentials hook catch errors, and they
 * are the ones that know a 401 when they see one.
 *
 * The state is **per client instance**. A test (or a settings change) builds a new client,
 * and until that client has been asked, it has no answer — which is why
 * {@link authStateFor} reports `checking` for a client this store has not met yet, and why
 * every writer here takes the client it is talking about.
 */

/** What the shell needs to know to decide what to render. */
export type AuthState =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly user: User }

/** The shared "no answer yet" value; one frozen object, so React sees one snapshot. */
const CHECKING: AuthState = Object.freeze({ status: 'checking' })

const listeners = new Set<() => void>()

/** The client the current {@link snapshot} belongs to. */
let current: Client | null = null
let snapshot: AuthState = CHECKING

/** The auth state for one client: `checking` until that client has been checked. */
export function authStateFor(client: Client): AuthState {
  return current === client ? snapshot : CHECKING
}

/** Watch for changes. */
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Ask the server who this client is, and remember the answer.
 *
 * The one read at startup: a 401 is a signed-out browser, anything else the server refuses
 * with is not — but a server that cannot answer at all is not a session either, and the
 * sign-in page is where a reader learns that (the config it loads says so in words). Either
 * way the promise never rejects; the caller renders `authStateFor`.
 */
export async function beginSessionCheck(client: Client): Promise<void> {
  publish(client, CHECKING)
  try {
    const user = await client.me()
    // A check for another client (a settings change, a test's next render) may have started
    // while this one was in flight; its answer is the one that is not stale.
    if (current === client) {
      publish(client, { status: 'signed-in', user })
    }
  } catch {
    if (current === client) {
      publish(client, { status: 'signed-out' })
    }
  }
}

/** Note the user the given client is signed in as. */
export function markSignedIn(client: Client, user: User): void {
  publish(client, { status: 'signed-in', user })
}

/** Note that the given client has no usable session. */
export function markSignedOut(client: Client): void {
  publish(client, { status: 'signed-out' })
}

/**
 * Sign out: revoke the session on the server, then stop being signed in here.
 *
 * The local state is set either way. A reader who clicked Sign out meant it, and a failure to
 * revoke — an offline browser — is not a reason to keep showing them the app; the session
 * they left behind expires on its own (7 days, sliding, epic #65, A2).
 */
export async function signOutSession(client: Client, auth: BrowserAuthClient): Promise<void> {
  try {
    await auth.signOut()
  } catch {
    // Nothing to report: the signs below are what the reader asked for.
  }
  markSignedOut(client)
}

/**
 * Note a call's failure, if it was the session's fault.
 *
 * This is the single answer to "any call 401s": the caller reports what it caught, and the
 * app signs out when — and only when — it is an {@link AuthenticationError}.
 *
 * @returns whether the error was an authentication one
 */
export function noteAuthenticationError(client: Client, error: unknown): boolean {
  // The client hands back an `AuthenticationError` for every 401 it sees, so the status test
  // is the same rule written twice — once for the typed error, once for any other 401 that
  // reaches this app (a hand-built one, a wrapper that rebuilt the error).
  if (
    !(error instanceof AuthenticationError) &&
    !(error instanceof ApiError && error.status === 401)
  ) {
    return false
  }
  markSignedOut(client)
  return true
}

/** Publish a state, but only for the client it is about. */
function publish(client: Client, next: AuthState): void {
  if (current !== client) {
    current = client
  }
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}
