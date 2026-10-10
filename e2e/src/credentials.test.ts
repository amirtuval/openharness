import { describe, expect, it } from 'vitest'

import {
  ApiErrorBodySchema,
  EVENT_TYPES,
  type BedrockRegion,
  type ProviderCredential,
  type SessionErrorEvent,
} from '@openharness/protocol'

import {
  collectStream,
  e2eHarness,
  errorOf,
  isStoredIdle,
  personFor,
  readLog,
  seedAzureCredential,
  seedBedrockCredential,
  seedProviderCredential,
  seedVertexCredential,
  startProviderStub,
  waitForTurnEnd,
  withDatabaseClient,
  type Person,
  type ProviderStub,
  type ServerProcess,
} from './harness'

/**
 * Provider credentials, end to end (epic #65, A5): write-only, sealed at rest, and the only
 * key a turn may run with.
 *
 * The properties here are the security ones, and they are asserted against the deployment a
 * user actually gets — a real process, a real Postgres — not against a unit's mocks:
 *
 * - a stored key is **never** in any response, event or log line;
 * - at rest it is a sealed blob: the plaintext appears in no column, and grepping the whole
 *   database for it finds nothing;
 * - a turn whose owner has no key for the model's provider ends with
 *   `missing_provider_credential`, and the **environment is not a fallback** — a decoy
 *   `OPENAI_API_KEY` in the server's own environment changes nothing;
 * - a key the provider refuses is refused on save (422) and never stored.
 *
 * Every scenario gets an account of its own, because the file shares one database: a
 * credential stored for one test's user must not be the next test's credential.
 *
 * The one thing this file does not do is `PUT` a *good* key: validation is a real provider
 * call and the process boundary has no seam for it (`provider-validation.ts`), so the stored
 * credentials here are seeded the way the route stores them (`harness/credentials.ts`). The
 * PUT path itself runs for real in `provider-smoke.test.ts`, when a real key is in the
 * environment.
 */

const harness = e2eHarness('credentials')

/** A key with a recognisable middle, so a dump can be grepped for it meaningfully. */
/**
 * A **throwaway** RSA key, generated for this test and protecting nothing — the same trade the
 * provider-stub TLS leaf makes (`fixtures/provider-stub/README.md` says so of that one). A
 * Vertex credential has to carry a key `google-auth-library` can *sign* a JWT with: with a
 * fake PEM the signing fails locally, before the stub could answer the token exchange, and the
 * listing would never be exercised. This key signs nothing but the stub's own token request.
 */
