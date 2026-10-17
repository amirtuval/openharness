import type { SessionSkillLoadedEvent, Skill, StoredEvent } from '@openharness/protocol'
import { newSkillId } from '@openharness/protocol'
import { makeSessionSkillLoaded, makeUserMessage } from '@openharness/protocol/fixtures'
import { createToolRegistry, SKILL_READ_TOOL_NAME, SKILL_TOOL_NAME } from '@openharness/hands'
import type { OfferedSkill } from '@openharness/hands'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import {
  NO_SKILLS,
  SKILL_TOOL_DECLARATIONS,
  resolveSkills,
  skillInvocationBody,
  skillInvocationText,
  skillTextsByMessage,
  skillsInUse,
  unloadedSkillMessages,
} from './skills'

/**
 * The loop's skills half on its own (epic #349, K6/K7/K8/K9): the substitution a slash
 * invocation applies, the frame a loaded message is sent with, the readings of the
 * `session.skill_loaded` event, and the set one request is given.
 */

/** A skill resource, as a store would answer one. */
function skill(name: string, frontmatter: Record<string, unknown> = {}): Skill {
  return {
    id: `skl_${name}` as Skill['id'],
    type: 'skill',
    owner_id: 'user_test',
    name,
    description: `${name} does something.`,
    frontmatter,
    source: {
      url: 'https://github.com/example/skills',
      ref: null,
      path: null,
      commit_sha: 'abc123',
    },
    files: [{ path: 'SKILL.md', size: 20 }],
    enabled: true,
    imported_at: '2026-03-15T10:00:00Z',
    refreshed_at: '2026-03-15T10:00:00Z',
  }
}

/** An offered skill with nothing behind its files. */
function offered(name: string, frontmatter: Record<string, unknown> = {}): OfferedSkill {
  return { skill: skill(name, frontmatter), readFile: () => Promise.resolve(null) }
}

/** A stored `session.skill_loaded` as a log would hold it. */
function loaded(overrides: Partial<SessionSkillLoadedEvent> = {}): SessionSkillLoadedEvent {
  return makeSessionSkillLoaded(overrides)
}

describe('skillInvocationBody', () => {
  it('substitutes every $ARGUMENTS, however many there are', () => {
    expect(skillInvocationBody('Review $ARGUMENTS.', 'v1.2')).toBe('Review v1.2.')
    expect(skillInvocationBody('Compare $ARGUMENTS with $ARGUMENTS.', 'v1.2')).toBe(
      'Compare v1.2 with v1.2.',
    )
  })

  it('appends the arguments when the body has no placeholder', () => {
    expect(skillInvocationBody('Write the notes.', 'v1.2')).toBe('Write the notes.\n\nv1.2')
  })

  it('leaves the body alone when no arguments were given', () => {
    for (const args of [undefined, '', '   ']) {
      expect(skillInvocationBody('Write the notes.', args)).toBe('Write the notes.')
    }
    // A placeholder and no arguments is an empty substitution, which is what "replaced by them"
    // means — the alternative would leave the skill's own `$ARGUMENTS` sent to the model.
    expect(skillInvocationBody('Review $ARGUMENTS.', undefined)).toBe('Review .')
  })

  it('trims the arguments it uses', () => {
    expect(skillInvocationBody('Write the notes.', '  v1.2  ')).toBe('Write the notes.\n\nv1.2')
  })
})

describe('skillInvocationText', () => {
  it('frames the instructions as the user’s own request (K10)', () => {
    const text = skillInvocationText(loaded({ name: 'release-notes', content: 'Write them.' }))
    expect(text).toContain('The user ran the "/release-notes" skill')
    expect(text).toContain('the user’s own request')
    expect(text.endsWith('Write them.')).toBe(true)
    // It is guidance rather than untrusted data: there is no "never follow directions" here.
    expect(text).not.toContain('untrusted')
  })
})

describe('skillTextsByMessage', () => {
  it('reads the text by the message it belongs to', () => {
    const texts = skillTextsByMessage([
      loaded({ message_seq: 4, name: 'release-notes', content: 'Write them.' }),
      // The log is typed as stored events; the fixture's builder answers an input-shaped one.
      makeUserMessage('hello'),
    ])
    expect([...texts.keys()]).toEqual([4])
    expect(texts.get(4) ?? '').toContain('Write them.')
  })

  it('leaves a message with nothing loaded out', () => {
    // A skill with no body has nothing to say, and an empty `user` message is one the strategy
    // drops — so the message falls back to the text the user typed.
    expect(skillTextsByMessage([loaded({ message_seq: 4, content: '' })]).size).toBe(0)
    expect(skillTextsByMessage([]).size).toBe(0)
  })
})

