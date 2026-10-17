import {
  RESERVED_SKILL_NAMES,
  isReservedSkillName,
  newSkillId,
  skillSettingsOf,
} from '@openharness/protocol'
import type { SkillImportCandidate } from '@openharness/protocol'
import { makeSkill } from '@openharness/protocol/fixtures'
import { describe, expect, it } from 'vitest'

import {
  BUILTIN_COMMANDS,
  candidateSelectable,
  filterSlashCommands,
  importableCandidateNames,
  invocationSkill,
  isBuiltinCommandName,
  parseSlashCommand,
  refreshChangeSummary,
  refreshFileChanges,
  shortCommit,
  skillBadgeLabel,
  skillFileList,
  skillFileSizeLabel,
  skillSourceLabel,
  slashCommandQuery,
  slashCommands,
  slashEnterAction,
} from './skills'

/** A candidate with nothing wrong with it, named `name`. */
function candidate(
  name: string,
  overrides: Partial<SkillImportCandidate> = {},
): SkillImportCandidate {
  return {
    name,
    folder: name,
    description: `${name} does a thing.`,
    files: [{ path: 'SKILL.md', size: 100 }],
    skill_md: `---\nname: ${name}\n---\n\nbody`,
    problems: [],
    name_taken: false,
    ...overrides,
  }
}

describe('the built-in command list (K7)', () => {
  it('names only reserved commands, and spells each one once', () => {
    expect(BUILTIN_COMMANDS.length).toBeGreaterThan(0)
    for (const command of BUILTIN_COMMANDS) {
      expect(isReservedSkillName(command.name)).toBe(true)
      expect(command.usage.startsWith(`/${command.name}`)).toBe(true)
      expect(command.description.length).toBeGreaterThan(0)
    }
    expect(new Set(BUILTIN_COMMANDS.map((command) => command.name)).size).toBe(
      BUILTIN_COMMANDS.length,
    )
  })

  it('is a subset of the reserved names, and answers which names are built-in', () => {
    // The menu's own names have to be reserved — otherwise a skill could take one — and the
    // list is deliberately shorter than the reserved names: a built-in appears when its action
    // exists, and the rest are held for the rows that land later.
    for (const name of BUILTIN_COMMANDS.map((command) => command.name)) {
      expect(RESERVED_SKILL_NAMES).toContain(name)
    }
    expect(isBuiltinCommandName('compact')).toBe(true)
    expect(isBuiltinCommandName('new')).toBe(false)
    expect(isBuiltinCommandName('release-notes')).toBe(false)
  })
})

