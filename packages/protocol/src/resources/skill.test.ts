import { describe, expect, it } from 'vitest'

import { newSkillId } from '../ids'
import {
  GetSkillResponseSchema,
  ListSkillsResponseSchema,
  MAX_SKILL_FILES,
  MAX_SKILLS_PER_USER,
  PreviewSkillImportRequestSchema,
  PreviewSkillImportResponseSchema,
  RESERVED_SKILL_NAMES,
  RefreshSkillPreviewResponseSchema,
  RefreshSkillRequestSchema,
  SKILL_CLONE_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_FILE_MAX_BYTES,
  SKILL_IMPORT_FAILURES,
  SKILL_IMPORT_MESSAGES,
  SKILL_MAX_BYTES,
  SKILL_MD_FILENAME,
  SKILL_MD_MAX_BYTES,
  SKILL_NAME_MAX_LENGTH,
  SkillFileContentSchema,
  SkillImportCandidateSchema,
  SkillImportRequestSchema,
  SkillNameSchema,
  SkillSchema,
  UpdateSkillRequestSchema,
  isReservedSkillName,
  isSkillName,
  skillBody,
  skillFileSize,
  skillSettingsOf,
} from './skill'
import type { Skill } from './skill'

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
    const file = {
      path: 'reference/tone.md',
      size: 6,
      encoding: 'utf8' as const,
      content: 'terse\n',
    }
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

describe('the import request shapes (K3)', () => {
  it('take a URL alone, or with a ref and a path', () => {
    const bare = PreviewSkillImportRequestSchema.parse({ url: 'https://github.com/a/b' })
    expect(bare).toEqual({ url: 'https://github.com/a/b' })
    const full = PreviewSkillImportRequestSchema.parse({
      url: 'https://github.com/a/b',
      ref: 'main',
      path: 'skills',
    })
    expect(full.ref).toBe('main')
    expect(full.path).toBe('skills')
  })

  it('carry the previewed commit and the picked names on the import itself', () => {
    const body = SkillImportRequestSchema.parse({
      url: 'https://github.com/a/b',
      commit_sha: 'abc123',
      names: ['release-notes'],
    })
    expect(body.names).toEqual(['release-notes'])
    // An import that picks nothing says nothing: there is no batch to store.
    expect(
      SkillImportRequestSchema.safeParse({
        url: 'https://github.com/a/b',
        commit_sha: 'a',
        names: [],
      }).success,
    ).toBe(false)
    // The commit is what makes the second step the one that was previewed.
    expect(
      SkillImportRequestSchema.safeParse({ url: 'https://github.com/a/b', names: ['x'] }).success,
    ).toBe(false)
  })

  it('answer a preview with the commit and the candidates', () => {
    const answer = PreviewSkillImportResponseSchema.parse({
      url: 'https://github.com/a/b',
      ref: null,
      path: 'skills',
      commit_sha: 'abc123',
      candidates: [
        {
          name: 'release-notes',
          folder: 'skills/release-notes',
          description: 'Writes the release notes.',
          files: [{ path: 'SKILL.md', size: 120 }],
          skill_md: '---\nname: release-notes\n---\n\nbody\n',
          problems: [],
          name_taken: false,
        },
      ],
    })
    expect(answer.candidates[0]?.name_taken).toBe(false)
    // A name that could not be read out of the frontmatter is `null`, and the folder's name
    // still says what the candidate is.
    const broken = PreviewSkillImportResponseSchema.parse({
      url: 'https://github.com/a/b',
      ref: 'main',
      path: null,
      commit_sha: 'abc123',
      candidates: [
        {
          name: 'broken',
          folder: 'broken',
          description: null,
          files: [],
          skill_md: 'no frontmatter here',
          problems: [{ code: 'invalid-frontmatter', message: 'no frontmatter' }],
          name_taken: true,
        },
      ],
    })
    expect(broken.candidates[0]?.description).toBeNull()
  })

  it('refuse a problem code the protocol does not have', () => {
    const parsed = SkillImportCandidateSchema.safeParse({
      name: 'x',
      folder: 'x',
      description: 'd',
      files: [],
      skill_md: 'x',
      problems: [{ code: 'made-up', message: 'no' }],
      name_taken: false,
    })
    expect(parsed.success).toBe(false)
  })

  it('name every failure, and say something for each', () => {
    for (const failure of SKILL_IMPORT_FAILURES) {
      expect(SKILL_IMPORT_MESSAGES[failure].length).toBeGreaterThan(10)
      expect(SKILL_IMPORT_MESSAGES[failure].endsWith('.')).toBe(true)
    }
    // The codes are the ones the issue names, one each — plus the one that says the repository
    // was read and the *skill* could not be stored.
    expect([...SKILL_IMPORT_FAILURES]).toEqual([
      'unreachable',
      'not_a_repository',
      'authentication_required',
      'ref_not_found',
      'path_not_found',
      'no_skills_found',
      'skill_not_importable',
      'over_limit',
      'refused_address',
    ])
  })
})

