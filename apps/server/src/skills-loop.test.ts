import {
  API_VERSION_PREFIX,
  EVENT_TYPES,
  SKILL_MD_FILENAME,
  SessionSchema,
  newSkillId,
  type AgentToolResultEvent,
  type AgentToolUseEvent,
  type ModelRequestStartEvent,
  type Mode,
  type Session,
  type SessionId,
  type SessionSkillLoadedEvent,
  type Skill,
  type SkillId,
  type StoredEvent,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { MOCK_SKILL_MARKER, MOCK_SKILL_READ_MARKER, createMockModelFactory } from './mock-model'
import { createSkillProvider } from './skills'
import { createTurnRegistry } from './tools'
import { createTestApp, postJson, readHistory, waitForIdle, type TestContext } from './test-support'

/**
 * Skills in the loop, through the real server (epic #349, K6/K7; #352).
 *
 * Two halves. The **provider** the brain is handed: the skills in force for a request, each with
 * a way to read one file of its snapshot. And the **turn** — a slash invocation stored, checked
 * and loaded, and the two tools the mock model calls, driven end to end through the app, the
 * scheduler, the brain and the store.
 *
 * Import is #351's, so every skill is seeded through the store the app runs on.
 */

const SESSIONS = `${API_VERSION_PREFIX}/sessions`
const SKILLS = `${API_VERSION_PREFIX}/me/skills`
const MODES = `${API_VERSION_PREFIX}/me/modes`

/** The instructions a test's skill carries, with the placeholder a slash invocation fills in. */
const SKILL_MD = [
  '---',
  'name: release-notes',
  'description: Writes the release notes for a version.',
  'argument-hint: "[version]"',
  '---',
  '',
  'Write the release notes for $ARGUMENTS.',
].join('\n')

/** Seed one skill for the signed-in caller, through the store the app reads. */
async function seedSkill(
  test: TestContext,
  overrides: {
    readonly id?: SkillId
    readonly name?: string
    readonly frontmatter?: Record<string, unknown>
    readonly enabled?: boolean
    readonly files?: readonly { readonly path: string; readonly content: string }[]
  } = {},
): Promise<Skill> {
  const me = await test.currentUser()
  return test.skills.create({
    id: overrides.id,
    ownerId: me.id,
    name: overrides.name ?? 'release-notes',
    description: 'Writes the release notes for a version.',
    frontmatter: overrides.frontmatter ?? {},
    source: {
      url: 'https://github.com/example/skills',
      ref: 'main',
      path: 'release-notes',
      commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
    },
    enabled: overrides.enabled ?? true,
    files: overrides.files ?? [
      { path: SKILL_MD_FILENAME, content: SKILL_MD },
      { path: 'reference/tone.md', content: 'Be terse.' },
    ],
  })
}

/** Create a session through the route and return it. */
async function createSession(test: TestContext, body: unknown = {}): Promise<Session> {
  const response = await postJson(test, SESSIONS, body)
  expect(response.status).toBe(201)
  return SessionSchema.parse(await response.json())
}

/** A `user.message` that invokes a skill as a slash command (K7). */
function invocation(name: string, args?: string): unknown {
  return {
    type: EVENT_TYPES.userMessage,
    content: [{ type: 'text', text: args === undefined ? `/${name}` : `/${name} ${args}` }],
    skill: { name, ...(args === undefined ? {} : { arguments: args }) },
  }
}

/** Post a batch of events and answer the response, whatever it was. */
function send(test: TestContext, sessionId: SessionId, events: unknown[]): Promise<Response> {
  return postJson(test, `${SESSIONS}/${sessionId}/events`, { events })
}

/** A session's log, as the replay read a client would load it with. */
function log(test: TestContext, sessionId: SessionId): Promise<StoredEvent[]> {
  return readHistory(test.store, sessionId)
}

/** The text one `agent.tool_result` carries. */
function resultText(result: AgentToolResultEvent | undefined): string {
  return result?.content.map((block) => block.text).join('') ?? ''
}

describe('the provider the brain is handed (#352)', () => {
  it('answers the skills in force, each able to read its own files', async () => {
    const test = createTestApp()
    const skill = await seedSkill(test)
    const me = await test.currentUser()

    const offered = await createSkillProvider({ skills: test.skills })(me.id, null)
    expect(offered.map((entry) => entry.skill.id)).toEqual([skill.id])
    expect(await offered[0]?.readFile(SKILL_MD_FILENAME)).toMatchObject({
      encoding: 'utf8',
      content: SKILL_MD,
    })
    expect(await offered[0]?.readFile('reference/tone.md')).toMatchObject({
      encoding: 'utf8',
      content: 'Be terse.',
    })
    // A path the snapshot does not hold, and another owner's skill, are both `null`.
    expect(await offered[0]?.readFile('nope.md')).toBeNull()
    const theirs = await createSkillProvider({ skills: test.skills })('user_somebody_else', null)
    expect(theirs).toEqual([])
  })

  it('follows the mode’s override, so a toggle applies from the next request (K8)', async () => {
    const test = createTestApp()
    // The ids are pinned, and their timestamps differ: the provider answers the store's list,
    // which orders by `(imported_at, id)` — so two skills created in the same millisecond tie
    // on the timestamp and a fresh ULID's random half would decide the order this asserts.
    const kept = await seedSkill(test, { id: newSkillId(1), name: 'release-notes' })
    const turnedOff = await seedSkill(test, { id: newSkillId(2), name: 'pdf-tools' })
    const me = await test.currentUser()

    const resolve = createSkillProvider({ skills: test.skills })
    expect((await resolve(me.id, null)).map((entry) => entry.skill.id)).toEqual([
      kept.id,
      turnedOff.id,
    ])
    const override = { builtin: {}, skills: { [turnedOff.id]: false } }
    expect((await resolve(me.id, override)).map((entry) => entry.skill.id)).toEqual([kept.id])
    // A skill the user switched off is the same answer, which is what makes a toggle and a mode
    // one rule rather than two.
    await test.skills.setEnabled(turnedOff.id, { ownerId: me.id }, false)
    expect((await resolve(me.id, null)).map((entry) => entry.skill.id)).toEqual([kept.id])
  })
})

describe('a slash invocation over HTTP (K7)', () => {
  it('stores the message as typed, naming the skill it invokes', async () => {
    const test = createTestApp()
    await seedSkill(test)
    const session = await createSession(test, { model: { id: 'anthropic/claude-sonnet-5' } })

    const response = await send(test, session.id, [invocation('release-notes', 'v1.2')])
    expect(response.status).toBe(200)

    const messages = (await log(test, session.id)).filter(
      (event) => event.type === EVENT_TYPES.userMessage,
    )
    expect(messages[0]).toMatchObject({
      skill: { name: 'release-notes', arguments: 'v1.2' },
      content: [{ type: 'text', text: '/release-notes v1.2' }],
    })
  })

  it('refuses a name that is not in force, storing nothing', async () => {
    const test = createTestApp()
    await seedSkill(test, { name: 'release-notes', enabled: false })
    const session = await createSession(test, { model: { id: 'anthropic/claude-sonnet-5' } })

    const response = await send(test, session.id, [invocation('release-notes')])
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message).toContain('release-notes')
    // Nothing was stored: a batch is one append, and one bad name refuses the whole of it.
    expect((await log(test, session.id)).filter((e) => e.type === EVENT_TYPES.userMessage)).toEqual(
      [],
    )

    const unknown = await send(test, session.id, [invocation('nope')])
    expect(unknown.status).toBe(400)
  })

  it('refuses a skill the user alone may run, and accepts one the model may not', async () => {
    const test = createTestApp()
    await seedSkill(test, { name: 'notes', frontmatter: { 'user-invocable': false } })
    await seedSkill(test, {
      name: 'manual-check',
      frontmatter: { 'disable-model-invocation': true },
    })
    const session = await createSession(test, { model: { id: 'anthropic/claude-sonnet-5' } })

    const refused = await send(test, session.id, [invocation('notes')])
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      'not user-invocable',
    )

    // `disable-model-invocation` is exactly the field that makes a skill the user's to run by
    // hand, so `/manual-check` is what it is for.
    const accepted = await send(test, session.id, [invocation('manual-check')])
    expect(accepted.status).toBe(200)
  })

  it('checks an invocation against the mode the batch leaves the chat on (K8)', async () => {
    const test = createTestApp()
    const skill = await seedSkill(test)
    await test.request(`${API_VERSION_PREFIX}/provider-credentials/anthropic`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'api_key', api_key: 'sk-test-anthropic-0123456789' }),
    })
    const created = await postJson(test, MODES, {
      name: 'quiet',
      model: 'anthropic/claude-sonnet-5',
      tools: { builtin: {}, skills: { [skill.id]: false } },
    })
    expect(created.status).toBe(201)
    const mode = (await created.json()) as Mode

    // A chat started on the mode is refused: the skill is off for it.
    const onMode = await createSession(test, {
      model: { id: 'anthropic/claude-sonnet-5' },
      mode: mode.id,
    })
    const refused = await send(test, onMode.id, [invocation('release-notes')])
    expect(refused.status).toBe(400)

    // A batch that switches the chat off the mode is checked against where it leaves it, so the
    // same invocation is accepted in the same request that detaches it.
    const detached = await send(test, onMode.id, [
      { ...(invocation('release-notes') as Record<string, unknown>), mode: null },
    ])
    expect(detached.status).toBe(200)
  })

  it('checks `initial_events` at creation too', async () => {
    const test = createTestApp()
    await seedSkill(test, { enabled: false })

    const response = await postJson(test, SESSIONS, {
      model: { id: 'anthropic/claude-sonnet-5' },
      initial_events: [invocation('release-notes')],
    })
    expect(response.status).toBe(400)
    // The session was not created either: the whole request is refused.
    const listed = await test.request(`${SESSIONS}`)
    expect(((await listed.json()) as { data: unknown[] }).data).toEqual([])
  })

  it('reads one skill’s files through the provider, whatever a mode says', async () => {
    const test = createTestApp()
    const skill = await seedSkill(test)
    const me = await test.currentUser()
    const mode = await postJson(test, MODES, {
      name: 'quiet',
      model: 'anthropic/claude-sonnet-5',
    })
    expect(mode.status).toBe(201)

    // A read the routes make still carries the whole snapshot: the mode is about what a chat is
    // offered, not about what a user's own settings screen may read.
    const response = await test.request(`${SKILLS}/${skill.id}/files/reference/tone.md`)
    expect(response.status).toBe(200)
    const provider = createSkillProvider({ skills: test.skills })
    expect(
      (await provider(me.id, { builtin: {}, skills: { [skill.id]: false } }))[0]?.skill.id,
    ).toBeUndefined()
  })
})

