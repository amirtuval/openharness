import type { Client } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
import { makeSkill } from '@openharness/protocol/fixtures'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  frameOf,
  pressKey,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
} from '../test-support/input'
import { skillRowDetail, skillRowHead, SkillsScreen } from './skills'

/**
 * `/skills` in a chat (#349, K3/K8; #354).
 *
 * The list at the keyboard, against the fake client that backs `/v1/me/skills`: the rows and what
 * they say, the switch, the remove with its question, and the URL entry the import opens with.
 */

const CONTEXT = { server: 'http://localhost:3000' }

afterEach(cleanup)

/** Render the screen and record whether it was left. */
function renderSkills(client: Client) {
  let left = false
  const app = render(
    <SkillsScreen
      client={client}
      context={CONTEXT}
      onDone={() => {
        left = true
      }}
    />,
  )
  return { app, done: () => left }
}

/** Wait until a skill's stored `enabled` is what the screen should have written. */
async function waitForEnabled(
  fake: ReturnType<typeof createFakeClient>,
  name: string,
  enabled: boolean,
): Promise<void> {
  await vi.waitFor(async () => {
    expect((await fake.skills.list()).data.find((skill) => skill.name === name)?.enabled).toBe(
      enabled,
    )
  })
}

describe('skillRowHead / skillRowDetail (#354)', () => {
  it('names the skill, its state and its badge', () => {
    expect(skillRowHead(makeSkill({ name: 'helper', enabled: false }))).toContain('helper')
    expect(skillRowHead(makeSkill({ name: 'helper', enabled: false }))).toContain('off')
    expect(skillRowHead(makeSkill({ frontmatter: { 'user-invocable': false } }))).toContain(
      'model only',
    )
    expect(
      skillRowHead(makeSkill({ frontmatter: { 'disable-model-invocation': true } })),
    ).toContain('command only')
  })

  it('says where the snapshot came from, with the short commit', () => {
    const detail = skillRowDetail(makeSkill())
    expect(detail).toContain('https://github.com/example/skills')
    expect(detail).toContain('9f2c1b4')
    expect(detail).toContain('Writes the release notes')
  })
})

describe('SkillsScreen (#354)', () => {
  it('lists the skills with what each is, and says how to add one when there are none', async () => {
    const empty = renderSkills(createFakeClient())
    await waitForScreen(empty.app, 'Skills')
    await waitForFrame(empty.app, 'No skills yet')
    expect(frameOf(empty.app)).toContain('No skills yet')

    // The fake lists a snapshot's skills by `(imported_at, id)`, and two seeded at the same
    // instant tie on the random half of their ULIDs — so the timestamps are pinned, the way
    // the client's own list-order test pins its ids, or the row order is a coin toss.
    const fake = createFakeClient({
      skills: [
        makeSkill({ name: 'release-notes', imported_at: '2026-01-01T00:00:00.000Z' }),
        makeSkill({
          name: 'helper',
          enabled: false,
          imported_at: '2026-01-02T00:00:00.000Z',
          frontmatter: { 'user-invocable': false },
        }),
      ],
    })
    const { app } = renderSkills(fake)
    await waitForScreen(app, 'Skills')
    await waitForFrame(app, 'release-notes')

    const frame = frameOf(app)
    expect(frame).toContain('❯ release-notes')
    expect(frame).toContain('on')
    expect(frame).toContain('helper')
    expect(frame).toContain('off')
    expect(frame).toContain('model only')
    expect(frame).toContain('9f2c1b4')
    expect(frame).toContain('space on/off · i import')
  })

  it('turns the highlighted skill off and on with space (K8)', async () => {
    const fake = createFakeClient({ skills: [makeSkill({ name: 'release-notes' })] })
    const { app, done } = renderSkills(fake)
    await waitForScreen(app, 'Skills')
    await waitForFrame(app, 'release-notes')

    typeText(app, ' ')
    await waitForEnabled(fake, 'release-notes', false)
    await waitForFrame(app, 'release-notes  off')
    expect(done()).toBe(false)

    typeText(app, ' ')
    await waitForEnabled(fake, 'release-notes', true)
    await waitForFrame(app, 'release-notes  on')
  })

  it('removes a skill after a `y`, and keeps it after an `n`', async () => {
    const fake = createFakeClient({ skills: [makeSkill({ name: 'release-notes' })] })
    const { app } = renderSkills(fake)
    await waitForScreen(app, 'Skills')
    await waitForFrame(app, 'release-notes')

    typeText(app, 'd')
    await waitForFrame(app, 'Remove release-notes? This cannot be undone [y/N]')
    typeText(app, 'n')
    await waitForFrame(app, 'release-notes')
    expect((await fake.skills.list()).data).toHaveLength(1)

    typeText(app, 'd')
    await waitForFrame(app, 'Remove release-notes?')
    typeText(app, 'y')
    await vi.waitFor(async () => {
      expect((await fake.skills.list()).data).toEqual([])
    })
    await waitForFrame(app, 'No skills yet')
  })

  it('opens a URL entry for an import, and closes it again with Esc', async () => {
    const fake = createFakeClient({ skills: [makeSkill()] })
    const { app } = renderSkills(fake)
    await waitForScreen(app, 'Skills')
    await waitForFrame(app, 'release-notes')

    typeText(app, 'i')
    await waitForFrame(app, 'Import a skill from a public git URL')
    // The prompt slot's one-line entry has the keyboard: Esc gives the list back.
    pressKey(app, 'escape')
    await waitForFrame(app, 'release-notes')
    expect(frameOf(app)).not.toContain('Import a skill from a public git URL')
  })

  it('leaves on Esc and on Ctrl+C', async () => {
    const escape = renderSkills(createFakeClient({ skills: [makeSkill()] }))
    await waitForScreen(escape.app, 'Skills')
    pressKey(escape.app, 'escape')
    await waitFor(() => escape.done())

    const interrupt = renderSkills(createFakeClient({ skills: [makeSkill()] }))
    await waitForScreen(interrupt.app, 'Skills')
    typeText(interrupt.app, '\u0003')
    await waitFor(() => interrupt.done())
  })
})
