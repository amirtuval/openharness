import { describe, expect, it } from 'vitest'
import {
  API_VERSION_PREFIX,
  SKILL_MD_FILENAME,
  GetSkillResponseSchema,
  SkillFileContentSchema,
  SkillSchema,
  newSkillId,
  skillFileSize,
  type ListSkillsResponse,
  type Mode,
  type Skill,
} from '@openharness/protocol'
import type { CreateSkillInput, SkillFileInput } from '@openharness/session'

import { createSkillSettingsResolver, skillsInForce } from './skills'
import { createTestApp, postJson, type TestContext } from './test-support'

/**
 * Skills over HTTP (epic #349, K4), and the settings answer the brain will read (K8).
 *
 * Import and refresh — the two routes that write a snapshot — are #351's, so every skill here
 * is seeded through the store the app runs on, which is the same store the routes read. What is
 * exercised is what a user does with a skill they have: see it, read it (its `SKILL.md` and any
 * file), switch it on or off, delete it — and which of them a request gets, with and without a
 * mode's override.
 */

const SKILLS = `${API_VERSION_PREFIX}/me/skills`
const MODES = `${API_VERSION_PREFIX}/me/modes`

/** The `SKILL.md` a test seeds, and the second file beside it. */
const SKILL_MD = '---\nname: release-notes\ndescription: Writes them.\n---\n\nWrite them.\n'
const FILES: readonly SkillFileInput[] = [
  { path: SKILL_MD_FILENAME, content: SKILL_MD },
  { path: 'reference/tone.md', content: 'Be terse.\n' },
]

/** A create body, with `ownerId` left for {@link seedSkill} — it comes from the signed-in user. */
function skillInput(overrides: Partial<Omit<CreateSkillInput, 'ownerId'>> = {}) {
  return {
    name: 'release-notes',
    description: 'Writes the release notes for a version.',
    frontmatter: { 'argument-hint': '[version]', license: 'MIT' },
    source: {
      url: 'https://github.com/example/skills',
      ref: 'main',
      path: 'release-notes',
      commit_sha: '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5',
    },
    enabled: true,
    files: FILES,
    ...overrides,
  }
}

/** Seed one skill for the signed-in caller, through the store the app reads. */
async function seedSkill(
  test: TestContext,
  overrides: Partial<Omit<CreateSkillInput, 'ownerId'>> = {},
): Promise<Skill> {
  const me = await test.currentUser()
  return test.skills.create({ ...skillInput(overrides), ownerId: me.id })
}

/** `GET` a path as the default caller. */
function get(test: TestContext, path: string): Promise<Response> {
  return test.request(path)
}

