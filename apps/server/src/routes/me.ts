import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  GetMeResponseSchema,
  PutPreferencesRequestSchema,
  type GetMeResponse,
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
 * `GET`/`PUT /v1/me/preferences` are the caller's stored settings (epic #116, U1): the
 * `default_model` a new chat starts with, read and written whole. Both are owner-only — the
 * resource is the caller, there is no id in the path to get wrong — and the `PUT` body's
 * `default_model` is shape-checked by the protocol's `DEFAULT_MODEL_PATTERN`, so a malformed
 * router id is the 400 `invalid_request_error` any bad body is.
 *
 * `GET /v1/auth-config` is the one unauthenticated `/v1` route, and the interface agreed with
 * the web app (#62): it reads it *before* sign-in to know which buttons to show. It is
 * registered before the auth guard in `app.ts`, so it never runs behind it.
 */
export function registerMeRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  app.get(`${API_VERSION_PREFIX}/me`, (c) => c.json(currentUser(c)))

  app.get(`${API_VERSION_PREFIX}/me/preferences`, async (c) =>
    c.json(await deps.store.getPreferences(c.get('user').id)),
  )

  app.put(`${API_VERSION_PREFIX}/me/preferences`, async (c) => {
    const body = await parseBody(c, PutPreferencesRequestSchema)
    const userId = c.get('user').id
    const stored = await deps.store.putPreferences(userId, body)
    // Whatever is stored now is the user's own choice (epic #116, U4), so the automatic
    // default must never re-pick it out from under them.
    deps.defaultModel.markExplicit(userId)
    return c.json(stored)
  })

  app.get(`${API_VERSION_PREFIX}/auth-config`, (c) =>
    c.json({
      providers: deps.auth.enabledProviders,
      dev_login: deps.auth.devLogin,
    }),
  )
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
