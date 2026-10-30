import {
  MAX_SKILLS_PER_USER,
  SKILL_MD_FILENAME,
  SkillSchema,
  newSkillId,
  skillFileSize,
  type UserId,
} from '@openharness/protocol'
import { describe, expect, it } from 'vitest'

import { timestampAt } from '../clock'
import { DuplicateSkillNameError, SkillLimitReachedError } from '../errors'
import type { CreateSkillInput, SkillFileInput, SkillStore } from '../skills'
import { type TestClock, createTestClock } from './clock'
import { OWNER_A, OWNER_B } from './conformance'

/**
 * The conformance suite every `SkillStore` implementation has to pass (epic #349, K4).
 *
 * It is the contract's executable form: `InMemorySkillStore` passes it today, and
 * `PostgresSkillStore` must pass the same suite unchanged. That is why it only asks for what
 * the contract promises — a name unique per user and a cap, owner scoping, a listing that
 * carries no file's content, a snapshot replaced whole and in one transaction, an `enabled`
 * switch that moves nothing else, and answers that cannot be written to — and never reaches
 * into an implementation.
 *
 * ## Writing the factory
 *
 * ```ts
 * import { InMemorySkillStore } from '@openharness/session'
 *
 * runSkillStoreConformance(
 *   (clock) => new InMemorySkillStore({ now: clock.now }),
 *   { name: 'InMemorySkillStore' },
 * )
 * ```
 *
 * The factory is called once per test with a fresh {@link TestClock}, and the store it returns
 * must take its time from that clock: `imported_at` and `refreshed_at` are the clock's, which
 * is how the suite checks both without sleeping. For a store whose schema references Better
 * Auth's `"user"` rows (Postgres), pass an `ensureUsers` that creates the suite's two owners,
 * exactly as the credential and MCP-server suites do.
 */
