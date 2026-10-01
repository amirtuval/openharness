import type { Context, MiddlewareHandler, Next } from 'hono'

import type { BetterAuthInstance } from './auth'
import { authenticationError, permissionError } from './http/errors'
import type { AppEnv } from './types'

/**
 * The `/v1` authentication guard (epic #65, A2): who is calling, and how.
 *
 * Every request under `/v1` — the SSE stream and the AI SDK adapter included, because they
 * are the same routes — must carry either the web app's session cookie or the CLI's
 * `Authorization: Bearer` token. Anything else is the protocol's 401 `authentication_error`,
 * and the route never runs. `/v1/auth-config` is the one exception: the web app reads it
 * *before* sign-in (agreed with #62), so it is registered ahead of this guard.
 *
 * **CSRF.** A cookie is attached by the browser to any request any page makes, so a write
 * authenticated by cookie must additionally prove the request came from a trusted origin: the
 * `Origin` header has to be present and be `BETTER_AUTH_URL`'s origin. `Origin` cannot be
 * forged by a page — the browser sets it — and a request from another origin (or a form post,
 * which sends `Origin` too) fails. Bearer-authenticated requests do not need it: a page
 * cannot attach an `Authorization` header cross-origin without a preflight the server never
 * grants.
 */

/** The methods that change state, and so are the CSRF rule's business. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** What {@link createAuthGuard} is configured with. */
export interface AuthGuardOptions {
  /** The Better Auth instance that resolves the cookie or bearer token. */
  readonly auth: BetterAuthInstance
  /**
   * The origins a cookie-authenticated write may come from: `BETTER_AUTH_URL`'s origin.
   *
   * A value that does not parse as a URL is ignored rather than trusted.
   */
  readonly trustedOrigins: readonly string[]
}

/**
 * Build the middleware that authenticates `/v1`.
 *
 * On success the caller is on the request (`user`, `session`, `authKind`); on failure it
 * throws the protocol's 401 (or the CSRF 403), which the app's error handler renders.
 */
export function createAuthGuard(options: AuthGuardOptions): MiddlewareHandler<AppEnv> {
  const trusted = new Set(
    options.trustedOrigins.map(originOf).filter((origin): origin is string => origin !== null),
  )
  return async (c: Context<AppEnv>, next: Next) => {
    const headers = c.req.raw.headers
    const session = await options.auth.api.getSession({ headers })
    if (session === null) {
      throw authenticationError('a session cookie or bearer token is required')
    }
    const kind: 'cookie' | 'bearer' = hasBearerToken(headers) ? 'bearer' : 'cookie'
    if (kind === 'cookie' && WRITE_METHODS.has(c.req.method) && !isTrustedOrigin(c, trusted)) {
      throw permissionError(
        'a cookie-authenticated write must carry an Origin header of a trusted origin',
      )
    }
    c.set('user', session.user)
    c.set('session', session.session)
    c.set('authKind', kind)
    await next()
  }
}

/** Whether the request presents a bearer token (the CLI's form). */
export function hasBearerToken(headers: Headers): boolean {
  const authorization = headers.get('authorization')
  return authorization !== null && authorization.toLowerCase().startsWith('bearer ')
}

/**
 * Whether a cookie-authenticated write comes from a trusted origin.
 *
 * The header has to be present at all: a same-origin `fetch` from a browser always sends it
 * for these methods, so its absence means the request did not come from the app's own page.
 */
function isTrustedOrigin(c: Context<AppEnv>, trusted: ReadonlySet<string>): boolean {
  const origin = c.req.header('origin')
  if (origin === undefined) {
    return false
  }
  const normalized = originOf(origin)
  return normalized !== null && trusted.has(normalized)
}

/** A URL's origin in the canonical spelling (`https://host:port`), or `null`. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value)
    return url.origin
  } catch {
    return null
  }
}
