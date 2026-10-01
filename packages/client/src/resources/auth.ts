import type { RequestOptions } from '../client'
import { ResponseValidationError, apiErrorFromResponse } from '../errors'
import type { ResponseSchema, Transport } from '../http'
import { sleep } from '../internal/async'

/**
 * Signing the CLI in: the device-code flow and session revocation, over Better Auth's
 * `/api/auth/*` surface (epic #65, A1 and A6).
 *
 * This is not part of the `/v1` protocol — it is Better Auth's own API, which the server
 * mounts under `/api/auth` — so the endpoints below are Better Auth's device-authorization
 * plugin as documented, RFC 8628:
 *
 * ```
 * POST /api/auth/device/code    start   -> the codes and where to approve them
 * POST /api/auth/device/token   poll    -> the session token, or a polling error
 * POST /api/auth/sign-out       revoke  -> ends the session the caller presented
 * ```
 *
 * The flow from the CLI's point of view: {@link AuthResource.startDeviceLogin} gets the codes,
 * the user approves them in a browser, and {@link AuthResource.pollDeviceLogin} polls until
 * they do. The token that comes out is an opaque session token — the same kind of session a
 * cookie holds (A2) — which the CLI stores and sends as `Authorization: Bearer`.
 */

/**
 * The `client_id` `oh login` presents to the device flow.
 *
 * Better Auth hands it to the plugin's `validateClient`, and #61 registers exactly this value
 * on the server; a server that does not know it answers `invalid_grant`.
 */
export const OPENHARNESS_CLI_CLIENT_ID = 'openharness-cli'

/** Where the server mounts Better Auth (`/api/auth/device/code`, `/api/auth/sign-out`, ...). */
const AUTH_PATH_PREFIX = '/api/auth'

/** The scopes the CLI asks for; the flow is session-based, so this is simply the documented set. */
const DEVICE_LOGIN_SCOPE = 'openid profile email'

/** RFC 8628's default polling interval, in seconds, when the caller does not pass one. */
const DEFAULT_POLL_INTERVAL_SECONDS = 5

/** RFC 8628: a `slow_down` answer means the client adds five seconds to its interval. */
const SLOW_DOWN_INCREMENT_SECONDS = 5

/** A device login as {@link AuthResource.startDeviceLogin} reports it, in camelCase. */
export interface DeviceLoginStart {
  /** The code the CLI polls with — a secret; it never leaves the machine. */
  readonly deviceCode: string
  /** The short code the user compares against the browser and types when asked. */
  readonly userCode: string
  /** The page the user approves the login on. */
  readonly verificationUri: string
  /**
   * {@link verificationUri} with the user code already filled in, for opening a browser at
   * it directly. The server may omit it; the CLI then falls back to {@link verificationUri}.
   */
  readonly verificationUriComplete: string | undefined
  /** Seconds between polls; pass it to {@link AuthResource.pollDeviceLogin}. */
  readonly interval: number
  /** How long, in seconds, the codes stay valid. */
  readonly expiresIn: number
}

/** What a caller can say about a poll. */
export interface PollDeviceLoginOptions {
  /**
   * Seconds between polls — the `interval` {@link AuthResource.startDeviceLogin} returned.
   * Defaults to RFC 8628's five seconds. A `slow_down` answer raises it by five.
   */
  interval?: number | undefined
  /** Stop polling when this aborts; the promise rejects with the abort reason. */
  signal?: AbortSignal | undefined
}

/**
 * The device login ended without a token, in a way only the user can resolve.
 *
 * `authorization_pending` and `slow_down` never surface here — they are the flow working as
 * designed and the poll loop handles them. What does: the code `expired_token` (start again),
 * `access_denied` (the user said no), and the failures the server answers with instead —
 * `invalid_grant`, `invalid_client`, `invalid_request`, `server_error`.
 *
 * @example
 * ```ts
 * catch (error) {
 *   if (error instanceof DeviceLoginError && error.code === 'expired_token') retryLogin()
 * }
 * ```
 */
export class DeviceLoginError extends Error {
  /**
   * The RFC 8628 error code: `expired_token`, `access_denied`, `invalid_grant`,
   * `invalid_client`, `invalid_request` or `server_error`.
   */
  readonly code: string

  /** The server's `error_description`, when it gave one. */
  readonly description: string | undefined

  constructor(code: string, description?: string) {
    super(
      description === undefined || description === ''
        ? `The device login failed (${code}).`
        : description,
    )
    this.name = 'DeviceLoginError'
    this.code = code
    this.description = description
  }
}

/** The auth helpers of a client: device login, and signing out. */
export interface AuthResource {
  /**
   * Ask the server for a device code.
   *
   * Unauthenticated — the caller has no session yet. Show {@link DeviceLoginStart.userCode}
   * and open a browser at `verificationUriComplete ?? verificationUri`, then hand the
   * `deviceCode` to {@link AuthResource.pollDeviceLogin}.
   *
   * @param options request options (cancellation)
   */
  startDeviceLogin(options?: RequestOptions): Promise<DeviceLoginStart>

