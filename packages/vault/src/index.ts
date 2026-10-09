/**
 * `@openharness/vault` — envelope encryption for user secrets (epic #65, decision A5).
 *
 * The server seals a provider credential with a fresh AES-256-GCM data key, wraps that key
 * with the master key and stores the {@link SealedSecret}; to make one model request it seals
 * nothing, it opens that row and keeps the plaintext for the request only. The master key
 * comes from one of two providers (#150, decision D6): {@link envKeyProvider} reads it from
 * `OPENHARNESS_SECRETS_KEY` (local development), and {@link gcpKmsKeyProvider} keeps it in
 * Cloud KMS (staging and production), loading the KMS client only when the provider is
 * actually used. Beside every wrapped data key the vault records which provider and which key
 * wrapped it, so a provider mismatch is refused with a clear error instead of a decryption
 * failure.
 *
 * The package is pure with one deliberate exception: the local path is `node:crypto` and
 * nothing else, and `@google-cloud/kms` is imported dynamically, on the first Cloud KMS
 * call, so a `local` deployment never loads it. No database, no state beyond the vault's
 * bounded in-memory cache of unwrapped data keys, no logging, and no other `@openharness/*`
 * package.
 */

export { VaultDecryptionError, VaultError, VaultKeyError } from './errors'
export { LOCAL_KEY_PROVIDER, envKeyProvider } from './keys'
export type { KeyEncryptionKeyProvider, WrappedKeyMeta } from './keys'
export { GCP_KMS_PROVIDER, gcpKmsKeyProvider } from './kms'
export type { GcpKmsKeyProviderOptions, KmsClient } from './kms'
export { DEFAULT_KEY_CACHE_MAX_ENTRIES, DEFAULT_KEY_CACHE_TTL_MS, createVault } from './vault'
export type { SealedSecret, Vault, VaultOptions } from './vault'