const VERTEX_PRIVATE_KEY =
  '-----BEGIN PRIVATE KEY-----\n' +
  'MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC5zi1kVAD33MjG\n' +
  '2bsiZjMWF2BKZXh1pYqWaGe4h36yo4uowg2Aw2iigUMel9rFsrrGrTjeY0N2mZEi\n' +
  '3kvtoN8ql6rlNVdv9uJfIDbWlTJRssfufdCVeaWShU6VRcGjDDl/20cfxVmaMWi6\n' +
  'HcCcW+G4axyEjajyIIkqb84bQCs3sDa3+mTL6KGO4Rv+hKm7Nh5nrRymKqwAswG2\n' +
  'AfzTIDj6F0eQnkcpROr6/CjAla8EcLhLvCEdfCAw9wrNtPi69pvIQEa7qKO1hppV\n' +
  'GAcu1Hrcpe7zmQzH3ZpfBa6GSqvpx4uFVyIPGQgWE98WOgsXEYcAvEXiqYHuhtq6\n' +
  'PHe3FsC1AgMBAAECggEAIHEMEmQrbhuVz8h06N7sxQrsVFkOtQXkInpUv86ik8jD\n' +
  '6gGFz4lu487LfBQ6DcI049sbXpL41MSf53VmTvWDeaGVJGORono6EK9ke8d9i2+6\n' +
  'glzj1jFw9BoD/EK7ej84a+dKrhSsXiSJ21M2DebqDKPhDRDZ4nrFUExIsY/c6+Iz\n' +
  'jJZAkIRn36fopxI8kuRap+u/2vohzaxsNth55IJCNBUfQYctgeG7VRaiQ01TdDJz\n' +
  'ajDbbhoIRDnUVAnqQcl3SkG9rguFt+6vma8rxmPSEQdnTNIqeyYHyXq5CRCALovr\n' +
  'OE0Mf5oRSc72YRr8zH+cUs8GyzjK+Gfpp5dAn5LH+QKBgQDlpUJLbSJ2dApjyAjX\n' +
  'ZrC7dkHXTglNYr23d1s4WcvFLNG+EudeU3ucWOvZuMLpPig+BOFZLSFKfVoanPun\n' +
  '3jkM7HcEndk8YPuRQB4ORJYx+iQRVCkbnR6XteDztHv4sAjLqh5Beq9+B/9rnaBa\n' +
  '5nmt+F2MUw5mNZhdHlsrXhMR/QKBgQDPIPDusdk3FuI8AKiV0OJl5UdS3PuMc29F\n' +
  'h4ToR/Nyd/nLOoJ/A1eStGMoDc+/H7ZzlZUBPw49obaNoeICjJ7W14Mq3YNuytry\n' +
  'yniHBatmlOvHnVt/jb45JHs/nWICnjYFZrC5aeuY4R9yyvYN37gySd+rqvcX0z51\n' +
  'efz6pe6rGQKBgQCwYHgFdGG2trNQJc/cmIt+v3ocQlxUqlTp92sBYb5mx2CkauJ3\n' +
  'CQl0cLtcclKJT+sajycBFe9uxc4RiKakLMKGkYtr6Uxy2k39JlCvRrBQ3D0dbhVQ\n' +
  'lyFrBg8rPmDFBXcL7bHlOrRUyRG89si1aDTmkE5RO21gxSMryefd7BgbhQKBgQCT\n' +
  'cWOQxtFVQdjx1ZYsb3F6D2hiOCRoqpN+7yVRJEbMKVOLs67JM1vXdslO7eYAq1Z5\n' +
  'mPVk2boNbVxCHgaAwhEf5nHcxaqV55lMU4zQsNx+PWxJwF4twnyyuKFze1kVfAIA\n' +
  'fkU294taXIbCdHALGEJKqgOqdB1IvHstrRTEZ/IpoQKBgQDjGdPZZn445XO41db6\n' +
  '8F0hy2uP83bVfFcFbD0XFzlfBuBmEPd0aJiZU5JDgVmWv28hFQXTYl3y61MdxbPV\n' +
  'lOzQUWn8Cw2cNa7JvhfqYNpSSkBfqEJKxmiZMxOY/gb3/XWNADBhVJ9xIDvj5C+p\n' +
  'bPmEyi4igRe6KaHdoUUfXy0kiw==\n' +
  '-----END PRIVATE KEY-----\n'

/** A distinctive slice of the key's body, for the "never logged" assertions. */
const VERTEX_KEY_MARKER = VERTEX_PRIVATE_KEY.slice(30, 70)

/** A service-account document for the vertex tests, carrying the throwaway key above. */
const VERTEX_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'openharness-vertex',
  private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  private_key: VERTEX_PRIVATE_KEY,
  client_email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
})

const PLAINTEXT = 'sk-ant-e2e-must-never-be-stored-7c41'
const MIDDLE = 'e2e-must-never-be-stored'
const LAST_FOUR = '7c41'

/** One page of a Model Garden list, in the shape Google's REST reference documents (#273). */
function publisherModelsPage(resources: readonly string[]): unknown {
  return {
    publisherModels: resources.map((name) => ({
      name,
      versionId: '1',
      openSourceCategory: 'PROPRIETARY',
      launchStage: 'GA',
      versionState: 'VERSION_STATE_STABLE',
    })),
  }
}

/** The publisher models the stub's Model Garden offers: runnable ones, and two it is not. */
const STUB_GOOGLE_MODELS = [
  'publishers/google/models/gemini-2.5-pro',
  // Gemini's image family: this build has a Gemini client, and the chat filter still drops it.
  'publishers/google/models/gemini-2.5-flash-image',
  // No client in this build at all.
  'publishers/google/models/imagen-3.0-generate-002',
]
const STUB_ANTHROPIC_MODELS = [
  'publishers/anthropic/models/claude-sonnet-4-5@20250929',
  'publishers/anthropic/models/claude-opus-4-1@20250805',
]

/**
 * Answer every Google-side call a Vertex listing makes, the way Google documents it: the OAuth
 * token exchange (which `google-auth-library` sends through the egress proxy like any other
 * request), both `publishers/{publisher}/models` lists for the credential's location, and the
 * project-scoped `modelGardenEula:check` — which says yes only for the ids in `enabled`.
 *
 * `refuse` makes the two lists answer that status instead, for the degrade path.
 */