describe('the / menu (K7)', () => {
  it('lists the built-ins first, then the reader’s usable skills, with their hints', () => {
    const releaseNotes = newSkillId()
    const commands = slashCommands([
      makeSkill({ name: 'release-notes', id: releaseNotes }),
      makeSkill({
        name: 'secret',
        id: newSkillId(),
        frontmatter: { 'user-invocable': false },
      }),
      makeSkill({ name: 'off', id: newSkillId(), enabled: false }),
    ])

    expect(commands.map((command) => command.name)).toEqual(['compact', 'release-notes'])
    const compact = commands[0]
    expect(compact).toMatchObject({
      kind: 'builtin',
      usage: '/compact [instructions]',
      argumentHint: null,
      skillId: null,
    })
    const skill = commands[1]
    expect(skill).toMatchObject({
      kind: 'skill',
      name: 'release-notes',
      skillId: releaseNotes,
      usage: '/release-notes <[version]>',
      argumentHint: '[version]',
    })
  })

  it('leaves a user-invocable: false skill out and keeps a command-only one in', () => {
    const commands = slashCommands([
      makeSkill({ name: 'model-only', frontmatter: { 'user-invocable': false } }),
      makeSkill({ name: 'command-only', frontmatter: { 'disable-model-invocation': true } }),
    ])

    expect(commands.map((command) => command.name)).toEqual(['compact', 'command-only'])
    expect(skillSettingsOf({ ...makeSkill(), frontmatter: {} }).userInvocable).toBe(true)
  })

  it('spells a skill with no argument-hint as just its name', () => {
    const commands = slashCommands([makeSkill({ frontmatter: {} })])

    expect(commands[1]?.usage).toBe('/release-notes')
    expect(commands[1]?.argumentHint).toBeNull()
  })

  it('reads the word being typed after the slash', () => {
    expect(slashCommandQuery('/')).toBe('')
    expect(slashCommandQuery('/co')).toBe('co')
    expect(slashCommandQuery('  /release')).toBe('release')
    expect(slashCommandQuery('/compact keep the API decisions')).toBeNull()
    expect(slashCommandQuery('a message with / in it')).toBeNull()
    expect(slashCommandQuery('hello')).toBeNull()
    expect(slashCommandQuery('')).toBeNull()
  })

  it('filters by prefix, case-insensitively, and answers nothing for a miss', () => {
    const commands = slashCommands([
      makeSkill({ name: 'release-notes' }),
      makeSkill({ name: 'changelog' }),
    ])

    expect(filterSlashCommands(commands, '').map((command) => command.name)).toEqual([
      'compact',
      'release-notes',
      'changelog',
    ])
    expect(filterSlashCommands(commands, 're').map((command) => command.name)).toEqual([
      'release-notes',
    ])
    expect(filterSlashCommands(commands, 'COMP').map((command) => command.name)).toEqual([
      'compact',
    ])
    expect(filterSlashCommands(commands, 'zzz')).toEqual([])
  })

  it('is what Enter does with the line: run a full built-in, complete a skill, else send', () => {
    const commands = slashCommands([makeSkill({ name: 'release-notes' })])
    const release = commands[1]!
    expect(release.kind).toBe('skill')

    // A built-in named in full is a command with nothing left to type: Enter runs it now.
    expect(slashEnterAction('/compact', commands)).toEqual({ kind: 'run', name: 'compact' })
    // A skill is never run from the menu — it is sent carrying its arguments — so even a full
    // name completes to `/name ` for them.
    expect(slashEnterAction('/release-notes', commands)).toEqual({
      kind: 'complete',
      name: 'release-notes',
    })
    // A name still being typed completes to the row the reader is on.
    expect(slashEnterAction('/co', commands, commands[0])).toEqual({
      kind: 'complete',
      name: 'compact',
    })
    expect(slashEnterAction('/release', commands, release)).toEqual({
      kind: 'complete',
      name: 'release-notes',
    })
    // Arguments typed, a miss, or an ordinary message: Enter sends, as it always did.
    expect(slashEnterAction('/release-notes v1.2', commands, release)).toEqual({ kind: 'send' })
    expect(slashEnterAction('/compact keep the API decisions', commands)).toEqual({ kind: 'send' })
    expect(slashEnterAction('/release-notes v1.2', commands)).toEqual({ kind: 'send' })
    expect(slashEnterAction('/zzz', commands)).toEqual({ kind: 'send' })
    expect(slashEnterAction('hello', commands)).toEqual({ kind: 'send' })
    expect(slashEnterAction('', commands)).toEqual({ kind: 'send' })
    // A partial with no row highlighted is nothing to complete to, so it is sent — and a line
    // naming no command is an ordinary message either way.
    expect(slashEnterAction('/release', commands)).toEqual({ kind: 'send' })
  })
})

describe('parsing a slash invocation (K7)', () => {
  const commands = slashCommands([makeSkill({ name: 'release-notes' })])

  it('reads a skill line into its name and arguments', () => {
    const invocation = parseSlashCommand('/release-notes v1.2', commands)

    expect(invocation).toMatchObject({
      text: '/release-notes v1.2',
      arguments: 'v1.2',
    })
    expect(invocation?.command).toMatchObject({ kind: 'skill', name: 'release-notes' })
    expect(invocationSkill(invocation!)).toEqual({ name: 'release-notes', arguments: 'v1.2' })
  })

  it('omits the arguments when the line carried none', () => {
    const bare = parseSlashCommand('/release-notes', commands)

    expect(bare?.arguments).toBeNull()
    expect(invocationSkill(bare!)).toEqual({ name: 'release-notes' })
    // Whitespace around the line is not an argument.
    expect(parseSlashCommand('  /release-notes   ', commands)?.arguments).toBeNull()
  })

  it('reads a built-in command and sends no skill for it', () => {
    const invocation = parseSlashCommand('/compact keep the API decisions', commands)

    expect(invocation?.command.kind).toBe('builtin')
    expect(invocation?.arguments).toBe('keep the API decisions')
    expect(invocation?.text).toBe('/compact keep the API decisions')
    // A built-in is a client action, never an invocation of a skill.
    expect(invocationSkill(invocation!)).toBeNull()
  })

  it('leaves everything else an ordinary message', () => {
    expect(parseSlashCommand('/Comp', commands)).toBeNull()
    expect(parseSlashCommand('/comp', commands)).toBeNull()
    expect(parseSlashCommand('/compactx', commands)).toBeNull()
    expect(parseSlashCommand('/unknown', commands)).toBeNull()
    expect(parseSlashCommand('hello /compact', commands)).toBeNull()
    expect(parseSlashCommand('a bare /', commands)).toBeNull()
    expect(parseSlashCommand('/release-notes-2 v1', commands)).toBeNull()
  })

  it('keeps the whole line as the message text, and its arguments trimmed', () => {
    const invocation = parseSlashCommand('/release-notes   v1.2  ', commands)

    expect(invocation?.text).toBe('/release-notes   v1.2')
    expect(invocation?.arguments).toBe('v1.2')
  })
})

