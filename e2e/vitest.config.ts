import { defineConfig } from 'vitest/config'
import { nodeVitestTestConfig } from '@openharness/config/vitest'

export default defineConfig({
  test: nodeVitestTestConfig({
    name: '@openharness/e2e',
    // An e2e test boots server processes, drives real sockets and streams replies the mock
    // model deliberately stretches to ten seconds, so the shared ten-second timeout is not
    // enough. File parallelism stays on: the files are independent — each owns a database of
    // its own — and they spend their time waiting rather than computing.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  }),
})