function answerVertexListing(
  stub: ProviderStub,
  input: { readonly enabled: readonly string[]; readonly refuse?: number },
): void {
  const page = (
    resources: readonly string[],
  ): { json: unknown } | { status: number; json: unknown } =>
    input.refuse === undefined
      ? { json: publisherModelsPage(resources) }
      : {
          status: input.refuse,
          json: { error: { code: input.refuse, status: 'PERMISSION_DENIED' } },
        }

  stub.answer('oauth2.googleapis.com', (request) =>
    request.path.startsWith('/token')
      ? { json: { access_token: 'ya29.e2e-vertex-token', expires_in: 3600, token_type: 'Bearer' } }
      : undefined,
  )
  stub.answer('europe-west4-aiplatform.googleapis.com', (request) => {
    if (request.path.startsWith('/v1beta1/publishers/google/models')) {
      return page(STUB_GOOGLE_MODELS)
    }
    if (request.path.startsWith('/v1beta1/publishers/anthropic/models')) {
      return page(STUB_ANTHROPIC_MODELS)
    }
    return undefined
  })
  stub.answer('aiplatform.googleapis.com', (request) => {
    if (!request.path.startsWith('/v1beta1/projects/openharness-vertex/modelGardenEula:check')) {
      return undefined
    }
    const resource = (JSON.parse(request.body) as { publisherModel?: string }).publisherModel ?? ''
    const model = resource.replace(/^publishers\/anthropic\/models\//u, '')
    return {
      json: {
        projectNumber: '42',
        publisherModel: resource,
        publisherModelEulaAcked: input.enabled.includes(model),
      },
    }
  })
}

/**
 * Put this test's servers away now rather than at the file's teardown, so a stubbed Vertex
 * listing's server does not stay up for every other file on a small runner (`kill` is
 * idempotent — the teardown's own call is a no-op after this).
 */
async function killServers(): Promise<void> {
  await Promise.all(harness.servers.map(async (server) => server.kill()))
}

/** A signed-in person nobody else in this file shares. */
async function person(server: ServerProcess, name: string): Promise<Person> {
  return personFor(
    server,
    await harness.user(server, {
      email: `${name}@credentials.test`,
      password: `${name}-password`,
    }),
  )
}

/** Everything a text-search can reach in a database, as one string. */
async function dumpDatabase(databaseName: string): Promise<string> {
  return withDatabaseClient(
    async (client) => {
      const tables = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public'`,
      )
      const parts: string[] = []
      for (const { table_name: table } of tables.rows) {
        const rows = await client.query(`select * from "${table}"`)
        parts.push(`${table}: ${JSON.stringify(rows.rows)}`)
      }
      return parts.join('\n')
    },
    { database: databaseName },
  )
}

/** The `session.error` events in a log. */
function sessionErrors(log: Awaited<ReturnType<typeof readLog>>): SessionErrorEvent[] {
  return log.filter((event): event is SessionErrorEvent => event.type === EVENT_TYPES.sessionError)
}

/** Run one turn on a fresh agent and answer its log. */
async function runTurn(
  me: Person,
  prompt: string,
  model = 'anthropic/claude-sonnet-5',
): Promise<Awaited<ReturnType<typeof readLog>>> {
  const agent = await me.client.agents.create({
    name: `Credential agent (${model})`,
    model: { id: model },
  })
  const session = await me.client.sessions.create({ agent: agent.id })
  const sent = await me.client.sendMessage(session.id, prompt)
  await waitForTurnEnd(me.client, session.id, { afterSeq: sent.seq })
  return readLog(me.client, session.id)
}