describe('the settings words (K1, K3, K5)', () => {
  it('names the two frontmatter fields that change who can use a skill', () => {
    expect(skillBadgeLabel(makeSkill({ frontmatter: {} }))).toBeNull()
    expect(skillBadgeLabel(makeSkill({ frontmatter: { 'disable-model-invocation': true } }))).toBe(
      'command only',
    )
    expect(skillBadgeLabel(makeSkill({ frontmatter: { 'user-invocable': false } }))).toBe(
      'model only',
    )
  })

  it('reads a source as one line, with the short commit', () => {
    expect(
      skillSourceLabel({
        url: 'https://github.com/example/skills',
        ref: 'main',
        path: 'release-notes',
        commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
      }),
    ).toBe('https://github.com/example/skills · main · release-notes @ 9f2c1b4')

    expect(
      skillSourceLabel({
        url: 'https://github.com/example/skills',
        ref: null,
        path: null,
        commit_sha: null,
      }),
    ).toBe('https://github.com/example/skills')
  })

  it('writes a file size as a reader reads it, and sorts a file list by path', () => {
    expect(skillFileSizeLabel(0)).toBe('0 B')
    expect(skillFileSizeLabel(380)).toBe('380 B')
    expect(skillFileSizeLabel(1_240)).toBe('1.2 KB')
    expect(skillFileSizeLabel(2 * 1024 * 1024)).toBe('2.0 MB')

    expect(
      skillFileList([
        { path: 'reference/tone.md', size: 1 },
        { path: 'SKILL.md', size: 2 },
      ]).map((file) => file.path),
    ).toEqual(['SKILL.md', 'reference/tone.md'])
  })

  it('keeps a candidate with problems or a taken name out of an import', () => {
    expect(candidateSelectable(candidate('a'))).toBe(true)
    expect(
      candidateSelectable(
        candidate('b', { problems: [{ code: 'name-mismatch', message: 'the name is not’s' }] }),
      ),
    ).toBe(false)
    expect(candidateSelectable(candidate('c', { name_taken: true }))).toBe(false)

    expect(
      importableCandidateNames([candidate('a'), candidate('c', { name_taken: true })]),
    ).toEqual(['a'])
  })

  it('summarizes a refresh: unchanged, or what moved', () => {
    const unchanged = {
      commit_sha: 'abc1234',
      changed: false,
      files_added: [],
      files_removed: [],
      files_changed: [],
      skill_md_diff: null,
      problems: [],
    }
    expect(refreshChangeSummary(unchanged)).toBe('unchanged')
    expect(refreshFileChanges(unchanged)).toEqual([])

    const changed = {
      ...unchanged,
      changed: true,
      files_added: ['new.md'],
      files_removed: ['gone.md', 'old.md'],
      files_changed: ['SKILL.md'],
      skill_md_diff: '--- a/SKILL.md\n+++ b/SKILL.md',
    }
    expect(refreshChangeSummary(changed)).toBe('1 file added, 2 files removed, 1 file changed')
    expect(refreshFileChanges(changed)).toEqual([
      { kind: 'added', path: 'new.md' },
      { kind: 'removed', path: 'gone.md' },
      { kind: 'removed', path: 'old.md' },
      { kind: 'changed', path: 'SKILL.md' },
    ])

    // `changed` with nothing in the three lists is a SKILL.md that differs some other way.
    expect(refreshChangeSummary({ ...unchanged, changed: true })).toBe('the snapshot differs')
  })

  it('shortens a commit the way git does', () => {
    expect(shortCommit('9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5')).toBe('9f2c1b4')
  })
})
