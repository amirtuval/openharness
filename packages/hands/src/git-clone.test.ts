import { spawn } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_CLONE_MAX_BYTES,
  GitCloneError,
  cloneRepository,
  isGitCloneError,
  type CloneRepositoryOptions,
} from './git-clone'
import type { AddressResolver, SafeFetchTransport } from './safe-fetch'
import { createGitFixture, gitAvailable, type GitFixture } from './testing/git-fixture'

/**
 * The clone (epic #349, K3).
 *
 * Every test here runs the **real** thing against a **real** git server: `isomorphic-git`
 * talking smart HTTP to `git upload-pack` on loopback, through the real `safeFetch` guard. The
 * fixture is `src/testing/git-fixture.ts` — a repository built from a map of files, served the
 * way a forge serves one — and what the clone answers is checked against `git rev-parse` and
 * the file map it was built from, so a test that passes has proved the packfile was really
 * read rather than that a stub agreed with itself.
 *
 * Two environment rules make it honest:
 *
 * - **The egress proxy is dropped.** `safeFetch` honours `HTTP_PROXY`/`HTTPS_PROXY`, and a
 *   sandbox started behind one would have the proxy answer for an address the guard was
 *   supposed to refuse. The same rule `safe-fetch.test.ts` follows.
 * - **A suite without a `git` executable skips itself**, with a note: the served side is real
 *   `git` on purpose (a hand-written packfile would test the client against our idea of the
 *   format), so a machine without one cannot run these.
 */
for (const key of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]) {
  delete process.env[key]
}

const GIT = await gitAvailable()

/** The files the fixture repository of most tests holds: two skills, one nested reference. */
const REPOSITORY = {
  'README.md': '# skills\n',
  'skills/release-notes/SKILL.md':
    '---\nname: release-notes\ndescription: Writes the release notes.\n---\n\nWrite them.\n',
  'skills/release-notes/reference/tone.md': 'Be brief.\n',
  'skills/changelog/SKILL.md':
    '---\nname: changelog\ndescription: Keeps the changelog.\n---\n\nKeep it.\n',
}

const fixtures: GitFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

/** A fixture this suite will close for the test, whatever the test does. */
async function fixture(files: Record<string, string> = REPOSITORY): Promise<GitFixture> {
  const created = await createGitFixture({ files })
  fixtures.push(created)
  return created
}

/** What a clone did: its answer, or the code it was refused with. */
async function attempt(
  options: CloneRepositoryOptions,
): Promise<
  { ok: true; files: Record<string, string>; commit_sha: string } | { ok: false; code: string }
> {
  try {
    const clone = await cloneRepository(options)
    const files: Record<string, string> = {}
    for (const file of clone.files) {
      files[file.path] = new TextDecoder().decode(file.content)
    }
    return { ok: true, files, commit_sha: clone.commit_sha }
  } catch (error) {
    return { ok: false, code: isGitCloneError(error) ? error.code : `threw:${String(error)}` }
  }
}

/** A resolver over a table, failing for anything else — the seam the guard's tests use. */
function resolverFor(table: Record<string, readonly string[]>): AddressResolver {
  return (hostname) => {
    const addresses = table[hostname.toLowerCase()]
    return addresses === undefined
      ? Promise.reject(new Error(`ENOTFOUND ${hostname}`))
      : Promise.resolve(addresses)
  }
}

/**
 * A transport that connects to the fixture whatever host the guard checked, so the first hop
 * can be a *public* name and the hop under test can be a later one.
 */
function viaFixture(port: number, host = 'public.example'): SafeFetchTransport {
  return (url, init) =>
    fetch(url.replace(`${host}:${port}`, `127.0.0.1:${port}`), {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      redirect: 'manual',
    })
}

