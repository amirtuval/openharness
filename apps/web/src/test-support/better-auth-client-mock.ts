import { vi } from 'vitest'

/**
 * The Better Auth client, as a test double.
 *
 * Sign-in is the one thing in this app that leaves the page — a social sign-in is a redirect,
 * a dev sign-in is a call Better Auth owns — so the tests mock the library at the module
 * boundary (`vitest.setup.ts` maps `better-auth/client` and its plugin entry here) and drive
 * the calls the app makes through this object. Everything around it is the real app, against
 * the client package's fake server.
 *
 * Each function answers what Better Auth answers (`{ data, error }`) and records the call, so
 * a test can script a failure with `mockResolvedValueOnce` and assert the arguments.
 */

/** A Better Auth answer, in the shape the library uses. */
export interface AuthMockResult<T = unknown> {
  readonly data: T | null
  readonly error: AuthMockError | null
}

/**
 * The failure a scripted call answers with.
 *
 * Better Auth folds the response body into the error, so a body the device endpoints send —
 * `{"error":"invalid_request","error_description":"Invalid user code"}` — is scripted as the
 * fields it is, beside `status`.
 */
export interface AuthMockError {
  readonly message?: string | undefined
  readonly status?: number | undefined
  readonly error?: string | undefined
  readonly error_description?: string | undefined
  readonly retry_after?: number | string | undefined
}

/**
 * The client `createAuthClient()` returns, once the module is mocked.
 *
 * Behaviors are restored by {@link resetAuthClientMock}, which the setup file runs after every
 * test: the defaults are "it worked, nothing to report", so a test only writes down the call
 * it cares about.
 */
export const mockAuthClient = {
  signIn: {
    social: vi.fn(),
    email: vi.fn(),
  },
  signOut: vi.fn(),
  // `device` is callable *and* carries the plugin's `approve`/`deny`, the way the library's
  // own client shapes it.
  device: Object.assign(vi.fn(), { approve: vi.fn(), deny: vi.fn() }),
}

/** The options one `createAuthClient()` call was made with. */
export interface AuthClientOptions {
  /** The server the sign-in surface points at; absent means the page's own origin. */
  readonly baseURL?: string | undefined
  /** The plugin factories the client was built with. */
  readonly plugins?: readonly unknown[]
}

/**
 * What every `createAuthClient()` call was constructed with, oldest first, reset with the
 * rest of the double.
 *
 * The double used to ignore its argument, which left "sign-in and the API point at the same
 * server" (`App.tsx`) unasserted — the app passes the same `settings.serverUrl` to both, and
 * this is where a test can see what it actually handed Better Auth (#105, P2).
 */
export const authClientCalls: AuthClientOptions[] = []

/** Put every scripted behavior back to its default. */
export function resetAuthClientMock(): void {
  authClientCalls.length = 0
  mockAuthClient.signIn.social.mockReset().mockResolvedValue({ data: {}, error: null })
  mockAuthClient.signIn.email.mockReset().mockResolvedValue({ data: {}, error: null })
  mockAuthClient.signOut.mockReset().mockResolvedValue({ data: { success: true }, error: null })
  mockAuthClient.device.mockReset().mockResolvedValue({ data: { status: 'pending' }, error: null })
  mockAuthClient.device.approve
    .mockReset()
    .mockResolvedValue({ data: { success: true }, error: null })
  mockAuthClient.device.deny.mockReset().mockResolvedValue({ data: { success: true }, error: null })
}

resetAuthClientMock()

/**
 * What `better-auth/client` exports, with the plugin entry's `deviceAuthorizationClient`.
 *
 * The plugin factory is a stand-in: nothing in the app reads the plugin object, only the
 * methods it registers — and those are on {@link mockAuthClient}. The construction options are
 * recorded on {@link authClientCalls} rather than interpreted.
 */
export function createAuthClient(options: AuthClientOptions = {}): typeof mockAuthClient {
  authClientCalls.push(options)
  return mockAuthClient
}

export function deviceAuthorizationClient(): { id: string } {
  return { id: 'device-authorization' }
}
