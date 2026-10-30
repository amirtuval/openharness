import { createFakeClient } from '@openharness/client/testing'
import { makeSkill } from '@openharness/protocol/fixtures'
import type { RefreshSkillPreviewResponse, SkillImportCandidate } from '@openharness/protocol'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import {
  formatSkillCandidates,
  formatSkillRefresh,
  formatSkills,
  runSkills,
  type SkillsTerminal,
} from './skills'

/**
 * `oh skills` (epic #349, K3/K5/K7/K8; #354).
 *
 * The formatting helpers hold the words still — the listing, the preview's candidates, the
 * refresh's diff — and `runSkills` is driven against the fake client, which backs
 * `/v1/me/skills` and both of its two-step flows the way the server does: the import stores the
 * previewed `skill_md`, and a refresh replaces the commit only after a confirm.
 */

/** A `CommandIo` that collects what was written, and never blocks on stdin. */
function recorder() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      context: { server: 'https://api.test', debug: false },
    },
  }
}

/** A stdin that answers one line, or nothing at all at end of input. */
function answering(answer: string | undefined): NodeJS.ReadStream {
  return Readable.from(answer === undefined ? [] : [`${answer}\n`]) as unknown as NodeJS.ReadStream
}

/**
 * A terminal for the command: a pipe by default (not a TTY), so a pick or a confirm that needs
 * one is refused the way CI's stdin is. The `[y/N]` questions read stdin directly, so a test
 * that answers one uses {@link piping} instead.
 */
function terminalFor(): SkillsTerminal {
  return {
    stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
    stdout: { write: () => true } as unknown as NodeJS.WriteStream,
    stderr: { write: () => true } as unknown as NodeJS.WriteStream,
  }
}

/** A terminal whose stdin answers `answer`, for the `[y/N]` a pipe reads a line from. */
function piping(answer: string | undefined): SkillsTerminal {
  return {
    stdin: answering(answer),
    stdout: { write: () => true } as unknown as NodeJS.WriteStream,
    stderr: { write: () => true } as unknown as NodeJS.WriteStream,
  }
}

/** One candidate as a preview reports it (K3). */
function candidate(overrides: Partial<SkillImportCandidate> = {}): SkillImportCandidate {
  return {
    name: 'release-notes',
    folder: 'release-notes',
    description: 'Writes the release notes.',
    files: [{ path: 'SKILL.md', size: 128 }],
    skill_md: '---\nname: release-notes\ndescription: Writes the release notes.\n---\n\nBody.\n',
    problems: [],
    name_taken: false,
    ...overrides,
  }
}

describe('formatSkills (#354)', () => {
  it('names a skill, its state, its badge, its source and its description', () => {
    const lines = formatSkills([
      makeSkill({
        name: 'release-notes',
        frontmatter: { 'disable-model-invocation': true, 'argument-hint': '[version]' },
      }),
    ])

    // The head: the name, that it is on, and the badge its frontmatter earns (K1/K8).
    expect(lines[0]).toContain('release-notes')
    expect(lines[0]).toContain('on')
    expect(lines[0]).toContain('command only')
    // The detail: the source with its short commit, and the description (K3).
    expect(lines[1]).toContain('https://github.com/example/skills')
    expect(lines[1]).toContain('9f2c1b4')
    expect(lines[1]).toContain('Writes the release notes')
  })

  it('shows `model only` for a skill the reader cannot type, and `off` for one turned off', () => {
    const lines = formatSkills([
      makeSkill({ name: 'helper', enabled: false, frontmatter: { 'user-invocable': false } }),
    ])
    expect(lines[0]).toContain('helper')
    expect(lines[0]).toContain('off')
    expect(lines[0]).toContain('model only')
  })

  it('says how to add one when there are none', () => {
    expect(formatSkills([])[0]).toContain('No skills yet')
  })
})

