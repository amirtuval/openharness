import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { decodeBase64 } from './base64'
import { VaultDecryptionError, VaultKeyError } from './errors'
import { type KeyEncryptionKeyProvider, LOCAL_KEY_PROVIDER, type WrappedKeyMeta } from './keys'

/** 32 bytes: 256-bit data keys. */
const DATA_KEY_BYTES = 32
/** 12 bytes: the GCM nonce. */
const NONCE_BYTES = 12
/** 16 bytes: the GCM authentication tag. */
const TAG_BYTES = 16

/**
 * How long an unwrapped data key stays cached by default: five minutes, the "few minutes" a
 * model request cadence makes worth having, short enough that a credential change or a
 * revoked key is not remembered for long.
 */
export const DEFAULT_KEY_CACHE_TTL_MS = 5 * 60_000

/**
 * How many unwrapped data keys are cached at once by default. Each entry is a 32-byte key
 * and the strings that name it — kilobytes in total — and the oldest entry is evicted when a
 * new one would exceed the limit.
 */
export const DEFAULT_KEY_CACHE_MAX_ENTRIES = 1024

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
  /**
   * The name of the key that wrapped `wrappedKey`, as its provider spells it: `v1` for the
   * local provider, a Cloud KMS `cryptoKeys/…` resource name for `gcp-kms`. For rotation
   * later, and the provider's own key check (see {@link WrappedKeyMeta}).
   */
  readonly kekVersion: string
  /**
   * Which key provider wrapped `wrappedKey` (#150): `local`, or `gcp-kms`. Never key
   * material — it names the provider so a secret cannot be opened by one that did not wrap
   * it. Absent on rows written before the field existed, where `local` was the only provider:
   * absent means `local`.
   */
  readonly keyProvider?: string
}

/**
 * Envelope encryption for user secrets.
 *
 * `seal` draws a fresh random 32-byte data key and a 12-byte nonce, encrypts the plaintext
 * with AES-256-GCM under that data key, and asks the key provider to wrap the data key with
 * the master key. `open` is the exact reverse. Nothing here talks to a database, and nothing
 * here ever logs: the vault hands the server a {@link SealedSecret} to store and a plaintext
 * to use, and keeps nothing — except, for a few minutes, the unwrapped data keys of the
 * secrets it has opened (see {@link VaultOptions}), which is what keeps a model request from
 * making a KMS round trip every time.
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
   * Rejects everything else: a different `aad`, tampered bytes, a malformed field, or a
   * `kekVersion` the provider does not know with a {@link VaultDecryptionError}. A secret
   * whose recorded `keyProvider` is not the provider this vault runs with is a
   * {@link VaultKeyError} instead — the deployment is wrong, not the row — and it is refused
   * before the master key is touched at all.
   */
  open(sealed: SealedSecret, aad: string): Promise<string>
}

/** What {@link createVault} takes beyond the provider. */
export interface VaultOptions {
  /**
   * How long an unwrapped data key stays in the vault's in-memory cache, in milliseconds.
   * Defaults to {@link DEFAULT_KEY_CACHE_TTL_MS}; `0` disables the cache, and with it any
   * memory the data keys would occupy.
   */
  readonly keyCacheTtlMs?: number
  /**
   * The cache's size limit: the most data keys kept at once, oldest evicted first. Defaults
   * to {@link DEFAULT_KEY_CACHE_MAX_ENTRIES}.
   */
  readonly keyCacheMaxEntries?: number
  /** The cache's clock, in milliseconds since epoch. Defaults to `Date.now`; tests inject. */
  readonly now?: () => number
}

/**
 * Creates a {@link Vault} whose data keys are wrapped by `kek`.
 *
 * The vault takes the provider's {@link KeyEncryptionKeyProvider.meta} once, at construction:
 * every secret it seals records that provider and key name, and reopening checks the provider
 * before delegating to `kek.unwrap` — which fails for any key name it does not know (key
 * rotation is otherwise the provider's business; see `AGENTS.md`).
 *
 * An unwrapped data key is cached for {@link VaultOptions.keyCacheTtlMs} (a few minutes by
 * default, bounded by `keyCacheMaxEntries`) so opening the same stored secret again — one
 * model request after another — does not ask KMS again. Cached keys are zeroed when they
 * expire or are evicted, and every caller is handed its own copy, which `open` zeroes after
 * use; the plaintext and the master key are never cached.
 */
