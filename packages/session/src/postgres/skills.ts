import {
  MAX_SKILLS_PER_USER,
  newSkillId,
  skillFileSize,
  type Skill,
  type SkillFileContent,
  type SkillId,
} from '@openharness/protocol'
import { Kysely, PostgresDialect, sql, type Insertable, type Transaction } from 'kysely'
import { Pool } from 'pg'

import { type Clock, systemClock } from '../clock'
import { DuplicateSkillNameError, SkillLimitReachedError } from '../errors'
import {
  assertSkillSnapshot,
  type CreateSkillInput,
  type SkillSnapshotInput,
  type SkillStore,
} from '../skills'
import type { OwnerScope } from '../store'
import {
  instant,
  skillFromRow,
  type PostgresSchema,
  type SkillFileListing,
  type SkillFileMetadataRow,
  type SkillRow,
  type SkillsTable,
} from './schema'
import { isUniqueViolation } from './store'

/**
 * The Postgres `SkillStore` (epic #349, K4): the durable implementation of the contract in
 * `skills.ts`, on the `skills` and `skill_files` tables.
 *
 * The two tables are one thing — a snapshot — so every write that touches both is one
 * transaction, and every read that answers a resource joins them: a listing selects
 * `skill_files`' `(path, size)` columns and **never** `content`, so "reading a skill never
 * reads its files' bytes" is a property of the SQL rather than a convention.
 *
 * `unique (owner_id, name)` is what makes a duplicate name a conflict rather than a race, and
 * the cap is a count then an insert under a per-owner `pg_advisory_xact_lock`, so two creates
 * racing for the last slot cannot both read a count below it — the rule modes and remote MCP
 * servers established.
 *
 * Time comes from the injected clock: `imported_at` and `refreshed_at` are written from it,
 * never from the database's `now()`.
 */
export class PostgresSkillStore implements SkillStore {
  readonly #db: Kysely<PostgresSchema>

  readonly #pool: Pool

  /** Whether this store opened the pool: only then does {@link PostgresSkillStore.close} end it. */
  readonly #ownsPool: boolean

  readonly #clock: Clock

  #closed = false

  constructor(options: PostgresSkillStoreOptions = {}) {
    const { pool, connectionString } = options
    if (pool !== undefined && connectionString !== undefined) {
      throw new TypeError('pass either `pool` or `connectionString`, not both')
    }
    if (pool === undefined && connectionString === undefined) {
      throw new TypeError('pass either `pool` or `connectionString`')
    }
    if (pool !== undefined) {
      this.#pool = pool
      this.#ownsPool = false
    } else {
      this.#pool = new Pool({ connectionString })
      this.#ownsPool = true
    }
    this.#db = new Kysely<PostgresSchema>({ dialect: new PostgresDialect({ pool: this.#pool }) })
    this.#clock = options.now ?? systemClock
  }

