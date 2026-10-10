import {
  PutProviderCredentialRequestSchema,
  credentialDetails,
  type ProviderCredential,
  type PutProviderCredentialRequest,
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
 * Users' provider credentials, server-side (epic #65, A5; named credentials: epic #245 A3a):
 * where they are sealed, opened and turned into the credential one model request runs under.
 *
 * The two halves are deliberately in one module, because they must agree on the associated
 * data: a credential is sealed with AAD `userId|name` and can only be opened with the same two
 * values, so a database row moved to another user (or another credential name) does not
 * decrypt at all. The store half lives in `@openharness/session` and never sees a plaintext;
 * this half never sees the database.
 *
 * A credential's **name** is the `provider` half of the model ids it serves: `anthropic` for a
 * fixed provider, `azure` or `azure-eu` for a named one. The **payload** sealed is whatever
 * the protocol's PUT body carries for its type, so adding a credential type is a schema
 * change plus the one place below that turns it into a {@link ModelCredential} — never a new
 * column.
 */

/** The AAD a credential is bound to: its owner and its name, and nothing else. */
export function credentialAad(userId: string, name: string): string {
  return `${userId}|${name}`
}

/** What a PUT seals: the protocol's request body, validated, as the JSON a vault opens later. */
export function credentialPayload(body: PutProviderCredentialRequest): string {
  return JSON.stringify(PutProviderCredentialRequestSchema.parse(body))
}

/** The last four characters of a secret, for the settings screen's recognition only. */
export function lastFour(secret: string): string {
  return secret.slice(-4)
}

/**
 * Seal a credential for storage: the vault's envelope, bound to this owner and name.
 *
 * The returned {@link SealedSecret} is what the `CredentialStore` writes down; the plaintext
 * exists only inside this call and inside the payload string the vault encrypts.
 */
export async function sealCredential(
  vault: Vault,
  input: { userId: string; name: string; body: PutProviderCredentialRequest },
): Promise<SealedSecret> {
  return vault.seal(credentialPayload(input.body), credentialAad(input.userId, input.name))
}

/** The `CredentialStore` input a sealed credential becomes, timestamps included. */
export function credentialUpsert(
  input: { userId: string; name: string; body: PutProviderCredentialRequest },
  sealed: SealedSecret,
  validatedAt: string,
): UpsertCredentialInput {
  const details = credentialDetails(input.body)
  return {
    userId: input.userId,
    name: input.name,
    type: input.body.type,
    sealed: { ...sealed },
    last4: lastFour(secretOf(input.body)),
    ...(details === undefined ? {} : { details }),
    validatedAt,
  }
}

/**
 * The secret a payload carries — what `last4` is the last four characters of.
 *
 * A custom OpenAI-compatible credential's key is optional (#249, A3b), so a keyless one stores
 * an empty `last4`: the settings list tells "no key" from a key by exactly that, and nothing
 * else about the secret is kept.
 */
function secretOf(body: PutProviderCredentialRequest): string {
  return body.api_key ?? ''
}

/**
 * Open a stored credential back into the payload it was sealed from.
 *
 * Every failure — a tampered blob, a row for another user or name, an unknown key version, a
 * payload the protocol no longer accepts — answers `null`, which the caller turns into its own
 * refusal (a missing credential for the brain, a fallback for the catalogue). The reason is
 * deliberately not distinguished: an error message is the place a secret would leak, and the
 * caller cannot act on it anyway.
 */
export async function openCredential(
  vault: Vault,
  input: { userId: string; name: string; sealed: SealedSecret },
): Promise<PutProviderCredentialRequest | null> {
  let plaintext: string
  try {
    plaintext = await vault.open(input.sealed, credentialAad(input.userId, input.name))
  } catch {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(plaintext)
  } catch {
    return null
  }
  const parsed = PutProviderCredentialRequestSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

/**
 * The credential the brain makes one model request with, from the payload a row was sealed
 * from.
 *
 * This is the whole mapping from "what a user saved" to "what the AI SDK client needs", and it
 * is total over the protocol's union: a new credential type is a new member here, and the
 * compiler says so.
 */
export function modelCredential(body: PutProviderCredentialRequest): ModelCredential {
  if (body.type === 'azure_openai') {
    return { type: 'azure_openai', apiKey: body.api_key, endpoint: body.endpoint }
  }
  if (body.type === 'openai_compatible') {
    // The key is optional (#249, A3b); a keyless endpoint is authenticated by nothing, and
    // the brain's `isUsableCredential` asks this type for a base URL rather than a key.
    return { type: 'openai_compatible', apiKey: body.api_key ?? '', baseUrl: body.base_url }
  }
  return { type: 'api_key', apiKey: body.api_key }
}

/**
 * Where a session's model requests get their credential (A5): bound to a session, because
 * that is how the brain asks (`ResolveCredential` is `(name) => …`).
 *
 * The lookup is: the session's owner (unscoped — a turn acts for a session, not for a user),
 * that owner's stored credential under that name, opened with the vault for this request only.
 * Nothing is cached: the credential lives as long as the request the brain makes with it.
 */
export type ResolveSessionCredential = (
  sessionId: SessionId,
  name: string,
) => Promise<ModelCredential | null>

/** What {@link createSessionCredentialResolver} reads from. */
export interface CredentialResolverDeps {
  /** The log: a session id answers whose session it is. */
  readonly store: Pick<SessionStore, 'getSessionUnscoped'>
  /** The sealed credentials. */
  readonly credentials: Pick<CredentialStore, 'get'>
  /** The vault that opens them. */
  readonly vault: Vault
  /** Where a refusal is explained — name and session only, never a secret. */
  readonly logger?: Logger
}

/** Build the resolver a scheduler hands to the brain. */
export function createSessionCredentialResolver(
  deps: CredentialResolverDeps,
): ResolveSessionCredential {
  return async (sessionId, name) => {
    const session = await deps.store.getSessionUnscoped(sessionId)
    if (session === null) {
      return null
    }
    const userId = session.owner_id
    const stored: SealedProviderCredential | null = await deps.credentials.get({ userId, name })
    if (stored === null) {
      return null
    }
    const body = await openCredential(deps.vault, { userId, name, sealed: stored.sealed })
    if (body === null) {
      deps.logger?.warn(
        `the stored ${name} credential for session ${sessionId} could not be opened; ` +
          'the turn will end with missing_provider_credential',
      )
      return null
    }
    return modelCredential(body)
  }
}

/** What `GET /v1/provider-credentials` and a PUT's response carry: metadata, never a secret. */
export type { ProviderCredential }
