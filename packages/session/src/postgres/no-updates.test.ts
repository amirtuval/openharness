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
 * file scans every source file of the package for the two shapes that would be that write —
 * a SQL statement rewriting the `events` table, and the Kysely builder's equivalent — and
 * fails on either. It runs without a database, so it also guards the suite on a machine where
 * the Postgres tests are skipped.
 *
 * This is a scan of the package's own source, not of a database session: statements the store
 * composes at runtime are all built from these literals, and a reviewer who reads this file
 * knows exactly which spellings are covered.
 */

/** `packages/session/src`, from this file's own URL, whichever directory the tests run from. */
const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

/** The two spellings a write back to the log would use. */
const WRITE_SHAPES = [/update\s+events/i, /updateTable\(\s*['"]events['"]\s*\)/]

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
    expect(store).toContain('delete from events')
    expect(schema).toContain('events: EventsTable')
  })
})

/** Every `.ts` file under `dir`, recursively, in a stable order. */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)))
    } else if (entry.name.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}