describe.skipIf(!GIT)('cloneRepository', () => {
  it('clones the repository’s default branch, tree and all', async () => {
    const repo = await fixture()
    const clone = await attempt({ url: repo.url, allowPrivate: true })
    expect(clone.ok).toBe(true)
    if (!clone.ok) {
      return
    }
    // The commit is the one the branch is really at, read back from git itself.
    expect(clone.commit_sha).toBe(await repo.head())
    expect(Object.keys(clone.files).sort()).toEqual(Object.keys(REPOSITORY).sort())
    expect(clone.files['skills/release-notes/reference/tone.md']).toBe('Be brief.\n')
    expect(clone.files['skills/release-notes/SKILL.md']).toContain('name: release-notes')
  })

  it('clones a branch, a tag and a commit by name', async () => {
    const repo = await fixture()
    const first = await repo.head()
    await repo.commit({ ...REPOSITORY, 'skills/changelog/SKILL.md': 'changed\n' }, 'second')
    const second = await repo.head()
    await repo.tag('v1.0', first)
    await repo.tag('v2.0-annotated', second)
    await repo.branch('stable', first)

    const branch = await attempt({ url: repo.url, ref: 'stable', allowPrivate: true })
    expect(branch).toMatchObject({ ok: true, commit_sha: first })
    const tag = await attempt({ url: repo.url, ref: 'v1.0', allowPrivate: true })
    expect(tag).toMatchObject({ ok: true, commit_sha: first })
    // An annotated tag's own object is not the commit; what is stored is the commit it names.
    const annotated = await attempt({ url: repo.url, ref: 'v2.0-annotated', allowPrivate: true })
    expect(annotated).toMatchObject({ ok: true, commit_sha: second })
    const commit = await attempt({ url: repo.url, ref: first, allowPrivate: true })
    expect(commit).toMatchObject({ ok: true, commit_sha: first })
  })

  it('carries the default branch’s files and nothing of the other branch’s', async () => {
    const repo = await fixture()
    const first = await repo.head()
    await repo.commit({ 'only-here/SKILL.md': 'x\n' }, 'second')
    await repo.branch('old', first)

    const current = await attempt({ url: repo.url, allowPrivate: true })
    expect(Object.keys(current.ok ? current.files : {})).toEqual(['only-here/SKILL.md'])
    const old = await attempt({ url: repo.url, ref: 'old', allowPrivate: true })
    expect(Object.keys(old.ok ? old.files : {}).sort()).toEqual(Object.keys(REPOSITORY).sort())
  })

  it('reads a repository whose root is empty', async () => {
    const repo = await fixture({})
    const clone = await attempt({ url: repo.url, allowPrivate: true })
    expect(clone).toMatchObject({ ok: true, files: {} })
  })

  it('skips a submodule entry instead of failing the clone', async () => {
    const repo = await fixture()
    // A gitlink is what a submodule is in a tree: an entry of type `commit`, whose object is
    // not in this repository at all. `isomorphic-git` walks it neither into the listing nor
    // into a read — which is what K3 means by "no submodules".
    await run('git', [
      '-C',
      repo.directory,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${await repo.head()},vendor/thing`,
    ])
    await run('git', [
      '-C',
      repo.directory,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '-m',
      'a submodule',
    ])

    const clone = await attempt({ url: repo.url, allowPrivate: true })
    expect(clone.ok).toBe(true)
    expect(clone.ok ? Object.keys(clone.files) : []).not.toContain('vendor/thing')
  })

  it('refuses a ref the repository does not have', async () => {
    const repo = await fixture()
    expect(await attempt({ url: repo.url, ref: 'nope', allowPrivate: true })).toEqual({
      ok: false,
      code: 'ref_not_found',
    })
  })

  it('refuses a loopback address unless the deployment allows private ones', async () => {
    const repo = await fixture()
    // The self-host flag is the guard's `allowPrivate`, the same one a remote MCP server reads
    // (#303, X10): with it off, the address a loopback fixture lives on is refused.
    expect(await attempt({ url: repo.url })).toEqual({ ok: false, code: 'refused_address' })
    expect(await attempt({ url: repo.url, allowPrivate: true })).toMatchObject({ ok: true })
  })

  it('refuses something that is not a repository', async () => {
    const repo = await fixture()
    const host = new URL(repo.url)
    const notGit = `http://${host.host}/nothing.git`
    expect(await attempt({ url: notGit, allowPrivate: true })).toEqual({
      ok: false,
      code: 'not_a_repository',
    })
  })

  it('refuses a host that cannot be reached', async () => {
    const clone = await attempt({
      url: 'http://127.0.0.1:9/none.git',
      allowPrivate: true,
      timeoutMs: 5_000,
    })
    expect(clone).toEqual({ ok: false, code: 'unreachable' })
  })

  it('refuses a redirect that lands on a private address', async () => {
    const repo = await fixture()
    const port = Number(new URL(repo.url).port)
    // The first hop is a public name (`public.example`), so the guard lets it leave; the hop
    // the fixture answers with is the link-local metadata service, and that is refused — by
    // the address check, on the *second* hop, which is the whole point of re-checking.
    const clone = await attempt({
      url: `http://public.example:${port}/skills.git/redirect/private`,
      resolver: resolverFor({ 'public.example': ['93.184.216.34'] }),
      transport: viaFixture(port),
    })
    expect(clone).toEqual({ ok: false, code: 'refused_address' })
  })

  it('refuses a clone over the byte cap', async () => {
    const repo = await fixture()
    const clone = await attempt({ url: repo.url, allowPrivate: true, maxBytes: 32 })
    expect(clone).toEqual({ ok: false, code: 'over_limit' })
    // The cap is the clone's, not one response's: a repository smaller than
    // DEFAULT_CLONE_MAX_BYTES clones with the default.
    expect(DEFAULT_CLONE_MAX_BYTES).toBeGreaterThan(1_000)
  })

  it('refuses a clone its deadline passes', async () => {
    const repo = await fixture()
    const stalled = `${repo.url}/stall`
    const clone = await attempt({ url: stalled, allowPrivate: true, timeoutMs: 250 })
    expect(clone).toEqual({ ok: false, code: 'over_limit' })
  })

  it('answers the in-memory tree and nothing on disk', async () => {
    const repo = await fixture()
    const clone = await cloneRepository({ url: repo.url, allowPrivate: true })
    // The files are the clone's own copies: two clones of one repository share no buffer, so a
    // caller cannot reach into another clone's repository through its answer.
    const second = await cloneRepository({ url: repo.url, allowPrivate: true })
    expect(clone.files[0]).not.toBe(second.files[0])
    expect(clone.files[0]?.content).not.toBe(second.files[0]?.content)
  })

  it('is a GitCloneError a caller can branch on', () => {
    const error = new GitCloneError('ref_not_found', 'no')
    expect(isGitCloneError(error)).toBe(true)
    expect(isGitCloneError(new Error('no'))).toBe(false)
    expect(error.code).toBe('ref_not_found')
  })
})

/** Run a program in a test's own repository; the fixture does the same thing for itself. */
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    )
  })
}