describe('formatSkillCandidates (#354)', () => {
  it('marks what can be imported and what cannot, with the reasons', () => {
    const lines = formatSkillCandidates({
      url: 'https://github.com/example/skills',
      ref: null,
      path: null,
      commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
      candidates: [
        candidate(),
        candidate({
          name: 'broken',
          problems: [{ code: 'invalid-frontmatter', message: 'no description' }],
        }),
        candidate({ name: 'mine', name_taken: true }),
      ],
    })

    expect(lines[0]).toContain('https://github.com/example/skills')
    expect(lines[0]).toContain('9f2c1b4')
    expect(lines.some((line) => line.includes('+ release-notes'))).toBe(true)
    expect(lines.some((line) => line.includes('! broken'))).toBe(true)
    expect(lines.some((line) => line.includes('invalid-frontmatter: no description'))).toBe(true)
    expect(lines.some((line) => line.includes('! mine'))).toBe(true)
    expect(lines.some((line) => line.includes('you already have a skill with this name'))).toBe(
      true,
    )
  })

  it('says so when the path holds no SKILL.md', () => {
    const lines = formatSkillCandidates({
      url: 'https://github.com/example/skills',
      ref: null,
      path: null,
      commit_sha: 'abc',
      candidates: [],
    })
    expect(lines[1]).toContain('holds a SKILL.md')
  })
})

describe('formatSkillRefresh (#354)', () => {
  const preview: RefreshSkillPreviewResponse = {
    commit_sha: 'a1b2c3d4e5f6a7b8',
    changed: true,
    files_added: ['reference/tone.md'],
    files_removed: [],
    files_changed: ['SKILL.md'],
    skill_md_diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new',
    problems: [],
  }

  it('summarizes what moved, lists the files, and prints the SKILL.md diff', () => {
    const lines = formatSkillRefresh('release-notes', preview)
    expect(lines[0]).toContain('release-notes')
    expect(lines[0]).toContain('1 file added, 1 file changed')
    expect(lines).toContain('  + reference/tone.md')
    expect(lines).toContain('  ~ SKILL.md')
    expect(lines.some((line) => line.includes('--- SKILL.md ---'))).toBe(true)
    expect(lines.some((line) => line.includes('+new'))).toBe(true)
  })

  it('says nothing changed for an unchanged snapshot', () => {
    const lines = formatSkillRefresh('release-notes', {
      ...preview,
      changed: false,
      files_added: [],
      files_changed: [],
      skill_md_diff: null,
    })
    expect(lines).toContain('  nothing changed.')
  })
})

