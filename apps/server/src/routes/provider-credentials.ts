import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  PutProviderCredentialRequestSchema,
  type ProviderCredential,
} from '@openharness/protocol'
import type { CredentialStore } from '@openharness/session'

import { type Vault } from '@openharness/vault'

import { SESSION_FRESH_AGE_SECONDS } from '../auth'
import { credentialUpsert, sealApiKey } from '../credentials'
import type { ProviderCredentialValidator } from '../provider-validation'
import { authenticationError, invalidProviderCredential, invalidRequest } from '../http/errors'
import { parseBody } from '../http/request'
import type { AppEnv } from '../types'
import type { RouteDeps } from './deps'

/**
 * The provider-credential endpoints (epic #65, A5):
 *
 * ```
 * PUT    /v1/provider-credentials/{provider}   add or replace (fresh session, validated)
 * GET    /v1/provider-credentials              metadata only
 * DELETE /v1/provider-credentials/{provider}   delete   (fresh session)
 * ```
 *
 * The API is write-only: the key goes up on `PUT`, is validated with one cheap provider call,
 * is sealed with `@openharness/vault` under AAD `userId|provider`, and only metadata ever
 * comes back. No response, log line or error message anywhere on this path carries the key.
 *
 * `PUT` and `DELETE` are the sensitive actions of A2 and require a **fresh** session — one
 * created within `freshAge` — so a stolen long-lived session cannot be used to replace a
 * user's credentials; a stale one is answered 401, the same refusal as no session at all.
 *
 * Both writes also drop that provider's cached catalogue entry for the user (epic #92, C4):
 * the model list `GET /v1/models` answered was fetched with the key that just changed, so it
 * must not outlive it.
 *
 * And both writes maintain the user's automatic default model (epic #116, U4): a save picks
 * one when the user has none, a delete that removed a row re-picks or clears a default whose
 * provider just lost its key. The pick is made against the live catalog, so it happens *after*
 * the cache invalidation above; a pick that fails never fails the credential write
 * (`DefaultModelPicker`).
 */

/** What the credential routes need beyond the store: the vault and the validator. */
export interface ProviderCredentialDeps {
  /** Where sealed credentials live. */
  readonly credentials: Pick<CredentialStore, 'upsert' | 'list' | 'delete'>
  /** The vault that seals them. */
  readonly vault: Vault
  /** The one cheap provider call a save is validated with (A5). */
  readonly validate: ProviderCredentialValidator
  /** The clock, for `validated_at`; injectable for tests. */
  readonly now?: () => Date
}

/** Register the three routes. */
export function registerProviderCredentialRoutes(app: Hono<AppEnv>, deps: RouteDeps): void {
  const credentials = `${API_VERSION_PREFIX}/provider-credentials`

  app.get(credentials, async (c) => {
    const data = await deps.credentialRoutes.credentials.list({ userId: c.get('user').id })
    return c.json({ data })
  })

  app.put(`${credentials}/:provider`, async (c) => {
    requireFreshSession(c)
    const provider = providerParam(c)
    const body = await parseBody(c, PutProviderCredentialRequestSchema)
    const userId = c.get('user').id
    // One cheap provider call before anything is stored: a key the provider rejects never
    // reaches the vault (A5).
    try {
      await deps.credentialRoutes.validate(provider, body.api_key)
    } catch (error) {
      throw invalidProviderCredential(
        `the ${provider} key was rejected: ` +
          (error instanceof Error ? error.message : 'validation failed'),
      )
    }
    const sealed = await sealApiKey(deps.credentialRoutes.vault, {
      userId,
      provider,
      apiKey: body.api_key,
    })
    const now = deps.credentialRoutes.now?.() ?? new Date()
    const credential: ProviderCredential = await deps.credentialRoutes.credentials.upsert(
      credentialUpsert({ userId, provider, apiKey: body.api_key }, sealed, now.toISOString()),
    )
    // The model catalogue caches this provider's list for an hour (C4); the key behind it just
    // changed, so that cached answer is stale — drop it, here, on the instance that handled
    // the write. Other instances' entries expire by TTL.
    deps.catalog.invalidate(userId, provider)
    // A user with no default gets one now (epic #116, U4), picked from this provider's live
    // catalog — "New chat" cannot open without a model to run. An existing default is never
    // overridden while its provider still has a key.
    await deps.defaultModel.onCredentialAdded(userId, provider)
    return c.json(credential, 200)
  })

  app.delete(`${credentials}/:provider`, async (c) => {
    requireFreshSession(c)
    const provider = providerParam(c)
    const userId = c.get('user').id
    // Deleting a provider that has no credential is not an error: the caller's state is
    // "no credential for this provider" either way, and 204 says exactly that.
    const removed = await deps.credentialRoutes.credentials.delete({ userId, provider })
    // The catalogue must stop listing a provider the moment its key is gone (C4/C5).
    deps.catalog.invalidate(userId, provider)
    // A default the deleted key was carrying is re-picked from the providers that remain, or
    // cleared (epic #116, U4): the model can no longer run, and a default that cannot run is
    // worse than none — the client shows "add a key" rather than failing the first message.
    // Only a delete that removed a row is a credential deletion: one that deleted nothing
    // leaves the stored preferences exactly as they were (#139).
    if (removed) {
      await deps.defaultModel.onCredentialRemoved(userId, provider)
    }
    return c.body(null, 204)
  })
}

/** The `{provider}` path parameter: a small slug, so it cannot smuggle anything. */
function providerParam(c: Context<AppEnv>): string {
  const provider = c.req.param('provider')
  if (provider === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider)) {
    throw invalidRequest('the `provider` path parameter must be a provider name, e.g. `anthropic`')
  }
  return provider
}

/**
 * Refuse a session older than `freshAge` (A2).
 *
 * Better Auth's freshness rule, applied to the session row the auth guard resolved: a session
 * is fresh for a day after it was created, and changing credentials needs one. 401 — the
 * same answer as no session — is what the client documents for a stale one, and it is what
 * tells the web app to sign the user in again.
 */
function requireFreshSession(c: Context<AppEnv>): void {
  const createdAt = c.get('session').createdAt
  const created = createdAt instanceof Date ? createdAt.getTime() : new Date(createdAt).getTime()
  if (Date.now() - created >= SESSION_FRESH_AGE_SECONDS * 1000) {
    throw authenticationError(
      'a fresh session is required to change provider credentials; sign in again',
    )
  }
}
