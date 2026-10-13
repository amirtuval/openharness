import { makeSkill } from '@openharness/protocol/fixtures'
import type { SkillImportCandidate } from '@openharness/protocol'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { FakeClient } from '@openharness/client/testing'

import { makeFake, renderApp } from '../../test-support/render-app'

/**
 * Settings → Skills (epic #349, K3/K5/K8; issue #353), against the fake server.
 *
 * The three things a reader does there: see what they have (with the two frontmatter fields
 * that change who can use a skill named on the row), import from a repository in two steps (a
 * preview, then the candidates they pick), and refresh one by hand (what changed, then the
 * confirm). The fake states the repository's side of both flows, because it has no network —
 * `skillImport`'s `candidates` and `refresh`.
 */

/** One candidate the fake's clone finds, importable unless the test says otherwise. */
function candidate(
  name: string,
  overrides: Partial<SkillImportCandidate> = {},
): SkillImportCandidate {
  return {
    name,
    folder: name,
    description: `${name} does a thing.`,
    files: [
      { path: 'SKILL.md', size: 120 },
      { path: 'reference.md', size: 40 },
    ],
    skill_md: `---\nname: ${name}\ndescription: ${name} does a thing.\n---\n\n# ${name}\n`,
    problems: [],
    name_taken: false,
    ...overrides,
  }
}

function renderSkills(options: Parameters<typeof makeFake>[0] = {}): FakeClient {
  const fake = makeFake(options)
  renderApp(fake, { hash: '#/settings' })
  return fake
}

const user = userEvent.setup()

/** The row for one skill, once the list has loaded. */
async function skillRow(name: string): Promise<HTMLElement> {
  const row = await screen.findByText(name)
  return row.closest('[data-slot="skill-row"]') as HTMLElement
}

describe('Settings → Skills: the list (#349, K4; #353)', () => {
  it('lists a skill with its source, its badge and its switch', async () => {
    renderSkills({
      skills: [
        makeSkill({
          name: 'release-notes',
          description: 'Writes the release notes.',
          source: {
            url: 'https://github.com/example/skills',
            ref: 'main',
            path: 'release-notes',
            commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
          },
        }),
      ],
    })

    const row = await skillRow('release-notes')
    expect(within(row).getByText('Writes the release notes.')).toBeInTheDocument()
    expect(
      within(row).getByText(/github\.com\/example\/skills · main · release-notes @ 9f2c1b4/),
    ).toBeInTheDocument()
    expect(within(row).getByRole('checkbox', { name: 'Enable release-notes' })).toBeChecked()
    // Both halves are available, so there is no badge to carry.
    expect(row.querySelector('[data-slot="skill-badge"]')).toBeNull()
  })

  it('names the two frontmatter fields that change who can use a skill', async () => {
    renderSkills({
      skills: [
        makeSkill({ name: 'command-only', frontmatter: { 'disable-model-invocation': true } }),
        makeSkill({ name: 'model-only', frontmatter: { 'user-invocable': false } }),
      ],
    })

    const command = await skillRow('command-only')
    expect(within(command).getByText('command only')).toBeInTheDocument()
    const model = await skillRow('model-only')
    expect(within(model).getByText('model only')).toBeInTheDocument()
    expect(within(model).getByText(/Not a command/)).toBeInTheDocument()
  })

  it('switches a skill off and writes only that field', async () => {
    const fake = renderSkills({ skills: [makeSkill({ name: 'release-notes' })] })

    const row = await skillRow('release-notes')
    await user.click(within(row).getByRole('checkbox', { name: 'Enable release-notes' }))

    // The write is `{ enabled }` and nothing else: a skill's snapshot is not editable here.
    await waitFor(async () => {
      expect((await fake.skills.list()).data[0]?.enabled).toBe(false)
    })
  })

  it('deletes a skill after an in-page confirmation', async () => {
    const fake = renderSkills({ skills: [makeSkill({ name: 'release-notes' })] })

    const row = await skillRow('release-notes')
    await user.click(within(row).getByRole('button', { name: 'Delete release-notes' }))
    expect(
      within(row).getByText(/Chats that already ran it keep their history/),
    ).toBeInTheDocument()
    // Cancel puts it back — nothing was deleted.
    await user.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect((await fake.skills.list()).data).toHaveLength(1)

    await user.click(within(row).getByRole('button', { name: 'Delete release-notes' }))
    // The confirmation's own Delete is named for its skill too, so a card of rows is addressable.
    await user.click(await within(row).findByRole('button', { name: 'Delete release-notes' }))

    await waitFor(async () => {
      expect((await fake.skills.list()).data).toEqual([])
    })
  })
})

