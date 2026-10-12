import { GitCloneError, cloneRepository, type CloneRepositoryOptions } from '@openharness/hands'
import { createGitFixture, gitAvailable, type GitFixture } from '@openharness/hands/testing'
import {
  API_VERSION_PREFIX,
  SKILL_MD_FILENAME,
  SKILL_MD_MAX_BYTES,
  SkillSchema,
  type ApiErrorBody,
  type GetSkillResponse,
  type RefreshSkillPreviewResponse,
  type PreviewSkillImportResponse,
  type Skill,
} from '@openharness/protocol'
import { afterEach, describe, expect, it } from 'vitest'

import { createTestApp, postJson, type TestContext } from './test-support'

/**
 * Importing a skill from a public repository, and refreshing one (epic #349, K3/K5), over HTTP.
 *
 * The routes are the real ones, the clone is the package's real one, and the repository is a
 * real git server on loopback (`@openharness/hands/testing`'s git fixture, served by
 * `git upload-pack`): only the **URL** is the test's, because an import may only be handed an
 * `https://` one and the fixture is on `http://127.0.0.1`. The injected clone checks that URL
 * and then reads the fixture, exactly as the deployment's clone would read the forge the URL
 * named — a seam in the shape of `createMcpFetch`'s, not a stub of the import itself.
 *
 * So one test proves the whole path at once: the request's URL is split (`parseGitUrl`), the
 * repository is cloned through the guard into memory (`cloneRepository` + `safeFetch`), the
 * candidates are discovered and validated, the picked ones are stored, and a refresh diffs the
 * stored snapshot against a second clone of the same source.
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

const SKILLS = `${API_VERSION_PREFIX}/me/skills`
const GIT = await gitAvailable()

/**
 * The repository most tests clone: one good skill with a reference file, one nested collection,
 * and the four ways a candidate can be unusable (no frontmatter, a name that is not the
 * folder's, a reserved name, and a `SKILL.md` over the 20 KB limit).
 */
const REPOSITORY: Record<string, string> = {
  'README.md': '# skills\n',
  'skills/release-notes/SKILL.md': [
    '---',
    'name: release-notes',
    'description: Writes the release notes for a version.',
    'argument-hint: "[version]"',
    'license: MIT',
    '---',
    '',
    'Write them from the commits since the last tag.',
    '',
  ].join('\n'),
  'skills/release-notes/reference/tone.md': 'Be terse.\n',
  'skills/nested/collection/SKILL.md':
    '---\nname: collection\ndescription: A nested one.\n---\n\nNested.\n',
  'skills/broken/SKILL.md': 'no frontmatter at all\n',
  'skills/mismatch/SKILL.md': '---\nname: other-name\ndescription: d\n---\n\nbody\n',
  // A folder named for a built-in command: the name is well-formed and matches its folder, and
  // it is still not a skill the `/` menu would ever reach (K7).
  'skills/compact/SKILL.md': '---\nname: compact\ndescription: d\n---\n\nbody\n',
  'skills/huge/SKILL.md': `---\nname: huge\ndescription: d\n---\n\n${'x'.repeat(SKILL_MD_MAX_BYTES)}\n`,
}

