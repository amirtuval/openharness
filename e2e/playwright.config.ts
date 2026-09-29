import { defineConfig, devices } from '@playwright/test'

/**
 * The QA pass of the running system (issue #14): a browser against a server that is already
 * up — the compose stack from the README, or any deployment reachable at `QA_BASE_URL`.
 *
 * These specs are **not** part of `yarn test` and not part of CI. Vitest's `include` is
 * `src/**` (see `vitest.config.ts` and the shared config), so nothing under `qa/` is collected
 * by the unit suite, and the specs need a live server that CI does not start.
 *
 *   QA_BASE_URL=http://localhost:3000 yarn qa:web
 */
const baseURL = process.env.QA_BASE_URL ?? 'http://localhost:3000'

export default defineConfig({
  testDir: './qa',
  // The scenarios drive one shared server and assert on order (the session list is
  // newest-first), so they run one at a time and in file order.
  fullyParallel: false,
  workers: 1,
  // A `__slow__` reply is ten seconds of streaming on purpose, and the server-restart
  // scenario waits for a container. The rest of the time is waiting for the UI to settle.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
