import {
  SKILL_MD_FILENAME,
  type Skill,
  type SkillFileContent,
  type SkillFrontmatter,
  type SkillId,
  type SkillSource,
  type UserId,
} from '@openharness/protocol'

import type { OwnerScope } from './store'

/**
 * The storage contract for users' **skills** (epic #349, K4).
 *
 * A skill is an imported snapshot: a folder of files taken from a public git repository
 * (K3), stored whole under one `skl_` id, owned by the user who imported it and reviewed it.
 * The store keeps the snapshot — the resource's metadata and every file's content — and
 * answers it back; it never clones anything itself, never parses a `SKILL.md` and never reads
 * a URL. What an import does with a repository is #351's; this is where its result lives.
 *
 * Two implementations exist: `InMemorySkillStore` — the test fake and the reference
 * behaviour — and `PostgresSkillStore`, which lives behind `@openharness/session/postgres` on
 * the `skills` and `skill_files` tables.
 *
 * ## What every implementation must guarantee
 *
 * - **A name is unique per user.** {@link SkillStore.create} refuses a second skill with the
 *   same `(ownerId, name)`, raising `DuplicateSkillNameError`, and a user holds at most
 *   `MAX_SKILLS_PER_USER`, enforced by the store rather than only checked by the caller — so
 *   two concurrent creates cannot both take a name or the last slot. The count is taken inside
 *   the creating transaction under a per-owner lock, the way modes and remote MCP servers are.
 * - **Owner-scoped.** Every read and write is scoped to the owner's id; another user's skill
 *   is `null` on a read and `false` on a delete, never a 403 and never a 500.
 * - **A listing is metadata only.** {@link SkillStore.list} and {@link SkillStore.get} answer
 *   the protocol's `Skill`, whose `files` is a path and a size per file — **never a content**.
 *   Implementations must not even select the content column for either: reading a file's bytes
 *   is {@link SkillStore.getFile} and nothing else, which is also what keeps the contents free
 *   to move to object storage later (K4) without a caller noticing.
 * - **A snapshot is a snapshot.** {@link SkillStore.replaceSnapshot} replaces the metadata and
 *   the **whole** file set in one transaction — a reader sees the old snapshot or the new one
 *   and never a mixture — keeps the skill's name, `enabled` and `imported_at`, and moves
 *   `refreshed_at`. That is what a confirmed refresh does (K5); an older chat is unaffected
 *   because what a chat loaded is in its log.
 * - **A skill is a folder with a `SKILL.md`** (K1). A snapshot without one, or with two files
 *   at the same path, is refused with a `RangeError` ({@link assertSkillSnapshot}) — both
 *   stores check it, so the fake cannot hold a shape the durable one would refuse.
 * - **Sizes are the store's.** A file's `size` is the byte length of the content the store was
 *   handed (`skillFileSize`), computed on the way in rather than passed beside it, so a size
 *   can never disagree with what is stored.
 * - **A listing's files are in path order.** The resource's `files` reads by path (the order
 *   the `skill_files` rows come back in), not in the order a snapshot happened to write them:
 *   two implementations that answered different orders for the same snapshot would be two
 *   answers to one question, and neither the contract nor a diff a client draws has a use for
 *   an import-order that only one of them keeps.
 * - **Deep-frozen answers.** What a store returns is deep-frozen, like a log's events and a
 *   credential: a snapshot is a value, and an edit to one is a compile error rather than a
 *   silent fork of what the store holds.
 *
 * The limits of K4 — `SKILL.md` ≤ 20 KB, one file ≤ 256 KB, a skill ≤ 2 MB and ≤ 100 files —
 * are **not** this store's: they are the protocol's constants and the import's checks (#351),
 * so a snapshot that breaks one is refused before it gets here, with the reason to show the
 * user. Only the per-user cap of {@link SkillStore.create} is a store rule, because only the
 * store can count a user's rows and insert one without a race between the two.
 */

/**
 * One file of a snapshot, as a caller writes it: the path inside the skill folder and the
 * content.
 *
 * The content is the file's text and the only thing that crosses this boundary — the store
 * computes the size it reports from it. A binary file of a skill is stored the same way, as
 * the text it was read as; running or interpreting one is not this epic's (K2).
 */
export interface SkillFileInput {
  /** The file's path, relative to the skill folder and forward-slashed (`SKILL.md`, `a/b.md`). */
  readonly path: string
  /** The file's content, exactly as it should be stored and handed back. */
  readonly content: string
}

/**
 * What a snapshot carries: the metadata the resource describes and every file of it.
 *
 * The unit both a create and a refresh write, so the two cannot disagree about what a snapshot
 * is. `name` is deliberately not here: it is the skill's identity among its owner's skills (a
 * refresh clones the same folder, and uniqueness is per user), while everything below is what
 * a clone of that folder produced.
 */
