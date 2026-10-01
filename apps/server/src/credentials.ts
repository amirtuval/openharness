import {
  ApiKeyProviderCredentialSchema,
  type ProviderCredential,
  type SessionId,
} from '@openharness/protocol'
import type { ModelCredential } from '@openharness/brain'
import type {
  CredentialStore,
  SealedProviderCredential,
  SessionStore,
  UpsertCredentialInput,
} from '@openharness/session'
import type { SealedSecret, Vault } from '@openharness/vault'

import type { Logger } from './types'

/**
 * Users' provider credentials, server-side (epic #65, A5): where they are sealed, opened and
 * turned into the credential one model request runs under.
 *
 * The two halves are deliberately in one module, because they must agree on the associated
 * data: a credential is sealed with AAD `userId|provider` and can only be opened with the
 * same two values, so a database row moved to another user (or another provider) does not
 * decrypt at all. The store half lives in `@openharness/session` and never sees a plaintext;
 * this half never sees the database.
 */

/** The AAD a credential is bound to: its owner and its provider, and nothing else. */
export function credentialAad(userId: string, provider: string): string {
  return `${userId}|${provider}`
}

/** What a PUT seals: the protocol's `api_key` payload, as the JSON a vault opens later. */
export function apiKeyPayload(apiKey: string): string {
  const payload = { type: 'api_key', api_key: apiKey }
  return JSON.stringify(ApiKeyProviderCredentialSchema.parse(payload))
}

/** The last four characters of a secret, for the settings screen's recognition only. */
export function lastFour(secret: string): string {
  return secret.slice(-4)
}

/**
 * Seal a key for storage: the vault's envelope, bound to this owner and provider.
 *
 * The returned {@link SealedSecret} is what the `CredentialStore` writes down; the plaintext
 * exists only inside this call.
 */
export async function sealApiKey(
  vault: Vault,
  input: { userId: string; provider: string; apiKey: string },
): Promise<SealedSecret> {
  return vault.seal(apiKeyPayload(input.apiKey), credentialAad(input.userId, input.provider))
}

/** The `CredentialStore` input a sealed key becomes, timestamps included. */
export function credentialUpsert(
  input: { userId: string; provider: string; apiKey: string },
  sealed: SealedSecret,
  validatedAt: string,
): UpsertCredentialInput {
  return {
    userId: input.userId,
    provider: input.provider,
    type: 'api_key',
    sealed: { ...sealed },
    last4: lastFour(input.apiKey),
    validatedAt,
  }
}

/**
 * Open a stored credential back into the one plaintext field a request needs.
 *
 * Every failure — a tampered blob, a row for another user or provider, an unknown key
 * version, a payload that is not an `api_key` — answers `null`, which the brain turns into its
 * `missing_provider_credential` ending. The reason is deliberately not distinguished: an
 * error message is the place a secret would leak, and the caller cannot act on it anyway.
 */
export async function openApiKey(
  vault: Vault,
  input: { userId: string; provider: string; sealed: SealedSecret },
): Promise<string | null> {
  let plaintext: string
  try {
    plaintext = await vault.open(input.sealed, credentialAad(input.userId, input.provider))
  } catch {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(plaintext)
  } catch {
    return null
  }
  const parsed = ApiKeyProviderCredentialSchema.safeParse(payload)
  return parsed.success ? parsed.data.api_key : null
}

/**
 * Where a session's model requests get their credential (A5): bound to a session, because
 * that is how the brain asks (`ResolveCredential` is `(provider) => …`).
 *
 * The lookup is: the session's owner (unscoped — a turn acts for a session, not for a user),
 * that owner's stored credential for the provider, opened with the vault for this request
 * only. Nothing is cached: the credential lives as long as the request the brain makes with
 * it.
 */
export type ResolveSessionCredential = (
  sessionId: SessionId,
  provider: string,
) => Promise<ModelCredential | null>

/** What {@link createSessionCredentialResolver} reads from. */
export interface CredentialResolverDeps {
  /** The log: a session id answers whose session it is. */
  readonly store: Pick<SessionStore, 'getSessionUnscoped'>
  /** The sealed credentials. */
  readonly credentials: Pick<CredentialStore, 'get'>
  /** The vault that opens them. */
  readonly vault: Vault
  /** Where a refusal is explained — provider and session only, never a secret. */
  readonly logger?: Logger
}

/** Build the resolver a scheduler hands to the brain. */
export function createSessionCredentialResolver(
  deps: CredentialResolverDeps,
): ResolveSessionCredential {
  return async (sessionId, provider) => {
    const session = await deps.store.getSessionUnscoped(sessionId)
    if (session === null) {
      return null
    }
    const userId = session.owner_id
    const stored: SealedProviderCredential | null = await deps.credentials.get({
      userId,
      provider,
    })
    if (stored === null) {
      return null
    }
    const apiKey = await openApiKey(deps.vault, { userId, provider, sealed: stored.sealed })
    if (apiKey === null) {
      deps.logger?.warn(
        `the stored ${provider} credential for session ${sessionId} could not be opened; ` +
          'the turn will end with missing_provider_credential',
      )
      return null
    }
    return { apiKey }
  }
}

/** What `GET /v1/provider-credentials` and a PUT's response carry: metadata, never a key. */
export type { ProviderCredential }