describe('skills over HTTP (epic #349, K4)', () => {
  it('lists the caller’s own skills, oldest first, with no file’s content', async () => {
    const test = createTestApp()
    // The ids are pinned, and their timestamps differ. `list` orders by `(imported_at, id)`,
    // and two skills created in the same millisecond tie on the timestamp — so a fresh ULID's
    // random half would decide the order, and this assertion would be a coin flip.
    const first = await seedSkill(test, { id: newSkillId(1) })
    const second = await seedSkill(test, { id: newSkillId(2), name: 'pdf-tools', enabled: false })

    const response = await get(test, SKILLS)
    expect(response.status).toBe(200)
    const body = (await response.json()) as ListSkillsResponse
    expect(body.data.map((skill) => skill.name)).toEqual(['release-notes', 'pdf-tools'])
    expect(body.data[0]).toEqual(first)
    expect(body.data[1]).toEqual(second)
    for (const skill of body.data) {
      expect(() => SkillSchema.parse(skill)).not.toThrow()
    }
    // A listing is metadata: no `SKILL.md`, no reference file, nothing from a snapshot.
    expect(JSON.stringify(body)).not.toContain('Write them.')
  })

  it('reads one skill with its SKILL.md, and one file with its content and size', async () => {
    const test = createTestApp()
    const skill = await seedSkill(test)

    const one = await get(test, `${SKILLS}/${skill.id}`)
    expect(one.status).toBe(200)
    // The wire shape is the protocol's, `content` and all.
    const detail = GetSkillResponseSchema.parse(await one.json())
    expect(detail.content).toBe(SKILL_MD)
    expect(detail).toMatchObject({ id: skill.id, name: 'release-notes', enabled: true })

    const file = await get(test, `${SKILLS}/${skill.id}/files/reference/tone.md`)
    expect(file.status).toBe(200)
    expect(SkillFileContentSchema.parse(await file.json())).toEqual({
      path: 'reference/tone.md',
      size: skillFileSize('Be terse.\n'),
      encoding: 'utf8',
      content: 'Be terse.\n',
    })
    // A path is the rest of the URL, and it is decoded: the `SKILL.md` is reachable by its own
    // name, and a space in a path is a space.
    const skillMd = await get(test, `${SKILLS}/${skill.id}/files/${SKILL_MD_FILENAME}`)
    expect(skillMd.status).toBe(200)
    expect(SkillFileContentSchema.parse(await skillMd.json()).content).toBe(SKILL_MD)
  })

  it('answers 404 for a file a skill does not hold, and for one outside its folder', async () => {
    const test = createTestApp()
    const skill = await seedSkill(test)
    for (const path of ['nope.md', 'reference/nope.md', '../SKILL.md', 'reference']) {
      const response = await get(test, `${SKILLS}/${skill.id}/files/${path}`)
      expect([path, response.status]).toEqual([path, 404])
      expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
        'not_found_error',
      )
    }
  })

  it('answers 404 for an unknown skill, and 400 for an id that could name none', async () => {
    const test = createTestApp()
    const unknown = await seedSkill(test)
    await test.skills.delete(unknown.id, { ownerId: (await test.currentUser()).id })

    for (const path of [SKILLS, `${SKILLS}/${unknown.id}`, `${SKILLS}/${unknown.id}/files/a.md`]) {
      const response =
        path === SKILLS
          ? await test.request(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: false }),
            })
          : await get(test, path)
      expect([path, response.status]).toEqual([path, 404])
    }
    // A malformed id could not name a skill however the database looked: 400, never 404.
    expect((await get(test, `${SKILLS}/not-a-skill-id`)).status).toBe(400)
    expect((await get(test, `${SKILLS}/mode_01JQZ8R6X9M4V0W7Y2B3C5D6E7`)).status).toBe(400)
  })

  it('turns a skill on and off, and refuses a body that says anything else', async () => {
    const test = createTestApp()
    const skill = await seedSkill(test)

    const off = await postJson(test, `${SKILLS}/${skill.id}`, { enabled: false })
    expect(off.status).toBe(200)
    expect((await off.json()) as Skill).toMatchObject({ id: skill.id, enabled: false })
    expect(
      (await test.skills.get(skill.id, { ownerId: (await test.currentUser()).id }))?.enabled,
    ).toBe(false)

    const on = await postJson(test, `${SKILLS}/${skill.id}`, { enabled: true })
    expect((await on.json()) as Skill).toMatchObject({ enabled: true })

    // `enabled` and nothing else: a body that names no field has no patch to apply.
    for (const body of [{}, { name: 'renamed' }, { enabled: 'yes' }]) {
      const refused = await postJson(test, `${SKILLS}/${skill.id}`, body)
      expect([JSON.stringify(body), refused.status]).toEqual([JSON.stringify(body), 400])
    }
    const malformed = await postJson(test, `${SKILLS}/nope`, { enabled: false })
    expect(malformed.status).toBe(400)
  })

  it('deletes a skill and its snapshot, and answers 404 once it is gone', async () => {
    const test = createTestApp()
    const skill = await seedSkill(test)
    const me = await test.currentUser()

    const deleted = await test.request(`${SKILLS}/${skill.id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect(await test.skills.get(skill.id, { ownerId: me.id })).toBeNull()
    expect(await test.skills.getFile(skill.id, { ownerId: me.id }, SKILL_MD_FILENAME)).toBeNull()
    expect((await test.request(`${SKILLS}/${skill.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await get(test, `${SKILLS}/${skill.id}`)).status).toBe(404)
  })
})

