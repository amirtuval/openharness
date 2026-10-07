import { readFileSync } from 'node:fs'
import { reactVitestTestConfig } from '@openharness/config/vitest'
import { defineConfig } from 'vitest/config'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  // Mirrors tsdown.config.ts: the version comes from package.json in tests too.
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
  // The Ink tests drive real timers and a real event loop, so a machine under load is
  // slower, not broken (the review of #105, P1): the waits poll with conditions, and this
  // looser ceiling is headroom for a contended CI runner rather than a licence to hang.
  test: reactVitestTestConfig({ name: '@openh/cli', testTimeout: 20_000 }),
})
