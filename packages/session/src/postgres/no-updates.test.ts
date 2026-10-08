import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The append-only guarantee, checked against the source of the store that speaks SQL (D9,
 * issue #46).
 *
 * "No code path writes back to a stored event" is the rule the whole replay story rests on,
 * and it is the kind of rule a later change can break without any test noticing: an append
 * that turned into a correction, a claim that started out easy as a write to the row. So this
 * file scans every non-test source file of the package for the shapes that would be that
 * write — raw SQL rewriting the `events` table (`update events`, `update "events"`,
 * schema-qualified, behind `only`, any case) and the Kysely builder's equivalent
 * (`updateTable('events')`, quoted, and behind `as const`) — and fails on either. Every
 * pattern is pinned against both halves in the second describe: the spellings that must be
 * caught, and the near-misses (appends, reads, other tables) that must not be. The scan needs
 * no database, so it also guards the suite on a machine where the Postgres tests are skipped;
 * where a database exists, `postgres.test.ts` verifies the rule structurally instead — a
 * snapshot of every `events` row across claims, a supersession and a compaction, compared
 * field by field.
 *
 * What no source scan can see is a table name that reaches `updateTable` as a runtime value
 * (`updateTable(EVENTS_TABLE)`), so that spelling would be missed; a reviewer who reads this
 * file knows exactly which spellings are covered.
 *
 * This is a scan of the package's own source, not of a database session: statements the store
 * composes at runtime are all built from these literals. The compaction delete — the one
 * `delete` the log itself has — is asserted clause by clause in the second describe.
 */

/** `packages/session/src`, from this file's own URL, whichever directory the tests run from. */
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

/**
 * The spellings a write back to the log would use.
 *
 * Raw SQL: `update` on `events` — bare, quoted, schema-qualified or behind `only`, any case,
 * any whitespace. The `\b` on either side keeps a different table whose name merely starts
 * with `events` (`update events_archive`) out.
 *
 * Kysely: `updateTable(...)` whose argument expression carries the literal `'events'` — a
 * plain string, a double-quoted one, a template literal, or any of those behind `as const`.
 */
const WRITE_SHAPES = [
  /\bupdate\s+(?:only\s+)?(?:[\w"]+\.)?"?events"?\b/i,
  /updateTable\([^)]*['"`]events['"`]/i,
]

describe('the log is append-only', () => {
  it('has no source line that writes back to the stored events', async () => {
    const files = await sourceFiles(SRC_DIR)
    // The scan is only meaningful if it found the package: a moved directory must fail here,
    // not pass silently with nothing to scan.
    expect(files.length).toBeGreaterThan(10)

    const offenders: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (WRITE_SHAPES.some((shape) => shape.test(source))) {
        offenders.push(file.slice(SRC_DIR.length))
      }
    }
    expect(offenders).toEqual([])
  })

  it('scans the files the SQL lives in, so a pass means something', async () => {
    const store = await readFile(join(SRC_DIR, 'postgres', 'store.ts'), 'utf8')
    const schema = await readFile(join(SRC_DIR, 'postgres', 'schema.ts'), 'utf8')
    // Append-only means appends and exactly one delete — compaction. Both are in the store.
    expect(store).toContain("insertInto('events')")
    expect(schema).toContain('events: EventsTable')
  })

  it('confines the compaction delete to what a recorded range covers', async () => {
    const store = await readFile(join(SRC_DIR, 'postgres', 'store.ts'), 'utf8')
    const start = store.indexOf('delete from events')
    const end = store.indexOf('returning e.id', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const statement = store.slice(start, end).replaceAll(/\s+/gu, ' ').trim()

    // Rows a recorded supersession covers, and nothing else. The join to
    // `event_supersessions` and the range check are the difference between deleting a
    // reply's chunks and deleting the log; the kind is the difference between a reply's
    // range, which covers its chunks and only chunks, and a rewind's, which covers every
    // event in the tail it restarted (#238); and `created_at` is the retention window.
    // The `WHERE` is spelled out in full here, so a relaxed clause — a fourth one, or one
    // that drops the kind — fails this test and has to be looked at rather than shipping
    // quietly.
    expect(statement).toBe(
      'delete from events e using event_supersessions s ' +
        'where e.session_id = s.session_id ' +
        'and e.seq between s.from_seq and s.to_seq ' +
        'and (s.kind = ${REWIND_KIND} or e.type in (${EVENT_TYPES.eventStart}, ${EVENT_TYPES.eventDelta})) ' +
        'and e.created_at < ${instant(cutoff)}',
    )
  })
})

describe('the write-shape patterns', () => {
  const catches = (sample: string): boolean => WRITE_SHAPES.some((shape) => shape.test(sample))

  it('catches every spelling a write back to the log would use', () => {
    for (const sample of [
      'await sql`update events set payload = ${json} where id = ${id}`',
      "await trx.updateTable('events').set(row).where('id', '=', id).execute()",
      'db.updateTable("events").set(row).execute()',
      "trx.updateTable('events' as const).set(row).execute()",
      'UPDATE Events SET processed_at = now()',
      'update  "events"  set payload = $1',
      'update only events set payload = $1',
      'update public.events set payload = $1',
    ]) {
      expect(catches(sample), sample).toBe(true)
    }
  })

  it('leaves appends, reads and other tables alone', () => {
    for (const sample of [
      "await trx.updateTable('agents').set(updated).where('id', '=', agentId).execute()",
      "await trx.updateTable('sessions').set(updated).execute()",
      'update partition_leases set expires_at = $1 where partition = $2',
      'on conflict (instance_id) do update set last_seen = excluded.last_seen',
      'insert into events (id, session_id) values ($1, $2)',
      'delete from events e using event_supersessions s where e.seq between s.from_seq and s.to_seq',
      'select * from events where created_at < $1',
      "await trx.updateTable('events_archive').set(row).execute()",
      'update events_archive set payload = $1',
    ]) {
      expect(catches(sample), sample).toBe(false)
    }
  })
})

/**
 * Every `.ts` file under `dir`, recursively, in a stable order, tests excluded.
 *
 * A test file may legitimately spell the very thing this scan refuses — the hostile samples
 * below do — and the rule being checked is about the code paths that run against a database,
 * not about assertions naming them.
 */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path)
    }
  }
  return files
}