export function runSkillStoreConformance(
  makeStore: MakeSkillStore,
  options: SkillStoreConformanceOptions = {},
): void {
  const name = options.name ?? 'SkillStore'

  /** A store for one test, built on a clock that test can move, with the suite's users seeded. */
  async function setup(): Promise<{ store: SkillStore; clock: TestClock }> {
    const clock = createTestClock(START_MS)
    const store = await makeStore(clock)
    await options.ensureUsers?.([OWNER_A, OWNER_B])
    return { store, clock }
  }

  /** The files a snapshot writes, with the two a real skill has. */
  function files(overrides: readonly SkillFileInput[] = DEFAULT_FILES): readonly SkillFileInput[] {
    return overrides.map((file) => ({ ...file }))
  }

  /** A create body with the suite's defaults, overridable field by field. */
  function draft(overrides: Partial<CreateSkillInput> = {}): CreateSkillInput {
    return {
      ownerId: OWNER_A,
      name: 'release-notes',
      description: 'Writes the release notes for a version.',
      frontmatter: { 'argument-hint': '[version]', license: 'MIT' },
      source: {
        url: 'https://github.com/example/skills',
        ref: 'main',
        path: 'release-notes',
        commit_sha: COMMIT_SHA,
      },
      files: files(),
      enabled: true,
      ...overrides,
    }
  }

  describe(`${name} conformance`, () => {
    describe('create', () => {
      it('stores a skill and answers its metadata under a fresh skl_ id', async () => {
        const { store, clock } = await setup()
        const skill = await store.create(draft())
        expect(skill.id).toMatch(/^skl_/)
        expect(skill).toMatchObject({
          type: 'skill',
          owner_id: OWNER_A,
          name: 'release-notes',
          description: 'Writes the release notes for a version.',
          frontmatter: { 'argument-hint': '[version]', license: 'MIT' },
          source: {
            url: 'https://github.com/example/skills',
            ref: 'main',
            path: 'release-notes',
            commit_sha: COMMIT_SHA,
          },
          enabled: true,
          imported_at: timestampAt(clock.currentMs),
          // A fresh snapshot is one already refreshed: the two instants start equal and only a
          // replacement moves the second.
          refreshed_at: timestampAt(clock.currentMs),
        })
        // The answer is the protocol's resource, exactly.
        expectExact(SkillSchema, skill, 'skill metadata')
      })

      it('answers a file listing whose sizes are the contents’ own', async () => {
        const { store } = await setup()
        const skill = await store.create(draft())
        expect(skill.files).toEqual([
          { path: SKILL_MD_FILENAME, size: FILE_SIZE },
          { path: 'reference/tone.md', size: skillFileSize('Be terse.\n') },
        ])
        // A listing carries paths and sizes and nothing else — the contract promises that, and
        // a store that answered the contents with them would be answering something else.
        expect(JSON.stringify(skill)).not.toContain('Write them.')
      })

      it('lists a snapshot’s files by path, whatever order they were written in', async () => {
        // The order is the contract's, not the input's: the Postgres store reads its rows back
        // by `(skill_id, path)` and cannot keep an insertion order without another column, so
        // the in-memory store sorts too — otherwise the two would answer the same snapshot two
        // ways, which is exactly what this suite exists to prevent.
        const { store } = await setup()
        const skill = await store.create(
          draft({
            files: files([
              { path: 'reference/tone.md', content: 'Be terse.\n' },
              { path: SKILL_MD_FILENAME, content: SKILL_MD },
            ]),
          }),
        )
        expect(skill.files.map((file) => file.path)).toEqual([
          SKILL_MD_FILENAME,
          'reference/tone.md',
        ])
      })

      it('accepts a snapshot nothing cloned: null ref, path and commit', async () => {
        const { store } = await setup()
        const skill = await store.create(
          draft({
            source: { url: 'https://x.test/s.git', ref: null, path: null, commit_sha: null },
          }),
        )
        expect(skill.source).toEqual({
          url: 'https://x.test/s.git',
          ref: null,
          path: null,
          commit_sha: null,
        })
      })

      it('refuses a snapshot that is not a skill (K1)', async () => {
        const { store } = await setup()
        // A folder with no SKILL.md describes nothing and could run nothing.
        const noSkillMd = draft({ files: files([{ path: 'notes.md', content: 'hi' }]) })
        expect(await thrownBy(() => store.create(noSkillMd))).toBeInstanceOf(RangeError)
        // Two files at one path cannot both be the snapshot, and `skill_files` is keyed by it.
        const doubled = draft({
          files: files([
            { path: SKILL_MD_FILENAME, content: 'one' },
            { path: SKILL_MD_FILENAME, content: 'two' },
          ]),
        })
        expect(await thrownBy(() => store.create(doubled))).toBeInstanceOf(RangeError)
        expect(await store.list({ ownerId: OWNER_A })).toEqual([])
      })

      it('refuses a second skill with the same name for one user, and allows it for another', async () => {
        const { store } = await setup()
        await store.create(draft())
        // `thrownBy` rather than `.rejects`: the in-memory store runs its whole body before it
        // answers, so a refusal it raises is a synchronous throw, not a rejected promise.
        expect(await thrownBy(() => store.create(draft()))).toBeInstanceOf(DuplicateSkillNameError)
        // The same name is a different user's to take: uniqueness is per owner.
        expect(await store.create(draft({ ownerId: OWNER_B }))).toMatchObject({ owner_id: OWNER_B })
      })

      it('refuses the skill past the per-user cap', async () => {
        const { store } = await setup()
        for (let i = 0; i < MAX_SKILLS_PER_USER; i += 1) {
          await store.create(draft({ name: `skill-${i}` }))
        }
        expect(await thrownBy(() => store.create(draft({ name: 'one-too-many' })))).toBeInstanceOf(
          SkillLimitReachedError,
        )
      })

      it('caps a user at MAX_SKILLS_PER_USER however many creates race for the last slot', async () => {
        // The cap is a count followed by an insert, so the store has to make the two one
        // critical section — a transaction alone does not, and two creates at the limit would
        // each read a count below it and both insert (the Postgres store takes a per-owner
        // advisory lock first, and the in-memory store is serial by construction).
        const { store } = await setup()
        const attempts = MAX_SKILLS_PER_USER + 5
        const results = await Promise.allSettled(
          // Deferred to a microtask: the in-memory store refuses synchronously, so a bare call
          // would throw while the array is being built rather than settling as a rejection.
          Array.from({ length: attempts }, (_, index) =>
            Promise.resolve().then(() => store.create(draft({ name: `raced-${index}` }))),
          ),
        )
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
          MAX_SKILLS_PER_USER,
        )
        expect(await store.list({ ownerId: OWNER_A })).toHaveLength(MAX_SKILLS_PER_USER)
      })
    })

    describe('get, list and ownership', () => {
      it('scopes every read and write to the owner', async () => {
        const { store } = await setup()
        const mine = await store.create(draft())
        expect(await store.get(mine.id, { ownerId: OWNER_B })).toBeNull()
        expect(await store.get(mine.id, { ownerId: OWNER_A })).not.toBeNull()
        expect(await store.list({ ownerId: OWNER_B })).toEqual([])
        expect(await store.getFile(mine.id, { ownerId: OWNER_B }, SKILL_MD_FILENAME)).toBeNull()
        expect(
          await store.replaceSnapshot(
            mine.id,
            { ownerId: OWNER_B },
            {
              description: 'theirs',
              frontmatter: {},
              source: { url: 'https://x.test/s.git', ref: null, path: null, commit_sha: null },
              files: files(),
            },
          ),
        ).toBeNull()
        expect(await store.setEnabled(mine.id, { ownerId: OWNER_B }, false)).toBeNull()
        expect(await store.delete(mine.id, { ownerId: OWNER_B })).toBe(false)
        // None of that touched what the owner holds.
        expect(await store.get(mine.id, { ownerId: OWNER_A })).toEqual(mine)
      })

      it('lists oldest first, with each skill’s own files', async () => {
        const { store, clock } = await setup()
        const first = await store.create(draft({ name: 'first' }))
        clock.advance(SECOND)
        const second = await store.create(
          draft({
            name: 'second',
            files: files([
              { path: SKILL_MD_FILENAME, content: 'second' },
              { path: 'a.md', content: 'a' },
              { path: 'b.md', content: 'b' },
            ]),
          }),
        )
        const listed = await store.list({ ownerId: OWNER_A })
        expect(listed.map((skill) => skill.name)).toEqual(['first', 'second'])
        expect(listed.map((skill) => skill.id)).toEqual([first.id, second.id])
        expect(second.files.map((file) => file.path)).toEqual([SKILL_MD_FILENAME, 'a.md', 'b.md'])
        for (const skill of listed) {
          expectExact(SkillSchema, skill, 'listed skill')
          expect(JSON.stringify(skill)).not.toContain('Write them.')
        }
      })

      it('answers a frozen value a caller cannot write through', async () => {
        const { store } = await setup()
        const skill = await store.create(draft())
        expect(() => {
          ;(skill as { name: string }).name = 'rewritten'
        }).toThrow()
      })
    })

    describe('getFile', () => {
      it('hands back one file’s content, size and path', async () => {
        const { store } = await setup()
        const skill = await store.create(draft())
        expect(await store.getFile(skill.id, { ownerId: OWNER_A }, 'reference/tone.md')).toEqual({
          path: 'reference/tone.md',
          size: skillFileSize('Be terse.\n'),
          encoding: 'utf8',
          content: 'Be terse.\n',
        })
        expect(
          await store.getFile(skill.id, { ownerId: OWNER_A }, SKILL_MD_FILENAME),
        ).toMatchObject({ encoding: 'utf8', content: DEFAULT_FILES[0]?.content })
      })

      it('hands a binary file back losslessly, with its original byte size', async () => {
        const { store } = await setup()
        // A tiny PNG: its bytes are not UTF-8 and hold a NUL, so a store that forced them
        // through `text` would either corrupt them or — on Postgres — refuse the write.
        const bytes = Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
          0x52,
        ])
        const content = Buffer.from(bytes).toString('base64')
        const skill = await store.create(
          draft({
            files: files([
              { path: SKILL_MD_FILENAME, content: SKILL_MD },
              { path: 'assets/icon.png', content, encoding: 'base64' },
            ]),
          }),
        )
        // The listing counts the bytes the file really is, not the base64 spelling.
        expect(skill.files).toEqual([
          { path: SKILL_MD_FILENAME, size: FILE_SIZE },
          { path: 'assets/icon.png', size: bytes.length },
        ])
        expect(await store.getFile(skill.id, { ownerId: OWNER_A }, 'assets/icon.png')).toEqual({
          path: 'assets/icon.png',
          size: bytes.length,
          encoding: 'base64',
          content,
        })
      })

      it('answers null for a path the snapshot does not hold, and for a skill nobody has', async () => {
        const { store } = await setup()
        const skill = await store.create(draft())
        expect(await store.getFile(skill.id, { ownerId: OWNER_A }, 'nope.md')).toBeNull()
        // A path outside the folder names nothing: the files are a set of paths, not a tree.
        expect(await store.getFile(skill.id, { ownerId: OWNER_A }, '../SKILL.md')).toBeNull()
        expect(
          await store.getFile(MISSING_SKILL_ID, { ownerId: OWNER_A }, SKILL_MD_FILENAME),
        ).toBeNull()
      })
    })

    describe('replaceSnapshot', () => {
      it('replaces the metadata and the whole file set, keeping the skill’s own fields', async () => {
        const { store, clock } = await setup()
        const created = await store.create(draft())
        await store.setEnabled(created.id, { ownerId: OWNER_A }, false)
        clock.advance(SECOND)
        const replaced = await store.replaceSnapshot(
          created.id,
          { ownerId: OWNER_A },
          {
            description: 'Rewrites the release notes.',
            frontmatter: { license: 'Apache-2.0' },
            source: {
              url: 'https://github.com/example/skills',
              ref: 'v2',
              path: 'release-notes',
              commit_sha: NEXT_COMMIT_SHA,
            },
            files: files([{ path: SKILL_MD_FILENAME, content: '# v2\n' }]),
          },
        )
        expect(replaced).toMatchObject({
          id: created.id,
          name: 'release-notes',
          description: 'Rewrites the release notes.',
          frontmatter: { license: 'Apache-2.0' },
          source: { ref: 'v2', commit_sha: NEXT_COMMIT_SHA },
          enabled: false,
          imported_at: created.imported_at,
          refreshed_at: timestampAt(clock.currentMs),
        })
        expect(replaced?.files).toEqual([
          { path: SKILL_MD_FILENAME, size: skillFileSize('# v2\n') },
        ])
        // The file the new snapshot does not carry is gone, and the new one is readable: the
        // replacement is the whole set, not an edit on top of it.
        expect(
          await store.getFile(created.id, { ownerId: OWNER_A }, 'reference/tone.md'),
        ).toBeNull()
        expect(
          await store.getFile(created.id, { ownerId: OWNER_A }, SKILL_MD_FILENAME),
        ).toMatchObject({ content: '# v2\n' })
      })

      it('leaves the previous snapshot in place when the new one is not a skill', async () => {
        // The replacement is one transaction: a refused or failing one changes nothing. Here
        // the snapshot is refused before the write; the Postgres store reaches the same state
        // because the whole replacement rolls back.
        const { store, clock } = await setup()
        const created = await store.create(draft())
        clock.advance(SECOND)
        expect(
          await thrownBy(() =>
            store.replaceSnapshot(
              created.id,
              { ownerId: OWNER_A },
              {
                description: 'no SKILL.md here',
                frontmatter: {},
                source: {
                  url: 'https://github.com/example/skills',
                  ref: null,
                  path: null,
                  commit_sha: null,
                },
                files: files([{ path: 'notes.md', content: 'hi' }]),
              },
            ),
          ),
        ).toBeInstanceOf(RangeError)
        expect(await store.get(created.id, { ownerId: OWNER_A })).toEqual(created)
        expect(await store.getFile(created.id, { ownerId: OWNER_A }, SKILL_MD_FILENAME)).toEqual({
          path: SKILL_MD_FILENAME,
          size: FILE_SIZE,
          encoding: 'utf8',
          content: DEFAULT_FILES[0]?.content,
        })
      })

      it('touches one skill and never another’s snapshot', async () => {
        const { store, clock } = await setup()
        const mine = await store.create(draft({ name: 'mine' }))
        const other = await store.create(draft({ name: 'other' }))
        clock.advance(SECOND)
        await store.replaceSnapshot(
          mine.id,
          { ownerId: OWNER_A },
          {
            description: 'Replaced.',
            frontmatter: {},
            source: {
              url: 'https://github.com/example/skills',
              ref: null,
              path: null,
              commit_sha: null,
            },
            files: files([{ path: SKILL_MD_FILENAME, content: '# Replaced\n' }]),
          },
        )
        expect(await store.get(other.id, { ownerId: OWNER_A })).toEqual(other)
      })

      it('answers null for a skill nobody has', async () => {
        const { store } = await setup()
        expect(
          await store.replaceSnapshot(
            MISSING_SKILL_ID,
            { ownerId: OWNER_A },
            {
              description: 'x',
              frontmatter: {},
              source: { url: 'https://x.test/s.git', ref: null, path: null, commit_sha: null },
              files: files(),
            },
          ),
        ).toBeNull()
      })
    })

    describe('setEnabled', () => {
      it('moves the one field and nothing else', async () => {
        const { store, clock } = await setup()
        const created = await store.create(draft())
        clock.advance(SECOND)
        const off = await store.setEnabled(created.id, { ownerId: OWNER_A }, false)
        expect(off).toEqual({ ...created, enabled: false })
        // `refreshed_at` does not move for a switch: the snapshot is the same snapshot.
        expect(off?.refreshed_at).toBe(created.refreshed_at)
        expect((await store.setEnabled(created.id, { ownerId: OWNER_A }, true))?.enabled).toBe(true)
        expect(await store.setEnabled(MISSING_SKILL_ID, { ownerId: OWNER_A }, false)).toBeNull()
      })
    })

    describe('delete', () => {
      it('removes the skill and its whole snapshot, false for an unknown id', async () => {
        const { store } = await setup()
        const created = await store.create(draft())
        expect(await store.delete(created.id, { ownerId: OWNER_A })).toBe(true)
        expect(await store.get(created.id, { ownerId: OWNER_A })).toBeNull()
        // The files went with it: nothing holds a content for a skill that is gone.
        expect(await store.getFile(created.id, { ownerId: OWNER_A }, SKILL_MD_FILENAME)).toBeNull()
        expect(await store.delete(created.id, { ownerId: OWNER_A })).toBe(false)
        // And a deleted name is free again, which is what makes re-importing one possible.
        expect(await store.create(draft())).toMatchObject({ name: 'release-notes' })
      })
    })
  })
}