describe('the refresh shapes (K5)', () => {
  it('confirm a refresh by naming the commit the preview resolved', () => {
    expect(RefreshSkillRequestSchema.parse({ commit_sha: 'abc123' })).toEqual({
      commit_sha: 'abc123',
    })
    expect(RefreshSkillRequestSchema.safeParse({}).success).toBe(false)
  })

  it('answer a preview with the three file lists, the diff and the problems', () => {
    const answer = RefreshSkillPreviewResponseSchema.parse({
      commit_sha: 'def456',
      changed: true,
      files_added: ['reference/new.md'],
      files_removed: ['reference/old.md'],
      files_changed: ['SKILL.md'],
      skill_md_diff: '--- a/SKILL.md\n+++ b/SKILL.md\n',
      problems: [],
    })
    expect(answer.changed).toBe(true)
    // An unchanged skill is a `false` and no diff, and the lists are empty rather than absent.
    const same = RefreshSkillPreviewResponseSchema.parse({
      commit_sha: 'def456',
      changed: false,
      files_added: [],
      files_removed: [],
      files_changed: [],
      skill_md_diff: null,
      problems: [],
    })
    expect(same.skill_md_diff).toBeNull()
  })
})

describe('skillSettingsOf', () => {
  const parsed = (frontmatter: Record<string, unknown>): Skill =>
    SkillSchema.parse(skill({ frontmatter }))

  it('defaults to a skill the model may use and the user may run', () => {
    expect(skillSettingsOf(parsed({}))).toEqual({
      disableModelInvocation: false,
      userInvocable: true,
      argumentHint: null,
    })
  })

  it('reads the three honoured fields', () => {
    expect(
      skillSettingsOf(
        parsed({
          'disable-model-invocation': true,
          'user-invocable': false,
          'argument-hint': '[version]',
        }),
      ),
    ).toEqual({ disableModelInvocation: true, userInvocable: false, argumentHint: '[version]' })
  })

  it('honours only the shapes the format documents', () => {
    // The frontmatter is open and untyped, so a value a hand-written file got wrong is an
    // ignored field rather than a skill that behaves differently from what it says.
    expect(
      skillSettingsOf(parsed({ 'disable-model-invocation': 'true' })).disableModelInvocation,
    ).toBe(false)
    expect(skillSettingsOf(parsed({ 'user-invocable': 'false' })).userInvocable).toBe(true)
    expect(skillSettingsOf(parsed({ 'argument-hint': '' })).argumentHint).toBe(null)
    expect(skillSettingsOf(parsed({ 'argument-hint': 42 })).argumentHint).toBe(null)
    // A hint is trimmed, and a padding-only one names nothing.
    expect(skillSettingsOf(parsed({ 'argument-hint': '  [version] ' })).argumentHint).toBe(
      '[version]',
    )
    expect(skillSettingsOf(parsed({ 'argument-hint': '   ' })).argumentHint).toBe(null)
  })

  it('renders the format’s bracket spelling back when YAML parsed it as a sequence', () => {
    // `argument-hint: [version]` is a YAML flow sequence, so a snapshot stored before the import
    // kept the raw line carries an array here — and the hint the file meant is what it renders.
    expect(skillSettingsOf(parsed({ 'argument-hint': ['version'] })).argumentHint).toBe('[version]')
    expect(skillSettingsOf(parsed({ 'argument-hint': ['a', 'b'] })).argumentHint).toBe('[a, b]')
    // A hint the format can only mean as text, and nothing else: bad items, and none at all.
    expect(skillSettingsOf(parsed({ 'argument-hint': [] })).argumentHint).toBe(null)
    expect(skillSettingsOf(parsed({ 'argument-hint': ['', ' '] })).argumentHint).toBe(null)
    expect(skillSettingsOf(parsed({ 'argument-hint': ['ok', 1] })).argumentHint).toBe(null)
    expect(skillSettingsOf(parsed({ 'argument-hint': { a: 1 } })).argumentHint).toBe(null)
  })

  it('reads the fields by the names the format uses, and nothing else', () => {
    expect(skillSettingsOf(parsed({ disableModelInvocation: true })).disableModelInvocation).toBe(
      false,
    )
    expect(skillSettingsOf(parsed({ userInvocable: false })).userInvocable).toBe(true)
  })
})

describe('skillBody', () => {
  it('strips a frontmatter block and keeps the instructions', () => {
    const file = '---\nname: release-notes\ndescription: Writes them.\n---\n\nWrite the notes.\n'
    expect(skillBody(file)).toBe('Write the notes.')
  })

  it('ends the block at either marker the format allows', () => {
    expect(skillBody('---\nname: a\n...\nbody\n')).toBe('body')
  })

  it('is the whole file when there is no frontmatter to strip', () => {
    expect(skillBody('Just instructions.\n')).toBe('Just instructions.')
    // A thematic break is not a frontmatter fence: the file does not *open* with one.
    expect(skillBody('Intro.\n\n---\n\nMore.\n')).toBe('Intro.\n\n---\n\nMore.')
    // A block that never closes is not a block.
    expect(skillBody('---\nname: a\nbody\n')).toBe('---\nname: a\nbody')
  })

  it('tolerates a byte-order mark, and trims the blank lines between the two halves', () => {
    expect(skillBody('﻿---\nname: a\n---\n\n  body  \n')).toBe('body')
  })

  it('answers an empty body for a file that is only frontmatter', () => {
    expect(skillBody('---\nname: a\n---\n')).toBe('')
  })

  it('does not parse YAML: the body starts where the marker says', () => {
    // A `---` inside the body is left alone, and a field whose value looks like a fence is a
    // field's problem rather than the body's.
    expect(skillBody('---\nname: a\n---\nbody\n\n---\nmore\n')).toBe('body\n\n---\nmore')
  })
})