describe('the skill tools in a turn (#352)', () => {
  /** A session with one message, and the log it produced once the turn went idle. */
  async function ranTurn(test: TestContext, prompt: string): Promise<SessionId> {
    const session = await createSession(test, { model: { id: 'anthropic/claude-sonnet-5' } })
    const sent = await send(test, session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: prompt }] },
    ])
    expect(sent.status).toBe(200)
    await waitForIdle(test.store, session.id)
    return session.id
  }

  it('offers both tools, reads the instructions and one file', async () => {
    const test = createTestApp({ model: createMockModelFactory(), tools: test_registry() })
    await seedSkill(test)

    const sessionId = await ranTurn(test, `${MOCK_SKILL_MARKER} release-notes`)
    const events = await log(test, sessionId)
    const spans = events.filter(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    )
    expect(spans[0]?.tools).toContainEqual({ name: 'skill', source: 'builtin' })
    expect(spans[0]?.tools).toContainEqual({ name: 'skill_read', source: 'builtin' })

    const uses = events.filter(
      (event): event is AgentToolUseEvent => event.type === EVENT_TYPES.agentToolUse,
    )
    expect(uses.map((use) => use.name)).toEqual(['skill'])
    const results = events.filter(
      (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
    )
    const text = resultText(results[0])
    expect(text).toContain('Write the release notes for $ARGUMENTS.')
    expect(text).toContain('Files (read one with skill_read)')
    expect(text).toContain('- reference/tone.md (9 bytes)')
  })

  it('reads a file with skill_read, and refuses a path it does not hold', async () => {
    const test = createTestApp({ model: createMockModelFactory(), tools: test_registry() })
    await seedSkill(test)

    const sessionId = await ranTurn(
      test,
      `${MOCK_SKILL_READ_MARKER} release-notes reference/tone.md`,
    )
    const results = (await log(test, sessionId)).filter(
      (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
    )
    expect(resultText(results[0])).toBe('Be terse.')
    expect(results[0]?.is_error ?? false).toBe(false)

    const missing = await ranTurn(test, `${MOCK_SKILL_READ_MARKER} release-notes nope.md`)
    const refused = (await log(test, missing)).filter(
      (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
    )
    expect(refused[0]?.is_error).toBe(true)
    expect(resultText(refused[0])).toContain('- reference/tone.md (9 bytes)')
  })

  it('offers neither tool to a chat with no skill the model may invoke (K6)', async () => {
    const test = createTestApp({ model: createMockModelFactory(), tools: test_registry() })
    const sessionId = await ranTurn(test, 'hello')

    const spans = (await log(test, sessionId)).filter(
      (event): event is ModelRequestStartEvent => event.type === EVENT_TYPES.modelRequestStart,
    )
    const names = (spans[0]?.tools ?? []).map((tool) => tool.name)
    expect(names).not.toContain('skill')
    expect(names).not.toContain('skill_read')
  })

  it('leaves a user-only skill out of the listing, and refuses it (K6)', async () => {
    const test = createTestApp({ model: createMockModelFactory(), tools: test_registry() })
    await seedSkill(test, {
      name: 'manual-check',
      frontmatter: { 'disable-model-invocation': true },
    })

    const sessionId = await ranTurn(test, `${MOCK_SKILL_MARKER} manual-check`)
    const events = await log(test, sessionId)
    // The chat's only skill is the user's own command, so neither tool was offered — the call
    // the mock made is answered by the registry as a name nothing carries.
    expect(events.filter((event) => event.type === EVENT_TYPES.modelRequestStart)[0]).toMatchObject(
      {},
    )
    const results = events.filter(
      (event): event is AgentToolResultEvent => event.type === EVENT_TYPES.agentToolResult,
    )
    expect(results[0]?.is_error).toBe(true)
    expect(resultText(results[0])).toContain('No tool named')
  })

  it('loads a slash invocation into the log, once, before the request that answers it', async () => {
    const test = createTestApp({ model: createMockModelFactory(), tools: test_registry() })
    const skill = await seedSkill(test)
    const session = await createSession(test, { model: { id: 'anthropic/claude-sonnet-5' } })
    await send(test, session.id, [invocation('release-notes', 'v1.2')])
    await waitForIdle(test.store, session.id)

    const loaded = (await log(test, session.id)).filter(
      (event): event is SessionSkillLoadedEvent => event.type === EVENT_TYPES.sessionSkillLoaded,
    )
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      name: 'release-notes',
      skill_id: skill.id,
      commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
      content: 'Write the release notes for v1.2.',
    })
    // The message the user sent is in the log as typed, and the loaded event names it.
    const messages = (await log(test, session.id)).filter(
      (event) => event.type === EVENT_TYPES.userMessage,
    )
    expect(loaded[0]?.message_seq).toBe(messages[0]?.seq)
    // A second turn loads nothing more.
    await send(test, session.id, [
      { type: EVENT_TYPES.userMessage, content: [{ type: 'text', text: 'thanks' }] },
    ])
    await waitForIdle(test.store, session.id)
    expect(
      (await log(test, session.id)).filter(
        (event) => event.type === EVENT_TYPES.sessionSkillLoaded,
      ),
    ).toHaveLength(1)
  })
})

/**
 * The registry a process really runs with (epic #303, #305; the test tool of #304).
 *
 * The harness builds no registry unless a test asks for one, and these tests are about the two
 * tools the **loop** puts together from a request's skills — so the deployment's own registry is
 * the built-ins, and the request is offered them beside the skill tools.
 */
function test_registry() {
  return createTurnRegistry({ kind: 'mock' })
}
