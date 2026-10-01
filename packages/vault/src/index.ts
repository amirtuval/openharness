/**
 * `@openharness/vault` — envelope encryption for user secrets (epic #65, decision A5).
 *
 * The server seals a provider credential with a fresh AES-256-GCM data key, wraps that key
 * with the master key from `OPENHARNESS_SECRETS_KEY` and stores the {@link SealedSecret}; to
 * make one model request it seals nothing, it opens that row and keeps the plaintext for the
 * request only. The package is pure: `node:crypto`, no database, no network, no logging, no
 * other `@openharness/*` package.
 */

export { VaultDecryptionError, VaultError, VaultKeyError } from './errors'
export { envKeyProvider } from './keys'
export type { KeyEncryptionKeyProvider } from './keys'
export { createVault } from './vault'
export type { SealedSecret, Vault } from './vault'