const fixtures: GitFixture[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

/** A repository fixture this suite closes, whatever the test does. */
async function fixture(files: Record<string, string> = REPOSITORY): Promise<GitFixture> {
  const created = await createGitFixture({ files })
  fixtures.push(created)
  return created
}

/**
 * The clone the routes are handed: the real one, pointed at the fixture.
 *
 * What the service asked for is recorded, so a test can prove the URL reached the clone as the
 * three fields the request meant (`https://github.com/anthropics/skills/tree/main/skills` is
 * `url` + `ref` + `path`, never a browse URL).
 */
function cloneVia(fixtureUrl: string, asked: CloneRepositoryOptions[] = []) {
  return async (options: CloneRepositoryOptions) => {
    asked.push(options)
    return cloneRepository({ ...options, url: fixtureUrl, allowPrivate: true })
  }
}

/** An app whose import routes clone the fixture. */
function appWith(fixtureUrl: string, options: { asked?: CloneRepositoryOptions[] } = {}) {
  return createTestApp({ skillImport: { clone: cloneVia(fixtureUrl, options.asked) } })
}

/** The import source body for a fixture, as a user would type it. */
const SOURCE = { url: 'https://github.com/example/skills', ref: 'main', path: 'skills' }

/** Preview a source, and read the answer. */
async function preview(
  test: TestContext,
  body: unknown = SOURCE,
): Promise<{ status: number; body: PreviewSkillImportResponse }> {
  const response = await postJson(test, `${SKILLS}/import/preview`, body)
  return { status: response.status, body: (await response.json()) as PreviewSkillImportResponse }
}

/** A preview's candidate by name. */
function candidate(body: PreviewSkillImportResponse, name: string) {
  const found = body.candidates.find((entry) => entry.name === name)
  if (found === undefined) {
    throw new Error(
      `no candidate named ${name} in ${body.candidates.map((c) => c.name).join(', ')}`,
    )
  }
  return found
}

/** Import the named candidates, and read the answer. */
async function importSkills(
  test: TestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; body: { data?: Skill[] } & Partial<ApiErrorBody> }> {
  const response = await postJson(test, `${SKILLS}/import`, body)
  const answer = (await response.json()) as { data?: Skill[] } & Partial<ApiErrorBody>
  return { status: response.status, body: answer }
}

/** The error envelope of a failed call. */
async function errorOf(response: Response): Promise<ApiErrorBody> {
  return (await response.json()) as ApiErrorBody
}

describe.skipIf(!GIT)('skill import (epic #349, K3)', () => {
  it('previews every SKILL.md under the path, with what is wrong with each', async () => {
    const repo = await fixture()
    const asked: CloneRepositoryOptions[] = []
    const test = appWith(repo.url, { asked })

    const answer = await postJson(test, `${SKILLS}/import/preview`, {
      url: `https://github.com/example/skills/tree/main/skills`,
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as PreviewSkillImportResponse

    // A browse URL is split into the three fields, and the clone got the repository — never the
    // `/tree/…` half, which no git server serves.
    expect(asked[0]?.url).toBe('https://github.com/example/skills')
    expect(asked[0]?.ref).toBe('main')
    expect(body.url).toBe('https://github.com/example/skills')
    expect(body.ref).toBe('main')
    expect(body.path).toBe('skills')
    expect(body.commit_sha).toBe(await repo.head())

    expect(body.candidates.map((entry) => entry.name).sort()).toEqual([
      'broken',
      'collection',
      'compact',
      'huge',
      'mismatch',
      'release-notes',
    ])

    const good = candidate(body, 'release-notes')
    expect(good.problems).toEqual([])
    expect(good.name_taken).toBe(false)
    expect(good.folder).toBe('skills/release-notes')
    expect(good.description).toBe('Writes the release notes for a version.')
    // The whole `SKILL.md`, frontmatter and body: what a reader reviews before approving.
    expect(good.skill_md).toContain('argument-hint: "[version]"')
    expect(good.skill_md).toContain('Write them from the commits since the last tag.')
    // A listing, never a content.
    expect(good.files.map((file) => file.path)).toEqual([SKILL_MD_FILENAME, 'reference/tone.md'])
    expect(good.files[0]?.size).toBeGreaterThan(0)
    expect(good.files[1]?.size).toBe(10)

    // A nested collection is a candidate of its own (K3: every `SKILL.md` under the path).
    expect(candidate(body, 'collection').folder).toBe('skills/nested/collection')

    expect(candidate(body, 'broken').problems.map((problem) => problem.code)).toEqual([
      'invalid-frontmatter',
    ])
    expect(candidate(body, 'mismatch').problems.map((problem) => problem.code)).toEqual([
      'name-mismatch',
    ])
    expect(candidate(body, 'compact').problems.map((problem) => problem.code)).toEqual([
      'reserved-name',
    ])
    expect(candidate(body, 'huge').problems[0]?.code).toBe('over-limit')
    // A candidate whose frontmatter did not parse still carries the folder's name, so it can be
    // pointed at — and its description is `null` rather than invented.
    expect(candidate(body, 'broken').description).toBeNull()
  })

  it('marks two folders of one name as duplicate candidates', async () => {
    const repo = await fixture({
      'one/dupe/SKILL.md': '---\nname: dupe\ndescription: One.\n---\n\nA.\n',
      'two/dupe/SKILL.md': '---\nname: dupe\ndescription: Two.\n---\n\nB.\n',
    })
    const test = appWith(repo.url)
    const { body } = await preview(test, { url: 'https://github.com/example/skills' })
    expect(body.candidates).toHaveLength(2)
    for (const entry of body.candidates) {
      // Neither can be imported — one user cannot hold two skills of one name (K4) — and both
      // say why rather than one silently winning.
      expect(entry.problems.map((problem) => problem.code)).toEqual(['duplicate-name'])
    }
  })

  it('says a name the caller already has is taken, without failing the preview', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)
    await test.skills.create({
      ownerId: (await test.currentUser()).id,
      name: 'release-notes',
      description: 'The one they already have.',
      frontmatter: {},
      source: { url: 'https://github.com/example/skills', ref: null, path: null, commit_sha: null },
      enabled: true,
      files: [{ path: SKILL_MD_FILENAME, content: '---\nname: release-notes\n---\n\nmine.\n' }],
    })

    const { body } = await preview(test)
    expect(candidate(body, 'release-notes').name_taken).toBe(true)
    expect(candidate(body, 'collection').name_taken).toBe(false)
  })

  it('reads a folder named as the path as one candidate', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)
    const { body } = await preview(test, { ...SOURCE, path: 'skills/release-notes' })
    expect(body.candidates.map((entry) => entry.name)).toEqual(['release-notes'])
  })

  it('refuses a path that is not there, and a path with no skill under it', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)

    const missing = await postJson(test, `${SKILLS}/import/preview`, { ...SOURCE, path: 'nope' })
    expect(missing.status).toBe(422)
    const notThere = await errorOf(missing)
    expect(notThere.error.type).toBe('skill_import_error')
    expect(notThere.error.message).toContain('That folder is not in the repository')

    // A folder that holds files but no `SKILL.md` is the other half: the path is there and
    // there is nothing to import.
    await repo.commit({ ...REPOSITORY, 'empty/notes.txt': 'nothing here\n' })
    const empty = await postJson(test, `${SKILLS}/import/preview`, { ...SOURCE, path: 'empty' })
    expect(empty.status).toBe(422)
    expect((await errorOf(empty)).error.message).toContain('holds no SKILL.md')
  })

  it('refuses a ref the repository does not have', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)
    const answer = await postJson(test, `${SKILLS}/import/preview`, { ...SOURCE, ref: 'nope' })
    expect(answer.status).toBe(422)
    const refusal = await errorOf(answer)
    expect(refusal.error.type).toBe('skill_import_error')
    expect(refusal.error.message).toContain('That branch, tag or commit is not in the repository')
  })

  it('refuses a URL that is not a public https git URL with a 400', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)
    for (const url of ['http://github.com/a/b', 'https://user:token@github.com/a/b', 'nope']) {
      const answer = await postJson(test, `${SKILLS}/import/preview`, { url })
      expect([url, answer.status]).toEqual([url, 400])
      expect((await errorOf(answer)).error.type).toBe('invalid_request_error')
    }
    // A folder path that climbs is the same 400: it names something nobody asked for.
    const climbing = await postJson(test, `${SKILLS}/import/preview`, { ...SOURCE, path: '../etc' })
    expect(climbing.status).toBe(400)
  })

  it('answers every way a clone can fail with the protocol’s own sentence', async () => {
    const repo = await fixture()
    const codes = [
      'unreachable',
      'not_a_repository',
      'authentication_required',
      'ref_not_found',
      'over_limit',
      'refused_address',
    ] as const
    for (const code of codes) {
      const test = createTestApp({
        skillImport: {
          clone: () => Promise.reject(new GitCloneError(code, `the clone said ${code}`)),
        },
      })
      const answer = await postJson(test, `${SKILLS}/import/preview`, SOURCE)
      expect([code, answer.status]).toEqual([code, 422])
      const body = await errorOf(answer)
      expect(body.error.type).toBe('skill_import_error')
      // Each code has its own sentence: the server tells the user which of the six it was.
      expect(body.error.message).toContain(
        code === 'unreachable'
          ? 'could not be reached'
          : code === 'not_a_repository'
            ? 'not a public git repository'
            : code === 'authentication_required'
              ? 'private or requires credentials'
              : code === 'ref_not_found'
                ? 'branch, tag or commit'
                : code === 'over_limit'
                  ? 'larger than the import limit'
                  : 'not a public one',
      )
    }
    expect(repo.url).toBeTruthy()
  })

  it('imports the picked candidate, and stores the snapshot whole', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)

    const { body } = await preview(test)
    const stored = await importSkills(test, {
      ...SOURCE,
      commit_sha: body.commit_sha,
      names: ['release-notes', 'collection'],
    })
    expect(stored.status).toBe(201)
    const skills = (stored.body.data ?? []).map((skill) => SkillSchema.parse(skill))
    expect(skills.map((skill) => skill.name)).toEqual(['release-notes', 'collection'])

    const release = skills[0]!
    expect(release.description).toBe('Writes the release notes for a version.')
    // The honoured fields ride in the frontmatter, stored and shown (K1, K10): nothing here
    // reads them into a permission.
    expect(release.frontmatter).toEqual({ 'argument-hint': '[version]', license: 'MIT' })
    expect(release.source).toEqual({
      url: 'https://github.com/example/skills',
      ref: 'main',
      path: 'skills',
      commit_sha: body.commit_sha,
    })
    expect(release.files.map((file) => file.path)).toEqual([SKILL_MD_FILENAME, 'reference/tone.md'])
    expect(release.enabled).toBe(true)

    // What was stored is what the single-skill read serves, `SKILL.md` content and all.
    const read = await test.request(`${SKILLS}/${release.id}`)
    const readBody = (await read.json()) as GetSkillResponse
    expect(readBody.content).toContain('Write them from the commits since the last tag.')
    expect(readBody.owner_id).toBe((await test.currentUser()).id)

    // And the size reported is the byte length of what was stored, not of the file in git.
    const tone = await test.request(`${SKILLS}/${release.id}/files/reference/tone.md`)
    expect((await tone.json()) as unknown).toMatchObject({ path: 'reference/tone.md', size: 10 })
  })

  it('refuses an import whose ref moved since the preview, storing nothing', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)
    const { body } = await preview(test)

    // Something lands on the branch between the preview and the confirm.
    await repo.commit({ ...REPOSITORY, 'skills/release-notes/SKILL.md': 'newer\n' })

    const answer = await importSkills(test, {
      ...SOURCE,
      commit_sha: body.commit_sha,
      names: ['release-notes'],
    })
    expect(answer.status).toBe(409)
    expect(answer.body.error?.type).toBe('conflict_error')
    expect(answer.body.error?.message).toContain('Preview the import again')
    expect(await test.skills.list({ ownerId: (await test.currentUser()).id })).toEqual([])
  })

  it('refuses a picked name no candidate has, and a candidate that cannot be imported', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)
    const { body } = await preview(test)

    const unknown = await importSkills(test, {
      ...SOURCE,
      commit_sha: body.commit_sha,
      names: ['never-heard-of-it'],
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error?.type).toBe('invalid_request_error')

    // One candidate picked twice is the same 400: the second copy could only be a partial
    // write, the first stored and the second refused by the store's uniqueness rule.
    const twice = await importSkills(test, {
      ...SOURCE,
      commit_sha: body.commit_sha,
      names: ['collection', 'collection'],
    })
    expect(twice.status).toBe(400)
    expect(twice.body.error?.message).toContain('more than once')
    expect(await test.skills.list({ ownerId: (await test.currentUser()).id })).toEqual([])

    const broken = await importSkills(test, {
      ...SOURCE,
      commit_sha: body.commit_sha,
      names: ['release-notes', 'broken'],
    })
    expect(broken.status).toBe(422)
    expect(broken.body.error?.type).toBe('skill_import_error')
    // The candidate's own problems are what the refusal says, because they are what the preview
    // showed: nothing was written, the good candidate included.
    expect(broken.body.error?.message).toContain('YAML frontmatter')
    expect(await test.skills.list({ ownerId: (await test.currentUser()).id })).toEqual([])
  })

  it('refuses a name the caller already has, storing none of the batch', async () => {
    const repo = await fixture()
    const test = appWith(repo.url)
    const { body } = await preview(test)
    const ownerId = (await test.currentUser()).id
    await test.skills.create({
      ownerId,
      name: 'collection',
      description: 'The one they already have.',
      frontmatter: {},
      source: { url: 'https://github.com/example/skills', ref: null, path: null, commit_sha: null },
      enabled: true,
      files: [{ path: SKILL_MD_FILENAME, content: '---\nname: collection\n---\n\nmine.\n' }],
    })

    const answer = await importSkills(test, {
      ...SOURCE,
      commit_sha: body.commit_sha,
      names: ['release-notes', 'collection'],
    })
    expect(answer.status).toBe(409)
    expect(answer.body.error?.type).toBe('conflict_error')
    expect((await test.skills.list({ ownerId })).map((skill) => skill.name)).toEqual(['collection'])
  })

  it('takes an explicit ref and path over what the URL implies', async () => {
    const repo = await fixture()
    const asked: CloneRepositoryOptions[] = []
    const test = appWith(repo.url, { asked })

    const answer = await postJson(test, `${SKILLS}/import/preview`, {
      url: 'https://github.com/example/skills/tree/main/skills',
      ref: 'main',
      path: 'skills/nested',
    })
    const body = (await answer.json()) as PreviewSkillImportResponse
    expect(body.candidates.map((entry) => entry.name)).toEqual(['collection'])
    expect(asked[0]?.ref).toBe('main')
  })
})

