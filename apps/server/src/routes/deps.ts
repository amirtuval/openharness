import type { ToolRegistry } from '@openharness/hands'
import type { SessionStore } from '@openharness/session'

import type { SocialProviderName } from '../auth-profile'
import type { ModelCatalog } from '../catalog/catalog'
import type { UsageReader } from '../usage'
import type { DefaultModelPicker } from '../default-model'
import type { SessionScheduler } from '../scheduler'
import type { SessionRevocations } from '../session-watch'
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
  /**
   * The model catalogue (epic #92): `GET /v1/models`, and the hook a saved or deleted
   * credential drops that provider's cached answer with (C4).
   */
  readonly catalog: Pick<ModelCatalog, 'list' | 'invalidate'>
  /**
   * The automatic default model (epic #116, U4): the credential routes let it set, re-pick or
   * clear a user's default, and the preferences route tells it a choice was the user's own.
   */
  readonly defaultModel: DefaultModelPicker
  /**
   * What a session and a user spent (epic #245, A2; issue #247): the two usage routes read the
   * log through this, and it holds the model catalog's prices.
   */
  readonly usage: UsageReader
  /**
   * What a preference of `null` falls back to, for `GET`/`PUT /v1/me/preferences` to report as
   * its `defaults` (epic #277, C3; #282): the deployment's compaction trigger share, and the
   * engine's own summary pass limit. The stored row holds `null` for "follow the default", so
   * a client cannot know either value on its own.
   */
  readonly preferenceDefaults: PreferenceDefaults
  /**
   * The tools this process registers (epic #303, X4; issue #307), or `undefined` for a
   * deployment that registers none. `GET`/`PUT /v1/me/tools` read it: the listing is the
   * registered tools with a user's choices over them, and a stored setting for a tool that is
   * not here is listed as unavailable. It is the same registry a turn is handed
   * (`createTurnRegistry`), so "available" and "a chat can call it" are the same fact.
   */
  readonly tools: ToolRegistry | undefined
  /** The SSE keepalive interval; tests shorten it. */
  readonly sseKeepaliveMs?: number
  /** The re-check interval of the long-lived routes (A2/#76); tests shorten it. */
  readonly sessionRecheckMs?: number
  /** The open responses a session revocation closes (A2/#76). */
  readonly revocations: SessionRevocations
  /**
   * Re-validate the session behind a long-lived response (A2/#76): whether the row still
   * exists and has not expired, read from the caller's own request headers. Wired to Better
   * Auth in `app.ts`.
   */
  readonly revalidateSession: (headers: Headers) => Promise<boolean>
}

/**
 * The defaults the preferences routes report (epic #277, C3; #282): camelCase here, mapped to
 * the protocol's `defaults` object at the route.
 */
export interface PreferenceDefaults {
  /** The server's own trigger share (`OPENHARNESS_COMPACTION_THRESHOLD`). */
  readonly compactionThreshold: number
  /** The engine's own summary pass limit. */
  readonly summaryMaxPasses: number
}

/** The auth surface the routes read (the guard in `app.ts` gets the Better Auth instance). */
export interface AuthDeps {
  /** The social providers whose credentials are configured, in protocol order. */
  readonly enabledProviders: readonly SocialProviderName[]
  /** `OPENHARNESS_DEV_LOGIN=1`: whether the dev login is on. */
  readonly devLogin: boolean
}