/** How a conformance test builds the store under test. */
export type MakeSkillStore = (clock: TestClock) => SkillStore | Promise<SkillStore>

/** How to title the suite in a report. */
export interface SkillStoreConformanceOptions {
  /** The implementation's name; the suite's blocks are titled `${name} conformance`. */
  readonly name?: string
  /**
   * Makes sure the given users exist, for a store whose schema references them — the Postgres
   * table's `owner_id` is a foreign key into Better Auth's `"user"` row. Called once per test,
   * after the factory; a store without users leaves it out.
   */
  readonly ensureUsers?: (userIds: readonly UserId[]) => Promise<void>
}

/** The instant every test's clock starts at; fixed, so a timestamp in a failure is readable. */
const START_MS = Date.UTC(2026, 2, 15, 10, 0, 0)

/** One second in milliseconds; the suite moves its clock in these. */
const SECOND = 1000

/** The commit the suite's default snapshot came from, and the one a refresh moves it to. */
const COMMIT_SHA = '9f2c1b4e5a6d7c8b9a0f1e2d3c4b5a69788796a5'
const NEXT_COMMIT_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'

/** The `SKILL.md` the suite's default snapshot carries; its size is used in assertions. */
const SKILL_MD = '---\nname: release-notes\n---\n\nWrite them.\n'

