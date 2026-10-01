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

/** A Better Auth client answer: `data` on success, `error` with a message on failure. */
interface RawCallResult<T = unknown> {
  readonly data?: T | null | undefined
  readonly error?:
    | { readonly message?: string | undefined; readonly status?: number | undefined }
    | null
    | undefined
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
      return {
        data: null,
        error: describeError(result.error.message),
        httpStatus: typeof result.error.status === 'number' ? result.error.status : null,
      }
    }
    return { data: result.data ?? null, error: null, httpStatus: null }
  } catch (caught) {
    return {
      data: null,
      error: describeError(caught instanceof Error ? caught.message : undefined),
      httpStatus: null,
    }
  }
}

/** The message to show for a failed call: the server's, or a stand-in when it gave none. */
function describeError(message: string | undefined): string {
  return message !== undefined && message !== '' ? message : 'The sign-in request failed.'
}

/** The status the verification answered with, or `null` for anything unrecognized. */
function deviceStatus(value: unknown): DeviceCodeStatus | null {
  return DEVICE_CODE_STATUSES.find((status) => status === value) ?? null
}
