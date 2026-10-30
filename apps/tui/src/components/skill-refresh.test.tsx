import type { RefreshSkillPreviewResponse } from '@openharness/protocol'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { frameOf, pressKey, tick, typeText, waitFor, waitForScreen } from '../test-support/input'
import { refreshConfirmHeading, refreshFileLines, SkillRefreshConfirm } from './skill-refresh'

/**
 * The refresh confirm (epic #349, K5; #354).
 *
 * A refresh replaces a snapshot, so the reader's answer is the whole screen: the skill, what the
 * preview came to, the files that moved, and `y`/`n`. A snapshot with problems cannot be stored,
 * so the screen says so and offers no confirm.
 */

afterEach(cleanup)

const PREVIEW: RefreshSkillPreviewResponse = {
  commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
  changed: true,
  files_added: ['reference/tone.md'],
  files_removed: ['old.md'],
  files_changed: ['SKILL.md'],
  skill_md_diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new',
  problems: [],
}

/** Render the confirm and record what it settled with. */
function renderConfirm(preview = PREVIEW) {
  const results: boolean[] = []
  const app = render(
    <SkillRefreshConfirm
      name="release-notes"
      preview={preview}
      onConfirm={() => results.push(true)}
      onCancel={() => results.push(false)}
    />,
  )
  return { app, results }
}

describe('refreshFileLines (#354)', () => {
  it('marks what was added, removed and changed', () => {
    expect(refreshFileLines(PREVIEW)).toEqual(['+ reference/tone.md', '- old.md', '~ SKILL.md'])
  })

  it('says what the preview came to, in the heading', () => {
    expect(refreshConfirmHeading('release-notes', PREVIEW)).toBe(
      'Refresh release-notes: 1 file added, 1 file removed, 1 file changed @ 9f2c1b4',
    )
  })
})

describe('SkillRefreshConfirm (#354)', () => {
  it('shows the summary, the files and the question', async () => {
    const { app } = renderConfirm()
    await waitForScreen(app, 'Refresh release-notes')

    const frame = frameOf(app)
    expect(frame).toContain('1 file added, 1 file removed, 1 file changed')
    expect(frame).toContain('+ reference/tone.md')
    expect(frame).toContain('- old.md')
    expect(frame).toContain('~ SKILL.md')
    expect(frame).toContain('Replace the stored snapshot with this one? [y/N]')
  })

  it('confirms on `y` and cancels on `n`', async () => {
    const yes = renderConfirm()
    await waitForScreen(yes.app, 'Refresh release-notes')
    typeText(yes.app, 'y')
    await waitFor(() => yes.results.length > 0)
    expect(yes.results).toEqual([true])

    const no = renderConfirm()
    await waitForScreen(no.app, 'Refresh release-notes')
    typeText(no.app, 'n')
    await waitFor(() => no.results.length > 0)
    expect(no.results).toEqual([false])
  })

  it('leaves on Esc and on Enter, keeping the snapshot', async () => {
    const escape = renderConfirm()
    await waitForScreen(escape.app, 'Refresh release-notes')
    pressKey(escape.app, 'escape')
    await waitFor(() => escape.results.length > 0)
    expect(escape.results).toEqual([false])

    const enter = renderConfirm()
    await waitForScreen(enter.app, 'Refresh release-notes')
    pressKey(enter.app, 'enter')
    await waitFor(() => enter.results.length > 0)
    expect(enter.results).toEqual([false])
  })

  it('offers no confirm for a snapshot that cannot be stored', async () => {
    const { app, results } = renderConfirm({
      ...PREVIEW,
      problems: [{ code: 'over-limit', message: 'the skill is over the limit' }],
    })
    await waitForScreen(app, 'Refresh release-notes')

    const frame = frameOf(app)
    expect(frame).toContain('cannot be stored')
    expect(frame).toContain('over-limit: the skill is over the limit')
    expect(frame).toContain('Keeping the snapshot you have.')

    // `y` is not a confirm here: the route would refuse the write.
    typeText(app, 'y')
    await tick(20)
    expect(results).toEqual([])
  })
})