describe('provider credentials (A5)', () => {
  it('never returns a stored key — in any response, event or stream', async () => {
    const server = await harness.server()
    const me = await person(server, 'reader')
    await seedProviderCredential(await harness.database(), {
      userId: me.signedIn.user.id,
      name: 'anthropic',
      apiKey: PLAINTEXT,
    })

    // The API's own answer: metadata only — the provider, the last four characters for
    // recognition, the timestamps. Nothing else, in any spelling.
    const listed = await me.client.providerCredentials.list()
    expect(listed.data.map((credential: ProviderCredential) => credential.name)).toEqual([
      'anthropic',
    ])
    expect(listed.data[0]?.last4).toBe(LAST_FOUR)
    expect(JSON.stringify(listed)).not.toContain(MIDDLE)

    // Every other read a client can make: who am I, my agents, my sessions, that session's
    // whole log — and the live stream over it, deltas included.
    const agent = await me.client.agents.create({
      name: 'Credential agent',
      model: { id: 'anthropic/claude-sonnet-5' },
    })
    const session = await me.client.sessions.create({ agent: agent.id })
    const stream = collectStream(me.client, session.id, { deltas: true })
    const sent = await me.client.sendMessage(session.id, 'a turn that carries no key with it')
    await waitForTurnEnd(me.client, session.id, { afterSeq: sent.seq })
    await stream.waitFor((events) => events.some(isStoredIdle), 'the streamed turn to end')
    await stream.stop()

    const readings: readonly (readonly [string, unknown])[] = [
      ['GET /v1/me', await me.client.me()],
      ['GET /v1/agents', await me.client.agents.list()],
      ['GET /v1/sessions', await me.client.sessions.list()],
      ['GET /v1/provider-credentials', listed],
      ['the session log', await readLog(me.client, session.id)],
      ['the live stream', stream.events],
      ['the server log', server.output()],
    ]
    for (const [what, value] of readings) {
      const text = JSON.stringify(value)
      expect([what, text.includes(MIDDLE)]).toEqual([what, false])
      expect([what, text.includes(PLAINTEXT)]).toEqual([what, false])
    }
  })

  it('keeps a key sealed at rest: nothing in the row, nothing in the database', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const me = await person(server, 'sealed')
    await seedProviderCredential(database, {
      userId: me.signedIn.user.id,
      name: 'anthropic',
      apiKey: PLAINTEXT,
    })

    // The row itself: the envelope the vault wrote, and `last4` — the one piece of the secret
    // that is deliberately stored in the open, for the settings screen to recognise it by.
    const row = await withDatabaseClient(
      async (client) =>
        client.query<{ ciphertext: string; nonce: string; wrapped_key: string; last4: string }>(
          'select ciphertext, nonce, wrapped_key, last4 from provider_credentials where user_id = $1',
          [me.signedIn.user.id],
        ),
      { database: database.name },
    )
    expect(row.rows).toHaveLength(1)
    const stored = row.rows[0]
    expect(stored?.last4).toBe(LAST_FOUR)
    expect(stored?.ciphertext).not.toContain(MIDDLE)
    expect(stored?.wrapped_key).not.toContain(MIDDLE)
    expect(stored?.nonce).not.toContain(MIDDLE)

    // The whole database, every column of every table: the key is in none of it. `last4` is
    // the only trace, which is the epic's deliberate exception.
    const dump = await dumpDatabase(database.name)
    expect(dump).not.toContain(MIDDLE)
    expect(dump).not.toContain(PLAINTEXT)
    expect(dump).toContain(LAST_FOUR)
  })

  it('ends a turn with missing_provider_credential when the owner has no key', async () => {
    // No `OPENHARNESS_TEST_MODEL`: the real router, the real resolver, and a person with no
    // credential — so the turn must end before any request is made (the provider is never
    // contacted, which is why this runs without a network).
    const server = await harness.server({ mockModel: false })
    expect(server.output()).toMatch(/model: provider factory/)
    const me = await person(server, 'keyless')

    const log = await runTurn(me, 'this must not reach a provider')
    const errors = sessionErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error.type).toBe('missing_provider_credential')
    // Never retried (the protocol refuses any other retry status for this type), and the
    // message names the provider so a client can point at the right Settings entry.
    expect(errors[0]?.error.retry_status.type).toBe('exhausted')
    expect(errors[0]?.error.message).toContain('Anthropic')
    // The turn is over, and nothing was answered.
    expect(log.at(-1)?.type).toBe(EVENT_TYPES.sessionStatusIdle)
    expect(log.some((event) => event.type === EVENT_TYPES.agentMessage)).toBe(false)
  })

  it('ignores provider keys in the environment — a decoy OPENAI_API_KEY changes nothing', async () => {
    // The decoy is deliberately a *valid-looking* key, and the agent's provider is the one it
    // pretends to be for: if any code path still read the environment, this turn would reach
    // OpenAI with it.
    const decoy = 'sk-decoy-that-must-never-be-used-0000'
    const server = await harness.server({
      mockModel: false,
      env: { OPENAI_API_KEY: decoy, ANTHROPIC_API_KEY: decoy },
    })
    const me = await person(server, 'decoy')

    const log = await runTurn(me, 'this must not use the environment key', 'openai/gpt-5.1')
    const errors = sessionErrors(log)
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error.type).toBe('missing_provider_credential')
    expect(errors[0]?.error.message).toContain('OpenAI')

    // And the decoy never surfaces anywhere the server writes: not in its log, and not in
    // anything a client can read.
    expect(server.output()).not.toContain(decoy)
    expect(JSON.stringify(await me.client.providerCredentials.list())).not.toContain(decoy)
  })

  it('refuses a key the provider rejects, and stores nothing', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const me = await person(server, 'refused')

    // One cheap provider call happens on save (A5). A key nothing issued is refused by the
    // provider — or, in an environment without egress, is not reachable at all; either way the
    // key cannot be validated, and an unvalidated key is not stored.
    const refused = await errorOf(() =>
      me.client.providerCredentials.put('anthropic', { type: 'api_key', api_key: PLAINTEXT }),
    )
    expect(refused.status).toBe(422)
    expect(refused.type).toBe('invalid_provider_credential')

    // The refusal says nothing about the key, and nothing was written for this person.
    expect(refused.message).not.toContain(MIDDLE)
    await expect(me.client.providerCredentials.list()).resolves.toEqual({ data: [] })
    const rows = await withDatabaseClient(
      async (client) =>
        client.query('select 1 from provider_credentials where user_id = $1', [
          me.signedIn.user.id,
        ]),
      { database: database.name },
    )
    expect(rows.rowCount).toBe(0)
  })

  it('deletes a credential, and the next turn is a missing-credential turn again', async () => {
    const server = await harness.server({ mockModel: false })
    const database = await harness.database()
    const me = await person(server, 'deleter')
    await seedProviderCredential(database, {
      userId: me.signedIn.user.id,
      name: 'anthropic',
      apiKey: PLAINTEXT,
    })
    await expect(me.client.providerCredentials.list()).resolves.toMatchObject({
      data: [{ name: 'anthropic', last4: LAST_FOUR }],
    })

    await me.client.providerCredentials.delete('anthropic')

    // Deleting twice is not an error, and the list is empty.
    await expect(me.client.providerCredentials.delete('anthropic')).resolves.toBeUndefined()
    await expect(me.client.providerCredentials.list()).resolves.toEqual({ data: [] })

    // The effect is the point: a turn that had a key no longer does. (The turn never reaches a
    // provider either way — the seeded key was never a real one — so this stays offline.)
    const errors = sessionErrors(await runTurn(me, 'no key any more'))
    expect(errors.map((event) => event.error.type)).toEqual(['missing_provider_credential'])
  })

  it('refuses an azure endpoint inside the network, and a name a provider owns (#245, A3a)', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const me = await person(server, 'azure-refusals')
    const azure = (endpoint: string) => ({
      type: 'azure_openai' as const,
      endpoint,
      api_key: 'az-key-4242',
      deployments: ['gpt-4o'],
    })

    // The SSRF guard runs **on save**: a loopback, link-local or metadata endpoint is refused
    // before any request is made, so a credential like this can never be stored at all — and
    // therefore never reached by a model call later.
    for (const endpoint of [
      'https://127.0.0.1',
      'https://localhost',
      'https://169.254.169.254',
      'https://metadata.google.internal',
    ]) {
      const refused = await errorOf(() =>
        me.client.providerCredentials.put('azure', azure(endpoint)),
      )
      expect([endpoint, refused.status]).toEqual([endpoint, 422])
      expect([endpoint, refused.type]).toEqual([endpoint, 'invalid_provider_credential'])
      expect([endpoint, refused.message.includes('az-key-4242')]).toEqual([endpoint, false])
    }

    // The endpoint has to be https (the schema's 400, before the guard is reached at all).
    const insecure = await errorOf(() =>
      me.client.providerCredentials.put('azure', azure('http://x.openai.azure.com')),
    )
    expect([insecure.status, insecure.type]).toEqual([400, 'invalid_request_error'])

    // A named credential may not take a fixed provider id: it would make `openai/gpt-5`
    // ambiguous between the provider and an Azure credential that called itself openai.
    const taken = await errorOf(() =>
      me.client.providerCredentials.put('openai', azure('https://x.openai.azure.com')),
    )
    expect([taken.status, taken.type]).toEqual([400, 'invalid_request_error'])

    // Nothing was stored by any of them.
    await expect(me.client.providerCredentials.list()).resolves.toEqual({ data: [] })
    const rows = await withDatabaseClient(
      async (client) =>
        client.query('select 1 from provider_credentials where user_id = $1', [
          me.signedIn.user.id,
        ]),
      { database: database.name },
    )
    expect(rows.rowCount).toBe(0)
  })

  it('lists one model per azure deployment, from the stored credential (A3a)', async () => {
    const server = await harness.server()
    const me = await person(server, 'azure-catalog')
    await seedAzureCredential(await harness.database(), {
      userId: me.signedIn.user.id,
      name: 'azure',
      endpoint: 'https://my-resource.openai.azure.com',
      apiKey: PLAINTEXT,
      deployments: ['gpt-4o', 'my-private-deployment'],
    })

    const catalog = await me.client.models.list()
    expect(catalog.data.map((entry) => entry.id)).toEqual([
      'azure/gpt-4o',
      'azure/my-private-deployment',
    ])
    // The deployment models.dev knows carries its context window; the one it does not gets
    // `null` rather than a guessed number.
    expect(catalog.data[0]).toMatchObject({
      provider: 'azure',
      name: 'GPT-4o',
      context_window: 128000,
    })
    expect(catalog.data[1]).toMatchObject({ context_window: null, max_output_tokens: null })
    expect(catalog.providers).toEqual([
      expect.objectContaining({ provider: 'azure', status: 'ok', message: null }),
    ])
    // Nothing about the credential leaks into the catalog: not the key, not the endpoint.
    expect(JSON.stringify(catalog)).not.toContain('openai.azure.com')
    expect(JSON.stringify(catalog)).not.toContain(MIDDLE)
  })

  it('refuses a bedrock region AWS does not serve, and a name a provider owns (#245, A3c)', async () => {
    const server = await harness.server()
    const me = await person(server, 'bedrock-refusals')
    // The cast is the point of the test: these are the strings a client should never send, and
    // the request schema is what refuses them.
    const bedrock = (region: string) => ({
      type: 'bedrock' as const,
      access_key_id: 'AKIAIOSFODNN7EXAMPLE',
      secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: region as BedrockRegion,
    })

    // The region goes into an AWS hostname, so it is validated against the protocol's list
    // before anything is called: a region that is not one is the schema's 400, not a request
    // to a host nobody chose.
    for (const region of ['us-east-3', 'evil.example', 'us-gov-west-1']) {
      const refused = await errorOf(() =>
        me.client.providerCredentials.put('bedrock', bedrock(region)),
      )
      expect([region, refused.status]).toEqual([region, 400])
      expect([region, refused.type]).toEqual([region, 'invalid_request_error'])
      expect([region, refused.message.includes('AKIAIOSFODNN7EXAMPLE')]).toEqual([region, false])
    }

    // A named credential may not take a fixed provider id — it would make `openai/gpt-5`
    // ambiguous between the provider and a Bedrock credential that called itself openai.
    const taken = await errorOf(() =>
      me.client.providerCredentials.put('openai', bedrock('us-east-1')),
    )
    expect([taken.status, taken.type]).toEqual([400, 'invalid_request_error'])

    // Nothing was stored by any of them.
    await expect(me.client.providerCredentials.list()).resolves.toEqual({ data: [] })
  })

  it('serves a seeded bedrock credential’s models from the registry, visibly (#245, A3c)', async () => {
    const server = await harness.server()
    const me = await person(server, 'bedrock-catalog')
    await seedBedrockCredential(await harness.database(), {
      userId: me.signedIn.user.id,
      name: 'bedrock',
      region: 'eu-west-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: PLAINTEXT,
    })

    // AWS refuses the fake keys (or is unreachable), so the region's own list cannot be read —
    // and the answer is the registry's Bedrock models, reported as a visible `fallback` (C3)
    // exactly as an unreachable provider is for the eleven fixed ids. The suite is
    // deterministic either way: a 403 and a transport failure both land here.
    const catalog = await me.client.models.list()
    expect(catalog.providers).toEqual([
      expect.objectContaining({ provider: 'bedrock', status: 'fallback' }),
    ])
    expect(catalog.data.length).toBeGreaterThan(0)
    expect(catalog.data.every((entry) => entry.provider === 'bedrock')).toBe(true)
    // The ids are `<credential name>/<bedrock model id>` and the list is models.dev's Amazon
    // Bedrock models, acknowledged to the model id and priced where the registry has a rate.
    // No particular upstream id is asserted — the snapshot moves with models.dev — only that the
    // join reached it: every entry carries the credential's own name, some entry is a family
    // models.dev files under Bedrock, and the prices came with them.
    expect(catalog.data.some((entry) => entry.id.startsWith('bedrock/anthropic.'))).toBe(true)
    expect(catalog.data.some((entry) => entry.cost !== null)).toBe(true)
    // Nothing about the credential leaks into the catalog: not the keys, not the name.
    const serialized = JSON.stringify(catalog)
    for (const secret of ['AKIAIOSFODNN7EXAMPLE', MIDDLE]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('refuses a vertex document that is not a service-account key, and lists a seeded one live (A3d, #273)', async () => {
    // Every Google-side call is the stub's: the token exchange (which google-auth-library
    // makes through the egress proxy like anything else), the two publisher lists, and the
    // Model Garden enablement check. Nothing here reaches Google.
    const stub = await startProviderStub()
    answerVertexListing(stub, { enabled: ['claude-sonnet-4-5@20250929'] })
    try {
      const server = await harness.server({ env: stub.env })
      const me = await person(server, 'vertex-catalog')

      // The document is checked **before** it is sealed, so a file that is not a service-account
      // key — the wrong download from the console, a gcloud ADC file — is the schema's 400 and
      // never reaches the vault or a provider call.
      for (const service_account of [
        '{}',
        'not json',
        JSON.stringify({ type: 'authorized_user', refresh_token: 'x' }),
      ]) {
        const refused = await errorOf(() =>
          me.client.providerCredentials.put('vertex', {
            type: 'vertex',
            service_account,
            project: 'openharness-vertex',
            location: 'europe-west4',
          }),
        )
        expect([service_account, refused.status]).toEqual([service_account, 400])
        expect([service_account, refused.type]).toEqual([service_account, 'invalid_request_error'])
      }
      // A location outside Google's list, and a project that is not a project id: the same 400.
      // A location outside Google's list, and a project that is not a project id. The typed
      // client refuses both before a request exists, so these bodies go over the wire by hand —
      // the same 400 either way, and nothing stored.
      for (const body of [
        {
          type: 'vertex',
          service_account: VERTEX_KEY,
          project: 'openharness-vertex',
          location: 'mars-north1',
        },
        {
          type: 'vertex',
          service_account: VERTEX_KEY,
          project: 'Not A Project',
          location: 'europe-west4',
        },
      ]) {
        const refused = await fetch(`${server.baseUrl}/v1/provider-credentials/vertex`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${me.signedIn.token}`,
          },
          body: JSON.stringify(body),
        })
        expect([body.location, body.project, refused.status]).toEqual([
          body.location,
          body.project,
          400,
        ])
        expect(ApiErrorBodySchema.parse(await refused.json()).error.type).toBe(
          'invalid_request_error',
        )
      }
      // A named type may not take a fixed provider id — the Vertex form of the azure rule.
      await expect(
        me.client.providerCredentials.put('openai', {
          type: 'vertex',
          service_account: VERTEX_KEY,
          project: 'openharness-vertex',
          location: 'europe-west4',
        }),
      ).rejects.toMatchObject({ status: 400, type: 'invalid_request_error' })
      await expect(me.client.providerCredentials.list()).resolves.toEqual({ data: [] })

      // A stored credential lists what the project can actually call: both publishers read live
      // from Model Garden, joined with the vendored models.dev snapshot for prices and windows —
      // and nothing of the private key. The Anthropic half is narrowed to the model this project
      // enabled; the disabled one is not offered (it would have failed on the first message).
      await seedVertexCredential(await harness.database(), {
        userId: me.signedIn.user.id,
        name: 'vertex',
        serviceAccount: VERTEX_KEY,
        project: 'openharness-vertex',
        location: 'europe-west4',
      })

      const catalog = await me.client.models.list()
      const ids = catalog.data.map((entry) => entry.id)
      expect(ids).toContain('vertex/gemini-2.5-pro')
      expect(ids).toContain('vertex/claude-sonnet-4-5@20250929')
      expect(ids).not.toContain('vertex/claude-opus-4-1@20250805')
      // Nothing the build has no client for: the MaaS models Google resells on Vertex, and the
      // non-chat families.
      expect(ids.some((id) => id.includes('maas'))).toBe(false)
      expect(ids.some((id) => id.includes('embedding'))).toBe(false)
      const gemini = catalog.data.find((entry) => entry.id === 'vertex/gemini-2.5-pro')
      expect(gemini).toMatchObject({ provider: 'vertex', context_window: 1048576 })
      expect(typeof gemini?.cost?.input).toBe('number')
      expect(catalog.providers).toEqual([
        expect.objectContaining({ provider: 'vertex', status: 'ok', message: null }),
      ])
      expect(JSON.stringify(catalog)).not.toContain(VERTEX_KEY_MARKER)

      // Which calls the listing cost: the token exchange, both publisher lists for the
      // credential's own location, and the enablement check for each model this build can run —
      // and never the private key, in any of them.
      const google = stub.requests.filter(
        (request) => request.host === 'europe-west4-aiplatform.googleapis.com',
      )
      expect(google.map((request) => request.path.split('?')[0])).toEqual([
        '/v1beta1/publishers/google/models',
        '/v1beta1/publishers/anthropic/models',
      ])
      expect(google.every((request) => request.method === 'GET')).toBe(true)
      expect(stub.requests.some((request) => request.host === 'oauth2.googleapis.com')).toBe(true)
      const checks = stub.requests.filter(
        (request) => request.method === 'POST' && request.host === 'aiplatform.googleapis.com',
      )
      expect(checks.map((request) => request.host)).toEqual([
        'aiplatform.googleapis.com',
        'aiplatform.googleapis.com',
      ])
      expect(
        checks.map(
          (request) => (JSON.parse(request.body) as { publisherModel: string }).publisherModel,
        ),
      ).toEqual([
        'publishers/anthropic/models/claude-sonnet-4-5@20250929',
        'publishers/anthropic/models/claude-opus-4-1@20250805',
      ])
      expect(stub.requests.every((request) => !request.path.includes(VERTEX_KEY_MARKER))).toBe(true)
    } finally {
      await killServers()
      await stub.stop()
    }
  })

  it('lists the snapshot’s Vertex models, with the reason, when the Model Garden listing is refused (#273)', async () => {
    const stub = await startProviderStub()
    answerVertexListing(stub, { enabled: [], refuse: 403 })
    try {
      const server = await harness.server({ env: stub.env })
      const me = await person(server, 'vertex-degraded')
      await seedVertexCredential(await harness.database(), {
        userId: me.signedIn.user.id,
        name: 'vertex',
        serviceAccount: VERTEX_KEY,
        project: 'openharness-vertex',
        location: 'europe-west4',
      })

      const catalog = await me.client.models.list()
      const ids = catalog.data.map((entry) => entry.id)
      // The list this source answered before #273 — the snapshot's Vertex models, through the
      // same two filters — so a degraded project keeps a usable picker.
      expect(ids).toContain('vertex/gemini-2.5-pro')
      expect(ids).toContain('vertex/claude-sonnet-4-5@20250929')
      expect(ids.some((id) => id.includes('maas'))).toBe(false)
      expect(catalog.providers).toEqual([
        expect.objectContaining({
          provider: 'vertex',
          status: 'fallback',
          fetched_at: null,
        }),
      ])
      // Google's own words, and no part of the credential.
      expect(catalog.providers[0]?.message).toContain(
        'the google publisher model list answered 403',
      )
      expect(JSON.stringify(catalog)).not.toContain(VERTEX_KEY_MARKER)
    } finally {
      await killServers()
      await stub.stop()
    }
  })

  it('answers 404 in the envelope for a route that does not exist', async () => {
    const server = await harness.server()
    const me = await person(server, 'router')

    const unknown = await fetch(`${server.baseUrl}/v1/provider-credentials/anthropic/extra`, {
      method: 'GET',
      headers: { authorization: `Bearer ${me.signedIn.token}` },
    })
    expect(unknown.status).toBe(404)
    expect(ApiErrorBodySchema.parse(await unknown.json()).error.type).toBe('not_found_error')
  })
})
