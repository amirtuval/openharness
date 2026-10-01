import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { decodeBase64 } from './base64'
import { VaultDecryptionError } from './errors'
import type { KeyEncryptionKeyProvider } from './keys'

/** 32 bytes: 256-bit data keys. */
const DATA_KEY_BYTES = 32
/** 12 bytes: the GCM nonce. */
const NONCE_BYTES = 12
/** 16 bytes: the GCM authentication tag. */
const TAG_BYTES = 16

/**
 * The sealed form of one secret: everything needed to recover the plaintext, and nothing
 * that reveals it. Every field is a string, so the whole object is a database row — columns
 * or one JSON value — with no binary and no key material in it.
 */
export interface SealedSecret {
  /** AES-256-GCM ciphertext of the plaintext, with the 16-byte authentication tag appended. */
  readonly ciphertext: string
  /** The 12-byte GCM nonce. Not secret, but fresh for every seal and never reused. */
  readonly nonce: string
  /** The per-secret 32-byte data key, itself encrypted under the master key. */
  readonly wrappedKey: string
  /** The version of the {@link KeyEncryptionKeyProvider} that wrapped `wrappedKey`. */
  readonly kekVersion: string
}

/**
 * Envelope encryption for user secrets.
 *
 * `seal` draws a fresh random 32-byte data key and a 12-byte nonce, encrypts the plaintext
 * with AES-256-GCM under that data key, and asks the key provider to wrap the data key with
 * the master key. `open` is the exact reverse. Nothing here talks to a database or a network,
 * and nothing here ever logs: the vault hands the server a {@link SealedSecret} to store and
 * a plaintext to use, and keeps nothing.
 */
export interface Vault {
  /**
   * Encrypts `plaintext`, binding it to `aad`.
   *
   * The output is different for every call, even for the same input: the data key and the
   * nonce are both random. `aad` is the caller's binding string — the server passes
   * `userId|provider` — and `open` must be given the same one.
   */
  seal(plaintext: string, aad: string): Promise<SealedSecret>

  /**
   * Decrypts a secret sealed with the same `aad` and a master key the provider knows.
   *
   * Rejects everything else with a {@link VaultDecryptionError}: a different `aad`, tampered
   * bytes, a malformed field, or a `kekVersion` the provider does not know.
   */
  open(sealed: SealedSecret, aad: string): Promise<string>
}

/**
 * Creates a {@link Vault} whose data keys are wrapped by `kek`.
 *
 * The vault takes the provider's `version` once, at construction: every secret it seals
 * records that version, and reopening is delegated to `kek.unwrap`, which fails for any
 * version it does not know (rotation is a later feature; see `AGENTS.md`).
 */
export function createVault(kek: KeyEncryptionKeyProvider): Vault {
  const kekVersion = kek.version

  return {
    async seal(plaintext: string, aad: string): Promise<SealedSecret> {
      const dataKey = randomBytes(DATA_KEY_BYTES)
      const nonce = randomBytes(NONCE_BYTES)
      try {
        const cipher = createCipheriv('aes-256-gcm', dataKey, nonce)
        cipher.setAAD(Buffer.from(aad, 'utf8'))
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
        const tag = cipher.getAuthTag()
        // The wrap is the one step that may leave the process (a KMS is a round trip). The
        // data key lives exactly until it returns, and is zeroed in the `finally` below.
        const wrappedKey = await kek.wrap(dataKey)
        return {
          ciphertext: Buffer.concat([ciphertext, tag]).toString('base64'),
          nonce: nonce.toString('base64'),
          wrappedKey: Buffer.from(wrappedKey).toString('base64'),
          kekVersion,
        }
      } finally {
        dataKey.fill(0)
      }
    },

    async open(sealed: SealedSecret, aad: string): Promise<string> {
      const nonce = decodeField(sealed.nonce, 'nonce')
      const ciphertext = decodeField(sealed.ciphertext, 'ciphertext')
      const wrappedKey = decodeField(sealed.wrappedKey, 'wrappedKey')
      if (nonce.byteLength !== NONCE_BYTES) {
        throw new VaultDecryptionError(
          `the sealed secret's nonce must be ${NONCE_BYTES} bytes; it is ${nonce.byteLength}`,
        )
      }
      if (ciphertext.byteLength < TAG_BYTES) {
        throw new VaultDecryptionError(
          `the sealed secret's ciphertext is shorter than its ${TAG_BYTES}-byte authentication tag`,
        )
      }

      let dataKey: Uint8Array | undefined
      try {
        // Whatever the provider throws for an unknown version, a wrong master key or tampered
        // bytes means one thing here: this sealed secret cannot be opened.
        dataKey = await kek.unwrap(wrappedKey, sealed.kekVersion)
        const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce)
        decipher.setAAD(Buffer.from(aad, 'utf8'))
        decipher.setAuthTag(ciphertext.subarray(ciphertext.byteLength - TAG_BYTES))
        const plaintext = Buffer.concat([
          decipher.update(ciphertext.subarray(0, ciphertext.byteLength - TAG_BYTES)),
          decipher.final(),
        ])
        const text = plaintext.toString('utf8')
        plaintext.fill(0)
        return text
      } catch (cause) {
        throw new VaultDecryptionError(
          'the sealed secret could not be decrypted: the associated data, the bytes or the ' +
            'key version do not match',
          { cause },
        )
      } finally {
        dataKey?.fill(0)
      }
    },
  }
}

/**
 * Decodes one base64 field of a sealed secret. Errors name the field — never the value, and
 * never any other field of the secret.
 */
function decodeField(value: unknown, field: string): Buffer {
  const bytes = decodeBase64(value)
  if (bytes === undefined) {
    throw new VaultDecryptionError(
      `the sealed secret's ${field} field is missing or not valid base64`,
    )
  }
  return bytes
}
