import { describe, expect, it } from 'vitest'

import { diffSnapshots, skillMdDiff } from './skills-diff'

/**
 * The refresh diff (epic #349, K5), on its own.
 *
 * The file story is pinned by {@link diffSnapshots} — what counts as added, removed and
 * changed for a snapshot of text files — and the `SKILL.md` story by {@link skillMdDiff}: the
 * `git diff` shape (a header, then `@@` hunks with three lines of context), the line numbers a
 * reader trusts, and the two whole-file cases (a file that is only added, one that is only
 * removed) that a single-line test would never reach.
 */

/** One file of a snapshot, as the diff takes it. */
function file(path: string, content: string): { path: string; content: string } {
  return { path, content }
}

describe('diffSnapshots', () => {
  it('sorts three ways: added, removed and changed', () => {
    const difference = diffSnapshots(
      [
        file('SKILL.md', 'a\n'),
        file('gone.md', 'x\n'),
        file('same.md', 'y\n'),
        file('edit.md', '1\n'),
      ],
      [
        file('SKILL.md', 'a\n'),
        file('new.md', 'z\n'),
        file('same.md', 'y\n'),
        file('edit.md', '2\n'),
      ],
    )
    expect(difference.added).toEqual(['new.md'])
    expect(difference.removed).toEqual(['gone.md'])
    expect(difference.changed).toEqual(['edit.md'])
  })

  it('is empty for two snapshots of the same files', () => {
    const files = [file('SKILL.md', 'a\n'), file('reference/tone.md', 'b\n')]
    expect(diffSnapshots(files, files)).toEqual({ added: [], removed: [], changed: [] })
  })

  it('reads two files of one path as changed, not as one file', () => {
    // The comparison is by content: a whitespace-only edit moved the file, and what a snapshot
    // stores is the text.
    const difference = diffSnapshots([file('a.md', 'x\n')], [file('a.md', 'x \n')])
    expect(difference.changed).toEqual(['a.md'])
    expect(difference.added).toEqual([])
  })
})

describe('skillMdDiff', () => {
  it('is null when the file did not change', () => {
    expect(skillMdDiff('a\nb\n', 'a\nb\n')).toBeNull()
    expect(skillMdDiff(null, null)).toBeNull()
    expect(skillMdDiff('', '')).toBeNull()
  })

  it('prints a header, a hunk and marked lines for a changed line', () => {
    const diff = skillMdDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\n')
    expect(diff).toBe(
      [
        '--- a/SKILL.md',
        '+++ b/SKILL.md',
        '@@ -1,3 +1,3 @@',
        ' one',
        '-two',
        '+TWO',
        ' three',
        '',
      ].join('\n'),
    )
  })

  it('counts the line numbers where the change really is', () => {
    const before = `${['a', 'b', 'c', 'd', 'e'].join('\n')}\n`
    const after = `${['a', 'b', 'c', 'D', 'e'].join('\n')}\n`
    const diff = skillMdDiff(before, after) ?? ''
    // The hunk covers line 1 through 5 with the three-line context around line 4.
    expect(diff).toContain('@@ -1,5 +1,5 @@')
    expect(diff).toContain('-d\n+D')
  })

  it('prints a whole-file hunk for a file that is only added or only removed', () => {
    const added = skillMdDiff(null, 'first\nsecond\n') ?? ''
    expect(added).toContain('@@ -0,0 +1,2 @@')
    expect(added).toContain('+first\n+second')

    const removed = skillMdDiff('first\nsecond\n', null) ?? ''
    expect(removed).toContain('@@ -1,2 +0,0 @@')
    expect(removed).toContain('-first\n-second')
  })

  it('splits changes far apart into two hunks, and keeps near ones together', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const before = `${lines.join('\n')}\n`
    // Two changes ten lines apart are separate hunks; nothing prints the unchanged lines
    // between them twice.
    const far =
      skillMdDiff(before, `${[...lines].with(1, 'CHANGED').with(15, 'ALSO').join('\n')}\n`) ?? ''
    expect(far.match(/@@ /g)).toHaveLength(2)

    const near =
      skillMdDiff(before, `${[...lines].with(1, 'CHANGED').with(4, 'ALSO').join('\n')}\n`) ?? ''
    expect(near.match(/@@ /g)).toHaveLength(1)
  })

  it('does not invent a line for a file with no trailing newline', () => {
    // Two files with no trailing newline and the same text are the same file.
    expect(skillMdDiff('one\ntwo', 'one\ntwo')).toBeNull()
    expect(skillMdDiff('one\ntwo', 'one\n2') ?? '').toContain('-two\n+2')
    expect(skillMdDiff('one\ntwo', 'one\ntwo\n') ?? '').toContain('+')
  })

  it('reads a file that became empty, and one that was empty', () => {
    expect(skillMdDiff('a\nb\n', '') ?? '').toContain('-a\n-b')
    expect(skillMdDiff('', 'a\nb\n') ?? '').toContain('+a\n+b')
  })
})