describe.skipIf(!GIT)('skill refresh (epic #349, K5)', () => {
  /** A skill imported from the fixture, so a refresh has a stored snapshot to compare. */
  async function imported(): Promise<{ test: TestContext; repo: GitFixture; skill: Skill }> {
    const repo = await fixture()
    const test = appWith(repo.url)
    const { body } = await preview(test)
    const stored = await importSkills(test, {
      ...SOURCE,
      commit_sha: body.commit_sha,
      names: ['release-notes'],
    })
    const skill = SkillSchema.parse((stored.body.data ?? [])[0])
    return { test, repo, skill }
  }

  it('says an unchanged skill is unchanged', async () => {
    const { test, skill } = await imported()
    const answer = await postJson(test, `${SKILLS}/${skill.id}/refresh/preview`, {})
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as RefreshSkillPreviewResponse
    expect(body.commit_sha).toBe(skill.source.commit_sha)
    expect(body.changed).toBe(false)
    expect(body.files_added).toEqual([])
    expect(body.files_removed).toEqual([])
    expect(body.files_changed).toEqual([])
    expect(body.skill_md_diff).toBeNull()
    expect(body.problems).toEqual([])

    // Confirming an unchanged refresh still moves `refreshed_at` and keeps everything else.
    const confirmed = await postJson(test, `${SKILLS}/${skill.id}/refresh`, {
      commit_sha: body.commit_sha,
    })
    expect(confirmed.status).toBe(200)
    const refreshed = SkillSchema.parse(await confirmed.json())
    expect(refreshed.name).toBe(skill.name)
    expect(refreshed.imported_at).toBe(skill.imported_at)
    expect(refreshed.files).toEqual(skill.files)
  })

  it('shows what changed, and replaces the snapshot when it is confirmed', async () => {
    const { test, repo, skill } = await imported()
    const newer = [
      '---',
      'name: release-notes',
      'description: Writes the release notes for a version, tersely.',
      '---',
      '',
      'Write them from the tags.',
      '',
    ].join('\n')
    await repo.commit(
      {
        ...REPOSITORY,
        'skills/release-notes/SKILL.md': newer,
        'skills/release-notes/reference/format.md': 'Bullets.\n',
      },
      'a second version',
    )

    const answer = await postJson(test, `${SKILLS}/${skill.id}/refresh/preview`, {})
    const body = (await answer.json()) as RefreshSkillPreviewResponse
    expect(body.commit_sha).toBe(await repo.head())
    expect(body.commit_sha).not.toBe(skill.source.commit_sha)
    expect(body.changed).toBe(true)
    expect(body.files_added).toEqual(['reference/format.md'])
    expect(body.files_removed).toEqual([])
    expect(body.files_changed).toEqual([SKILL_MD_FILENAME])
    // The `SKILL.md` diff is the file a skill is read by, so it comes with the preview.
    expect(body.skill_md_diff).toContain('--- a/SKILL.md')
    expect(body.skill_md_diff).toContain('+++ b/SKILL.md')
    expect(body.skill_md_diff).toContain('-Write them from the commits since the last tag.')
    expect(body.skill_md_diff).toContain('+Write them from the tags.')

    const confirmed = await postJson(test, `${SKILLS}/${skill.id}/refresh`, {
      commit_sha: body.commit_sha,
    })
    expect(confirmed.status).toBe(200)
    const replaced = SkillSchema.parse(await confirmed.json())
    expect(replaced.description).toBe('Writes the release notes for a version, tersely.')
    expect(replaced.files.map((file) => file.path)).toEqual([
      SKILL_MD_FILENAME,
      'reference/format.md',
      'reference/tone.md',
    ])
    // The snapshot moved; the skill's identity did not (K5, K4).
    expect(replaced.id).toBe(skill.id)
    expect(replaced.source.commit_sha).toBe(body.commit_sha)
    expect(replaced.refreshed_at >= skill.refreshed_at).toBe(true)
  })

  it('refuses a refresh whose commit is not the one the preview named', async () => {
    const { test, skill } = await imported()
    const previewed = await postJson(test, `${SKILLS}/${skill.id}/refresh/preview`, {})
    const body = (await previewed.json()) as RefreshSkillPreviewResponse
    expect(body.commit_sha).toBe(skill.source.commit_sha)
    // A commit that is not what the preview resolved — the branch moved under it, or a stale
    // confirm arrived — is a conflict, and the snapshot is untouched.
    const answer = await postJson(test, `${SKILLS}/${skill.id}/refresh`, {
      commit_sha: '0123456789abcdef0123456789abcdef01234567',
    })
    expect(answer.status).toBe(409)
    expect((await errorOf(answer)).error.message).toContain('Preview')
    const read = await test.request(`${SKILLS}/${skill.id}`)
    expect(((await read.json()) as GetSkillResponse).source.commit_sha).toBe(
      skill.source.commit_sha,
    )
  })

  it('refuses a refresh that would replace a working skill with a broken one', async () => {
    const { test, repo, skill } = await imported()
    await repo.commit({
      ...REPOSITORY,
      'skills/release-notes/SKILL.md': 'no frontmatter any more\n',
    })

    const previewed = await postJson(test, `${SKILLS}/${skill.id}/refresh/preview`, {})
    const body = (await previewed.json()) as RefreshSkillPreviewResponse
    expect(body.problems.map((problem) => problem.code)).toEqual(['invalid-frontmatter'])
    expect(body.changed).toBe(true)

    const answer = await postJson(test, `${SKILLS}/${skill.id}/refresh`, {
      commit_sha: body.commit_sha,
    })
    expect(answer.status).toBe(422)
    expect((await errorOf(answer)).error.type).toBe('skill_import_error')
    const read = await test.request(`${SKILLS}/${skill.id}`)
    expect(((await read.json()) as GetSkillResponse).content).toContain(
      'Write them from the commits',
    )
  })

  it('refuses a refresh of a skill that is not the caller’s, before it clones anything', async () => {
    const { test, skill } = await imported()
    const b = await test.signIn('b@example.com', 'b-password')

    for (const [method, path, body] of [
      ['POST', `${SKILLS}/${skill.id}/refresh/preview`, {}],
      ['POST', `${SKILLS}/${skill.id}/refresh`, { commit_sha: skill.source.commit_sha }],
    ] as const) {
      const response = await test.request(path, {
        method,
        headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect([path, response.status]).toEqual([path, 404])
    }
  })
})