describe('runSkills (#354)', () => {
  it('lists the reader’s skills, and says how to add one when there are none', async () => {
    const empty = createFakeClient()
    const { io, out } = recorder()
    expect(await runSkills(empty, io, { action: 'list' }, terminalFor())).toBe(0)
    expect(out[0]).toContain('No skills yet')

    const fake = createFakeClient({ skills: [makeSkill()] })
    const second = recorder()
    expect(await runSkills(fake, second.io, { action: 'list' }, terminalFor())).toBe(0)
    expect(second.out.join('\n')).toContain('release-notes')
  })

  it('imports every importable candidate with --all, and skips the broken one', async () => {
    const fake = createFakeClient({
      skillImport: {
        candidates: [
          candidate(),
          candidate({
            name: 'broken',
            problems: [{ code: 'invalid-frontmatter', message: 'no description' }],
          }),
        ],
      },
    })
    const { io, out } = recorder()

    const code = await runSkills(
      fake,
      io,
      { action: 'add', url: 'https://github.com/example/skills', all: true, names: [] },
      terminalFor(),
    )

    expect(code).toBe(0)
    expect(out.some((line) => line.includes('+ release-notes'))).toBe(true)
    expect(out.some((line) => line.includes('! broken'))).toBe(true)
    expect(out.at(-1)).toBe('Imported release-notes.')
    expect((await fake.skills.list()).data.map((skill) => skill.name)).toEqual(['release-notes'])
  })

  it('imports the candidates --name picked, repeatably', async () => {
    const fake = createFakeClient({
      skillImport: { candidates: [candidate(), candidate({ name: 'helper' })] },
    })
    const { io, out } = recorder()

    const code = await runSkills(
      fake,
      io,
      {
        action: 'add',
        url: 'https://github.com/example/skills',
        all: false,
        names: ['release-notes', 'helper'],
      },
      terminalFor(),
    )

    expect(code).toBe(0)
    expect(out.at(-1)).toBe('Imported 2 skills: release-notes, helper.')
  })

  it('names a --name the preview did not offer, and imports nothing', async () => {
    const fake = createFakeClient({ skillImport: { candidates: [candidate()] } })
    const { io, err } = recorder()

    const code = await runSkills(
      fake,
      io,
      { action: 'add', url: 'https://github.com/example/skills', all: false, names: ['nope'] },
      terminalFor(),
    )

    expect(code).toBe(1)
    expect(err[0]).toContain('no skill named nope')
    expect((await fake.skills.list()).data).toEqual([])
  })

  it('refuses a --name whose candidate cannot be imported, with the reason', async () => {
    const fake = createFakeClient({
      skillImport: {
        candidates: [
          candidate({
            name: 'broken',
            problems: [{ code: 'reserved-name', message: 'a built-in name' }],
          }),
        ],
      },
    })
    const { io, err } = recorder()

    const code = await runSkills(
      fake,
      io,
      { action: 'add', url: 'https://github.com/example/skills', all: false, names: ['broken'] },
      terminalFor(),
    )

    expect(code).toBe(1)
    expect(err[0]).toContain('broken cannot be imported')
    expect(err[0]).toContain('reserved-name')
  })

  it('refuses --all when nothing can be imported', async () => {
    const fake = createFakeClient({
      skillImport: {
        candidates: [candidate({ name_taken: true })],
      },
    })
    const { io, err } = recorder()

    const code = await runSkills(
      fake,
      io,
      { action: 'add', url: 'https://github.com/example/skills', all: true, names: [] },
      terminalFor(),
    )

    expect(code).toBe(1)
    expect(err[0]).toContain('nothing in that repository can be imported')
  })

  it('needs a terminal for the pick, and refuses with exit 2 when there is none', async () => {
    const fake = createFakeClient({ skillImport: { candidates: [candidate()] } })
    const { io, err } = recorder()

    const code = await runSkills(
      fake,
      io,
      { action: 'add', url: 'https://github.com/example/skills', all: false, names: [] },
      terminalFor(),
    )

    expect(code).toBe(2)
    expect(err.join('\n')).toContain('--all')
  })

  it('prints the server’s own sentence when the repository could not be read', async () => {
    const fake = createFakeClient({ skillImport: { candidates: [], failure: 'not_a_repository' } })
    const { io, err } = recorder()

    const code = await runSkills(
      fake,
      io,
      { action: 'add', url: 'https://example.com/not-a-repo', all: true, names: [] },
      terminalFor(),
    )

    expect(code).toBe(1)
    expect(err[0]).toContain('not a public git repository')
  })

  it('turns a skill on and off (K8)', async () => {
    const fake = createFakeClient({ skills: [makeSkill({ name: 'release-notes', enabled: true })] })
    const { io, out } = recorder()

    expect(
      await runSkills(fake, io, { action: 'disable', name: 'release-notes' }, terminalFor()),
    ).toBe(0)
    expect(out[0]).toBe('release-notes is off.')
    expect((await fake.skills.list()).data[0]?.enabled).toBe(false)

    expect(
      await runSkills(fake, io, { action: 'enable', name: 'release-notes' }, terminalFor()),
    ).toBe(0)
    expect(out[1]).toBe('release-notes is on.')
  })

  it('lists the names it has when a name is not one of them', async () => {
    const fake = createFakeClient({ skills: [makeSkill({ name: 'release-notes' })] })
    const { io, err } = recorder()

    expect(await runSkills(fake, io, { action: 'enable', name: 'nope' }, terminalFor())).toBe(1)
    expect(err[0]).toContain('no skill named nope')
    expect(err[0]).toContain('release-notes')
  })

  it('refreshes a snapshot after a `y`, and leaves it alone after an `n`', async () => {
    const skill = makeSkill()
    const changed: RefreshSkillPreviewResponse = {
      commit_sha: 'b'.repeat(40),
      changed: true,
      files_added: [],
      files_removed: [],
      files_changed: ['SKILL.md'],
      skill_md_diff: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b',
      problems: [],
    }
    const yes = createFakeClient({
      skills: [skill],
      skillImport: { candidates: [], refresh: { [skill.id]: changed } },
    })
    const first = recorder()

    expect(
      await runSkills(
        yes,
        first.io,
        { action: 'refresh', name: 'release-notes', yes: false },
        piping('y\n'),
      ),
    ).toBe(0)
    expect(first.out.some((line) => line.includes('+b'))).toBe(true)
    expect(first.out.at(-1)).toBe(`Refreshed release-notes to ${'b'.repeat(7)}.`)
    expect((await yes.skills.get(skill.id)).source.commit_sha).toBe('b'.repeat(40))

    const no = createFakeClient({
      skills: [skill],
      skillImport: { candidates: [], refresh: { [skill.id]: changed } },
    })
    const second = recorder()
    expect(
      await runSkills(
        no,
        second.io,
        { action: 'refresh', name: 'release-notes', yes: false },
        piping('n\n'),
      ),
    ).toBe(0)
    expect(second.out.at(-1)).toBe('Not refreshed.')
    expect((await no.skills.get(skill.id)).source.commit_sha).toBe(skill.source.commit_sha)
  })

  it('refreshes without asking with --yes', async () => {
    const skill = makeSkill()
    const fake = createFakeClient({
      skills: [skill],
      skillImport: {
        candidates: [],
        refresh: {
          [skill.id]: {
            commit_sha: 'c'.repeat(40),
            changed: true,
            files_added: [],
            files_removed: [],
            files_changed: ['SKILL.md'],
            skill_md_diff: null,
            problems: [],
          },
        },
      },
    })
    const { io, out } = recorder()

    expect(
      await runSkills(
        fake,
        io,
        { action: 'refresh', name: 'release-notes', yes: true },
        piping(undefined),
      ),
    ).toBe(0)
    expect(out.at(-1)).toBe(`Refreshed release-notes to ${'c'.repeat(7)}.`)
  })

  it('refuses a refresh whose new snapshot cannot be stored, exit 1', async () => {
    const skill = makeSkill()
    const fake = createFakeClient({
      skills: [skill],
      skillImport: {
        candidates: [],
        refresh: {
          [skill.id]: {
            commit_sha: 'd'.repeat(40),
            changed: true,
            files_added: [],
            files_removed: [],
            files_changed: ['SKILL.md'],
            skill_md_diff: null,
            problems: [{ code: 'over-limit', message: 'too big' }],
          },
        },
      },
    })
    const { io, err, out } = recorder()

    expect(
      await runSkills(
        fake,
        io,
        { action: 'refresh', name: 'release-notes', yes: true },
        piping(undefined),
      ),
    ).toBe(1)
    expect(err[0]).toContain('cannot be stored')
    expect(out.some((line) => line.includes('over-limit: too big'))).toBe(true)
    expect((await fake.skills.get(skill.id)).source.commit_sha).toBe(skill.source.commit_sha)
  })

  it('says an unchanged snapshot is already up to date, and asks nothing', async () => {
    const fake = createFakeClient({ skills: [makeSkill()] })
    const { io, out } = recorder()

    expect(
      await runSkills(
        fake,
        io,
        { action: 'refresh', name: 'release-notes', yes: false },
        piping(undefined),
      ),
    ).toBe(0)
    expect(out.at(-1)).toContain('Already up to date')
  })

  it('removes a skill after a `y`, and keeps it after an `n`', async () => {
    const fake = createFakeClient({ skills: [makeSkill()] })
    const first = recorder()

    expect(
      await runSkills(
        fake,
        first.io,
        { action: 'remove', name: 'release-notes', yes: false },
        piping('n\n'),
      ),
    ).toBe(0)
    expect(first.out.at(-1)).toBe('Not removed.')
    expect((await fake.skills.list()).data).toHaveLength(1)

    const second = recorder()
    expect(
      await runSkills(
        fake,
        second.io,
        { action: 'remove', name: 'release-notes', yes: false },
        piping('y\n'),
      ),
    ).toBe(0)
    expect(second.out.at(-1)).toBe('Removed release-notes.')
    expect((await fake.skills.list()).data).toEqual([])
  })

  it('removes without asking with --yes', async () => {
    const fake = createFakeClient({ skills: [makeSkill()] })
    const { io, out } = recorder()

    expect(
      await runSkills(
        fake,
        io,
        { action: 'remove', name: 'release-notes', yes: true },
        piping(undefined),
      ),
    ).toBe(0)
    expect(out.at(-1)).toBe('Removed release-notes.')
    expect((await fake.skills.list()).data).toEqual([])
  })
})
