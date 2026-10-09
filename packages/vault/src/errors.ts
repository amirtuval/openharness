/**
 * The errors this package throws.
 *
 * Every message here is safe to show an operator, because the only thing they may ever carry
 * is metadata: which key version was involved, how many bytes a value decoded to. Never a
 * plaintext, a data key or the master key — not in the message, not in the `cause` chain,
 * not in the `stack`. Callers (the server) can branch on the class: {@link VaultKeyError}
 * means the deployment or the stored data names a key that cannot be used at all, while
 * {@link VaultDecryptionError} means this particular sealed secret did not decrypt.
 */

/** Base class for every error `@openharness/vault` throws. */
export class VaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultError'
  }
}

/**
 * A key-encryption key cannot be used: `OPENHARNESS_SECRETS_KEY` is missing, is not base64,
 * does not decode to the 32 bytes AES-256 needs, or a wrapped key names a version this
 * provider does not know.
 */
export class VaultKeyError extends VaultError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultKeyError'
  }
}

/**
 * A sealed secret cannot be opened: it was sealed under a different associated-data string,
 * its bytes were tampered with, one of its fields is malformed, or its `kekVersion` is
 * unknown. `open()` throws this for all of those, so nothing distinguishes "wrong user" from
 * "corrupted row" to a caller — and none of them carries any of the bytes involved.
 */
export class VaultDecryptionError extends VaultError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VaultDecryptionError'
  }
}
