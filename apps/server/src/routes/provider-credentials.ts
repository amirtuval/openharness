import type { Context, Hono } from 'hono'
import {
  API_VERSION_PREFIX,
  PutProviderCredentialRequestSchema,
  isReservedCredentialName,
  isValidCredentialName,
  type ProviderCredential,
  type PutProviderCredentialRequest,
} from '@openharness/protocol'
import type { CredentialStore } from '@openharness/session'

import { type Vault } from '@openharness/vault'

import { SESSION_FRESH_AGE_SECONDS } from '../auth'
import { credentialUpsert, sealCredential } from '../credentials'
import type { ProviderCredentialValidator } from '../provider-validation'
import { authenticationError, invalidProviderCredential, invalidRequest } from '../http/errors'
import { parseBody } from '../http/request'
import type { AppEnv } from '../types'
import type { RouteDeps } from './deps'

/**
 * The provider-credential endpoints (epic #65, A5; named credentials: epic #245 A3a):
 *
 * ```
 * PUT    /v1/provider-credentials/{name}   add or replace (fresh session, validated)
 * GET    /v1/provider-credentials          metadata only
 * DELETE /v1/provider-credentials/{name}   delete   (fresh session)
 * ```
 *
 * The path parameter is a credential **name**, not a provider id — and for the eleven fixed
 * providers the two are the same string, which is why the route did not change shape when
 * named credentials arrived. The name is the `provider` half of the model ids the credential
 * serves: `PUT …/anthropic` stores the Anthropic key, and `PUT …/azure-eu` stores a second
 * Azure OpenAI credential answering `azure-eu/<deployment>`. Which names a type may take is
 * checked below; the name's format is checked for every type.
 *
 * The API is write-only: the secret goes up on `PUT`, is validated with one cheap call, is
 * sealed with `@openharness/vault` under AAD `userId|name`, and only metadata ever comes back.
 * No response, log line or error message anywhere on this path carries the secret.
 *
 * `PUT` and `DELETE` are the sensitive actions of A2 and require a **fresh** session — one
 * created within `freshAge` — so a stolen long-lived session cannot be used to replace a
 * user's credentials; a stale one is answered 401, the same refusal as no session at all.
 *
 * Both writes also drop that credential's cached catalogue entry for the user (epic #92, C4):
 * the model list `GET /v1/models` answered was built from the credential that just changed, so
 * it must not outlive it.
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

  app.put(`${credentials}/:name`, async (c) => {
    requireFreshSession(c)
    const body = await parseBody(c, PutProviderCredentialRequestSchema)
    const name = credentialName(c, body)
    const userId = c.get('user').id
    // One cheap call before anything is stored: a credential the provider rejects never
    // reaches the vault (A5). Which call it is depends on the type — a provider's own list
    // for an `api_key`, one deployment for Azure — and it is the validator's to know.
    try {
      await deps.credentialRoutes.validate(name, body)
    } catch (error) {
      throw invalidProviderCredential(
        `the ${name} credential was rejected: ` +
          (error instanceof Error ? error.message : 'validation failed'),
      )
    }
    const sealed = await sealCredential(deps.credentialRoutes.vault, { userId, name, body })
    const now = deps.credentialRoutes.now?.() ?? new Date()
    const credential: ProviderCredential = await deps.credentialRoutes.credentials.upsert(
      credentialUpsert({ userId, name, body }, sealed, now.toISOString()),
    )
    // The model catalogue caches this credential's list for an hour (C4); the credential
    // behind it just changed, so that cached answer is stale — drop it, here, on the instance
    // that handled the write. Other instances' entries expire by TTL.
    deps.catalog.invalidate(userId, name)
    // A user with no default gets one now (epic #116, U4), picked from this credential's live
    // catalog — "New chat" cannot open without a model to run. An existing default is never
    // overridden while its provider still has a key.
    await deps.defaultModel.onCredentialAdded(userId, name)
    return c.json(credential, 200)
  })

  app.delete(`${credentials}/:name`, async (c) => {
    requireFreshSession(c)
    const name = deleteNameParam(c)
    const userId = c.get('user').id
    // Deleting a credential that is not there is not an error: the caller's state is
    // "no credential under this name" either way, and 204 says exactly that.
    const removed = await deps.credentialRoutes.credentials.delete({ userId, name })
    // The catalogue must stop listing a credential's models the moment it is gone (C4/C5).
    deps.catalog.invalidate(userId, name)
    // A default the deleted credential was carrying is re-picked from the credentials that
    // remain, or cleared (epic #116, U4): the model can no longer run, and a default that
    // cannot run is worse than none — the client shows "add a key" rather than failing the
    // first message. Only a delete that removed a row is a credential deletion: one that
    // deleted nothing leaves the stored preferences exactly as they were (#139).
    if (removed) {
      await deps.defaultModel.onCredentialRemoved(userId, name)
    }
    return c.body(null, 204)
  })
}

/**
 * The `{name}` path parameter for a `PUT`, checked against the payload's type.
 *
 * Two rules, and they are the same rule seen from either side: a name may be a fixed provider
 * id **or** a name the user chose, never both. An `api_key` credential is the eleven providers
 * and nothing else — one each, under their own ids — while a named type (`azure_openai`) may
 * take any legal name except one of those ids, which would make `openai/gpt-5` ambiguous
 * between the OpenAI provider and an Azure credential that called itself `openai`.
 */
function credentialName(c: Context<AppEnv>, body: PutProviderCredentialRequest): string {
  const name = c.req.param('name')
  if (name === undefined || !isValidCredentialName(name)) {
    throw invalidRequest(
      'the `name` path parameter must be a credential name: lowercase letters, digits and ' +
        'dashes, e.g. `anthropic` or `azure-eu`',
    )
  }
  if (body.type === 'api_key') {
    if (!isReservedCredentialName(name)) {
      throw invalidRequest(
        `an api_key credential is stored under a fixed provider id (` +
          `e.g. \`anthropic\`, \`openai\`), not ${JSON.stringify(name)}; a named credential ` +
          'carries its own type',
      )
    }
    return name
  }
  if (isReservedCredentialName(name)) {
    throw invalidRequest(
      `${JSON.stringify(name)} is a fixed provider id; choose another name for this credential`,
    )
  }
  return name
}

/**
 * The `{name}` path parameter for a `DELETE`.
 *
 * Only the format is checked, not the type: a delete names a credential that may not be there,
 * and the eleven provider ids are legal names for it — removing a fixed provider's credential
 * must keep working exactly as it did.
 */
function deleteNameParam(c: Context<AppEnv>): string {
  const name = c.req.param('name')
  if (name === undefined || !isValidCredentialName(name)) {
    throw invalidRequest(
      'the `name` path parameter must be a credential name: lowercase letters, digits and ' +
        'dashes, e.g. `anthropic` or `azure-eu`',
    )
  }
  return name
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
