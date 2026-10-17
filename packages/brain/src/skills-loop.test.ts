import type {
  SessionSkillLoadedEvent,
  Skill,
  StoredEvent,
  UserEventInput,
} from '@openharness/protocol'
import { EVENT_TYPES, newSkillId } from '@openharness/protocol'
import type { OfferedSkill } from '@openharness/hands'
import { SKILL_READ_TOOL_NAME, SKILL_TOOL_NAME } from '@openharness/hands'
import { describe, expect, it } from 'vitest'

import type { SkillProvider } from './skills'
import { NATIVE_SEARCH_TOOL, eventTypes, logOf, newSession } from './testing/harness'
import { mockModel, readPrompt, TEST_CREDENTIAL } from './testing/mock-model'
import { runTurn } from './turn'

/**
 * Skills in the turn loop (epic #349, K6/K7): what a slash invocation turns into, what the
 * request carries, and what happens when the snapshot moves underneath a chat.
 *
 * The engine's own suite covers the substitution and the listing; this is the loop's half — the
 * `session.skill_loaded` event written when the message is first handled, the frame the context
 * strategy builds the message with, the tools the request is offered, and the rule that a chat
 * already built keeps what it was built on.
 */

const SKILL_MD = [
  '---',
  'name: release-notes',
  'description: Writes the release notes for a version.',
  '---',
  '',
  'Write the release notes for $ARGUMENTS.',
].join('\n')

const OTHER_SKILL_MD = [
  '---',
  'name: release-notes',
  'description: Writes the release notes for a version.',
  '---',
  '',
  'The refreshed instructions.',
].join('\n')

/** One fixed id for the fixture, so a log built twice is the same log. */
const SKILL_ID = newSkillId(1_700_000_000_000)

/** A skill resource as the provider answers one. */
function skill(name: string, overrides: Partial<Skill> = {}): Skill {
  return {
    id: SKILL_ID,
    type: 'skill',
    owner_id: 'user_brain_tests',
    name,
    description: 'Writes the release notes for a version.',
    frontmatter: {},
    source: {
      url: 'https://github.com/example/skills',
      ref: 'main',
      path: name,
      commit_sha: 'abc123',
    },
    files: [
      { path: 'SKILL.md', size: SKILL_MD.length },
      { path: 'reference/tone.md', size: 9 },
    ],
    enabled: true,
    imported_at: '2026-03-15T10:00:00Z',
    refreshed_at: '2026-03-15T10:00:00Z',
    ...overrides,
  }
}

/** A provider over one skill whose `SKILL.md` a test can replace between turns. */
function provider(contents: {
  current: string
  readonly name?: string
  readonly extra?: string
}): SkillProvider {
  return () => {
    const file = (path: string, content: string) => ({
      path,
      size: new TextEncoder().encode(content).length,
      encoding: 'utf8' as const,
      content,
    })
    const offered: OfferedSkill = {
      skill: skill(contents.name ?? 'release-notes'),
      readFile: (path) =>
        Promise.resolve(
          path === 'SKILL.md'
            ? file(path, contents.current)
            : path === 'reference/tone.md' && contents.extra !== undefined
              ? file(path, contents.extra)
              : null,
        ),
    }
    return Promise.resolve([offered])
  }
}

/** `/name arguments` as a client sends it: the text the user typed, and the skill it names. */
function invocation(name: string, args?: string): UserEventInput {
  return {
    type: 'user.message',
    content: [{ type: 'text', text: args === undefined ? `/${name}` : `/${name} ${args}` }],
    skill: { name, ...(args === undefined ? {} : { arguments: args }) },
  }
}

/** The `session.skill_loaded` events in a log. */
function loadedEvents(events: readonly StoredEvent[]): SessionSkillLoadedEvent[] {
  return events.filter(
    (event): event is SessionSkillLoadedEvent => event.type === EVENT_TYPES.sessionSkillLoaded,
  )
}

/** The text an `agent.tool_result` carries. */
function resultText(event: StoredEvent): string {
  return event.type === EVENT_TYPES.agentToolResult
    ? event.content.map((block) => block.text).join('')
    : ''
}

/** What the second message in a log is, as the prompt a request really carried. */
function userTexts(prompt: readonly { readonly role: string; readonly text: string }[]): string[] {
  return prompt.filter((message) => message.role === 'user').map((message) => message.text)
}

