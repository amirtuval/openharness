import { describe, expect, it } from 'vitest'

import {
  ApiErrorBodySchema,
  EVENT_TYPES,
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
  seedProviderCredential,
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
      provider: 'anthropic',
      apiKey: PLAINTEXT,
    })

    // The API's own answer: metadata only — the provider, the last four characters for
    // recognition, the timestamps. Nothing else, in any spelling.
    const listed = await me.client.providerCredentials.list()
    expect(listed.data.map((credential: ProviderCredential) => credential.provider)).toEqual([
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
      provider: 'anthropic',
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
      provider: 'anthropic',
      apiKey: PLAINTEXT,
    })
    await expect(me.client.providerCredentials.list()).resolves.toMatchObject({
      data: [{ provider: 'anthropic', last4: LAST_FOUR }],
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