/** The size of {@link SKILL_MD}, spelled once so an assertion and the fixture cannot drift. */
const FILE_SIZE = skillFileSize(SKILL_MD)

/** The two files the suite's default snapshot writes. */
const DEFAULT_FILES: readonly SkillFileInput[] = [
  { path: SKILL_MD_FILENAME, content: SKILL_MD },
  { path: 'reference/tone.md', content: 'Be terse.\n' },
]

/**
 * An `skl_` id no store holds, for the "nobody's skill" cases: minted, and never created.
 *
 * A ULID carries its own randomness, so a freshly generated one names no row — the suite never
 * asks a store to hold this one.
 */
const MISSING_SKILL_ID = newSkillId(START_MS)

/**
 * Run `action` and answer whatever it threw.
 *
 * The in-memory store is synchronous — its whole body runs before it answers — so a refusal it
 * raises is a synchronous throw rather than a rejected promise; this is how the suite catches
 * one without caring which implementation it is. It throws when the call does not refuse.
 */
async function thrownBy(action: () => unknown): Promise<unknown> {
  try {
    await action()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to be refused')
}

/** Assert that `value` parses as `schema` and carries nothing the protocol does not define. */
function expectExact<T>(schema: { parse(value: unknown): T }, value: unknown, what: string): void {
  const parsed = schema.parse(value)
  expect(parsed, `${what} is exactly its protocol shape`).toEqual(value)
}
