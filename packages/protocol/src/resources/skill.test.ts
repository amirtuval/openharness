import { describe, expect, it } from 'vitest'

import { newSkillId } from '../ids'
import {
  GetSkillResponseSchema,
  ListSkillsResponseSchema,
  MAX_SKILL_FILES,
  MAX_SKILLS_PER_USER,
  RESERVED_SKILL_NAMES,
  SKILL_CLONE_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_MAX_BYTES,
  SKILL_MAX_BYTES,
  SKILL_MD_FILENAME,
  SKILL_MD_MAX_BYTES,
  SKILL_NAME_MAX_LENGTH,
  SkillFileContentSchema,
  SkillNameSchema,
  SkillSchema,
  UpdateSkillRequestSchema,
  isReservedSkillName,
  isSkillName,
  skillFileSize,
} from './skill'

/** One fixed id for the fixture, so two builds of it are the same value. */
const SKILL_ID = newSkillId(1_700_000_000_000)

/** A minimal valid resource, so a test can override exactly the field it is about. */
function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SKILL_ID,
    type: 'skill',
    owner_id: 'user_1',
    name: 'release-notes',
    description: 'Writes the release notes for a version.',
    frontmatter: { 'argument-hint': '[version]', license: 'MIT' },
    source: {
      url: 'https://github.com/example/skills',
      ref: 'main',
      path: 'release-notes',
      commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
    },
    files: [
      { path: 'SKILL.md', size: 1_240 },
      { path: 'reference/tone.md', size: 380 },
    ],
    enabled: true,
    imported_at: '2026-03-15T10:00:00Z',
    refreshed_at: '2026-03-15T10:00:00Z',
    ...overrides,
  }
}

describe('skill names', () => {
  it('accepts the names of K1: lowercase, digits and interior dashes', () => {
    expect(isSkillName('release-notes')).toBe(true)
    expect(isSkillName('a')).toBe(true)
    expect(isSkillName('pdf-2')).toBe(true)
    expect(isSkillName('a'.repeat(SKILL_NAME_MAX_LENGTH))).toBe(true)
  })

  it('refuses a name the format does not allow', () => {
    expect(isSkillName('')).toBe(false)
    expect(isSkillName('-release')).toBe(false)
    expect(isSkillName('release-')).toBe(false)
    expect(isSkillName('Release-Notes')).toBe(false)
    expect(isSkillName('release_notes')).toBe(false)
    expect(isSkillName('release.notes')).toBe(false)
    expect(isSkillName('a'.repeat(SKILL_NAME_MAX_LENGTH + 1))).toBe(false)
  })

  it('reserves every built-in slash command, as one list (K7)', () => {
    expect(RESERVED_SKILL_NAMES).toEqual(['compact', 'new', 'model', 'mode', 'agents', 'skills'])
    for (const name of RESERVED_SKILL_NAMES) {
      expect(isReservedSkillName(name)).toBe(true)
      // Reserved names have the shape of one, so the reservation is what refuses them and not
      // the pattern: a test that only checked the shape would pass for the wrong reason.
      expect(isSkillName(name)).toBe(true)
      expect(SkillNameSchema.safeParse(name).success).toBe(false)
    }
    expect(isReservedSkillName('release-notes')).toBe(false)
    expect(SkillNameSchema.parse('release-notes')).toBe('release-notes')
  })

  it('carries the name rule on the resource a store answers with', () => {
    expect(SkillSchema.parse(skill())).toMatchObject({ name: 'release-notes' })
    expect(SkillSchema.safeParse(skill({ name: 'compact' })).success).toBe(false)
    expect(SkillSchema.safeParse(skill({ name: 'Not A Name' })).success).toBe(false)
  })
})