  async create(input: CreateSkillInput): Promise<Skill> {
    assertSkillSnapshot(input)
    const now = this.#clock()
    const at = instant(now)
    const id = input.id ?? newSkillId(now)
    return this.#db.transaction().execute(async (trx) => {
      // The per-owner lock first, so the count below and the insert it guards are one critical
      // section: two creates at the cap cannot both read a count below it and both insert.
      await sql`select pg_advisory_xact_lock(hashtext(${SKILL_CREATE_LOCK + input.ownerId}))`.execute(
        trx,
      )
      const existing = await trx
        .selectFrom('skills')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('owner_id', '=', input.ownerId)
        .executeTakeFirstOrThrow()
      if (Number(existing.count) >= MAX_SKILLS_PER_USER) {
        throw new SkillLimitReachedError(input.ownerId, MAX_SKILLS_PER_USER)
      }
      let saved: SkillRow
      try {
        saved = await trx
          .insertInto('skills')
          .values(skillRow(input, id, at))
          .returningAll()
          .executeTakeFirstOrThrow()
      } catch (error) {
        if (isUniqueViolation(error, SKILL_NAME_CONSTRAINTS)) {
          throw new DuplicateSkillNameError(input.ownerId, input.name)
        }
        throw error
      }
      await insertFiles(trx, id, input.files)
      return skillFromRow(saved, filesOf(input))
    })
  }

  async get(skillId: SkillId, options: OwnerScope): Promise<Skill | null> {
    const row = await this.#db
      .selectFrom('skills')
      .selectAll()
      .where('id', '=', skillId)
      .where('owner_id', '=', options.ownerId)
      .executeTakeFirst()
    if (row === undefined) {
      return null
    }
    return skillFromRow(row, await this.#files(skillId, this.#db))
  }

  async list(options: OwnerScope): Promise<Skill[]> {
    // The skills of one owner, then their files' paths and sizes: two queries rather than one
    // per skill, and neither of them names a `content` column. `(imported_at, id)` is the order
    // every resource list uses, and the index in the migration seeks by it.
    const rows = await this.#db
      .selectFrom('skills')
      .selectAll()
      .where('owner_id', '=', options.ownerId)
      .orderBy('imported_at', 'asc')
      .orderBy('id', 'asc')
      .execute()
    if (rows.length === 0) {
      return []
    }
    const files = await this.#db
      .selectFrom('skill_files')
      .innerJoin('skills', 'skills.id', 'skill_files.skill_id')
      .select(FILE_COLUMNS)
      .where('skills.owner_id', '=', options.ownerId)
      .orderBy('skill_files.skill_id', 'asc')
      .orderBy('skill_files.path', 'asc')
      .execute()
    const bySkill = groupFiles(files)
    return rows.map((row) => skillFromRow(row, bySkill.get(row.id) ?? []))
  }

  async getFile(
    skillId: SkillId,
    options: OwnerScope,
    path: string,
  ): Promise<SkillFileContent | null> {
    // One statement, owner-scoped through the join: another user's skill and an unknown path
    // are the same absent row, which is what makes the route above answer 404 for both.
    const row = await this.#db
      .selectFrom('skill_files')
      .innerJoin('skills', 'skills.id', 'skill_files.skill_id')
      .select([
        'skill_files.path',
        'skill_files.size',
        'skill_files.encoding',
        'skill_files.content',
      ])
      .where('skill_files.skill_id', '=', skillId)
      .where('skill_files.path', '=', path)
      .where('skills.owner_id', '=', options.ownerId)
      .executeTakeFirst()
    return row === undefined
      ? null
      : { path: row.path, size: row.size, encoding: row.encoding, content: row.content }
  }

  async replaceSnapshot(
    skillId: SkillId,
    options: OwnerScope,
    input: SkillSnapshotInput,
  ): Promise<Skill | null> {
    assertSkillSnapshot(input)
    const refreshedAt = instant(this.#clock())
    return this.#db.transaction().execute(async (trx) => {
      // The skill row is locked for the whole replacement, so a concurrent refresh of the same
      // skill serializes behind this one rather than interleaving two file sets.
      const current = await trx
        .selectFrom('skills')
        .select(['id', 'owner_id'])
        .where('id', '=', skillId)
        .where('owner_id', '=', options.ownerId)
        .forUpdate()
        .executeTakeFirst()
      if (current === undefined) {
        return null
      }
      // The snapshot's metadata, and only the fields a refresh replaces: the name, `enabled`
      // and `imported_at` are the skill's own and stay as they are (K5).
      const saved = await trx
        .updateTable('skills')
        .set({
          description: input.description,
          frontmatter: JSON.stringify(input.frontmatter),
          source_url: input.source.url,
          source_ref: input.source.ref,
          source_path: input.source.path,
          commit_sha: input.source.commit_sha,
          refreshed_at: refreshedAt,
        })
        .where('id', '=', skillId)
        .where('owner_id', '=', options.ownerId)
        .returningAll()
        .executeTakeFirstOrThrow()
      // The whole file set: deleted and re-written in this transaction, so a reader sees the
      // old snapshot or the new one and nothing in between.
      await trx.deleteFrom('skill_files').where('skill_id', '=', skillId).execute()
      await insertFiles(trx, skillId, input.files)
      return skillFromRow(saved, filesOf(input))
    })
  }

  async setEnabled(skillId: SkillId, options: OwnerScope, enabled: boolean): Promise<Skill | null> {
    const row = await this.#db
      .updateTable('skills')
      .set({ enabled })
      .where('id', '=', skillId)
      .where('owner_id', '=', options.ownerId)
      .returningAll()
      .executeTakeFirst()
    if (row === undefined) {
      return null
    }
    return skillFromRow(row, await this.#files(skillId, this.#db))
  }

  async delete(skillId: SkillId, options: OwnerScope): Promise<boolean> {
    // The files cascade (`on delete cascade`), so this one statement is the whole delete.
    const deleted = await this.#db
      .deleteFrom('skills')
      .where('id', '=', skillId)
      .where('owner_id', '=', options.ownerId)
      .executeTakeFirst()
    return Number(deleted.numDeletedRows) > 0
  }

  /** One skill's file listing, from any handle: a transaction's or the store's own. */
  async #files(skillId: SkillId, db: Kysely<PostgresSchema>): Promise<SkillFileMetadataRow[]> {
    return db
      .selectFrom('skill_files')
      .select(FILE_COLUMNS)
      .where('skill_id', '=', skillId)
      .orderBy('path', 'asc')
      .execute()
  }

  /**
   * Give up the store's own resources: end the pool when this store opened it.
   *
   * A store built on a pool the caller owns leaves that pool alone. Idempotent, and nothing
   * else may be called afterwards.
   */
  async close(): Promise<void> {
    if (this.#closed) {
      return
    }
    this.#closed = true
    if (this.#ownsPool) {
      await this.#db.destroy()
    }
  }
}

