import type { PreviewSkillImportResponse, SkillImportCandidate } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import {
  frameOf,
  pressKey,
  tick,
  typeText,
  waitFor,
  waitForFrame,
  waitForScreen,
} from '../test-support/input'
import { SkillImportPicker } from './skill-import'

/**
 * The import pick (epic #349, K3; #354).
 *
 * The screen at the keyboard: which candidates start chosen, what space and `a` do, that a
 * candidate which cannot be imported does not respond to space, and what Enter hands back —
 * the whole of what a reader decides before an import, without a terminal.
 */

afterEach(cleanup)

function candidate(overrides: Partial<SkillImportCandidate> = {}): SkillImportCandidate {
  return {
    name: 'release-notes',
    folder: 'release-notes',
    description: 'Writes the release notes.',
    files: [{ path: 'SKILL.md', size: 128 }],
    skill_md: '---\nname: release-notes\n---\n',
    problems: [],
    name_taken: false,
    ...overrides,
  }
}

const PREVIEW: PreviewSkillImportResponse = {
  url: 'https://github.com/example/skills',
  ref: null,
  path: null,
  commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
  candidates: [
    candidate(),
    candidate({
      name: 'broken',
      description: null,
      problems: [{ code: 'invalid-frontmatter', message: 'no description' }],
    }),
    candidate({ name: 'mine', name_taken: true }),
  ],
}

/** Render the pick and record what it settled with. */
function renderPicker(initialSelection?: readonly string[], preview = PREVIEW) {
  const results: (readonly string[] | null)[] = []
  const app = render(
    <SkillImportPicker
      preview={preview}
      {...(initialSelection === undefined ? {} : { initialSelection })}
      onConfirm={(names) => results.push(names)}
      onCancel={() => results.push(null)}
    />,
  )
  return { app, results }
}

describe('SkillImportPicker (#354)', () => {
  it('names where the clone landed, and marks each candidate', async () => {
    const { app } = renderPicker()
    await waitForScreen(app, 'Import from')

    await waitForFrame(app, 'release-notes')
    const frame = frameOf(app)
    expect(frame).toContain('https://github.com/example/skills')
    expect(frame).toContain('9f2c1b4')
    // Every importable candidate starts chosen; the two that cannot be imported are marked and
    // carry their reason.
    expect(frame).toContain('◉ release-notes')
    expect(frame).toContain('✗ broken')
    expect(frame).toContain('cannot be imported')
    expect(frame).toContain('invalid-frontmatter: no description')
    expect(frame).toContain('✗ mine')
    expect(frame).toContain('you already have a skill with this name')
    // What Enter would import, so a reader knows before pressing it.
    expect(frame).toContain('Enter import (1)')
  })

  it('toggles a candidate with space, and hands back the chosen ones on Enter', async () => {
    const preview: PreviewSkillImportResponse = {
      ...PREVIEW,
      candidates: [candidate(), candidate({ name: 'helper', description: 'Helps.' })],
    }
    const { app, results } = renderPicker(undefined, preview)
    await waitForScreen(app, 'Import from')

    // Both start chosen; space drops the highlighted one, so only `helper` is left.
    await waitForFrame(app, 'Enter import (2)')
    typeText(app, ' ')
    await waitForFrame(app, 'Enter import (1)')
    pressKey(app, 'enter')

    await waitFor(() => results.length > 0)
    expect(results).toEqual([['helper']])
  })

  it('does not let space choose a candidate that cannot be imported', async () => {
    const { app, results } = renderPicker()
    await waitForScreen(app, 'Import from')
    await waitForFrame(app, 'Enter import (1)')

    // Walk to the broken candidate and press space: nothing changes, and Enter still imports
    // only the one that can be imported.
    pressKey(app, 'down')
    await tick(20)
    typeText(app, ' ')
    await tick(20)
    expect(frameOf(app)).toContain('✗ broken')
    expect(frameOf(app)).toContain('Enter import (1)')

    pressKey(app, 'enter')
    await waitFor(() => results.length > 0)
    expect(results).toEqual([['release-notes']])
  })

  it('takes them all and drops them all with `a`', async () => {
    const preview: PreviewSkillImportResponse = {
      ...PREVIEW,
      candidates: [candidate(), candidate({ name: 'helper' })],
    }
    const { app, results } = renderPicker([], preview)
    await waitForScreen(app, 'Import from')
    await waitForFrame(app, 'nothing chosen')

    typeText(app, 'a')
    await waitForFrame(app, 'Enter import (2)')
    pressKey(app, 'enter')

    await waitFor(() => results.length > 0)
    expect(results).toEqual([['release-notes', 'helper']])
  })

  it('leaves with Esc, choosing nothing', async () => {
    const { app, results } = renderPicker()
    await waitForScreen(app, 'Import from')

    pressKey(app, 'escape')
    await waitFor(() => results.length > 0)
    expect(results).toEqual([null])
  })

  it('says so when the path held no candidate at all', async () => {
    const { app } = renderPicker(undefined, { ...PREVIEW, candidates: [] })
    await waitForScreen(app, 'Import from')
    await waitForFrame(app, 'Nothing under that path')
    expect(frameOf(app)).toContain('Nothing under that path holds a SKILL.md.')
  })
})
