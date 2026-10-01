import { randomBytes } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'

import { envKeyProvider } from './keys'
import { createVault } from './vault'

// Long, random and unique: if any of them reaches a string — a message, String(), a JSON
// dump, a stack, util.inspect — the assertions below are categorical about it.
const masterKey = randomBytes(32).toString('base64')
const masterKeyHex = Buffer.from(masterKey, 'base64').toString('hex')
const plaintext = `sk-${randomBytes(24).toString('hex')}`
const aad = `user_${randomBytes(8).toString('hex')}|anthropic`

/** Asserts that `subject` contains none of the secrets, whichever encoding they leaked in. */
function expectNoSecrets(subject: string, label: string): void {
  expect(subject, `${label} contains the plaintext`).not.toContain(plaintext)
  expect(subject, `${label} contains the master key`).not.toContain(masterKey)
  expect(subject, `${label} contains the master key as hex`).not.toContain(masterKeyHex)
}

/** Runs `call` and returns the error it threw; fails when it does not throw. */
async function capture(call: () => unknown): Promise<unknown> {
  try {
    await call()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

/** Flips one byte of a base64 field, keeping it valid base64 of the same length. */
function tamper(field: string): string {
  const bytes = Buffer.from(field, 'base64')
  bytes[0] = (bytes[0] ?? 0) ^ 0xff
  return bytes.toString('base64')
}

/** `String(value)` on purpose: the default '[object Object]' is what is being asserted. */
function objectToString(value: object): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the default format is the point
  return String(value)
}

describe('nothing secret ever reaches a string', () => {
  it('the vault, the provider and the sealed secret carry no plaintext or key', async () => {
    const provider = envKeyProvider(masterKey)
    const vault = createVault(provider)
    const sealed = await vault.seal(plaintext, aad)

    const objects = [
      ['vault', vault],
      ['provider', provider],
    ] as const
    for (const [label, value] of objects) {
      expectNoSecrets(objectToString(value), `String(${label})`)
      expectNoSecrets(JSON.stringify(value), `JSON.stringify(${label})`)
      // `console.log` prints via util.inspect; nothing here may leak there either.
      expectNoSecrets(inspect(value), `inspect(${label})`)
    }

    expectNoSecrets(JSON.stringify(sealed), 'JSON.stringify(sealed)')
    // The plaintext's own bytes must not be recognizable inside the stored row.
    expect(JSON.stringify(sealed)).not.toContain(Buffer.from(plaintext, 'utf8').toString('base64'))
  })

  it('every error from the vault and the provider is clean', async () => {
    const provider = envKeyProvider(masterKey)
    const vault = createVault(provider)
    const otherKeyVault = createVault(envKeyProvider(randomBytes(32).toString('base64')))
    const sealed = await vault.seal(plaintext, aad)

    const errors = [
      await capture(() => vault.open(sealed, `${aad}-elsewhere`)), // wrong aad
      await capture(() => vault.open({ ...sealed, kekVersion: 'v9' }, aad)), // unknown version
      await capture(() => vault.open({ ...sealed, ciphertext: tamper(sealed.ciphertext) }, aad)),
      await capture(() => vault.open({ ...sealed, nonce: tamper(sealed.nonce) }, aad)),
      await capture(() => vault.open({ ...sealed, wrappedKey: tamper(sealed.wrappedKey) }, aad)),
      await capture(() => vault.open({ ...sealed, ciphertext: 'garbage' }, aad)),
      await capture(() => otherKeyVault.open(sealed, aad)), // a different master key
      await capture(() => envKeyProvider('this is not base64')), // invalid master key
      await capture(() => envKeyProvider(randomBytes(16).toString('base64'))), // wrong length
      await capture(() => provider.unwrap(new Uint8Array(60), provider.version)), // garbage wrap
    ]
    expect(errors).toHaveLength(10)

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error)
      expectNoSecrets(String(error), 'String(error)')
      expectNoSecrets(JSON.stringify(error), 'JSON.stringify(error)')
      expectNoSecrets((error as Error).stack ?? '', 'error.stack')
      for (
        let cause: unknown = (error as Error).cause;
        cause instanceof Error;
        cause = cause.cause
      ) {
        expectNoSecrets(String(cause), 'String(cause)')
        expectNoSecrets(JSON.stringify(cause), 'JSON.stringify(cause)')
      }
    }
  })
})