describe('Settings → Skills: the import (#349, K3; #353)', () => {
  it('previews a repository and imports the candidates the reader picked', async () => {
    const fake = renderSkills({
      skillImport: { candidates: [candidate('release-notes'), candidate('changelog')] },
    })
    await waitFor(() => expect(screen.getByText(/No skills yet/)).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Import' }))
    const url = screen.getByLabelText('Repository URL')
    await user.type(url, 'https://github.com/example/skills')
    // The optional ref and folder are behind Advanced (K3): a browse URL fills them in.
    await user.click(screen.getByRole('button', { name: /Advanced: a branch/ }))
    await user.type(screen.getByLabelText('Ref'), 'main')
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    // Each candidate carries its description, and both can be imported — so both start picked.
    const notes = (await screen.findByText('release-notes')).closest(
      '[data-slot="skill-candidate"]',
    )
    expect(notes).not.toBeNull()
    expect(
      within(notes as HTMLElement).getByText('release-notes does a thing.'),
    ).toBeInTheDocument()
    expect(
      within(notes as HTMLElement).getByRole('checkbox', { name: 'Import release-notes' }),
    ).toBeChecked()
    // Its SKILL.md and file list are there to read before importing.
    await user.click(within(notes as HTMLElement).getByRole('button', { name: /2 files/ }))
    expect(within(notes as HTMLElement).getByText(/name: release-notes/)).toBeInTheDocument()
    expect(within(notes as HTMLElement).getByText('reference.md')).toBeInTheDocument()
    expect(within(notes as HTMLElement).getByText('40 B')).toBeInTheDocument()

    // Untick one, and Import says what it will do.
    await user.click(
      within(notes as HTMLElement).getByRole('checkbox', { name: 'Import release-notes' }),
    )
    const button = screen.getByRole('button', { name: 'Import 1 skill' })
    await user.click(button)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Import 1 skill' })).not.toBeInTheDocument()
    })
    const stored = (await fake.skills.list()).data
    expect(stored.map((skill) => skill.name)).toEqual(['changelog'])
    expect(stored[0]?.source).toMatchObject({
      url: 'https://github.com/example/skills',
      ref: 'main',
      commit_sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    })
    // And the row is on the screen, with the flow closed.
    expect(await skillRow('changelog')).toBeInTheDocument()
  })

  it('shows a candidate’s problems and a taken name, and will not select them', async () => {
    renderSkills({
      skills: [makeSkill({ name: 'changelog' })],
      skillImport: {
        candidates: [
          candidate('broken', {
            problems: [{ code: 'name-mismatch', message: 'the folder is called broken-two' }],
          }),
          candidate('changelog', { name_taken: true }),
          candidate('release-notes'),
        ],
      },
    })

    await screen.findByText('changelog')
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await user.type(screen.getByLabelText('Repository URL'), 'https://github.com/example/skills')
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    const broken = (await screen.findByText('broken')).closest('[data-slot="skill-candidate"]')
    expect(broken).toHaveAttribute('data-selectable', 'false')
    expect(
      within(broken as HTMLElement).getByText('the folder is called broken-two'),
    ).toBeInTheDocument()
    expect(
      within(broken as HTMLElement).getByRole('checkbox', { name: 'Import broken' }),
    ).toBeDisabled()

    const taken = document.querySelector('[data-candidate="changelog"]') as HTMLElement
    expect(taken).toHaveAttribute('data-selectable', 'false')
    expect(within(taken).getByText(/already have a skill called changelog/)).toBeInTheDocument()
    expect(within(taken).getByRole('checkbox', { name: 'Import changelog' })).toBeDisabled()

    // Only the importable one is counted, and only it can be imported.
    expect(screen.getByRole('button', { name: 'Import 1 skill' })).toBeEnabled()
  })

  it('shows the server’s sentence when a repository cannot be read', async () => {
    const fake = renderSkills({ skillImport: { candidates: [], failure: 'no_skills_found' } })

    await waitFor(() => expect(screen.getByText(/No skills yet/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Import' }))
    await user.type(screen.getByLabelText('Repository URL'), 'https://github.com/example/empty')
    await user.click(screen.getByRole('button', { name: 'Preview' }))

    expect(
      await screen.findByText('That folder holds no SKILL.md, so there is no skill to import.'),
    ).toBeInTheDocument()
    // No preview, so there is nothing to pick and nothing to store.
    expect(screen.queryByText(/Pick the ones to import/)).not.toBeInTheDocument()
    expect((await fake.skills.list()).data).toEqual([])
  })
})

describe('Settings → Skills: the refresh (#349, K5; #353)', () => {
  it('previews the diff and replaces the snapshot on confirm', async () => {
    const skill = makeSkill({ name: 'release-notes' })
    const fake = renderSkills({
      skills: [skill],
      skillImport: {
        candidates: [],
        refresh: {
          [skill.id]: {
            commit_sha: 'f00dbabe1234567890abcdef1234567890abcdef',
            changed: true,
            files_added: ['new.md'],
            files_removed: [],
            files_changed: ['SKILL.md'],
            skill_md_diff: '--- a/SKILL.md\n+++ b/SKILL.md\n+one line more',
            problems: [],
          },
        },
      },
    })

    const row = await skillRow('release-notes')
    await user.click(within(row).getByRole('button', { name: 'Refresh release-notes' }))

    const panel = await within(row).findByText('1 file added, 1 file changed')
    expect(panel).toHaveAttribute('data-changed', 'true')
    expect(within(row).getByText('new.md')).toBeInTheDocument()
    // The changed file is listed, and SKILL.md's own diff is under it.
    expect(
      within(row).getByText('SKILL.md', { selector: 'code[class*="font-mono"]' }),
    ).toBeInTheDocument()
    expect(within(row).getByText(/\+one line more/)).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Replace with this version' }))

    await waitFor(async () => {
      const [stored] = (await fake.skills.list()).data
      expect(stored?.source.commit_sha).toBe('f00dbabe1234567890abcdef1234567890abcdef')
    })
    expect(within(row).queryByText('1 file added, 1 file changed')).not.toBeInTheDocument()
  })

  it('says unchanged when the source has not moved, and still offers the confirm', async () => {
    const skill = makeSkill({ name: 'release-notes' })
    const fake = renderSkills({ skills: [skill] })

    const row = await skillRow('release-notes')
    await user.click(within(row).getByRole('button', { name: 'Refresh release-notes' }))

    const summary = await within(row).findByText('unchanged')
    expect(summary).toHaveAttribute('data-changed', 'false')
    // Nothing to show — no file list, no diff — and the confirm is still there.
    expect(row.querySelector('[data-slot="skill-refresh-files"]')).toBeNull()
    expect(row.querySelector('[data-slot="skill-refresh-diff"]')).toBeNull()

    await user.click(within(row).getByRole('button', { name: 'Confirm' }))
    await waitFor(() => {
      expect(within(row).queryByText('unchanged')).not.toBeInTheDocument()
    })
    // A no-op on the snapshot, and a real write: the skill is still there.
    expect((await fake.skills.list()).data).toHaveLength(1)
  })

  it('refuses to confirm a snapshot with problems', async () => {
    const skill = makeSkill({ name: 'release-notes' })
    renderSkills({
      skills: [skill],
      skillImport: {
        candidates: [],
        refresh: {
          [skill.id]: {
            commit_sha: 'abc1234',
            changed: true,
            files_added: [],
            files_removed: [],
            files_changed: ['SKILL.md'],
            skill_md_diff: 'diff',
            problems: [{ code: 'over-limit', message: 'SKILL.md is over the 20 KB limit' }],
          },
        },
      },
    })

    const row = await skillRow('release-notes')
    await user.click(within(row).getByRole('button', { name: 'Refresh release-notes' }))

    expect(await within(row).findByText('SKILL.md is over the 20 KB limit')).toBeInTheDocument()
    // Replacing a working skill with a broken one is not a refresh, so there is nothing to press.
    expect(within(row).getByRole('button', { name: 'Cannot refresh' })).toBeDisabled()
  })
})
