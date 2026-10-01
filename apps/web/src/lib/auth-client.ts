import { createAuthClient } from 'better-auth/client'
import { deviceAuthorizationClient } from 'better-auth/client/plugins'

import type { AuthProvider } from './auth-config'

/**
 * The browser's way in: Better Auth's own client, narrowed to the six calls this app makes.
 *
 * Signing in is not part of the openharness protocol — it is Better Auth's `/api/auth/*`
 * surface mounted in the server (epic #65, A1) — so this module wraps `better-auth/client`
 * with the device-authorization plugin, against the same origin as the API (or the server
 * URL from the settings, when one is configured). The session it creates is a cookie (A2):
 * nothing here ever sees or stores a token, and every later request is the API client's
 * `credentials: 'include'`.
 *
 * The wrapper is deliberately small and explicitly typed. Better Auth's client methods are
 * inferred from a server type this app does not have (the server is a sibling app, not an
 * import), and a typed seam of our own keeps the rest of the app away from that inference —
 * and gives the tests one module boundary to mock.
 *
 * ```ts
 * auth.signInWithProvider('google', callbackURL) // -> leaves for Google, returns to callbackURL
 * auth.signInWithEmail('dev@localhost', 'dev')   // the dev form (A7), only when dev_login
 * auth.signOut()                                 // revokes this browser's session
 * auth.verifyDeviceCode('WXYZ-1234')             // the device approval page (A6), step 1
 * auth.approveDeviceCode('WXYZ-1234')            // ... step 2: approve
 * auth.denyDeviceCode('WXYZ-1234')               // ... or deny
 * ```
 */

/** What a Better Auth call reports: a message when it failed, `null` when it worked. */
export interface AuthCallOutcome {
  /** The server's own message, or `null` when the call succeeded. */
  readonly error: string | null
  /**
   * The HTTP status behind the message, when there was one.
   *
   * The device page reads it: a 401 there is a dead session, which is worth signing in again
   * for, where every other failure is a code the server would not take.
   */
  readonly httpStatus: number | null
}

/** The device-authorization status Better Auth answers the verification with. */
export const DEVICE_CODE_STATUSES = ['pending', 'approved', 'denied'] as const

export type DeviceCodeStatus = (typeof DEVICE_CODE_STATUSES)[number]

/** What verifying a user code found. */
export interface DeviceCodeVerification extends AuthCallOutcome {
  /** The pending code's status, or `null` when verification failed. */
  readonly codeStatus: DeviceCodeStatus | null
}

/** The Better Auth calls this app makes. */
export interface BrowserAuthClient {
  /**
   * Start a social sign-in. On success the browser leaves for the provider and comes back to
   * `callbackURL`; the cookie is set on the way through.
   */
  signInWithProvider(provider: AuthProvider, callbackURL: string): Promise<AuthCallOutcome>

  /** The dev-only email/password sign-in (A7). */
  signInWithEmail(email: string, password: string): Promise<AuthCallOutcome>

  /** Revoke this browser's session. */
  signOut(): Promise<AuthCallOutcome>

  /**
   * Verify a device user code and bind it to this browser's session, which is what makes it
   * approvable. Signed in only.
   */
  verifyDeviceCode(userCode: string): Promise<DeviceCodeVerification>

  /** Approve the device login the user code belongs to. */
  approveDeviceCode(userCode: string): Promise<AuthCallOutcome>

  /** Deny the device login the user code belongs to. */
  denyDeviceCode(userCode: string): Promise<AuthCallOutcome>
}

/**
 * The slice of Better Auth's client this app uses, spelled out.
 *
 * The library infers its methods from the server's own types; without those, this is the
 * contract, and {@link createBrowserAuthClient} is the one place that asserts Better Auth
 * satisfies it.
 */
interface RawAuthClient {
  signIn: {
    social(input: { provider: AuthProvider; callbackURL: string }): Promise<RawCallResult>
    email(input: { email: string; password: string }): Promise<RawCallResult>
  }
  signOut(): Promise<RawCallResult>
  device: {
    (input: { query: { user_code: string } }): Promise<RawCallResult<{ status?: unknown }>>
    approve(input: { userCode: string }): Promise<RawCallResult>
    deny(input: { userCode: string }): Promise<RawCallResult>
  }
}

/** A Better Auth client answer: `data` on success, `error` with the failure on failure. */
interface RawCallResult<T = unknown> {
  readonly data?: T | null | undefined
  readonly error?: RawCallError | null | undefined
}

/**
 * A failed call, as Better Auth's client reports it.
 *
 * The library folds the response body into the error, so the device endpoints'
 * `{"error":"invalid_request","error_description":"Invalid user code"}` arrives as fields
 * beside `status` — which is why `message` alone cannot be the thing this app reads.
 */
interface RawCallError {
  readonly message?: string | undefined
  readonly status?: number | undefined
  /** The OAuth-style error code, when the body carried one. */
  readonly error?: unknown
  /** The code's human explanation, when the body carried one. */
  readonly error_description?: unknown
  /**
   * The wait a rate-limit answer asks for, in seconds, when a body carries it. Better Auth's
   * own rate limiter sends it as the `X-Retry-After` header instead, which its client does
   * not surface — so in practice the rate-limit sentence is the whole message.
   */
  readonly retry_after?: unknown
  readonly retryAfter?: unknown
}