describe('the skills in force for a request (epic #349, K8)', () => {
  it('follows the user’s own `enabled` with no mode at all', async () => {
    const test = createTestApp()
    const on = await seedSkill(test)
    const off = await seedSkill(test, { name: 'pdf-tools', enabled: false })
    const me = await test.currentUser()

    const inForce = await createSkillSettingsResolver({ skills: test.skills })(me.id, null)
    expect(inForce.map((skill) => skill.id)).toEqual([on.id])
    // The rule on its own, without a store: a skill nobody turned off is on.
    expect(skillsInForce([on, off], null).map((skill) => skill.id)).toEqual([on.id])
  })

  it('lets a mode turn one off and another on, and ignores a skill that is gone', async () => {
    const test = createTestApp()
    const first = await seedSkill(test)
    const second = await seedSkill(test, { name: 'pdf-tools', enabled: false })
    const me = await test.currentUser()

    // A mode saved through the real route, carrying the third half of `Mode.tools` (#349, K8):
    // this is what a settings screen writes and what a chat on the mode follows.
    const created = await postJson(test, MODES, {
      name: 'deep',
      model: 'anthropic/claude-sonnet-5',
      tools: {
        builtin: { web_search: true },
        skills: { [first.id]: false, [second.id]: true },
      },
    })
    expect(created.status).toBe(201)
    const mode = (await created.json()) as Mode
    expect(mode.tools?.skills).toEqual({ [first.id]: false, [second.id]: true })

    const resolve = createSkillSettingsResolver({ skills: test.skills })
    expect((await resolve(me.id, mode.tools)).map((skill) => skill.id)).toEqual([second.id])

    // A mode naming a skill the user no longer has is ignored rather than refused: the map is
    // stored by id without checking it, so a delete leaves the modes that named it untroubled
    // — the entry matches nothing, and every other skill follows the user as it did.
    await test.skills.delete(second.id, { ownerId: me.id })
    const goneOverride = { builtin: {}, skills: { [second.id]: true } }
    expect((await resolve(me.id, goneOverride)).map((skill) => skill.id)).toEqual([first.id])
    expect(skillsInForce([first], goneOverride).map((skill) => skill.id)).toEqual([first.id])
    // The one skill that is left still follows the user, and a mode that says nothing about
    // skills leaves every enabled one alone.
    expect((await resolve(me.id, null)).map((skill) => skill.id)).toEqual([first.id])
    expect((await resolve(me.id, { builtin: { web_search: false } })).map((s) => s.id)).toEqual([
      first.id,
    ])
  })

  it('applies the skills default: off is an allowlist, on turns every skill on (B8)', async () => {
    const test = createTestApp()
    // Pinned ids, as in the listing test above: these skills are created in the same
    // millisecond, so a fresh ULID's random half would decide their `(imported_at, id)` order.
    const on = await seedSkill(test, { id: newSkillId(1) })
    const off = await seedSkill(test, { id: newSkillId(2), name: 'pdf-tools', enabled: false })
    const me = await test.currentUser()
    const resolve = createSkillSettingsResolver({ skills: test.skills })

    // `off` is an allowlist: only the skill the map turns on is in force, and a skill imported
    // afterwards is not — which is the whole point of the setting.
    expect(
      (await resolve(me.id, { skills_default: 'off', skills: { [on.id]: true } })).map(
        (skill) => skill.id,
      ),
    ).toEqual([on.id])
    const later = await seedSkill(test, { id: newSkillId(3), name: 'later' })
    expect(
      (await resolve(me.id, { skills_default: 'off', skills: { [on.id]: true } })).map(
        (skill) => skill.id,
      ),
    ).toEqual([on.id])

    // `on` turns every skill on except the ones the map turns off, even one the user disabled.
    expect((await resolve(me.id, { skills_default: 'on' })).map((skill) => skill.id)).toEqual([
      on.id,
      off.id,
      later.id,
    ])
    expect(
      (await resolve(me.id, { skills_default: 'on', skills: { [on.id]: false } })).map(
        (skill) => skill.id,
      ),
    ).toEqual([off.id, later.id])
    // An absent default is `follow`, so the user's own switches stand.
    expect((await resolve(me.id, { skills: {} })).map((skill) => skill.id)).toEqual([
      on.id,
      later.id,
    ])
  })

  it('answers the skill’s own metadata, never a file’s content', async () => {
    const test = createTestApp()
    await seedSkill(test)
    const me = await test.currentUser()

    const inForce = await createSkillSettingsResolver({ skills: test.skills })(me.id, null)
    expect(inForce[0]).toMatchObject({
      name: 'release-notes',
      description: 'Writes the release notes for a version.',
    })
    expect(JSON.stringify(inForce)).not.toContain('Write them.')
  })
})
