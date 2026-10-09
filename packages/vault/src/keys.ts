import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { decodeBase64 } from './base64'
import { VaultKeyError } from './errors'

/** The key provider `local`: the master key in `OPENHARNESS_SECRETS_KEY`. */
export const LOCAL_KEY_PROVIDER = 'local'

/**
 * The name of the local master key: the `version` an {@link envKeyProvider} stamps on
 * everything it wraps.
 *
 * It is stored beside a sealed secret as `kekVersion`. Rotation later means minting a
 * provider (or a provider that knows several keys) under a new name; the local provider
 * accepts nothing but this one.
 */
const ENV_KEY_NAME = 'v1'

/** 32 bytes: the master key, and every data key it wraps (AES-256). */
const KEY_BYTES = 32
/** 12 bytes: the GCM nonce. */
const NONCE_BYTES = 12
/** 16 bytes: the GCM authentication tag. */
const TAG_BYTES = 16
/** nonce + data key + tag — the exact size of a key wrapped by an `envKeyProvider`. */
const WRAPPED_KEY_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES

/**
 * What a sealed secret records about the key that wrapped its data key: the **provider** and
 * the provider's **name for the key** — `local` wraps with `v1`, `gcp-kms` with a Cloud KMS
 * `cryptoKeys/…` resource name.
 *
 * It is metadata and nothing else: nothing here can help decrypt anything, and a sealed
 * secret whose recorded provider does not match the one this server runs with is refused with
 * a clear error instead of a confusing decryption failure.
 */
export interface WrappedKeyMeta {
  /** The key provider's name, as `OPENHARNESS_KEY_PROVIDER` spells it: `local` or `gcp-kms`. */
  readonly provider: string
  /**
   * The provider's own identifier for the key. For `local` this is the key version (`v1`);
   * for `gcp-kms` the Cloud KMS `projects/…/cryptoKeys/…` resource name — deliberately not a
   * KMS key *version*, so rotating the version needs no data migration.
   */
  readonly key: string
}

/**
 * A key-encryption key (KEK): the thing that wraps and unwraps per-secret data keys. It
 * never sees a plaintext, only 32-byte data keys.
 *
 * `meta` names the provider and the key, so a sealed secret knows which key can open it.
 * `wrap` stamps that metadata on everything it wraps (through {@link import('./vault').createVault}),
 * and `unwrap` receives it back and throws a clear {@link VaultKeyError} when it names a
 * provider or key this one is not — that is what makes a secret wrapped under `local`
 * impossible to open under `gcp-kms` (and the reverse).
 *
 * Two implementations ship here: {@link envKeyProvider}, the local
 * `OPENHARNESS_SECRETS_KEY` provider, and `gcpKmsKeyProvider` in `kms.ts`, whose key never
 * leaves Cloud KMS.
 */
export interface KeyEncryptionKeyProvider {
  /** What every seal records, and what `unwrap` receives back. */
  readonly meta: WrappedKeyMeta
  /** Encrypts a data key under the provider's key. */
  wrap(dataKey: Uint8Array): Promise<Uint8Array>
  /** Decrypts a wrapped data key; `meta` is what was recorded at seal time. */
  unwrap(wrapped: Uint8Array, meta: WrappedKeyMeta): Promise<Uint8Array>
}

/**
 * A {@link KeyEncryptionKeyProvider} backed by one AES-256-GCM key from the server
 * environment: `OPENHARNESS_SECRETS_KEY`, the base64 of `openssl rand -base64 32`.
 *
 * Wrapping takes a fresh 12-byte nonce and uses the key name as associated data, so a blob
 * wrapped under one key cannot be unwrapped as another. A key that is missing, is not base64
 * or does not decode to exactly 32 bytes is rejected here, at boot, with an error that names
 * the variable and the decoded length — never the value.
 */
