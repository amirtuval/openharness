import { describe, expect, it } from 'vitest'

import { cloneRepository } from './git-clone'

/**
 * The clone against a **real public repository** (epic #349, K3) — the one thing a loopback
 * fixture cannot prove: that `isomorphic-git`'s smart-HTTP client and our guard understand a
 * real forge.
 *
 * It is opt-in, because it needs the internet: `OPENHARNESS_TEST_NETWORK=1` runs it, and
 * without the variable the file skips with a note. It is deliberately **not** skipped by
 * catching a failure: a test that turns a network error into a pass is a test that never runs.
 *
 * Two rules differ from `git-clone.test.ts`, and both are why this is a file of its own: the
 * egress proxy is left **alone** (a deployment behind one is a documented deployment, and this
 * test may be running behind one), and the repository is not ours to keep, so what is asserted
 * is its shape rather than its contents.
 */
const NETWORK = (process.env['OPENHARNESS_TEST_NETWORK'] ?? '').trim() === '1'

describe.skipIf(!NETWORK)('cloneRepository against a public repository', () => {
  it('clones anthropics/skills through the guard', async () => {
    const clone = await cloneRepository({ url: 'https://github.com/anthropics/skills' })
    expect(clone.commit_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(clone.files.length).toBeGreaterThan(0)
    // It really is a repository of skills: at least one folder holds a SKILL.md.
    expect(clone.files.some((file) => file.path.endsWith('SKILL.md'))).toBe(true)
  }, 120_000)

  it('answers a ref that is not there as ref_not_found', async () => {
    await expect(
      cloneRepository({ url: 'https://github.com/anthropics/skills', ref: 'no-such-branch' }),
    ).rejects.toMatchObject({ code: 'ref_not_found' })
  }, 120_000)
})
