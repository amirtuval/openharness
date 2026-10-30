import { skillFileSize } from '@openharness/protocol'
import type { Skill, SkillFileContent, SkillFileEncoding } from '@openharness/protocol'
import { SKILL_LISTING_MAX_CHARS } from './skill'
import { describe, expect, it } from 'vitest'

import { createToolRegistry } from './registry'
import {
  SKILL_READ_TOOL_NAME,
  SKILL_SCRIPTS_NOTICE,
  SKILL_TOOL_NAME,
  createSkillTools,
  looksBinary,
  skillListingDescription,
  skillToolsOffered,
  type OfferedSkill,
} from './skill'

/**
 * The two skill tools on their own (epic #349, K6).
 *
 * Everything runs through the **real registry**, so a test exercises the input schema, the
 * permission and the result shape a request would meet — not just the `run` a test called by
 * hand.
 */

/** The `SKILL.md` body a fixture's folder holds by default. */
const RELEASE_NOTES_MD = [
  '---',
  'name: release-notes',
  'description: Writes the release notes for a version.',
  'argument-hint: "[version]"',
  '---',
  '',
  '# Release notes',
  '',
  'Write one paragraph per change.',
  '',
].join('\n')

/**
 * One offered skill, from the pieces a test cares about.
 *
 * @param name the skill's name
 * @param options the frontmatter, the description, the files and their contents
 */
function offered(
  name: string,
  options: {
    readonly description?: string
    readonly frontmatter?: Record<string, unknown>
    readonly files?: readonly {
      readonly path: string
      readonly content: string
      readonly encoding?: SkillFileEncoding
    }[]
  } = {},
): OfferedSkill {
  const files = options.files ?? [{ path: 'SKILL.md', content: RELEASE_NOTES_MD }]
  const skill: Skill = {
    id: `skl_${name.replace(/[^a-z0-9]/g, '')}` as Skill['id'],
    type: 'skill',
    owner_id: 'user_test',
    name,
    description: options.description ?? 'Writes the release notes for a version.',
    frontmatter: { ...options.frontmatter },
    source: {
      url: 'https://github.com/example/skills',
      ref: 'main',
      path: name,
      commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
    },
    files: files.map((file) => ({
      path: file.path,
      size: skillFileSize(file.content, file.encoding),
    })),
    enabled: true,
    imported_at: '2026-03-15T10:00:00Z',
    refreshed_at: '2026-03-15T10:00:00Z',
  }
  const contents = new Map<string, SkillFileContent>(
    files.map((file) => [
      file.path,
      {
        path: file.path,
        size: skillFileSize(file.content, file.encoding),
        encoding: file.encoding ?? 'utf8',
        content: file.content,
      },
    ]),
  )
  return {
    skill,
    readFile: (path) => Promise.resolve(contents.get(path) ?? null),
  }
}

/** The registry a call is made through, and the text it answered with. */
async function call(
  skills: readonly OfferedSkill[],
  name: string,
  input: unknown,
  userLoadedSkills?: ReadonlySet<string>,
): Promise<{ readonly text: string; readonly isError: boolean }> {
  const registry = createToolRegistry(createSkillTools({ skills, userLoadedSkills }))
  const result = await registry.execute(name, input)
  return {
    text: result.content.map((block) => block.text).join(''),
    isError: result.isError === true,
  }
}

describe('the tools a request offers', () => {
  it('are offered for a skill the model may invoke, and not otherwise', () => {
    expect(skillToolsOffered([offered('release-notes')])).toBe(true)
    expect(skillToolsOffered([])).toBe(false)
    // A skill the user alone runs leaves the chat with nothing the model may read (K6): it is
    // not in the listing, and neither tool would answer for it.
    expect(
      skillToolsOffered([
        offered('release-notes', { frontmatter: { 'disable-model-invocation': true } }),
      ]),
    ).toBe(false)
  })

  it('describe themselves for the model', () => {
    const [skill, read] = createSkillTools({ skills: [offered('release-notes')] })
    expect(skill?.name).toBe(SKILL_TOOL_NAME)
    expect(read?.name).toBe(SKILL_READ_TOOL_NAME)
    expect(skill?.permission).toBe('allow')
    expect(read?.permission).toBe('allow')
    // Both declare what one of their results may cost a request (X9): a `SKILL.md` is bounded by
    // the file limit, and a file of a skill by its own larger one.
    expect(skill?.maxResultTokens).toBeGreaterThan(0)
    expect(read?.maxResultTokens).toBeGreaterThan(skill?.maxResultTokens ?? 0)
  })
})

