import { credentialUpsert, sealCredential } from '@openharness/server'
import { createPostgresCredentialStore } from '@openharness/session/postgres'
import { createVault, envKeyProvider } from '@openharness/vault'
import type { BedrockRegion, ProviderCredential, VertexLocation } from '@openharness/protocol'

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
 * Store a sealed **custom OpenAI-compatible** credential, the way a `PUT` of that payload
 * would (epic #245, A3b).
 *
 * A `PUT` of this type validates against the endpoint the reader typed — which a test can
 * point at a local stub, but only when the server's self-host flag is on. This is for the
 * tests that need such a credential to exist with the flag **off** — the "refused at request
 * time" path — where the save-time check would have to reach a private address the server is
 * told not to.
 */
export async function seedOpenAICompatibleCredential(
  database: E2eDatabase,
  input: {
    readonly userId: string
    readonly name: string
    readonly baseUrl: string
    readonly apiKey?: string
  },
): Promise<ProviderCredential> {
  const body = {
    type: 'openai_compatible' as const,
    base_url: input.baseUrl,
    ...(input.apiKey === undefined ? {} : { api_key: input.apiKey }),
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

/**
 * Store a sealed **Amazon Bedrock** credential, the way a `PUT` of that payload would.
 *
 * The same reason `seedAzureCredential` exists: the save-time check is `ListFoundationModels`
 * against AWS, which a deterministic offline suite cannot make — the harness writes the row the
 * route writes, and the route's own refusals (a region AWS does not serve, a name a provider
 * owns) are exercised through it where they need no network.
 */
export async function seedBedrockCredential(
  database: E2eDatabase,
  input: {
    readonly userId: string
    readonly name: string
    /** One of the protocol's Bedrock regions; the schema refuses anything else on the wire. */
    readonly region: BedrockRegion
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  },
): Promise<ProviderCredential> {
  const body = {
    type: 'bedrock' as const,
    access_key_id: input.accessKeyId,
    secret_access_key: input.secretAccessKey,
    ...(input.sessionToken === undefined ? {} : { session_token: input.sessionToken }),
    region: input.region,
  }
  return await writeCredential(database, input, body)
}

/**
 * Store a sealed **Google Vertex** credential, the way a `PUT` of that payload would.
 *
 * Same reasoning as {@link seedAzureCredential}: the save-time check is a real call to Google,
 * so a suite that runs offline seeds the row instead — and the catalogue, which answers from
 * the vendored models.dev snapshot and dials nothing, is what the tests using this drive.
 */
export async function seedVertexCredential(
  database: E2eDatabase,
  input: {
    readonly userId: string
    readonly name: string
    readonly serviceAccount: string
    readonly project: string
    /** One of the protocol's `VERTEX_LOCATIONS`; the type is what the payload's union holds. */
    readonly location: VertexLocation
  },
): Promise<ProviderCredential> {
  const body = {
    type: 'vertex' as const,
    service_account: input.serviceAccount,
    project: input.project,
    location: input.location,
  }
  return await writeCredential(database, input, body)
}

/** Seal a body under its owner and name, and write the row the route would have written. */
async function writeCredential(
  database: E2eDatabase,
  key: { readonly userId: string; readonly name: string },
  body: Parameters<typeof sealCredential>[1]['body'],
): Promise<ProviderCredential> {
  const sealed = await sealCredential(e2eVault(), {
    userId: key.userId,
    name: key.name,
    body,
  })
  const store = createPostgresCredentialStore({ connectionString: database.url })
  try {
    return await store.upsert(
      credentialUpsert(
        { userId: key.userId, name: key.name, body },
        sealed,
        new Date().toISOString(),
      ),
    )
  } finally {
    await store.close()
  }
}
