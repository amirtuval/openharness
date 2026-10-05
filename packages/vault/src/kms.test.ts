import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { VaultKeyError } from './errors'
import { LOCAL_KEY_PROVIDER, envKeyProvider } from './keys'
import { GCP_KMS_PROVIDER, gcpKmsKeyProvider, type KmsClient } from './kms'
import { createVault } from './vault'

/**
 * The Cloud KMS adapter (#150), tested against a fake client behind the same interface.
 *
 * The fake plays KMS: it encrypts and decrypts with a local AES-256-GCM key, so a wrap and an
 * unwrap are real cryptography without a network, and records every request so the tests can
 * assert the adapter's request shapes — the resource name, the 32-byte data key, the
 * ciphertext round trip. A real KMS call is not something CI can make; the opt-in suite at
 * the bottom of this file is where a deployment with credentials can run one.
 */

const KEY = 'projects/test-project/locations/global/keyRings/openharness/cryptoKeys/credentials'

/** The `Encrypt` answer tuple `KmsClient` declares, so a fake can be written without `async`. */
function encryptAnswered(
  ciphertext: Uint8Array | string | null,
): Awaited<ReturnType<KmsClient['encrypt']>> {
  return [{ ciphertext }]
}

/** The `Decrypt` answer tuple `KmsClient` declares. */
function decryptAnswered(
  plaintext: Uint8Array | string | null,
): Awaited<ReturnType<KmsClient['decrypt']>> {
  return [{ plaintext }]
}

/** A `KmsClient` that behaves like KMS, with a local key, and records what it was asked. */
function fakeKms(options: { key?: Uint8Array } = {}): {
  client: KmsClient
  encrypts: { name: string; plaintext: Uint8Array }[]
  decrypts: { name: string; ciphertext: Uint8Array }[]
} {
  const master = options.key ?? randomBytes(32)
  const encrypts: { name: string; plaintext: Uint8Array }[] = []
  const decrypts: { name: string; ciphertext: Uint8Array }[] = []
  return {
    encrypts,
    decrypts,
    client: {
      encrypt(request) {
        encrypts.push({ name: request.name, plaintext: Uint8Array.from(request.plaintext) })
        const nonce = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', master, nonce)
        // The resource name as associated data, like KMS binds to the key it was called on.
        cipher.setAAD(Buffer.from(request.name, 'utf8'))
        const body = Buffer.concat([cipher.update(request.plaintext), cipher.final()])
        return Promise.resolve(encryptAnswered(Buffer.concat([nonce, body, cipher.getAuthTag()])))
      },
      decrypt(request) {
        decrypts.push({ name: request.name, ciphertext: Uint8Array.from(request.ciphertext) })
        const bytes = Buffer.from(request.ciphertext)
        const decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12))
        decipher.setAAD(Buffer.from(request.name, 'utf8'))
        decipher.setAuthTag(bytes.subarray(bytes.byteLength - 16))
        const plaintext = Buffer.concat([
          decipher.update(bytes.subarray(12, bytes.byteLength - 16)),
          decipher.final(),
        ])
        return Promise.resolve(decryptAnswered(plaintext))
      },
    },
  }
}

/** A client whose every call rejects with `error`. */
function refusingKms(error: Error): KmsClient {
  return {
    encrypt: () => Promise.reject(error),
    decrypt: () => Promise.reject(error),
  }
}

