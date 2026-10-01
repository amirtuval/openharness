import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { decodeBase64 } from './base64'
import { VaultKeyError } from './errors'

/**
 * The `version` an {@link envKeyProvider} stamps on everything it wraps.
 *
 * It is stored beside a sealed secret as `kekVersion`. Rotation later means minting a
 * provider (or a provider that knows several versions) under a new name; nothing today
 * accepts a version other than this one.
 */
const ENV_KEY_VERSION = 'v1'

/** 32 bytes: the master key, and every data key it wraps (AES-256). */
const KEY_BYTES = 32
/** 12 bytes: the GCM nonce. */
const NONCE_BYTES = 12
/** 16 bytes: the GCM authentication tag. */
const TAG_BYTES = 16
/** nonce + data key + tag — the exact size of a key wrapped by an `envKeyProvider`. */
const WRAPPED_KEY_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES

/**
 * A key-encryption key (KEK): the thing that wraps and unwraps per-secret data keys. It
 * never sees a plaintext, only 32-byte data keys.
 *
 * `version` names the master key, so a sealed secret knows which key can open it. `unwrap`
 * receives the version back — the seal stored it — and throws when it does not know it;
 * `createVault`'s `open` turns any such failure into a `VaultDecryptionError`.
 *
 * `envKeyProvider` is the implementation that keeps the key in the server environment. A
 * KMS-backed one (`wrap`/`unwrap` as Encrypt/Decrypt calls, `version` as a key id) can be
 * dropped in later without touching the vault.
 */
export interface KeyEncryptionKeyProvider {
  readonly version: string
  /** Encrypts a data key under the master key. */
  wrap(dataKey: Uint8Array): Promise<Uint8Array>
  /** Decrypts a wrapped data key; `version` is the `kekVersion` recorded at seal time. */
  unwrap(wrapped: Uint8Array, version: string): Promise<Uint8Array>
}

/**
 * A {@link KeyEncryptionKeyProvider} backed by one AES-256-GCM key from the server
 * environment: `OPENHARNESS_SECRETS_KEY`, the base64 of `openssl rand -base64 32`.
 *
 * Wrapping takes a fresh 12-byte nonce and uses the version string as associated data, so a
 * blob wrapped under one version cannot be unwrapped as another. A key that is missing, is
 * not base64 or does not decode to exactly 32 bytes is rejected here, at boot, with an error
 * that names the variable and the decoded length — never the value.
 */
export function envKeyProvider(base64Key: string): KeyEncryptionKeyProvider {
  const masterKey = decodeMasterKey(base64Key)

  return {
    version: ENV_KEY_VERSION,

    // `wrap` and `unwrap` are not `async`: Node's crypto is synchronous, and the interface's
    // promise is just the seam a KMS provider will need. They still reject rather than throw.
    wrap(dataKey: Uint8Array): Promise<Uint8Array> {
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv('aes-256-gcm', masterKey, nonce)
      cipher.setAAD(Buffer.from(ENV_KEY_VERSION, 'utf8'))
      const sealed = Buffer.concat([
        nonce,
        cipher.update(dataKey),
        cipher.final(),
        cipher.getAuthTag(),
      ])
      return Promise.resolve(new Uint8Array(sealed))
    },

    unwrap(wrapped: Uint8Array, version: string): Promise<Uint8Array> {
      if (version !== ENV_KEY_VERSION) {
        return Promise.reject(
          new VaultKeyError(
            `unknown key version ${JSON.stringify(version)}: this provider wraps with version ` +
              `${JSON.stringify(ENV_KEY_VERSION)}`,
          ),
        )
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
        decipher.setAAD(Buffer.from(ENV_KEY_VERSION, 'utf8'))
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
