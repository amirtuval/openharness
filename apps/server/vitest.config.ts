import { defineConfig } from 'vitest/config'
import { nodeVitestTestConfig } from '@openharness/config/vitest'

export default defineConfig({
  test: nodeVitestTestConfig({
    name: '@openharness/server',
    // One test file at a time. Two suites here run against the same Postgres —
    // `partition-scheduler.test.ts` and `sse-postgres.test.ts` — and each empties the tables
    // it uses, so two of them in flight at once would delete each other's sessions. The
    // in-memory suites do not care, and running files one after another costs this package
    // about a second.
    fileParallelism: false,
  }),
})
