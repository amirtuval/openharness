import { describe, expect, it } from 'vitest'

import { VaultKeyError } from '@openharness/vault'

import { createConfigVault } from './key-provider'
import { testConfig } from './test-support'

/**
 * The vault the configuration asks for (#150): the wiring between `OPENHARNESS_KEY_PROVIDER`
 * and the provider package, and the two provider halves of the mismatch rule.
 *
 * The Cloud KMS half needs no network here: constructing its provider builds no client (the
 * client is lazy), and every assertion below is about a secret a KMS provider must refuse
 * *before* it would ever call KMS.
 */

const KMS_KEY =
  'projects/openharness-dev/locations/global/keyRings/openharness/cryptoKeys/credentials'
const AAD = 'user_01H8|anthropic'

describe('createConfigVault', () => {
  it('builds the local vault from the environment key, and it round-trips', async () => {
    const vault = createConfigVault(testConfig())
    const sealed = await vault.seal('sk-ant-secret', AAD)
    expect(sealed.keyProvider).toBe('local')
    await expect(vault.open(sealed, AAD)).resolves.toBe('sk-ant-secret')
  })

  it('builds the gcp-kms vault, which refuses a local row with a clear error', async () => {
    // A deployment that switches OPENHARNESS_KEY_PROVIDER must not read its old rows as
    // corrupt: the error names both providers. Nothing here touches KMS — the mismatch is
    // refused before the client is built, which is also why this test needs no credentials.
    const kmsVault = createConfigVault({
      ...testConfig(),
      keyProvider: 'gcp-kms',
      kmsKey: KMS_KEY,
      secretsKey: undefined,
    })

    const localSealed = await createConfigVault(testConfig()).seal('sk-ant-secret', AAD)
    let error: unknown
    try {
      await kmsVault.open(localSealed, AAD)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(VaultKeyError)
    expect(String(error)).toContain('"local"')
    expect(String(error)).toContain('"gcp-kms"')
  })

  it('refuses a hand-made config whose provider and key disagree', () => {
    // readServerConfig already refuses these at boot; the vault builder refuses them too, so
    // a host that constructs a ServerConfig itself cannot end up with a half-configured vault.
    expect(() =>
      createConfigVault({ ...testConfig(), keyProvider: 'gcp-kms', kmsKey: undefined }),
    ).toThrow(/OPENHARNESS_KMS_KEY/)
    expect(() => createConfigVault({ ...testConfig(), secretsKey: undefined })).toThrow(
      /OPENHARNESS_SECRETS_KEY/,
    )
  })

  it('passes the key-cache TTL through to the vault', async () => {
    // The cache itself is the vault's (tested there); here the wiring is what is pinned — a
    // TTL the vault refuses must fail loudly rather than be silently dropped, and `0` has to
    // reach the vault as "no cache", not as "cache with a zero TTL".
    expect(() => createConfigVault({ ...testConfig(), keyCacheTtlMs: -1 })).toThrow(TypeError)

    const uncached = createConfigVault({ ...testConfig(), keyCacheTtlMs: 0 })
    const sealed = await uncached.seal('secret', AAD)
    await expect(uncached.open(sealed, AAD)).resolves.toBe('secret')
  })
})
