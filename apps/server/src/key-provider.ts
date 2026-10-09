import { createVault, envKeyProvider, gcpKmsKeyProvider, type Vault } from '@openharness/vault'

import { ENV_VARS, type ServerConfig } from './config'

/**
 * The vault the configuration asks for (#150, deployment epic #148 decision D6).
 *
 * One place — here — turns `OPENHARNESS_KEY_PROVIDER` into the vault every credential path in
 * the server uses: the routes that seal a saved key, the per-request resolver, and the model
 * catalogue. The provider is constructed from the key the configuration already validated, so
 * the two cannot disagree about which key a process runs with.
 *
 * `gcp-kms` builds a provider whose Cloud KMS client is loaded lazily, on the first wrap or
 * unwrap: a server configured for it does not reach KMS (or load `@google-cloud/kms`) until a
 * credential is actually sealed or opened, and a `local` server never loads it at all.
 *
 * A `local` vault keeps unwrapped data keys for `OPENHARNESS_KEY_CACHE_TTL_MS` (a few
 * minutes by default) so a model request does not re-wrap for every turn; `0` disables the
 * cache. The vault caches data keys only — never a plaintext, never the master key.
 *
 * @throws Error when the configuration is inconsistent — the case `readServerConfig` already
 *   refuses at boot, restated here so this function can never build a half-configured vault
 *   even when handed a hand-made `ServerConfig`
 */
export function createConfigVault(config: ServerConfig): Vault {
  const options = { keyCacheTtlMs: config.keyCacheTtlMs }
  if (config.keyProvider === 'gcp-kms') {
    if (config.kmsKey === undefined) {
      throw new Error(
        `${ENV_VARS.keyProvider}=gcp-kms requires ${ENV_VARS.kmsKey} to be set: ` +
          'a Cloud KMS key resource name, e.g. ' +
          'projects/<project>/locations/<location>/keyRings/<ring>/cryptoKeys/<key>',
      )
    }
    return createVault(gcpKmsKeyProvider({ key: config.kmsKey }), options)
  }
  if (config.secretsKey === undefined) {
    throw new Error(
      `${ENV_VARS.keyProvider}=local requires ${ENV_VARS.secretsKey} to be set: ` +
        'the base64 32-byte vault key (`openssl rand -base64 32`)',
    )
  }
  return createVault(envKeyProvider(config.secretsKey), options)
}
