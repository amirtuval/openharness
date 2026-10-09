import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { VaultDecryptionError, VaultKeyError } from './errors'
import { LOCAL_KEY_PROVIDER, envKeyProvider, type KeyEncryptionKeyProvider } from './keys'
import { createVault, type SealedSecret } from './vault'

const kek = envKeyProvider(randomBytes(32).toString('base64'))
const vault = createVault(kek)
const aad = 'user_01H8|anthropic'

/** Flips one byte of a base64 field, keeping it valid base64 of the same length. */
function tamper(field: string): string {
  const bytes = Buffer.from(field, 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 0xff
  return bytes.toString('base64')
}

/**
 * A second provider, behind the same interface: the shape a KMS adapter has (a different
 * `provider`), encrypting with a local key so a test needs no network. It wraps exactly like
 * `envKeyProvider` but stamps `gcp-kms`, which is all the vault and the provider interface
 * look at.
 */
function otherProvider(provider = 'gcp-kms'): KeyEncryptionKeyProvider {
  const local = envKeyProvider(randomBytes(32).toString('base64'))
  return {
    meta: { provider, key: 'projects/test/locations/global/keyRings/r/cryptoKeys/k' },
    wrap: (dataKey) => local.wrap(dataKey),
    unwrap: (wrapped, meta) => local.unwrap(wrapped, meta),
  }
}

/** The sealed secret as a row written before `keyProvider` existed: that field absent. */
function withoutProviderField(sealed: SealedSecret): SealedSecret {
  return {
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    wrappedKey: sealed.wrappedKey,
    kekVersion: sealed.kekVersion,
  }
}

/** Counts the provider's wraps and unwraps, so a test can assert a cache hit skipped one. */
function countingProvider(inner: KeyEncryptionKeyProvider): {
  provider: KeyEncryptionKeyProvider
  calls: { wraps: number; unwraps: number }
} {
  const calls = { wraps: 0, unwraps: 0 }
  return {
    calls,
    provider: {
      meta: inner.meta,
      wrap: (dataKey) => {
        calls.wraps += 1
        return inner.wrap(dataKey)
      },
      unwrap: (wrapped, meta) => {
        calls.unwraps += 1
        return inner.unwrap(wrapped, meta)
      },
    },
  }
}

describe('vault round trip', () => {
  it('opens what it sealed', async () => {
    const sealed = await vault.seal('sk-ant-api03-secret', aad)
    await expect(vault.open(sealed, aad)).resolves.toBe('sk-ant-api03-secret')
  })

  it('round-trips the empty string and unicode', async () => {
    const plaintext = 'naïve 🔐 ünïcode key'
    await expect(vault.open(await vault.seal('', aad), aad)).resolves.toBe('')
    await expect(vault.open(await vault.seal(plaintext, aad), aad)).resolves.toBe(plaintext)
  })

  it('returns a base64 sealed secret stamped with the provider and its key name', async () => {
    const sealed = await vault.seal('secret', aad)
    expect(Object.keys(sealed).sort()).toEqual([
      'ciphertext',
      'kekVersion',
      'keyProvider',
      'nonce',
      'wrappedKey',
    ])
    for (const field of ['ciphertext', 'nonce', 'wrappedKey'] as const) {
      expect(sealed[field]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    }
    expect(sealed.kekVersion).toBe(kek.meta.key)
    expect(sealed.keyProvider).toBe(kek.meta.provider)
  })

  it('never seals the same plaintext to the same bytes', async () => {
    const first = await vault.seal('same plaintext', aad)
    const second = await vault.seal('same plaintext', aad)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.wrappedKey).not.toBe(second.wrappedKey)
  })

  it('opens a row written before the keyProvider field existed: absent means local', async () => {
    const sealed = await vault.seal('legacy secret', aad)
    await expect(vault.open(withoutProviderField(sealed), aad)).resolves.toBe('legacy secret')
  })
})

describe('vault open rejects', () => {
  it('a different associated-data string', async () => {
    const sealed = await vault.seal('secret', 'user_1|anthropic')
    await expect(vault.open(sealed, 'user_2|anthropic')).rejects.toThrow(VaultDecryptionError)
    await expect(vault.open(sealed, 'user_1|openai')).rejects.toThrow(VaultDecryptionError)
    await expect(vault.open(sealed, '')).rejects.toThrow(VaultDecryptionError)
  })

  it('tampered ciphertext, nonce or wrapped key', async () => {
    const sealed = await vault.seal('secret', aad)
    const variants = [
      ['ciphertext', { ...sealed, ciphertext: tamper(sealed.ciphertext) }],
      ['nonce', { ...sealed, nonce: tamper(sealed.nonce) }],
      ['wrappedKey', { ...sealed, wrappedKey: tamper(sealed.wrappedKey) }],
    ] as const

    for (const [field, variant] of variants) {
      await expect(vault.open(variant, aad), field).rejects.toThrow(VaultDecryptionError)
    }
  })

  it('an unknown key version', async () => {
    const sealed = await vault.seal('secret', aad)
    await expect(vault.open({ ...sealed, kekVersion: 'v2' }, aad)).rejects.toThrow(
      VaultDecryptionError,
    )
    await expect(vault.open({ ...sealed, kekVersion: '' }, aad)).rejects.toThrow(
      VaultDecryptionError,
    )
  })

  it('a malformed field', async () => {
    const sealed = await vault.seal('secret', aad)
    const variants = [
      ['ciphertext not base64', { ...sealed, ciphertext: 'not base64!!' }],
      ['ciphertext shorter than a tag', { ...sealed, ciphertext: 'AAAA' }],
      ['nonce of the wrong length', { ...sealed, nonce: Buffer.from('short').toString('base64') }],
      ['nonce missing', { ...sealed, nonce: '' }],
      [
        'wrapped key of the wrong size',
        { ...sealed, wrappedKey: Buffer.alloc(16).toString('base64') },
      ],
    ] as const

    for (const [label, variant] of variants) {
      await expect(vault.open(variant, aad), label).rejects.toThrow(VaultDecryptionError)
    }
  })

  it('a different master key', async () => {
    const sealed = await vault.seal('secret', aad)
    const other = createVault(envKeyProvider(randomBytes(32).toString('base64')))
    await expect(other.open(sealed, aad)).rejects.toThrow(VaultDecryptionError)
  })

  it('a secret wrapped by another provider, either way round, with a clear error', async () => {
    // #150: what a deployment migrating its key provider gets instead of a corrupt-row
    // mystery. The error names both providers and is a VaultKeyError — the deployment is
    // wrong, not the row.
    const kmsVault = createVault(otherProvider())
    const localSealed = await vault.seal('secret', aad)
    const kmsSealed = await kmsVault.seal('secret', aad)

    let error: unknown
    try {
      await kmsVault.open(localSealed, aad)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(VaultKeyError)
    expect(error).not.toBeInstanceOf(VaultDecryptionError)
    expect(String(error)).toContain(JSON.stringify(LOCAL_KEY_PROVIDER))
    expect(String(error)).toContain('"gcp-kms"')
    expect(String(error)).toContain('OPENHARNESS_KEY_PROVIDER')

    let reverse: unknown
    try {
      await vault.open(kmsSealed, aad)
    } catch (caught) {
      reverse = caught
    }
    expect(reverse).toBeInstanceOf(VaultKeyError)
    expect(reverse).not.toBeInstanceOf(VaultDecryptionError)
    expect(String(reverse)).toContain('"gcp-kms"')
  })

  it('a legacy local row under a gcp-kms vault, with the same clear error', async () => {
    const kmsVault = createVault(otherProvider())
    const sealed = withoutProviderField(await vault.seal('secret', aad))
    await expect(kmsVault.open(sealed, aad)).rejects.toThrow(/key provider "local"/)
  })
})

describe('data-key cache', () => {
  it('skips the provider on a hit and still opens every time', async () => {
    const { provider, calls } = countingProvider(kek)
    const caching = createVault(provider)
    const sealed = await caching.seal('cached secret', aad)

    await expect(caching.open(sealed, aad)).resolves.toBe('cached secret')
    expect(calls.unwraps).toBe(1)
    // The second open is a cache hit: no provider call, and the same plaintext. This is also
    // what proves the first open zeroing its data key did not poison the cache.
    await expect(caching.open(sealed, aad)).resolves.toBe('cached secret')
    expect(calls.unwraps).toBe(1)

    // A different secret is a different wrap: it is unwrapped once, on its own.
    const other = await caching.seal('another', aad)
    await expect(caching.open(other, aad)).resolves.toBe('another')
    expect(calls.unwraps).toBe(2)
  })

  it('expires entries after the TTL', async () => {
    const { provider, calls } = countingProvider(kek)
    let now = 1_000_000
    const caching = createVault(provider, { keyCacheTtlMs: 1000, now: () => now })
    const sealed = await caching.seal('secret', aad)

    await caching.open(sealed, aad)
    expect(calls.unwraps).toBe(1)

    // Just inside the window: still cached.
    now += 999
    await caching.open(sealed, aad)
    expect(calls.unwraps).toBe(1)

    // At the edge the entry is expired: unwrapped again, and the answer is the same.
    now += 1
    await expect(caching.open(sealed, aad)).resolves.toBe('secret')
    expect(calls.unwraps).toBe(2)
  })

  it('evicts the oldest entry past the size limit', async () => {
    const { provider, calls } = countingProvider(kek)
    const caching = createVault(provider, { keyCacheMaxEntries: 2 })
    const first = await caching.seal('first', aad)
    const second = await caching.seal('second', aad)
    const third = await caching.seal('third', aad)

    await caching.open(first, aad)
    await caching.open(second, aad)
    await caching.open(third, aad) // evicts `first`
    expect(calls.unwraps).toBe(3)

    // `third` is still cached; `first` was evicted and is unwrapped again.
    await caching.open(third, aad)
    expect(calls.unwraps).toBe(3)
    await expect(caching.open(first, aad)).resolves.toBe('first')
    expect(calls.unwraps).toBe(4)
  })

  it('is off when the TTL is zero', async () => {
    const { provider, calls } = countingProvider(kek)
    const uncached = createVault(provider, { keyCacheTtlMs: 0 })
    const sealed = await uncached.seal('secret', aad)
    await uncached.open(sealed, aad)
    await uncached.open(sealed, aad)
    expect(calls.unwraps).toBe(2)
  })

  it('rejects a negative TTL or an empty cache', () => {
    expect(() => createVault(kek, { keyCacheTtlMs: -1 })).toThrow(TypeError)
    expect(() => createVault(kek, { keyCacheMaxEntries: 0 })).toThrow(TypeError)
  })
})
