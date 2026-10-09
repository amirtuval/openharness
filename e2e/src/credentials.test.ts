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
  waitForTurnEnd,
  withDatabaseClient,
  type Person,
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
/** A service-account document for the vertex tests: shaped like one, and not a real key. */
const VERTEX_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'openharness-vertex',
  private_key_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  private_key:
    '-----BEGIN PRIVATE KEY-----\\nVERTEX-PRIVATE-KEY-DO-NOT-LOG\\n-----END PRIVATE KEY-----\\n',
  client_email: 'vertex-runner@openharness-vertex.iam.gserviceaccount.com',
})

const PLAINTEXT = 'sk-ant-e2e-must-never-be-stored-7c41'
const MIDDLE = 'e2e-must-never-be-stored'
const LAST_FOUR = '7c41'

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

  it('refuses a vertex document that is not a service-account key, and lists a seeded one (A3d)', async () => {
    const server = await harness.server()
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

    // A stored credential lists the publisher models the build can run — Google's and
    // Anthropic's, from the vendored models.dev snapshot — and nothing of the private key.
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
    expect(JSON.stringify(catalog)).not.toContain('VERTEX-PRIVATE-KEY')
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