describe('gcpKmsKeyProvider', () => {
  it('names the provider and the key it wraps with', () => {
    const provider = gcpKmsKeyProvider({
      key: KEY,
      createClient: () => Promise.resolve(fakeKms().client),
    })
    expect(provider.meta).toEqual({ provider: GCP_KMS_PROVIDER, key: KEY })
  })

  it('round-trips a data key through the client, as an Encrypt then a Decrypt', async () => {
    const kms = fakeKms()
    const provider = gcpKmsKeyProvider({
      key: KEY,
      createClient: () => Promise.resolve(kms.client),
    })
    const dataKey = randomBytes(32)

    const wrapped = await provider.wrap(dataKey)
    expect(kms.encrypts).toHaveLength(1)
    expect(kms.encrypts[0]?.name).toBe(KEY)
    expect(Buffer.from(kms.encrypts[0]?.plaintext ?? [])).toEqual(dataKey)

    const unwrapped = await provider.unwrap(wrapped, provider.meta)
    expect(kms.decrypts).toHaveLength(1)
    expect(kms.decrypts[0]?.name).toBe(KEY)
    expect(Buffer.from(kms.decrypts[0]?.ciphertext ?? [])).toEqual(Buffer.from(wrapped))
    expect(Buffer.from(unwrapped)).toEqual(dataKey)
  })

  it('builds the client lazily, once, on the first use', async () => {
    const kms = fakeKms()
    const createClient = vi.fn(() => Promise.resolve(kms.client))
    const provider = gcpKmsKeyProvider({ key: KEY, createClient })

    // Constructing the provider must not load the client — that is what keeps a deployment
    // on `local` from ever paying for `@google-cloud/kms`.
    expect(createClient).not.toHaveBeenCalled()

    const wrapped = await provider.wrap(randomBytes(32))
    expect(createClient).toHaveBeenCalledTimes(1)
    await provider.unwrap(wrapped, provider.meta)
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('takes surrounding whitespace off the key name', () => {
    const provider = gcpKmsKeyProvider({
      key: `\n  ${KEY}\n`,
      createClient: () => Promise.resolve(fakeKms().client),
    })
    expect(provider.meta.key).toBe(KEY)
  })

  it('refuses a key name that is not a cryptoKey resource, at construction', () => {
    for (const key of [
      '',
      'credentials',
      'projects/p/locations/l/keyRings/r',
      // A key *version* would pin every seal to it and turn rotation into a migration.
      'projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
    ]) {
      let error: unknown
      try {
        gcpKmsKeyProvider({ key })
      } catch (caught) {
        error = caught
      }
      expect(error, key).toBeInstanceOf(VaultKeyError)
      expect(String(error), key).toContain('OPENHARNESS_KMS_KEY')
    }
  })

  it('refuses metadata naming another provider or key without calling KMS', async () => {
    const kms = fakeKms()
    const createClient = vi.fn(() => Promise.resolve(kms.client))
    const provider = gcpKmsKeyProvider({ key: KEY, createClient })

    const cases = [
      { provider: LOCAL_KEY_PROVIDER, key: 'v1' },
      {
        provider: GCP_KMS_PROVIDER,
        key: 'projects/other/locations/global/keyRings/r/cryptoKeys/k',
      },
    ]
    for (const meta of cases) {
      let error: unknown
      try {
        await provider.unwrap(new Uint8Array(80), meta)
      } catch (caught) {
        error = caught
      }
      expect(error, JSON.stringify(meta)).toBeInstanceOf(VaultKeyError)
      expect(String(error)).toContain(JSON.stringify(meta.provider))
      expect(String(error)).toContain(JSON.stringify(meta.key))
    }
    expect(createClient).not.toHaveBeenCalled()
  })

  it('wraps a client that throws into a VaultKeyError that carries no key material', async () => {
    const dataKey = randomBytes(32)
    const boom = new Error('7 PERMISSION_DENIED: caller does not have permission')
    const failing = refusingKms(boom)

    const errors = [
      await capture(() =>
        gcpKmsKeyProvider({ key: KEY, createClient: () => Promise.resolve(failing) }).wrap(dataKey),
      ),
      await capture(async () => {
        const provider = gcpKmsKeyProvider({
          key: KEY,
          createClient: () => Promise.resolve(failing),
        })
        return provider.unwrap(new Uint8Array(80), provider.meta)
      }),
    ]

    const dataKeyHex = Buffer.from(dataKey).toString('hex')
    for (const error of errors) {
      expect(error).toBeInstanceOf(VaultKeyError)
      expect(String(error)).toContain(KEY)
      expect(String(error)).not.toContain(dataKeyHex)
      expect((error as VaultKeyError).cause).toBe(boom)
    }
  })

  it('refuses an answer that carries no bytes or the wrong-sized plaintext', async () => {
    const providerOf = (client: KmsClient) =>
      gcpKmsKeyProvider({ key: KEY, createClient: () => Promise.resolve(client) })

    // Encrypt answered with nothing.
    const empty = await capture(() =>
      providerOf({
        encrypt: () => Promise.resolve(encryptAnswered(null)),
        decrypt: () => Promise.resolve(decryptAnswered(null)),
      }).wrap(randomBytes(32)),
    )
    expect(String(empty)).toContain('no ciphertext')

    // Decrypt answered with a 12-byte value where a 32-byte data key belongs.
    const short = await capture(() =>
      providerOf({
        encrypt: () => Promise.resolve(encryptAnswered(null)),
        decrypt: () => Promise.resolve(decryptAnswered(randomBytes(12))),
      }).unwrap(new Uint8Array(80), { provider: GCP_KMS_PROVIDER, key: KEY }),
    )
    expect(short).toBeInstanceOf(VaultKeyError)
    expect(String(short)).toContain('12-byte')
  })

  it('accepts base64 strings for the protobuf bytes fields', async () => {
    const dataKey = randomBytes(32)
    // A JSON transport hands `bytes` back as base64; the adapter decodes it.
    const provider = gcpKmsKeyProvider({
      key: KEY,
      createClient: () =>
        Promise.resolve({
          encrypt: () =>
            Promise.resolve(encryptAnswered(Buffer.from('wrapped').toString('base64'))),
          decrypt: () => Promise.resolve(decryptAnswered(Buffer.from(dataKey).toString('base64'))),
        }),
    })
    expect(Buffer.from(await provider.wrap(dataKey))).toEqual(Buffer.from('wrapped'))
    expect(Buffer.from(await provider.unwrap(new Uint8Array(8), provider.meta))).toEqual(dataKey)
  })

  it('works through the vault: seal records gcp-kms, open gets the plaintext back', async () => {
    const kms = fakeKms()
    const vault = createVault(
      gcpKmsKeyProvider({ key: KEY, createClient: () => Promise.resolve(kms.client) }),
    )
    const sealed = await vault.seal('sk-secret', 'user_1|anthropic')
    expect(sealed.keyProvider).toBe(GCP_KMS_PROVIDER)
    expect(sealed.kekVersion).toBe(KEY)
    await expect(vault.open(sealed, 'user_1|anthropic')).resolves.toBe('sk-secret')
  })

  it('cannot open a local row, and the local vault cannot open a kms row', async () => {
    const kmsVault = createVault(
      gcpKmsKeyProvider({ key: KEY, createClient: () => Promise.resolve(fakeKms().client) }),
    )
    const localVault = createVault(envKeyProvider(randomBytes(32).toString('base64')))

    const localSealed = await localVault.seal('secret', 'user_1|anthropic')
    const kmsSealed = await kmsVault.seal('secret', 'user_1|anthropic')

    await expect(kmsVault.open(localSealed, 'user_1|anthropic')).rejects.toThrow(/key provider/)
    await expect(localVault.open(kmsSealed, 'user_1|anthropic')).rejects.toThrow(/key provider/)
  })
})

/**
 * A real Cloud KMS call, opt-in because CI has no credentials and no project.
 *
 * Set `OPENHARNESS_TEST_KMS_KEY` to a `cryptoKeys/…` resource name the ambient Application
 * Default Credentials may use (`gcloud auth application-default login` locally, Workload
 * Identity in GKE) and this suite runs a wrap and an unwrap against the real service; CI
 * skips it.
 */
const liveKey = process.env.OPENHARNESS_TEST_KMS_KEY

/** The live key, or a failure — never reached while the suite below is skipped. */
function requireLiveKey(): string {
  if (liveKey === undefined || liveKey === '') {
    throw new Error('OPENHARNESS_TEST_KMS_KEY is not set')
  }
  return liveKey
}

describe.skipIf(liveKey === undefined || liveKey === '')('gcpKmsKeyProvider (live)', () => {
  it('wraps and unwraps a data key against real Cloud KMS', async () => {
    const provider = gcpKmsKeyProvider({ key: requireLiveKey() })
    const dataKey = randomBytes(32)
    const wrapped = await provider.wrap(dataKey)
    const unwrapped = await provider.unwrap(wrapped, provider.meta)
    expect(Buffer.from(unwrapped)).toEqual(dataKey)

    // And a full vault round trip on top of it.
    const vault = createVault(provider)
    const sealed = await vault.seal('live secret', 'user_1|anthropic')
    await expect(vault.open(sealed, 'user_1|anthropic')).resolves.toBe('live secret')
  })
})

/** Runs `call` and returns the error it threw; fails when it does not throw. */
async function capture(call: () => unknown): Promise<unknown> {
  try {
    await call()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}
