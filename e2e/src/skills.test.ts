import { SKILL_MD_FILENAME, EVENT_TYPES, newSkillId, skillFileSize } from '@openharness/protocol'
import type {
  AgentToolResultEvent,
  AgentToolUseEvent,
  EventInput,
  ModelRequestStartEvent,
  SessionSkillLoadedEvent,
} from '@openharness/protocol'
import { SKILL_READ_TOOL_NAME, SKILL_TOOL_NAME } from '@openharness/hands'
import { MOCK_SKILL_MARKER, MOCK_SKILL_READ_MARKER } from '@openharness/server'
import type { Client } from '@openharness/client'
import { describe, expect, it } from 'vitest'

import type { E2eDatabase, ServerProcess } from './harness'
import {
  clientFor,
  e2eHarness,
  errorOf,
  readLog,
  waitForTurnEnd,
  withDatabaseClient,
} from './harness'

/**
 * Skills through the real thing (epic #349, K6/K7; issue #352).
 *
 * The whole path: a built server, a real Postgres, the deterministic model and the built client.
 * A skill is seeded **into the database** — import is #351's, so there is no route to write one
 * through yet — and then read the ways a chat reads one: the mock model calls `skill` and
 * `skill_read` on its markers, and a `/name arguments` message is loaded, stored and answered.
 *
 * The log is the evidence, as it is for the loop itself: the tools a request was really offered
 * are on its `span.model_request_start`, the body the model was handed is in
 * `session.skill_loaded` exactly as it was given, and the deterministic model's reply is the
 * prompt it was sent — which is how "the chat ran on the skill's instructions" is checkable
 * from the outside.
 */

const harness = e2eHarness('skills')

/** The instructions a seeded skill carries, with the placeholder a slash invocation fills in. */
const SKILL_MD = [
  '---',
  'name: release-notes',
  'description: Writes the release notes for a version.',
  'argument-hint: "[version]"',
  '---',
  '',
  'Write the release notes for $ARGUMENTS.',
].join('\n')

const TONE = 'Be terse.'

/** The commit the seeded snapshot claims, so the log's record of it is checkable. */
const COMMIT_SHA = '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5'

/**
 * Seed one skill for a signed-in person, the way an import would.
 *
 * The two tables `@openharness/session`'s `0032` migration creates, written directly: the
 * server under test has already migrated this file's database, and no route can write a
 * snapshot until #351 lands.
 */
async function seedSkill(
  database: E2eDatabase,
  ownerId: string,
  options: {
    readonly name?: string
    readonly frontmatter?: Record<string, unknown>
    readonly enabled?: boolean
  } = {},
): Promise<string> {
  const id = newSkillId()
  await withDatabaseClient(
    async (client) => {
      await client.query(
        `insert into skills
           (id, owner_id, name, description, frontmatter, source_url, source_ref, source_path,
            commit_sha, enabled, imported_at, refreshed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())`,
        [
          id,
          ownerId,
          options.name ?? 'release-notes',
          'Writes the release notes for a version.',
          JSON.stringify(options.frontmatter ?? {}),
          'https://github.com/example/skills',
          'main',
          'release-notes',
          COMMIT_SHA,
          options.enabled ?? true,
        ],
      )
      await client.query(
        `insert into skill_files (skill_id, path, content, size) values ($1, $2, $3, $4)`,
        [id, SKILL_MD_FILENAME, SKILL_MD, skillFileSize(SKILL_MD)],
      )
      await client.query(
        `insert into skill_files (skill_id, path, content, size) values ($1, $2, $3, $4)`,
        [id, 'reference/tone.md', TONE, skillFileSize(TONE)],
      )
    },
    { database: database.name },
  )
  return id
}

/**
 * One account of this file's own, plus a client carrying it.
 *
 * A seeded skill belongs to its owner, and every test here seeds one — so each test needs an
 * account whose skills no other test has touched. (The file's database is shared: skills live
 * in Postgres, not in the server process.)
 */
async function person(
  server: ServerProcess,
  label: string,
): Promise<{ readonly client: Client; readonly id: string }> {
  const email = `${label}@skills.example.com`
  const signedIn = await harness.user(server, { email, password: 'e2e-password-123' })
  return { client: clientFor(server, signedIn), id: signedIn.user.id }
}

/** Create a chat on the mock model and answer its id. */
async function newChat(client: Client): Promise<string> {
  const created = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })
  return created.id
}