describe('SkillSchema', () => {
  it('parses an imported skill', () => {
    expect(SkillSchema.parse(skill())).toEqual(skill())
  })

  it('requires the owner the server assigned, and a typed source', () => {
    const { owner_id: _owner, ...withoutOwner } = skill()
    expect(SkillSchema.safeParse(withoutOwner).success).toBe(false)
    expect(SkillSchema.safeParse(skill({ id: 'skl_nope' })).success).toBe(false)
    expect(
      SkillSchema.safeParse(
        skill({ source: { url: 'https://github.com/example/skills', ref: 'main' } }),
      ).success,
    ).toBe(false)
  })

  it('accepts a source nothing cloned: null ref, path and commit', () => {
    expect(
      SkillSchema.parse(
        skill({ source: { url: 'https://x.test/s.git', ref: null, path: null, commit_sha: null } }),
      ).source,
    ).toEqual({ url: 'https://x.test/s.git', ref: null, path: null, commit_sha: null })
  })

  it('frontmatter is whatever the file said, nested fields included', () => {
    const frontmatter = {
      license: 'Apache-2.0',
      metadata: { author: 'example', tags: ['notes'] },
      'allowed-tools': ['Read', 'Write'],
      'user-invocable': false,
    }
    expect(SkillSchema.parse(skill({ frontmatter })).frontmatter).toEqual(frontmatter)
  })

  it('a file is a path and a size, and a content is not part of the listing', () => {
    const parsed = SkillSchema.parse(skill())
    expect(parsed.files).toEqual([
      { path: 'SKILL.md', size: 1_240 },
      { path: 'reference/tone.md', size: 380 },
    ])
    // A content beside them is stripped like every unknown field (the protocol's rule), so a
    // listing can never carry one however it was built.
    const withContent = skill({
      files: [{ path: 'SKILL.md', size: 12, content: 'a whole file' }],
    })
    expect(SkillSchema.parse(withContent).files).toEqual([{ path: 'SKILL.md', size: 12 }])
    expect(SkillSchema.safeParse(skill({ files: [{ path: '', size: 1 }] })).success).toBe(false)
    expect(SkillSchema.safeParse(skill({ files: [{ path: 'a.md', size: -1 }] })).success).toBe(
      false,
    )
  })

  it('caps the description at the format’s 1024 characters', () => {
    const description = 'd'.repeat(SKILL_DESCRIPTION_MAX_LENGTH)
    expect(SkillSchema.safeParse(skill({ description })).success).toBe(true)
    expect(SkillSchema.safeParse(skill({ description: `${description}d` })).success).toBe(false)
  })
})

describe('the skill endpoints’ shapes', () => {
  it('reads one skill with SKILL.md’s content', () => {
    const response = { ...skill(), content: '---\nname: release-notes\n---\n\nWrite them.\n' }
    expect(GetSkillResponseSchema.parse(response)).toMatchObject({
      name: 'release-notes',
      content: response.content,
    })
    const { content: _content, ...withoutContent } = response
    expect(GetSkillResponseSchema.safeParse(withoutContent).success).toBe(false)
  })

  it('reads one file with its path, its size and its content', () => {
    const file = { path: 'reference/tone.md', size: 6, content: 'terse\n' }
    expect(SkillFileContentSchema.parse(file)).toEqual(file)
  })

  it('lists skills without a pagination envelope', () => {
    expect(ListSkillsResponseSchema.parse({ data: [skill()] }).data).toHaveLength(1)
  })

  it('updates `enabled` and nothing else', () => {
    expect(UpdateSkillRequestSchema.parse({ enabled: false })).toEqual({ enabled: false })
    expect(UpdateSkillRequestSchema.safeParse({}).success).toBe(false)
    expect(UpdateSkillRequestSchema.parse({ enabled: true, name: 'other' })).toEqual({
      enabled: true,
    })
  })
})

describe('the limits of K4', () => {
  it('are the agreed numbers, in bytes', () => {
    expect(SKILL_MD_MAX_BYTES).toBe(20 * 1024)
    expect(SKILL_FILE_MAX_BYTES).toBe(256 * 1024)
    expect(SKILL_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(MAX_SKILL_FILES).toBe(100)
    expect(MAX_SKILLS_PER_USER).toBe(50)
    expect(SKILL_CLONE_MAX_BYTES).toBe(20 * 1024 * 1024)
    expect(SKILL_MD_FILENAME).toBe('SKILL.md')
  })

  it('fit inside one another', () => {
    // The smaller bounds have to be reachable inside the larger ones, or a limit would be
    // unreachable rather than strict.
    expect(SKILL_MD_MAX_BYTES).toBeLessThanOrEqual(SKILL_FILE_MAX_BYTES)
    expect(SKILL_FILE_MAX_BYTES).toBeLessThanOrEqual(SKILL_MAX_BYTES)
    expect(SKILL_CLONE_MAX_BYTES).toBeLessThanOrEqual(SKILL_MAX_BYTES * MAX_SKILL_FILES)
  })
})

describe('skillFileSize', () => {
  it('counts bytes, not characters', () => {
    expect(skillFileSize('')).toBe(0)
    expect(skillFileSize('hello')).toBe(5)
    // A limit of "20 KB" has to mean what would really be stored: an emoji is four bytes.
    expect(skillFileSize('—')).toBe(3)
    expect(skillFileSize('🙂')).toBe(4)
    expect(skillFileSize('héllo')).toBe(6)
  })
})