/** Everything {@link PostgresSkillStore} takes. */
export interface PostgresSkillStoreOptions {
  /** A connection string this store opens (and, on {@link PostgresSkillStore.close}, ends) itself. */
  readonly connectionString?: string
  /** A pool to borrow. The store never ends it; the caller owns its lifecycle. */
  readonly pool?: Pool
  /**
   * The store's time source. Defaults to {@link systemClock}; pass a controllable clock in
   * tests, which is what the conformance suite does.
   */
  readonly now?: Clock
}

/** How the two ways of reaching Postgres are written: a connection string, or a pool. */
export type PostgresSkillStoreConfig =
  { readonly connectionString: string } | { readonly pool: Pool }

/**
 * Build a Postgres-backed skill store.
 *
 * ```ts
 * const store = createPostgresSkillStore({ connectionString: process.env.DATABASE_URL })
 * ```
 *
 * The tables have to exist: run {@link migrate} against the same database first — the same
 * migrations the session store applies.
 */
export function createPostgresSkillStore(
  config: PostgresSkillStoreConfig,
  options: Omit<PostgresSkillStoreOptions, 'connectionString' | 'pool'> = {},
): PostgresSkillStore {
  return new PostgresSkillStore({ ...config, ...options })
}

/**
 * The file columns a **listing** reads: a path and a size, never a content.
 *
 * Qualified with the table because every listing query joins `skills` to stay owner-scoped, and
 * `skills` has no `path` of its own only by luck — naming the table is what keeps this a
 * property of the SQL rather than of the schema's current shape.
 */
const FILE_COLUMNS = ['skill_files.skill_id', 'skill_files.path', 'skill_files.size'] as const

/** The unique constraint behind a duplicate-name refusal. */
const SKILL_NAME_CONSTRAINTS = new Set(['skills_owner_name_key'])

/** The advisory lock `create` takes, keyed by owner, so two users' creates never wait on each other. */
const SKILL_CREATE_LOCK = 'openharness:skill-create:'

/** The `skills` row a create writes. */
function skillRow(input: CreateSkillInput, id: SkillId, at: Date): Insertable<SkillsTable> {
  return {
    id,
    owner_id: input.ownerId,
    name: input.name,
    description: input.description,
    frontmatter: JSON.stringify(input.frontmatter),
    source_url: input.source.url,
    source_ref: input.source.ref,
    source_path: input.source.path,
    commit_sha: input.source.commit_sha,
    enabled: input.enabled,
    imported_at: at,
    refreshed_at: at,
  }
}

/** The snapshot's files as the table holds them: a path, a content and the content's size. */
async function insertFiles(
  trx: Transaction<PostgresSchema>,
  skillId: SkillId,
  files: SkillSnapshotInput['files'],
): Promise<void> {
  if (files.length === 0) {
    // Unreachable for a snapshot (`assertSkillSnapshot` requires a `SKILL.md`) — and a Kysely
    // insert of nothing is not a statement, so it is also the guard that keeps this total.
    return
  }
  await trx
    .insertInto('skill_files')
    .values(
      files.map((file) => ({
        skill_id: skillId,
        path: file.path,
        content: file.content,
        encoding: file.encoding ?? 'utf8',
        size: skillFileSize(file.content, file.encoding),
      })),
    )
    .execute()
}

/**
 * The listing of a snapshot, built from the input rather than re-read from the table — and
 * sorted by path, so a write's answer is the one a later read gives (`list`, whose rows come
 * back in `(skill_id, path)` order, and `get`).
 */
function filesOf(input: SkillSnapshotInput): SkillFileListing[] {
  return input.files
    .map((file) => ({ path: file.path, size: skillFileSize(file.content, file.encoding) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

/**
 * The file rows of a whole listing, grouped by the skill they belong to: what turns the one
 * query a `list` makes into each resource's own `files`.
 */
function groupFiles(files: readonly SkillFileMetadataRow[]): Map<string, SkillFileListing[]> {
  const bySkill = new Map<string, SkillFileListing[]>()
  for (const file of files) {
    const held = bySkill.get(file.skill_id)
    if (held === undefined) {
      bySkill.set(file.skill_id, [file])
    } else {
      held.push(file)
    }
  }
  return bySkill
}

export { SKILL_CREATE_LOCK, SKILL_NAME_CONSTRAINTS }