/** Send one message and wait for the turn it starts to end. */
async function say(client: Client, sessionId: string, text: string): Promise<void> {
  await sendAndWait(client, sessionId, {
    type: 'user.message',
    content: [{ type: 'text', text }],
  })
}

/**
 * Run a skill as a slash command: the text the user typed, and the skill it names (K7).
 *
 * The two are one message — the transcript keeps the command, and the server checks the name
 * against the skills in force before anything lands.
 */
async function run(client: Client, sessionId: string, name: string, args?: string): Promise<void> {
  await sendAndWait(client, sessionId, {
    type: 'user.message',
    content: [{ type: 'text', text: args === undefined ? `/${name}` : `/${name} ${args}` }],
    skill: { name, ...(args === undefined ? {} : { arguments: args }) },
  })
}

/** Send one event and wait for the turn it starts to end. */
async function sendAndWait(client: Client, sessionId: string, event: EventInput): Promise<void> {
  const sent = await client.sessions.events.send(sessionId, [event])
  const seq = sent.data[0]?.seq
  await waitForTurnEnd(client, sessionId, seq === undefined ? undefined : { afterSeq: seq })
}

/** The spans of a log, in order. */
function spans(log: Awaited<ReturnType<typeof readLog>>): ModelRequestStartEvent[] {
  return log.filter(
    (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
  )
}

/** The `agent.tool_result` events of a log, in order. */
function results(log: Awaited<ReturnType<typeof readLog>>): AgentToolResultEvent[] {
  return log.filter(
    (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
  )
}

/** The text one event carries, as one line. */
function textOfEvent(event: { readonly content: readonly { readonly text: string }[] }): string {
  return event.content.map((block) => block.text).join('')
}

describe('skills through the real server (epic #349; #352)', () => {
  it('offers the two tools, reads the instructions and lists the files', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const { client, id } = await person(server, 'tools')
    await seedSkill(database, id)

    const sessionId = await newChat(client)
    await say(client, sessionId, `${MOCK_SKILL_MARKER} release-notes`)

    const log = await readLog(client, sessionId)
    expect(spans(log)[0]?.tools).toContainEqual({ name: SKILL_TOOL_NAME, source: 'builtin' })
    expect(spans(log)[0]?.tools).toContainEqual({ name: SKILL_READ_TOOL_NAME, source: 'builtin' })

    const calls = log.filter(
      (event): event is AgentToolUseEvent => event.type === EVENT_TYPES.agentToolUse,
    )
    expect(calls.map((call) => call.name)).toEqual([SKILL_TOOL_NAME])
    // The reply is the prompt the deterministic model was sent, so the result it read is the
    // text it answers — the whole round trip, from the snapshot to the reply.
    expect(textOfEvent(results(log)[0]!)).toContain('Write the release notes for $ARGUMENTS.')
    expect(textOfEvent(results(log)[0]!)).toContain(
      `Files (read one with ${SKILL_READ_TOOL_NAME}):`,
    )
    expect(textOfEvent(results(log)[0]!)).toContain(
      `- reference/tone.md (${skillFileSize(TONE)} bytes)`,
    )
  })

  it('reads one file, and refuses a path the skill does not hold', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const { client, id } = await person(server, 'read')
    await seedSkill(database, id)

    const sessionId = await newChat(client)
    await say(client, sessionId, `${MOCK_SKILL_READ_MARKER} release-notes reference/tone.md`)
    let stored = results(await readLog(client, sessionId))
    expect(textOfEvent(stored[0]!)).toBe(TONE)
    expect(stored[0]?.is_error ?? false).toBe(false)

    await say(client, sessionId, `${MOCK_SKILL_READ_MARKER} release-notes nope.md`)
    stored = results(await readLog(client, sessionId))
    expect(stored.at(-1)?.is_error).toBe(true)
    expect(textOfEvent(stored.at(-1)!)).toContain('reference/tone.md')
  })

  it('loads a slash invocation into the log, and answers it with the instructions', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const { client, id } = await person(server, 'slash')
    const skillId = await seedSkill(database, id)

    const sessionId = await newChat(client)
    await run(client, sessionId, 'release-notes', 'v1.2')

    const log = await readLog(client, sessionId)
    const messages = log.filter((event) => event.type === EVENT_TYPES.userMessage)
    // The message is stored as the user typed it — a client renders the command it wrote — and
    // the loaded event names it.
    expect(textOfEvent(messages[0]!)).toBe('/release-notes v1.2')
    expect(messages[0]?.type === EVENT_TYPES.userMessage ? messages[0].skill : undefined).toEqual({
      name: 'release-notes',
      arguments: 'v1.2',
    })

    const loaded = log.filter(
      (event): event is SessionSkillLoadedEvent => event.type === EVENT_TYPES.sessionSkillLoaded,
    )
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      message_seq: messages[0]?.seq,
      name: 'release-notes',
      skill_id: skillId,
      commit_sha: COMMIT_SHA,
      // Exactly what the model was given: the body, the placeholder filled in, the frontmatter
      // gone.
      content: 'Write the release notes for v1.2.',
    })
    // A chat that has run a skill keeps what it ran on: a second message loads nothing more.
    await say(client, sessionId, 'thanks')
    expect(
      (await readLog(client, sessionId)).filter(
        (event) => event.type === EVENT_TYPES.sessionSkillLoaded,
      ),
    ).toHaveLength(1)
  })

  it('refuses a slash invocation the chat cannot run, storing nothing', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const { client, id } = await person(server, 'refused')
    await seedSkill(database, id, { name: 'notes', enabled: false })

    const sessionId = await newChat(client)
    const refused = await errorOf(() =>
      client.sessions.events.send(sessionId, [
        {
          type: 'user.message',
          content: [{ type: 'text', text: '/notes' }],
          skill: { name: 'notes' },
        },
      ]),
    )
    expect(refused.status).toBe(400)
    expect(refused.type).toBe('invalid_request_error')
    // Nothing was appended: the batch is one append, and the refusal is before it.
    expect(
      (await readLog(client, sessionId)).filter((event) => event.type === EVENT_TYPES.userMessage),
    ).toEqual([])
  })

  it('offers neither tool to a chat with no skill the model may invoke', async () => {
    const server = await harness.server()
    const { client } = await person(server, 'none')

    const sessionId = await newChat(client)
    await say(client, sessionId, `${MOCK_SKILL_MARKER} release-notes`)

    const log = await readLog(client, sessionId)
    const names = (spans(log)[0]?.tools ?? []).map((tool) => tool.name)
    expect(names).not.toContain(SKILL_TOOL_NAME)
    expect(names).not.toContain(SKILL_READ_TOOL_NAME)
    // The call the model made anyway is answered as a tool nothing carries: a request that
    // offered no skills is exactly a deployment with none.
    expect(textOfEvent(results(log)[0]!)).toContain('No tool named')
  })

  it('leaves a user-only skill out of the listing, and out of a request', async () => {
    const server = await harness.server()
    const database = await harness.database()
    const { client, id } = await person(server, 'user-only')
    await seedSkill(database, id, {
      name: 'manual-check',
      frontmatter: { 'disable-model-invocation': true },
    })

    const sessionId = await newChat(client)
    // The user runs it themselves, which is what the field is for.
    await run(client, sessionId, 'manual-check')

    const log = await readLog(client, sessionId)
    expect(log.filter((event) => event.type === EVENT_TYPES.sessionSkillLoaded)).toHaveLength(1)
    // The model was not told it exists: neither tool is on the request's offer.
    const names = (spans(log)[0]?.tools ?? []).map((tool) => tool.name)
    expect(names).not.toContain(SKILL_TOOL_NAME)
    expect(names).not.toContain(SKILL_READ_TOOL_NAME)
  })

  it('answers another person’s skill as if it did not exist', async () => {
    const server = await harness.server()
    const database = await harness.database()
    // Two accounts, and the skill belongs to the other one: this chat may not see it at all.
    const mine = await person(server, 'isolation-mine')
    const theirs = await person(server, 'isolation-theirs')
    await seedSkill(database, theirs.id)

    const sessionId = await newChat(mine.client)
    await say(mine.client, sessionId, `${MOCK_SKILL_MARKER} release-notes`)

    // The skill belongs to the other account, so this chat has none: neither tool is offered.
    const log = await readLog(mine.client, sessionId)
    const names = (spans(log)[0]?.tools ?? []).map((tool) => tool.name)
    expect(names).not.toContain(SKILL_TOOL_NAME)

    // And the slash invocation is refused for the same reason.
    const refused = await errorOf(() =>
      mine.client.sessions.events.send(sessionId, [
        {
          type: 'user.message',
          content: [{ type: 'text', text: '/release-notes' }],
          skill: { name: 'release-notes' },
        },
      ]),
    )
    expect(refused.status).toBe(400)
  })
})