describe('the listing', () => {
  it('names every skill the model may invoke, with the K2 note', () => {
    const description = skillListingDescription([
      offered('release-notes', { description: 'Writes the release notes.' }),
      offered('deploy', { description: 'Ships a version.' }),
    ])
    expect(description).toContain('Skills available in this chat:')
    expect(description).toContain('- release-notes: Writes the release notes.')
    expect(description).toContain('- deploy: Ships a version.')
    // K2, in as many words: nothing in a skill's folder is executed.
    expect(description).toContain(SKILL_SCRIPTS_NOTICE)
    expect(SKILL_SCRIPTS_NOTICE).toContain('cannot be run')
  })

  it('leaves a disable-model-invocation skill out, and refuses it by name (K6)', async () => {
    const skills = [
      offered('release-notes'),
      offered('secret-notes', { frontmatter: { 'disable-model-invocation': true } }),
    ]
    const description = skillListingDescription(skills)
    expect(description).not.toContain('secret-notes')

    // A model that guesses the name anyway is told why rather than that the skill is missing.
    const refusal = await call(skills, SKILL_TOOL_NAME, { name: 'secret-notes' })
    expect(refusal.isError).toBe(true)
    expect(refusal.text).toContain('disable-model-invocation')
    expect(refusal.text).toContain('only the user can run it')
    // And reading its files is the same refusal: it is the user's command, both ways round.
    const read = await call(skills, SKILL_READ_TOOL_NAME, {
      name: 'secret-notes',
      path: 'SKILL.md',
    })
    expect(read.isError).toBe(true)
    expect(read.text).toContain('disable-model-invocation')
  })

  it('lets a user-run disable-model-invocation skill be read, still without listing it', async () => {
    const skills = [offered('secret-notes', { frontmatter: { 'disable-model-invocation': true } })]
    const userLoaded = new Set(['secret-notes'])

    // The tools exist for the model to read the files the user's own instructions name...
    expect(skillToolsOffered(skills, userLoaded)).toBe(true)
    // ...but the flag keeps the skill out of the listing the model chooses from (K6).
    expect(skillListingDescription(skills)).not.toContain('secret-notes')

    const instructions = await call(skills, SKILL_TOOL_NAME, { name: 'secret-notes' }, userLoaded)
    expect(instructions.isError).toBe(false)
    expect(instructions.text).toContain('# Release notes')

    const file = await call(
      skills,
      SKILL_READ_TOOL_NAME,
      { name: 'secret-notes', path: 'SKILL.md' },
      userLoaded,
    )
    expect(file.isError).toBe(false)
    expect(file.text).toContain('# Release notes')

    // With nothing loaded, the unchanged refusal still stands.
    const refused = await call(skills, SKILL_READ_TOOL_NAME, {
      name: 'secret-notes',
      path: 'SKILL.md',
    })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('only the user can run it')
  })

  it('cuts descriptions to a budget, and never a name', () => {
    const long = 'x'.repeat(SKILL_LISTING_MAX_CHARS)
    const skills = Array.from({ length: 20 }, (_, index) =>
      offered(`skill-${String(index)}`, { description: long }),
    )
    const description = skillListingDescription(skills)
    for (const { skill } of skills) {
      expect(description).toContain(`- ${skill.name}:`)
    }
    // Every description shares the budget, so twenty skills cost about what one budgeted
    // listing does rather than twenty times it.
    expect(description.length).toBeLessThan(
      SKILL_LISTING_MAX_CHARS + 20 * 80 + SKILL_SCRIPTS_NOTICE.length + 200,
    )
    expect(description).toContain('…')
  })

  it('says so when the chat has no skill the model may invoke', () => {
    expect(skillListingDescription([])).toContain('no skills available to you')
  })
})

