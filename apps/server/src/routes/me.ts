import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  GetMeResponseSchema,
  PutPreferencesRequestSchema,
  type GetMeResponse,
  type GetPreferencesResponse,
  type UserPreferences,
} from '@openharness/protocol'

import type { AuthUser } from '../auth'
import type { AppEnv } from '../types'
import { parseBody } from '../http/request'
import type { RouteDeps } from './deps'

/**
 * Who the caller is, and what sign-in the deployment offers.
 *
 * `GET /v1/me` answers the signed-in user (the protocol's `user` resource, unwrapped):
 * identity, so a client can show who is signed in — and the id every agent and session the
 * caller creates is owned by. The identity itself is Better Auth's (A1/A3); this route is
 * only the mapping onto the protocol's shape.
 *
 * `GET`/`PUT /v1/me/preferences` are the caller's stored settings (epic #116, U1; the theme:
 * #203, epic #201 X3; the compaction controls: epic #277 C3, #282): the `default_model` a new
 * chat starts with, the colour scheme the web app paints with, and the three compaction
 * settings. Both are owner-only — the resource is the caller, there is no id in the path to
 * get wrong — and the `PUT` body's model ids are shape-checked by the protocol's
 * `DEFAULT_MODEL_PATTERN` and its numeric bounds, so a malformed id or an out-of-range share is
 * the 400 `invalid_request_error` any bad body is. The `PUT` merges the fields it is given over
 * what is stored, so the web app's theme and `oh`'s default model never clear each other.
 *
 * The response carries a `defaults` object (C3): what each `null` compaction control means,
 * which is the deployment's own trigger share and the engine's pass limit — values a client
 * cannot know. Both verbs answer the same shape, so a settings screen reads the defaults back
 * from the write it just made.
 *
 * `GET /v1/auth-config` is the one unauthenticated `/v1` route, and the interface agreed with
 * the web app (#62): it reads it *before* sign-in to know which buttons to show. It is
 * registered before the auth guard in `app.ts`, so it never runs behind it.
 */
export function registerMeRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  app.get(`${API_VERSION_PREFIX}/me`, (c) => c.json(currentUser(c)))

  app.get(`${API_VERSION_PREFIX}/me/preferences`, async (c) =>
    c.json(preferencesResponse(await deps.store.getPreferences(c.get('user').id), deps)),
  )

  app.put(`${API_VERSION_PREFIX}/me/preferences`, async (c) => {
    const body = await parseBody(c, PutPreferencesRequestSchema)
    const userId = c.get('user').id
    // A write merges (epic #201, X3): the body carries the fields to change and everything
    // else keeps its stored value, so changing the theme never clears the default model and
    // `oh default-model` — which knows nothing about themes — never clears it either. The
    // stored row is still written whole, which is the store's contract.
    const current = await deps.store.getPreferences(userId)
    const stored = await deps.store.putPreferences(userId, {
      default_model: body.default_model === undefined ? current.default_model : body.default_model,
      theme: body.theme ?? current.theme,
      compaction_threshold:
        body.compaction_threshold === undefined
          ? current.compaction_threshold
          : body.compaction_threshold,
      summary_model: body.summary_model ?? current.summary_model,
      summary_max_passes:
        body.summary_max_passes === undefined
          ? current.summary_max_passes
          : body.summary_max_passes,
    })
    // Whatever is stored now is the user's own choice (epic #116, U4), so the automatic
    // default must never re-pick it out from under them.
    deps.defaultModel.markExplicit(userId)
    return c.json(preferencesResponse(stored, deps))
  })

  app.get(`${API_VERSION_PREFIX}/auth-config`, (c) =>
    c.json({
      providers: deps.auth.enabledProviders,
      dev_login: deps.auth.devLogin,
    }),
  )
}

/**
 * The stored preferences as the protocol's response: the value, plus what each `null`
 * compaction control falls back to (epic #277, C3; #282).
 *
 * A `null` `compaction_threshold` means the deployment's own share and a `null`
 * `summary_max_passes` the engine's own limit — neither of which a client can know, so they
 * travel with the read rather than being constants there.
 */
function preferencesResponse(stored: UserPreferences, deps: RouteDeps): GetPreferencesResponse {
  return {
    ...stored,
    defaults: {
      compaction_threshold: deps.preferenceDefaults.compactionThreshold,
      summary_max_passes: deps.preferenceDefaults.summaryMaxPasses,
    },
  }
}

/** The caller as the protocol's `user` resource. */
export function currentUser(c: Context<AppEnv>): GetMeResponse {
  const user = c.get('user')
  const mapped = {
    id: user.id,
    email: user.email,
    ...optionalName(user),
    ...optionalImage(user),
    created_at: toTimestamp(user.createdAt),
  }
  return GetMeResponseSchema.parse(mapped)
}

/** `name` only when the provider gave one; Better Auth stores an empty string for none. */
function optionalName(user: AuthUser): { name?: string } {
  return user.name === undefined || user.name === '' ? {} : { name: user.name }
}

/** `image` only when there is one; Better Auth answers `null` for none. */
function optionalImage(user: AuthUser): { image?: string } {
  return typeof user.image === 'string' && user.image !== '' ? { image: user.image } : {}
}

/** A Better Auth timestamp (a `Date` or a string) as the protocol's ISO instant. */
function toTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