  /**
   * Poll until the user approves the device login, and return the session token.
   *
   * Waits `interval` seconds before every request (RFC 8628), continues silently on
   * `authorization_pending`, adds five seconds to the interval on `slow_down`, and throws a
   * {@link DeviceLoginError} on `expired_token`, `access_denied` and every other end that
   * needs the user. A transport failure (offline, a 5xx) throws — the caller decides whether
   * to retry.
   *
   * @param deviceCode the `deviceCode` {@link AuthResource.startDeviceLogin} returned
   * @param options the interval to poll at, and cancellation
   */
  pollDeviceLogin(deviceCode: string, options?: PollDeviceLoginOptions): Promise<string>

  /**
   * Revoke the session the client authenticated with.
   *
   * The bearer-token counterpart of the web app's sign-out: the server deletes the session
   * row, and every later request from this token answers 401. A client with no token (the web
   * app) signs out by revoking its cookie session the same way.
   *
   * @param options request options (cancellation)
   */
  signOut(options?: RequestOptions): Promise<void>
}

/** Build the auth resource over a transport. */
export function createAuthResource(transport: Transport): AuthResource {
  return {
    async startDeviceLogin(options) {
      const response = await transport.json(DEVICE_CODE_SCHEMA, {
        method: 'POST',
        path: `${AUTH_PATH_PREFIX}/device/code`,
        body: { client_id: OPENHARNESS_CLI_CLIENT_ID, scope: DEVICE_LOGIN_SCOPE },
        signal: options?.signal,
      })
      return {
        deviceCode: response.device_code,
        userCode: response.user_code,
        verificationUri: response.verification_uri,
        verificationUriComplete: response.verification_uri_complete,
        interval: response.interval,
        expiresIn: response.expires_in,
      }
    },

    async pollDeviceLogin(deviceCode, options = {}) {
      let interval = options.interval ?? DEFAULT_POLL_INTERVAL_SECONDS
      for (;;) {
        await sleep(interval * 1000, options.signal)
        options.signal?.throwIfAborted()
        const response = await transport.rawJson({
          method: 'POST',
          path: `${AUTH_PATH_PREFIX}/device/token`,
          body: {
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: deviceCode,
            client_id: OPENHARNESS_CLI_CLIENT_ID,
          },
          signal: options.signal,
        })
        if (response.status >= 200 && response.status < 300) {
          const parsed = DEVICE_TOKEN_SCHEMA.safeParse(response.body)
          if (!parsed.success) {
            throw new ResponseValidationError(
              response.status,
              'The server returned a device token response that does not match RFC 8628.',
              parsed.error.message,
            )
          }
          return parsed.data.access_token
        }
        const failure = parseDeviceError(response.body)
        if (response.status === 400 && failure !== null) {
          if (failure.error === 'authorization_pending') {
            continue
          }
          if (failure.error === 'slow_down') {
            interval += SLOW_DOWN_INCREMENT_SECONDS
            continue
          }
          throw new DeviceLoginError(failure.error, failure.error_description)
        }
        // Not the device flow's error vocabulary — a proxy, an outage, a rate limit. The
        // caller gets the same typed error any other request would produce.
        throw apiErrorFromResponse(response.status, response.body, {
          statusText: response.statusText,
          requestId: response.requestId,
        })
      }
    },

    signOut(options) {
      return transport.noContent({
        method: 'POST',
        path: `${AUTH_PATH_PREFIX}/sign-out`,
        signal: options?.signal,
      })
    },
  }
}

/** The device-code answer, as the wire spells it. */
interface DeviceCodeResponse {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string | undefined
  readonly interval: number
  readonly expires_in: number
}

/** The `{ error, error_description }` body the token endpoint answers polling errors with. */
interface DeviceTokenError {
  readonly error: string
  readonly error_description: string | undefined
}

const DEVICE_CODE_SCHEMA: ResponseSchema<DeviceCodeResponse> = {
  safeParse(value) {
    const record = asRecord(value)
    const deviceCode = record?.device_code
    const userCode = record?.user_code
    const verificationUri = record?.verification_uri
    const verificationUriComplete = record?.verification_uri_complete
    const interval = record?.interval
    const expiresIn = record?.expires_in
    if (
      typeof deviceCode !== 'string' ||
      typeof userCode !== 'string' ||
      typeof verificationUri !== 'string' ||
      (verificationUriComplete !== undefined && typeof verificationUriComplete !== 'string') ||
      typeof interval !== 'number' ||
      typeof expiresIn !== 'number'
    ) {
      return {
        success: false,
        error: { message: 'The body is not a device-code response (RFC 8628 §3.2).' },
      }
    }
    return {
      success: true,
      data: {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        verification_uri_complete: verificationUriComplete,
        interval,
        expires_in: expiresIn,
      },
    }
  },
}

const DEVICE_TOKEN_SCHEMA: ResponseSchema<{ readonly access_token: string }> = {
  safeParse(value) {
    const accessToken = asRecord(value)?.access_token
    if (typeof accessToken !== 'string' || accessToken === '') {
      return {
        success: false,
        error: { message: 'The body carries no access_token (RFC 8628 §3.5).' },
      }
    }
    return { success: true, data: { access_token: accessToken } }
  },
}

/** The polling error the body describes, or `null` when it is not one. */
function parseDeviceError(value: unknown): DeviceTokenError | null {
  const record = asRecord(value)
  const error = record?.error
  if (typeof error !== 'string') {
    return null
  }
  const description = record?.error_description
  return {
    error,
    error_description: typeof description === 'string' ? description : undefined,
  }
}

/** The value as a plain object, or `undefined` for anything else (arrays included). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