/**
 * Build the browser's auth client.
 *
 * @param serverUrl the configured server URL; empty means the page's own origin, which Better
 *   Auth's own default (`/api/auth`, relative) already is.
 */
export function createBrowserAuthClient(serverUrl: string): BrowserAuthClient {
  const url = serverUrl.trim()
  const raw = createAuthClient({
    ...(url === '' ? {} : { baseURL: url }),
    plugins: [deviceAuthorizationClient()],
  }) as unknown as RawAuthClient

  return {
    async signInWithProvider(provider, callbackURL) {
      const { error, httpStatus } = await callResult(() =>
        raw.signIn.social({ provider, callbackURL }),
      )
      return { error, httpStatus }
    },

    async signInWithEmail(email, password) {
      const { error, httpStatus } = await callResult(() => raw.signIn.email({ email, password }))
      return { error, httpStatus }
    },

    async signOut() {
      const { error, httpStatus } = await callResult(() => raw.signOut())
      return { error, httpStatus }
    },

    async verifyDeviceCode(userCode) {
      const { data, error, httpStatus } = await callResult(() =>
        raw.device({ query: { user_code: userCode } }),
      )
      return error === null
        ? { error: null, httpStatus: null, codeStatus: deviceStatus(data?.status) }
        : { error, httpStatus, codeStatus: null }
    },

    async approveDeviceCode(userCode) {
      const { error, httpStatus } = await callResult(() => raw.device.approve({ userCode }))
      return { error, httpStatus }
    },

    async denyDeviceCode(userCode) {
      const { error, httpStatus } = await callResult(() => raw.device.deny({ userCode }))
      return { error, httpStatus }
    },
  }
}

/** A call's data, error and status, with a thrown failure reported like a returned one. */
async function callResult<T>(
  call: () => Promise<RawCallResult<T>>,
): Promise<{ data: T | null; error: string | null; httpStatus: number | null }> {
  try {
    const result = await call()
    if (result.error != null) {
      const httpStatus = typeof result.error.status === 'number' ? result.error.status : null
      return { data: null, error: describeError(result.error, httpStatus), httpStatus }
    }
    return { data: result.data ?? null, error: null, httpStatus: null }
  } catch (caught) {
    return {
      data: null,
      error: describeError({ message: caught instanceof Error ? caught.message : undefined }, null),
      httpStatus: null,
    }
  }
}

/** What a failure says when neither the server nor the transport gave a reason. */
const GENERIC_FAILURE = 'The sign-in request failed.'

/**
 * The message to show for a failed call.
 *
 * Better Auth's sign-in endpoints answer with a `message`, which is shown as-is. The device
 * endpoints (A6) answer with the OAuth pair `{"error": …, "error_description": …}` instead —
 * a shape with no `message` — so the codes a reader can act on are mapped to a sentence here,
 * and everything else falls back, in order, to the server's own words: `message`, then
 * `error_description`, then the bare code, then {@link GENERIC_FAILURE}.
 */
function describeError(failure: RawCallError, httpStatus: number | null): string {
  if (httpStatus === 429) {
    const seconds = retryAfterSeconds(failure)
    return seconds === null
      ? 'Too many requests — wait a moment and try again.'
      : `Too many requests — try again in ${seconds} seconds.`
  }

  const code = textOf(failure.error)
  const description = textOf(failure.error_description)

  if (code === 'expired_token') {
    return 'This code has expired. Run `oh login` again for a fresh one.'
  }
  if (code === 'access_denied') {
    return 'The server refused this request. Run `oh login` again to start over.'
  }
  // `invalid_request` is the device endpoints' 400 for a code this server never issued — but
  // approve and deny also answer it for a code that was already decided or claimed by
  // someone else's session, and those refusals keep their description. Only the "invalid user
  // code" form (the code, the description, or both) is the reader's mistake, and gets the
  // sentence that says so.
  if (isInvalidUserCode(description) || (code === 'invalid_request' && description === null)) {
    return 'This code is not one this server issued. Check it against your terminal, or run `oh login` again.'
  }

  return failure.message ?? description ?? code ?? GENERIC_FAILURE
}

/** A string when the body carried a usable one, `null` otherwise. */
function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Whether a description is the device flow's own words for a code it does not know. */
function isInvalidUserCode(description: string | null): boolean {
  return description !== null && /invalid user code/i.test(description)
}

/** The wait a rate-limit answer asked for, in whole seconds, when it named one. */
function retryAfterSeconds(failure: RawCallError): number | null {
  const raw = failure.retry_after ?? failure.retryAfter
  const seconds = typeof raw === 'string' ? Number(raw) : raw
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds)
    : null
}

/** The status the verification answered with, or `null` for anything unrecognized. */
function deviceStatus(value: unknown): DeviceCodeStatus | null {
  return DEVICE_CODE_STATUSES.find((status) => status === value) ?? null
}