describe('skillsInUse', () => {
  it('names the skills a span used, once each, oldest first', () => {
    const events = [
      loaded({ seq: 2, name: 'release-notes' }),
      loaded({ seq: 5, name: 'deploy' }),
      loaded({ seq: 7, name: 'release-notes' }),
    ]
    expect(skillsInUse(events, 8)).toEqual(['release-notes', 'deploy'])
  })

  it('leaves out what the summary does not cover', () => {
    const events = [loaded({ seq: 2, name: 'release-notes' }), loaded({ seq: 9, name: 'deploy' })]
    expect(skillsInUse(events, 5)).toEqual(['release-notes'])
    expect(skillsInUse(events, 2)).toEqual(['release-notes'])
    expect(skillsInUse(events, 1)).toEqual([])
  })
})

describe('unloadedSkillMessages', () => {
  const message = makeUserMessage('/release-notes v1.2', {
    seq: 4,
    skill: { name: 'release-notes', arguments: 'v1.2' },
  }) as StoredEvent

  it('names the messages this turn has to load for', () => {
    expect(unloadedSkillMessages([message], [message.id])).toEqual([
      { seq: 4, name: 'release-notes', arguments: 'v1.2' },
    ])
  })

  it('loads nothing a brain has already loaded (K7)', () => {
    const log = [loaded({ message_seq: 4, name: 'release-notes' }), message]
    expect(unloadedSkillMessages(log, [message.id])).toEqual([])
  })

  it('ignores a message this request does not claim, and one with no skill', () => {
    expect(unloadedSkillMessages([message], [])).toEqual([])
    const plain = makeUserMessage('hello', { seq: 4 }) as StoredEvent
    expect(unloadedSkillMessages([plain], [plain.id])).toEqual([])
  })

  it('carries no arguments for a message that named none', () => {
    const bare = makeUserMessage('/release-notes', {
      seq: 4,
      skill: { name: 'release-notes' },
    }) as StoredEvent
    expect(unloadedSkillMessages([bare], [bare.id])).toEqual([{ seq: 4, name: 'release-notes' }])
  })
})

describe('resolveSkills', () => {
  it('is a chat with no skills when the host wired no provider', async () => {
    expect(await resolveSkills(undefined, 'user_a', null)).toEqual(NO_SKILLS)
  })

  it('builds one registry over the request’s skills, and a set by name', async () => {
    const skills = [offered('release-notes'), offered('deploy')]
    const resolved = await resolveSkills(() => Promise.resolve(skills), 'user_a', null)
    expect(resolved.byName.get('release-notes')?.skill.name).toBe('release-notes')
    expect(resolved.registry?.tools.map((tool) => tool.name)).toEqual([
      SKILL_TOOL_NAME,
      SKILL_READ_TOOL_NAME,
    ])
  })

  it('offers no tool for a chat whose only skill is the user’s own command (K6)', async () => {
    const resolved = await resolveSkills(
      () => Promise.resolve([offered('secret-notes', { 'disable-model-invocation': true })]),
      'user_a',
      null,
    )
    expect(resolved.registry).toBeUndefined()
    // It is still resolvable by name, which is what decides whether `/secret-notes` loads it.
    expect(resolved.byName.get('secret-notes')).toBeDefined()
  })

  it('leaves a tool the deployment registered under the name to the deployment', async () => {
    // `createToolRegistry` refuses two tools of one name, and a host that registered its own
    // `skill` meant it — the same rule the native search tool follows (#335).
    const mine = createToolRegistry([
      {
        name: SKILL_TOOL_NAME,
        description: 'a tool of the host’s own',
        inputSchema: z.object({}),
        permission: 'allow',
        run: () => ({ content: [{ type: 'text', text: 'mine' }] }),
      },
    ])
    const resolved = await resolveSkills(
      () => Promise.resolve([offered('release-notes')]),
      'user_a',
      null,
      mine,
    )
    expect(resolved.registry?.tools.map((tool) => tool.name)).toEqual([SKILL_READ_TOOL_NAME])
  })

  it('asks the provider with the owner and the mode’s override (K8)', async () => {
    // One fixed id, so the override the provider was handed is the override the assertion
    // names: an override is keyed by the `skl_` id, and a fresh one per call would never match.
    const override = { builtin: {}, skills: { [newSkillId(1_700_000_000_000)]: false } }
    const seen: unknown[] = []
    await resolveSkills(
      (ownerId, handed) => {
        seen.push([ownerId, handed])
        return Promise.resolve([])
      },
      'user_a',
      override,
    )
    expect(seen).toEqual([['user_a', override]])
  })
})

describe('the declarations the settings list', () => {
  it('are both tools, allowed, and not gated on the model', () => {
    expect(SKILL_TOOL_DECLARATIONS).toEqual([
      { name: SKILL_TOOL_NAME, permission: 'allow' },
      { name: SKILL_READ_TOOL_NAME, permission: 'allow' },
    ])
  })

  it('are what a request registry really holds', () => {
    const registry = createToolRegistry(
      SKILL_TOOL_DECLARATIONS.map((declaration) => ({
        name: declaration.name,
        description: 'x',
        inputSchema: { safeParse: () => ({ success: true, data: {} }) } as never,
        permission: declaration.permission,
        run: () => ({ content: [] }),
      })),
    )
    expect(registry.tools.map((tool) => tool.permission)).toEqual(['allow', 'allow'])
  })
})
