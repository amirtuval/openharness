import type {
  ProviderCredential,
  ProviderCredentialType,
  Timestamp,
  UserId,
} from '@openharness/protocol'

/**
 * The storage contract for users' model-provider credentials (epic #65, decision A5).
 *
 * Every user brings their own provider keys. A credential is **sealed before it gets here**:
 * the server encrypts the plaintext with `@openharness/vault` and hands this store a
 * {@link SealedSecret} — the ciphertext, its nonce, the wrapped data key and the master key's
 * version — which the store writes down as it was given. The plaintext never reaches a store,
 * and this package deliberately has no dependency on the vault: the sealed shape is restated
 * here ({@link SealedSecret}) so the two are structurally interchangeable without one
 * importing the other.
 *
 * Two implementations exist: `InMemoryCredentialStore` — the test fake — and
 * `PostgresCredentialStore`, which lives behind `@openharness/session/postgres`.
 *
 * ## What every implementation must guarantee
 *
 * - **One credential per user and provider.** {@link CredentialStore.upsert} replaces the
 *   stored credential for its `(userId, provider)`: the id and `created_at` stay, everything
 *   else moves, and a second upsert for the same pair never creates a second row. Two users
 *   may each hold the same provider.
 * - **Owner-scoped.** Every method is keyed by `userId`; there is no way to read or delete a
 *   credential without naming its owner, and a credential of another user is simply not
 *   there (`null`, `false`, or missing from a list).
 * - **Metadata out, never secrets.** {@link CredentialStore.list} returns metadata only, and
 *   implementations must not even read the sealed columns for it; only
 *   {@link CredentialStore.get} hands the sealed form back, and only to the server code that
 *   opens it for one model request. No method ever returns a plaintext.
 * - **Immutable hand-outs.** What a store returns is deep-frozen, like the log's events: a
 *   sealed blob and the metadata beside it are values, and a caller that writes to one throws
 *   instead of changing what the store holds.
 * - **Cascade.** A credential belongs to its user record: deleting a `user` (Better Auth's
 *   `"user"` table) takes the user's credentials with it. In-memory stores have no users to
 *   delete, so the property is the schema's there — it is the Postgres store's foreign key.
 *
 * See `AGENTS.md` for the conformance suite both implementations pass.
 */
export interface CredentialStore {
  /**
   * Add a credential, or replace the one the same user already has for the same provider.
   *
   * The write is keyed by `(userId, provider)`, not by id: a replacement keeps the stored
   * credential's `id` and `created_at`, takes the new sealed blob, `type`, `last4` and
   * `validatedAt`, and moves `updated_at` to the clock's current instant. The answer is the
   * metadata as stored — never the secret, not even the sealed form that was just written.
   *
   * `sealed` is stored exactly as given; a store does not open it and cannot check it. The
   * caller (the server) has already validated the plaintext against the provider, and
   * `validatedAt` is the instant it did. `last4` is the last four characters of the secret,
   * for recognition only.
   */
  upsert(input: UpsertCredentialInput): Promise<ProviderCredential>

  /**
   * Read one credential **including its sealed form**, or `null` when the user has none for
   * that provider.
   *
   * This is the one read that hands the sealed blob back. It is for the server's model-call
   * path, which opens it with the vault (and the `userId|provider` associated data it was
   * sealed with) for one request; nothing else has any business calling it, and nothing may
   * log what it returns.
   */
  get(key: CredentialKey): Promise<SealedProviderCredential | null>

  /**
   * List one user's credential metadata, ordered by `provider` ascending (byte order).
   *
   * Metadata only — `id`, `type`, `provider`, `last4`, the timestamps — with no sealed field
   * in any shape. This is what the settings screen and `GET /v1/provider-credentials` show.
   * Empty, never absent, for a user who has none.
   */
  list(options: ListCredentialsOptions): Promise<ProviderCredential[]>

  /**
   * Delete the user's credential for one provider.
   *
   * @returns `true` when one was deleted, `false` when the user had none — deleting a
   *   credential that is not there is not an error
   */
  delete(key: CredentialKey): Promise<boolean>
}

/**
 * The sealed form of one secret: everything needed to recover the plaintext, and nothing
 * that reveals it.
 *
 * Structurally identical to `@openharness/vault`'s `SealedSecret` — a value sealed by the
 * vault is assignable here and vice versa — but restated in this package so that the store
 * contract does not depend on the vault. Every field is a base64 string; the store treats
 * them as opaque.
 */
export interface SealedSecret {
  /** AES-256-GCM ciphertext of the plaintext, with the 16-byte authentication tag appended. */
  readonly ciphertext: string
  /** The 12-byte GCM nonce. Not secret, but fresh for every seal and never reused. */
  readonly nonce: string
  /** The per-secret 32-byte data key, itself encrypted under the master key. */
  readonly wrappedKey: string
  /** The version of the master key that wrapped `wrappedKey`, for rotation later. */
  readonly kekVersion: string
}

/** Which user's credential a {@link CredentialStore.get} or {@link CredentialStore.delete} is about. */
export interface CredentialKey {
  /** The owner: the `user.id` Better Auth minted. */
  readonly userId: UserId
  /** The Mastra router provider the key authenticates, e.g. `anthropic`, `openai`. */
  readonly provider: string
}

/** What {@link CredentialStore.upsert} writes. */
export interface UpsertCredentialInput extends CredentialKey {
  /** The credential's form; `api_key` is the only one today. */
  readonly type: ProviderCredentialType
  /** The sealed secret, as `@openharness/vault` produced it. Stored as given, never opened. */
  readonly sealed: SealedSecret
  /** The last four characters of the plaintext secret, for recognition only. */
  readonly last4: string
  /** When the server validated the credential against the provider, on save. */
  readonly validatedAt: Timestamp
}

/** What {@link CredentialStore.list} takes. */
export interface ListCredentialsOptions {
  /** The owner whose credentials to list. */
  readonly userId: UserId
}

/**
 * A stored credential as {@link CredentialStore.get} returns it: the protocol's metadata plus
 * the sealed secret.
 *
 * This type never appears in an API response — it is what the server's model-call path reads
 * to open the credential for one request, and its `sealed` field is what must never be logged
 * or serialized outward.
 */
export interface SealedProviderCredential extends ProviderCredential {
  /** The sealed secret, exactly as {@link CredentialStore.upsert} was given it. */
  readonly sealed: SealedSecret
}