export interface SkillSnapshotInput {
  /** The one-line description the model is shown (K1). */
  readonly description: string
  /** The frontmatter's other fields, as parsed (K1). */
  readonly frontmatter: SkillFrontmatter
  /** Where the snapshot came from: the URL, the ref, the path and the commit (K3). */
  readonly source: SkillSource
  /** The snapshot's files, contents included. `SKILL.md` has to be one of them. */
  readonly files: readonly SkillFileInput[]
}

/** What {@link SkillStore.create} writes. The store assigns `id` and the timestamps. */
export interface CreateSkillInput extends SkillSnapshotInput {
  /**
   * The skill's `skl_` id, when the caller mints it; the store mints one from its own clock
   * otherwise, which is what a bare test does.
   */
  readonly id?: SkillId
  /** The owner: the `user.id` Better Auth minted. */
  readonly ownerId: UserId
  /** The skill's name (K1), unique among its owner's skills. */
  readonly name: string
  /** Whether the skill is on for this user's chats (K8); on when imported. */
  readonly enabled: boolean
}

/** The storage contract for a user's imported skills. */
export interface SkillStore {
  /**
   * Store a new skill for its owner, with its whole snapshot.
   *
   * It is on or off as the input says — on when imported (K8) — and its `imported_at` and
   * `refreshed_at` are the store's clock: a fresh snapshot is one already refreshed.
   *
   * @throws `DuplicateSkillNameError` when the owner already has a skill with that name
   * @throws `SkillLimitReachedError` when the owner is at `MAX_SKILLS_PER_USER`
   * @throws RangeError when the snapshot is not a skill (see {@link assertSkillSnapshot})
   */
  create(input: CreateSkillInput): Promise<Skill>

  /**
   * Read one skill's metadata — its files as paths and sizes, never their contents — or `null`
   * when the id names no skill of this owner's.
   *
   * The one metadata read of a single skill; a file's content is
   * {@link SkillStore.getFile}.
   */
  get(skillId: SkillId, scope: OwnerScope): Promise<Skill | null>

  /**
   * List one owner's skills, oldest first — `(imported_at, id)` order, the order the agent,
   * mode and MCP-server lists use.
   *
   * Metadata only: no file's content appears in an answer.
   */
  list(scope: OwnerScope): Promise<Skill[]>

  /**
   * Read one file of one owner's skill, or `null` when the skill is not theirs or holds no
   * file at that path.
   *
   * An unknown path and another user's skill answer the same `null`, so a caller cannot use
   * this to learn that a skill exists — the route above it answers 404 for both.
   */
  getFile(skillId: SkillId, scope: OwnerScope, path: string): Promise<SkillFileContent | null>

  /**
   * Replace one owner's snapshot — its description, frontmatter, source and **every** file —
   * or answer `null` for an id nobody's skill has.
   *
   * One transaction: the old snapshot is wholly replaced by the new one. The skill's `name`,
   * `enabled` and `imported_at` are kept (a refresh is the same skill, re-read), `refreshed_at`
   * moves to the store's now, and the files the new snapshot does not carry are gone.
   *
   * @throws RangeError when the snapshot is not a skill (see {@link assertSkillSnapshot})
   */
  replaceSnapshot(
    skillId: SkillId,
    scope: OwnerScope,
    input: SkillSnapshotInput,
  ): Promise<Skill | null>

  /**
   * Turn one owner's skill on or off (K8), or answer `null` for an id nobody's skill has.
   *
   * The one field of a stored skill a user changes without a refresh — what a settings
   * screen's switch calls. Nothing else moves, `refreshed_at` included: the snapshot is the
   * same snapshot.
   */
  setEnabled(skillId: SkillId, scope: OwnerScope, enabled: boolean): Promise<Skill | null>

  /**
   * Delete one owner's skill and its whole snapshot.
   *
   * @returns `true` when one was deleted, `false` for an unknown id and another owner's skill
   *   alike
   */
  delete(skillId: SkillId, scope: OwnerScope): Promise<boolean>
}

/**
 * Refuse a snapshot that is not a skill's, before a store writes it (K1).
 *
 * Two shapes are structurally impossible rather than merely over a limit, which is why they
 * are refused here and not left to the import's checks: a folder with no `SKILL.md` is not a
 * skill — nothing could describe it or run it — and two files at one path cannot both be the
 * snapshot (`skill_files` is keyed by `(skill, path)`, and an in-memory store would silently
 * keep one of them). Both stores call this, so the fake and the durable one refuse the same
 * snapshots; the limits of K4 are the caller's and live in the protocol.
 *
 * @throws RangeError naming what is wrong with the snapshot
 */
export function assertSkillSnapshot(input: SkillSnapshotInput): void {
  const seen = new Set<string>()
  for (const file of input.files) {
    if (file.path.length === 0) {
      throw new RangeError('a skill file needs a path')
    }
    if (seen.has(file.path)) {
      throw new RangeError(`a skill holds one file per path: ${file.path} appears twice`)
    }
    seen.add(file.path)
  }
  if (!seen.has(SKILL_MD_FILENAME)) {
    throw new RangeError(`a skill needs a ${SKILL_MD_FILENAME} at its root`)
  }
}
