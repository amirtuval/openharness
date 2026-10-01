import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { VaultKeyError } from './errors'
import { envKeyProvider } from './keys'

const validKey = randomBytes(32).toString('base64')

describe('envKeyProvider', () => {
  it('wraps and unwraps a data key', async () => {
    const provider = envKeyProvider(validKey)
    const dataKey = randomBytes(32)
    const wrapped = await provider.wrap(dataKey)
    expect(wrapped).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(await provider.unwrap(wrapped, provider.version))).toEqual(dataKey)
  })

  it('names the version it wraps with', () => {
    expect(envKeyProvider(validKey).version).toBe('v1')
  })

  it('wraps differently every time, even for the same data key', async () => {
    const provider = envKeyProvider(validKey)
    const dataKey = randomBytes(32)
    const first = await provider.wrap(dataKey)
    const second = await provider.wrap(dataKey)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  it('tolerates surrounding whitespace from the environment', () => {
    expect(() => envKeyProvider(`\n  ${validKey}\n`)).not.toThrow()
  })

  it('rejects invalid master keys, naming the variable but never the value', () => {
    const cases: [string, string][] = [
      ['empty', ''],
      ['not base64', 'not a base64 key!!'],
      ['base64 of the wrong length (16 bytes)', randomBytes(16).toString('base64')],
      ['base64 of the wrong length (31 bytes)', randomBytes(31).toString('base64')],
      ['base64 of the wrong length (33 bytes)', randomBytes(33).toString('base64')],
      ['base64 of the wrong length (64 bytes)', randomBytes(64).toString('base64')],
      ['padding in the middle', `${validKey.slice(0, 10)}=${validKey.slice(10)}`],
    ]

    for (const [label, key] of cases) {
      let error: unknown
      try {
        envKeyProvider(key)
      } catch (caught) {
        error = caught
      }
      expect(error, label).toBeInstanceOf(VaultKeyError)
      expect(String(error), label).toContain('OPENHARNESS_SECRETS_KEY')
      if (key.length > 0) {
        expect(String(error), label).not.toContain(key)
      }
    }
  })

  describe('unwrap', () => {
    it('rejects a version it does not know', async () => {
      const provider = envKeyProvider(validKey)
      const wrapped = await provider.wrap(randomBytes(32))
      await expect(provider.unwrap(wrapped, 'v2')).rejects.toThrow(VaultKeyError)
      await expect(provider.unwrap(wrapped, '')).rejects.toThrow(VaultKeyError)
    })

    it('rejects a tampered or truncated wrapped key', async () => {
      const provider = envKeyProvider(validKey)
      const wrapped = await provider.wrap(randomBytes(32))

      const tampered = Uint8Array.from(wrapped)
      tampered[0] = (tampered[0] ?? 0) ^ 0xff
      await expect(provider.unwrap(tampered, provider.version)).rejects.toThrow(VaultKeyError)

      const truncated = wrapped.subarray(0, wrapped.byteLength - 1)
      await expect(provider.unwrap(truncated, provider.version)).rejects.toThrow(VaultKeyError)
    })

    it('rejects a wrapped key that another master key produced', async () => {
      const other = envKeyProvider(randomBytes(32).toString('base64'))
      const wrapped = await other.wrap(randomBytes(32))
      await expect(envKeyProvider(validKey).unwrap(wrapped, 'v1')).rejects.toThrow(VaultKeyError)
    })
  })
})
