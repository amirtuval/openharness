import type { SessionStore } from '@openharness/session'

import type { SocialProviderName } from '../auth-profile'
import type { SessionScheduler } from '../scheduler'
import type { ProviderCredentialDeps } from './provider-credentials'

/**
 * What every route needs: the log, the thing that runs the brains working on it, and what
 * this deployment offers for sign-in.
 *
 * Routes never run a turn themselves. They append and they {@link SessionScheduler.signal},
 * which is the seam that lets a single-instance server and a multi-instance one (#11) share
 * the same handlers.
 */
export interface RouteDeps {
  /** The durable session log. */
  readonly store: SessionStore
  /** Who runs a session's brain when the API says it needs one. */
  readonly scheduler: SessionScheduler
  /** The sign-in this deployment offers; `/v1/auth-config` reports it unauthenticated. */
  readonly auth: AuthDeps
  /** The vault, the sealed-credential store and the validator the credential routes use. */
  readonly credentialRoutes: ProviderCredentialDeps
  /** The SSE keepalive interval; tests shorten it. */
  readonly sseKeepaliveMs?: number
}

/** The auth surface the routes read (the guard in `app.ts` gets the Better Auth instance). */
export interface AuthDeps {
  /** The social providers whose credentials are configured, in protocol order. */
  readonly enabledProviders: readonly SocialProviderName[]
  /** `OPENHARNESS_DEV_LOGIN=1`: whether the dev login is on. */
  readonly devLogin: boolean
}