export function envKeyProvider(base64Key: string): KeyEncryptionKeyProvider {
  const masterKey = decodeMasterKey(base64Key)

  return {
    meta: { provider: LOCAL_KEY_PROVIDER, key: ENV_KEY_NAME },

    // `wrap` and `unwrap` are not `async`: Node's crypto is synchronous, and the interface's
    // promise is just the seam a KMS provider needs. They still reject rather than throw.
    wrap(dataKey: Uint8Array): Promise<Uint8Array> {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
      cipher.setAAD(Buffer.from(ENV_KEY_NAME, 'utf8'))
      const sealed = Buffer.concat([
        nonce,
        cipher.update(dataKey),
        cipher.final(),
        cipher.getAuthTag(),
      ])
      return Promise.resolve(new Uint8Array(sealed))
    },

    unwrap(wrapped: Uint8Array, meta: WrappedKeyMeta): Promise<Uint8Array> {
      if (meta.provider !== LOCAL_KEY_PROVIDER || meta.key !== ENV_KEY_NAME) {
        return Promise.reject(unknownKeyError(meta, LOCAL_KEY_PROVIDER, ENV_KEY_NAME))
      }
      if (wrapped.byteLength !== WRAPPED_KEY_BYTES) {
        return Promise.reject(
          new VaultKeyError(
            `the wrapped key must be ${WRAPPED_KEY_BYTES} bytes (nonce + data key + tag); ` +
              `it is ${wrapped.byteLength}`,
          ),
        )
      }

      try {
        const bytes = Buffer.from(wrapped)
        const decipher = createDecipheriv('aes-256-gcm', masterKey, bytes.subarray(0, NONCE_BYTES))
        decipher.setAAD(Buffer.from(ENV_KEY_NAME, 'utf8'))
        const body = bytes.subarray(NONCE_BYTES)
        decipher.setAuthTag(body.subarray(body.byteLength - TAG_BYTES))
        const dataKey = Buffer.concat([
          decipher.update(body.subarray(0, body.byteLength - TAG_BYTES)),
          decipher.final(),
        ])
        const result = new Uint8Array(dataKey)
        // The Buffer copy has served its purpose; only the caller's copy outlives this call.
        dataKey.fill(0)
        return Promise.resolve(result)
      } catch (cause) {
        return Promise.reject(
          new VaultKeyError(
            'the wrapped key cannot be unwrapped: the master key is wrong or the bytes were ' +
              'tampered with',
            { cause },
          ),
        )
      }
    },
  }
}

/**
 * The error every provider throws for metadata that names a key it does not hold.
 *
 * It names both sides — the recorded provider and key, and this provider's own — and never
 * any key material. `createVault`'s `open` turns a foreign *provider* into its own
 * `VaultKeyError` before `unwrap` is even called; this is the same check for a caller using a
 * provider directly, and the backstop for the provider half.
 */
export function unknownKeyError(
  wrappedBy: WrappedKeyMeta,
  provider: string,
  key: string,
): VaultKeyError {
  return new VaultKeyError(
    `the data key was wrapped by key provider ${JSON.stringify(wrappedBy.provider)} (key ` +
      `${JSON.stringify(wrappedBy.key)}); this provider is ${JSON.stringify(provider)} (key ` +
      `${JSON.stringify(key)})`,
  )
}

/**
 * Decodes `OPENHARNESS_SECRETS_KEY` and checks its length. Surrounding whitespace is
 * tolerated (`$(openssl rand -base64 32)` pasted into a `.env` is not always clean).
 */
function decodeMasterKey(base64Key: unknown): Buffer {
  const trimmed = typeof base64Key === 'string' ? base64Key.trim() : ''
  const key = decodeBase64(trimmed)
  if (key === undefined) {
    throw new VaultKeyError(
      'OPENHARNESS_SECRETS_KEY must be base64 (generate one with `openssl rand -base64 32`); ' +
        'the value is not valid base64',
    )
  }
  if (key.byteLength !== KEY_BYTES) {
    throw new VaultKeyError(
      `OPENHARNESS_SECRETS_KEY must decode to ${KEY_BYTES} bytes for AES-256; it decodes to ` +
        `${key.byteLength}`,
    )
  }
  return key
}