describe('a slash invocation in the turn loop (K7)', () => {
  it('writes what the model was given, once, and sends the instructions', async () => {
    const chat = mockModel({ text: ['ok'] })
    const session = await newSession([invocation('release-notes', 'v1.2')])

    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills: provider({ current: SKILL_MD }),
    })

    const events = await logOf(session.store, session.sessionId)
    const loaded = loadedEvents(events)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      name: 'release-notes',
      skill_id: SKILL_ID,
      commit_sha: 'abc123',
      // The body with the arguments substituted, and the frontmatter gone: exactly what the
      // request below carries, and what the log is the record of.
      content: 'Write the release notes for v1.2.',
    })
    expect(loaded[0]?.message_seq).toBe(
      events.find((event) => event.type === EVENT_TYPES.userMessage)?.seq,
    )
    // The event lands before the request that answers the message, which is what makes the
    // prompt below the one it was loaded for.
    expect(eventTypes(events).indexOf(EVENT_TYPES.sessionSkillLoaded)).toBeLessThan(
      eventTypes(events).indexOf(EVENT_TYPES.modelRequestStart),
    )

    const prompt = readPrompt(chat.calls[0]!)
    expect(userTexts(prompt)[0]).toContain('The user ran the "/release-notes" skill')
    expect(userTexts(prompt)[0]).toContain('Write the release notes for v1.2.')
    // What the user typed is in the log but is not what the model was sent.
    expect(userTexts(prompt)[0]).not.toContain('/release-notes v1.2')
  })

  it('loads what the log already holds rather than loading it again (K7)', async () => {
    // A brain that wrote the event and died before answering the message: the log holds both,
    // and the turn that inherits them loads nothing — the chat is the one that was built.
    const chat = mockModel({ text: ['ok'] })
    const session = await newSession([invocation('release-notes', 'v1.2')])
    const [message] = await logOf(session.store, session.sessionId)
    const [stored] = await session.store.appendEvents(session.sessionId, [
      {
        type: EVENT_TYPES.sessionSkillLoaded,
        message_seq: message?.seq ?? 1,
        name: 'release-notes',
        skill_id: SKILL_ID,
        commit_sha: 'abc123',
        content: 'Write the release notes for v1.2.',
      },
    ])
    expect(stored?.type).toBe(EVENT_TYPES.sessionSkillLoaded)

    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills: provider({ current: OTHER_SKILL_MD }),
    })

    const events = await logOf(session.store, session.sessionId)
    expect(loadedEvents(events)).toHaveLength(1)
    const sent = userTexts(readPrompt(chat.calls[0]!))[0] ?? ''
    expect(sent).toContain('The user ran the "/release-notes" skill')
    // The request carries what the log recorded, not what the skill says now: a snapshot
    // replaced underneath a chat cannot rewrite it (K5).
    expect(sent).toContain('Write the release notes for v1.2.')
    expect(sent).not.toContain('The refreshed instructions.')
  })

  it('keeps the chat a refresh cannot reach (K5)', async () => {
    const chat = mockModel({ text: ['ok'] }, { text: ['ok again'] })
    const session = await newSession([invocation('release-notes', 'v1.2')])
    const contents = { current: SKILL_MD }
    const skills = provider(contents)

    const options = {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills,
    }
    await runTurn(session.sessionId, options)
    // The snapshot is replaced — the same skill, a new commit — and the chat carries on.
    contents.current = OTHER_SKILL_MD
    await session.store.appendEvents(session.sessionId, [invocation('release-notes', 'v9')])
    await runTurn(session.sessionId, options)

    const events = await logOf(session.store, session.sessionId)
    expect(loadedEvents(events)).toHaveLength(2)
    expect(loadedEvents(events).map((event) => event.content)).toEqual([
      'Write the release notes for v1.2.',
      'The refreshed instructions.\n\nv9',
    ])
    // The first chat is untouched: its message still carries the instructions it ran on.
    const texts = userTexts(readPrompt(chat.calls[1]!))
    expect(texts[0]).toContain('Write the release notes for v1.2.')
    expect(texts[0]).not.toContain('The refreshed instructions.')
  })

  it('sends the text the user typed when the skill is no longer there', async () => {
    const chat = mockModel({ text: ['ok'] })
    const session = await newSession([invocation('release-notes', 'v1.2')])

    // The owner turned the skill off between the append and the turn — the narrow race the
    // server's own check cannot cover. Nothing is loaded, and the message goes as typed.
    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills: () => Promise.resolve([]),
    })

    const events = await logOf(session.store, session.sessionId)
    expect(loadedEvents(events)).toHaveLength(0)
    expect(userTexts(readPrompt(chat.calls[0]!))[0]).toBe('/release-notes v1.2')
  })

  it('offers the two tools, and reads a skill through them', async () => {
    const chat = mockModel(
      { toolCalls: [{ name: SKILL_TOOL_NAME, input: { name: 'release-notes' } }] },
      {
        toolCalls: [
          {
            name: SKILL_READ_TOOL_NAME,
            input: { name: 'release-notes', path: 'reference/tone.md' },
          },
        ],
      },
      { text: ['done'] },
    )
    const session = await newSession([
      { type: 'user.message', content: [{ type: 'text', text: 'read it' }] },
    ])

    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills: provider({ current: SKILL_MD, extra: 'Be terse.' }),
    })

    const events = await logOf(session.store, session.sessionId)
    // The tools the request offered are on its span, as this build's own.
    const span = events.find((event) => event.type === EVENT_TYPES.modelRequestStart)
    // The request's own model has a native search tool, so it is offered beside them (#335).
    expect(span?.type === EVENT_TYPES.modelRequestStart ? span.tools : undefined).toEqual([
      { name: SKILL_TOOL_NAME, source: 'builtin' },
      { name: SKILL_READ_TOOL_NAME, source: 'builtin' },
      NATIVE_SEARCH_TOOL,
    ])
    const results = events
      .filter((event) => event.type === EVENT_TYPES.agentToolResult)
      .map(resultText)
    expect(results[0]).toContain('Write the release notes for $ARGUMENTS.')
    expect(results[0]).toContain('- reference/tone.md (9 bytes)')
    expect(results[1]).toBe('Be terse.')
  })

  it('offers neither tool for a chat with no skill the model may invoke (K6)', async () => {
    const chat = mockModel({ text: ['ok'] })
    const session = await newSession([
      { type: 'user.message', content: [{ type: 'text', text: 'hello' }] },
    ])

    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills: () => Promise.resolve([]),
    })

    const events = await logOf(session.store, session.sessionId)
    const span = events.find((event) => event.type === EVENT_TYPES.modelRequestStart)
    // The request offers no tools at all: with no registry to attach it to, the native search
    // tool is not offered either (#335) — a chat with no skills is a chat with no tools.
    expect(span?.type === EVENT_TYPES.modelRequestStart ? span.tools : undefined).toBeUndefined()
  })

  it('lets the model read a user-run skill whose flag forbids model invocation (K1)', async () => {
    // The user ran `/secret-notes`; its body is in the request, and an instruction in it that
    // says "read reference/tone.md" is exactly what `skill_read` is for. The flag keeps the
    // model from *picking* the skill, not from following the user's own instructions.
    const chat = mockModel(
      {
        toolCalls: [
          {
            name: SKILL_READ_TOOL_NAME,
            input: { name: 'secret-notes', path: 'reference/tone.md' },
          },
        ],
      },
      { text: ['done'] },
    )
    const session = await newSession([invocation('secret-notes')])
    const file = (path: string, content: string) => ({
      path,
      size: new TextEncoder().encode(content).length,
      encoding: 'utf8' as const,
      content,
    })

    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills: () =>
        Promise.resolve([
          {
            skill: skill('secret-notes', {
              frontmatter: { 'disable-model-invocation': true },
            }),
            readFile: (path) =>
              Promise.resolve(
                path === 'SKILL.md'
                  ? file(path, '---\nname: secret-notes\n---\n\nRead reference/tone.md.')
                  : path === 'reference/tone.md'
                    ? file(path, 'Be terse.')
                    : null,
              ),
          },
        ]),
    })

    const events = await logOf(session.store, session.sessionId)
    const span = events.find((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(span?.type === EVENT_TYPES.modelRequestStart ? span.tools : undefined).toEqual([
      { name: SKILL_TOOL_NAME, source: 'builtin' },
      { name: SKILL_READ_TOOL_NAME, source: 'builtin' },
      NATIVE_SEARCH_TOOL,
    ])
    const results = events
      .filter((event) => event.type === EVENT_TYPES.agentToolResult)
      .map(resultText)
    expect(results[0]).toBe('Be terse.')
  })

  it('still offers neither tool when the user has not run the user-only skill', async () => {
    const chat = mockModel({ text: ['ok'] })
    const session = await newSession([
      { type: 'user.message', content: [{ type: 'text', text: 'hello' }] },
    ])

    await runTurn(session.sessionId, {
      store: session.store,
      model: chat.factory,
      resolveCredential: () => Promise.resolve(TEST_CREDENTIAL),
      skills: () =>
        Promise.resolve([
          {
            skill: skill('secret-notes', {
              frontmatter: { 'disable-model-invocation': true },
            }),
            readFile: () => Promise.resolve(null),
          },
        ]),
    })

    const events = await logOf(session.store, session.sessionId)
    const span = events.find((event) => event.type === EVENT_TYPES.modelRequestStart)
    expect(span?.type === EVENT_TYPES.modelRequestStart ? span.tools : undefined).toBeUndefined()
  })
})
