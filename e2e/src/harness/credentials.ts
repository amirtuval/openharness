import { credentialUpsert, sealCredential } from '@openharness/server'
import { createPostgresCredentialStore } from '@openharness/session/postgres'
import { createVault, envKeyProvider } from '@openharness/vault'
import type { ProviderCredential } from '@openharness/protocol'

import type { E2eDatabase } from './database'
import { E2E_SECRETS_KEY } from './server'

/**
 * Seeding a provider credential (A5) for tests that need one to exist.
 *
 * `PUT /v1/provider-credentials/{name}` is the door a person uses, and it validates the
 * key with **one cheap call to the provider** first — a real network request from a real
 * process, and the process boundary exposes no seam to stub it (`provider-validation.ts`
 * hard-codes the provider URLs; the injectable validator is only reachable in-process). A
 * suite that must run offline and deterministically therefore cannot create a credential
 * through the API.
 *
 * What it can do — and what this does — is write **the exact row the route writes**, with the
 * server's own code: the same vault (`OPENHARNESS_SECRETS_KEY`, the harness's fixed value),
 * the same `userId|name` associated data, the same `credentialUpsert` input, through the
 * same `CredentialStore` the server reads with. Nothing here duplicates the server's sealing,
 * so a change to it that breaks the contract shows up as a test that cannot open what it
 * stored.
 *
 * The route itself is covered where it can be for real: `provider-smoke.test.ts` PUTs the
 * environment's provider key through it (validate, seal, store, resolve per request) whenever
 * a real key is present, and `credentials.test.ts` asserts a key the provider refuses is
 * refused with 422 and never stored.
 */

/** The vault the e2e servers and this harness share; see {@link E2E_SECRETS_KEY}. */
function e2eVault() {
  return createVault(envKeyProvider(E2E_SECRETS_KEY))
}

/**
 * Store a sealed API key for one user, exactly as the `PUT` route would after validating it.
 *
 * @param database the test file's database — the one the server under test runs against
 * @param input the owner, the credential name, and the plaintext key (which is sealed here,
 *   never written down anywhere)
 * @returns the credential's metadata, as the `CredentialStore` answered it
 */
export async function seedProviderCredential(
  database: E2eDatabase,
  input: { readonly userId: string; readonly name: string; readonly apiKey: string },
): Promise<ProviderCredential> {
  const body = { type: 'api_key' as const, api_key: input.apiKey }
  const sealed = await sealCredential(e2eVault(), { userId: input.userId, name: input.name, body })
  const store = createPostgresCredentialStore({ connectionString: database.url })
  try {
    return await store.upsert(
      credentialUpsert(
        { userId: input.userId, name: input.name, body },
        sealed,
        new Date().toISOString(),
      ),
    )
  } finally {
    await store.close()
  }
}

/**
 * Store a sealed **Azure OpenAI** credential, the way a `PUT` of that payload would.
 *
 * The suite's own refusal paths (a bad key, a private endpoint) go through the route, because
 * the route is what refuses them; this is for the tests that need an Azure credential to
 * exist — the catalogue and the model path — where the save-time check would reach Azure.
 */
export async function seedAzureCredential(
  database: E2eDatabase,
  input: {
    readonly userId: string
    readonly name: string
    readonly endpoint: string
    readonly apiKey: string
    readonly deployments: readonly string[]
  },
): Promise<ProviderCredential> {
  const body = {
    type: 'azure_openai' as const,
    endpoint: input.endpoint,
    api_key: input.apiKey,
    deployments: [...input.deployments],
  }
  const sealed = await sealCredential(e2eVault(), { userId: input.userId, name: input.name, body })
  const store = createPostgresCredentialStore({ connectionString: database.url })
  try {
    return await store.upsert(
      credentialUpsert(
        { userId: input.userId, name: input.name, body },
        sealed,
        new Date().toISOString(),
      ),
    )
  } finally {
    await store.close()
  }
}