export function createVault(kek: KeyEncryptionKeyProvider, options: VaultOptions = {}): Vault {
  const kekMeta = kek.meta
  const ttlMs = options.keyCacheTtlMs ?? DEFAULT_KEY_CACHE_TTL_MS
  if (!Number.isInteger(ttlMs) || ttlMs < 0) {
    throw new TypeError(`keyCacheTtlMs must be an integer of at least 0, got ${String(ttlMs)}`)
  }
  const cache =
    ttlMs === 0
      ? undefined
      : new DataKeyCache(
          ttlMs,
          options.keyCacheMaxEntries ?? DEFAULT_KEY_CACHE_MAX_ENTRIES,
          options.now ?? Date.now,
        )

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
          kekVersion: kekMeta.key,
          keyProvider: kekMeta.provider,
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

      const meta = keyMetaOf(sealed)
      if (meta.provider !== kekMeta.provider) {
        // A provider mismatch is a deployment fact, not a bad row: say so plainly, name no
        // bytes, and do not let it read as "this secret is corrupt".
        throw new VaultKeyError(
          `the sealed secret was wrapped by key provider ${JSON.stringify(meta.provider)}; ` +
            `this server runs key provider ${JSON.stringify(kekMeta.provider)} ` +
            '(OPENHARNESS_KEY_PROVIDER) — a secret can only be opened by the provider that ' +
            'wrapped it',
        )
      }

      let dataKey: Uint8Array | undefined
      try {
        // The cache keys on exactly what identifies the wrap: the provider, its key and the
        // wrapped bytes. A cache hit skips `kek.unwrap` — the KMS round trip — and nothing
        // else: the AES-GCM open below still runs every time.
        const cached = cache?.get(`${meta.provider}\u0000${meta.key}\u0000${sealed.wrappedKey}`)
        if (cached !== undefined) {
          dataKey = cached
        } else {
          dataKey = await kek.unwrap(wrappedKey, meta)
          cache?.set(`${meta.provider}\u0000${meta.key}\u0000${sealed.wrappedKey}`, dataKey)
        }
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
        // The cached copy survives (the cache hands out copies); this call's copy does not.
        dataKey?.fill(0)
      }
    },
  }
}

/** What a sealed secret records about the key that wrapped it, with the legacy default. */
function keyMetaOf(sealed: SealedSecret): WrappedKeyMeta {
  return { provider: sealed.keyProvider ?? LOCAL_KEY_PROVIDER, key: sealed.kekVersion }
}

/**
 * The vault's in-memory cache of unwrapped data keys, keyed by the wrapped form that
 * identifies one secret's wrap.
 *
 * Three rules make it safe to hold key material:
 *
 * - **Every hand-out is a copy.** `get` returns a fresh `Uint8Array`, because `open` zeroes
 *   what it is given; `set` copies too, because the provider's buffer is the caller's to
 *   zero. The cached bytes are never handed to anyone who could write to them.
 * - **Entries expire** ({@link VaultOptions.keyCacheTtlMs}) and **the cache is bounded**
 *   ({@link VaultOptions.keyCacheMaxEntries}); expiry and eviction zero the bytes they drop.
 * - **Recency order is insertion order.** A `get` moves its entry to the back, so the first
 *   key of the map is always the oldest — the one an over-limit `set` evicts.
 */
class DataKeyCache {
  readonly #ttlMs: number

  readonly #maxEntries: number

  readonly #now: () => number

  readonly #entries = new Map<string, { readonly key: Uint8Array; readonly expiresAt: number }>()

  constructor(ttlMs: number, maxEntries: number, now: () => number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError(`keyCacheMaxEntries must be an integer of at least 1, got ${maxEntries}`)
    }
    this.#ttlMs = ttlMs
    this.#maxEntries = maxEntries
    this.#now = now
  }

  /** The cached data key for `id` as a fresh copy, or `undefined` when none is live. */
  get(id: string): Uint8Array | undefined {
    const entry = this.#entries.get(id)
    if (entry === undefined) {
      return undefined
    }
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(id)
      entry.key.fill(0)
      return undefined
    }
    // Refresh recency, so a key that is actually being used is the last one evicted.
    this.#entries.delete(id)
    this.#entries.set(id, entry)
    return new Uint8Array(entry.key)
  }

  /** Cache a copy of `key` under `id`, evicting the oldest entry when the limit is reached. */
  set(id: string, key: Uint8Array): void {
    const existing = this.#entries.get(id)
    if (existing !== undefined) {
      this.#entries.delete(id)
      existing.key.fill(0)
    }
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) {
        break
      }
      this.#entries.get(oldest.value)?.key.fill(0)
      this.#entries.delete(oldest.value)
    }
    this.#entries.set(id, { key: new Uint8Array(key), expiresAt: this.#now() + this.#ttlMs })
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
