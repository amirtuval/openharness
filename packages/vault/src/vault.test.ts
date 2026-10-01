import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { VaultDecryptionError } from './errors'
import { envKeyProvider } from './keys'
import { createVault } from './vault'

const kek = envKeyProvider(randomBytes(32).toString('base64'))
const vault = createVault(kek)
const aad = 'user_01H8|anthropic'

/** Flips one byte of a base64 field, keeping it valid base64 of the same length. */
function tamper(field: string): string {
  const bytes = Buffer.from(field, 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 0xff
  return bytes.toString('base64')
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

  it('returns a base64 sealed secret stamped with the provider version', async () => {
    const sealed = await vault.seal('secret', aad)
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'kekVersion', 'nonce', 'wrappedKey'])
    for (const field of ['ciphertext', 'nonce', 'wrappedKey'] as const) {
      expect(sealed[field]).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    }
    expect(sealed.kekVersion).toBe(kek.version)
  })

  it('never seals the same plaintext to the same bytes', async () => {
    const first = await vault.seal('same plaintext', aad)
    const second = await vault.seal('same plaintext', aad)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.wrappedKey).not.toBe(second.wrappedKey)
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
})