describe('skill', () => {
  it('answers the instructions with the frontmatter stripped, and the files', async () => {
    const result = await call([offered('release-notes')], SKILL_TOOL_NAME, {
      name: 'release-notes',
    })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Write one paragraph per change.')
    // The frontmatter is gone from what the model is handed: the resource already carries it.
    expect(result.text.split('---')[0]).not.toContain('description:')
    expect(result.text).toContain(`Files (read one with ${SKILL_READ_TOOL_NAME}):`)
    expect(result.text).toContain('- SKILL.md (')
    expect(result.text).toContain('bytes)')
  })

  it('lists every file of the folder, paths and sizes', async () => {
    const result = await call(
      [
        offered('release-notes', {
          files: [
            { path: 'SKILL.md', content: RELEASE_NOTES_MD },
            { path: 'reference/tone.md', content: 'Be terse.' },
          ],
        }),
      ],
      SKILL_TOOL_NAME,
      { name: 'release-notes' },
    )
    expect(result.text).toContain('- reference/tone.md (9 bytes)')
  })

  it('refuses a name no skill has, listing the ones that are there', async () => {
    const result = await call([offered('release-notes'), offered('deploy')], SKILL_TOOL_NAME, {
      name: 'nope',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('No skill named "nope"')
    expect(result.text).toContain('release-notes, deploy')
    // A name only a user-invocable:false-style skill has is not offered to the model at all.
    expect(result.text).not.toContain('secret')
  })

  it('answers a broken snapshot rather than pretending the skill is missing', async () => {
    const broken: OfferedSkill = {
      skill: offered('release-notes').skill,
      readFile: () => Promise.resolve(null),
    }
    const result = await call([broken], SKILL_TOOL_NAME, { name: 'release-notes' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('SKILL.md')
  })

  it('refuses input that is not a name', async () => {
    const result = await call([offered('release-notes')], SKILL_TOOL_NAME, { name: '' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Invalid input')
  })
})

describe('skill_read', () => {
  const withReference = () => [
    offered('release-notes', {
      files: [
        { path: 'SKILL.md', content: RELEASE_NOTES_MD },
        { path: 'reference/tone.md', content: 'Be terse.' },
      ],
    }),
  ]

  it('answers one file as text, exactly as the snapshot holds it', async () => {
    const result = await call(withReference(), SKILL_READ_TOOL_NAME, {
      name: 'release-notes',
      path: 'reference/tone.md',
    })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('Be terse.')
  })

  it('reads a script as text and runs nothing (K2)', async () => {
    const result = await call(
      [
        offered('release-notes', {
          files: [
            { path: 'SKILL.md', content: RELEASE_NOTES_MD },
            { path: 'scripts/notes.sh', content: '#!/bin/sh\necho hi\n' },
          ],
        }),
      ],
      SKILL_READ_TOOL_NAME,
      { name: 'release-notes', path: 'scripts/notes.sh' },
    )
    expect(result.isError).toBe(false)
    expect(result.text).toContain('echo hi')
  })

  it('refuses a path the skill does not hold, listing the files it does', async () => {
    const result = await call(withReference(), SKILL_READ_TOOL_NAME, {
      name: 'release-notes',
      path: 'reference/missing.md',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('is not a file of "release-notes"')
    expect(result.text).toContain('- reference/tone.md (')
  })

  it('answers the binary marker for a file stored as base64', async () => {
    // The import stores a non-text file as base64, so the content itself is printable text;
    // the stored encoding is what says the file is binary, not what the string looks like.
    const result = await call(
      [
        offered('release-notes', {
          files: [
            { path: 'SKILL.md', content: RELEASE_NOTES_MD },
            { path: 'assets/logo.png', content: 'iVBORw0KGgo=', encoding: 'base64' },
          ],
        }),
      ],
      SKILL_READ_TOOL_NAME,
      { name: 'release-notes', path: 'assets/logo.png' },
    )
    expect(result.isError).toBe(false)
    expect(result.text).toContain('binary file of 8 bytes')
    expect(result.text).not.toContain('iVBORw0KGgo')
  })

  it('answers a marker for a file that is not text', async () => {
    const binary = `\u0000\u0001\u0002${'x'.repeat(20)}`
    const result = await call(
      [
        offered('release-notes', {
          files: [
            { path: 'SKILL.md', content: RELEASE_NOTES_MD },
            { path: 'assets/logo.png', content: binary },
          ],
        }),
      ],
      SKILL_READ_TOOL_NAME,
      { name: 'release-notes', path: 'assets/logo.png' },
    )
    expect(result.isError).toBe(false)
    expect(result.text).toContain('binary file')
    expect(result.text).toContain('not shown')
    expect(result.text).not.toContain('xxxx')
  })

  it('refuses a name no skill has', async () => {
    const result = await call(withReference(), SKILL_READ_TOOL_NAME, {
      name: 'nope',
      path: 'SKILL.md',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('No skill named "nope"')
  })
})

describe('looksBinary', () => {
  it('is true for the three shapes a decoded binary file takes', () => {
    expect(looksBinary('a\u0000b')).toBe(true)
    expect(looksBinary('a�b')).toBe(true)
    // A tenth of the content in control characters: what a compressed file looks like decoded.
    expect(looksBinary('\u0001'.repeat(5) + 'x'.repeat(44))).toBe(true)
  })

  it('is false for text, and for the whitespace text is full of', () => {
    expect(looksBinary('')).toBe(false)
    expect(looksBinary('plain text\nwith lines\tand tabs\r\n')).toBe(false)
    // A stray control character in prose is not a binary file.
    expect(looksBinary(`${'word '.repeat(40)}\u0007`)).toBe(false)
  })
})
