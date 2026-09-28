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
  test: reactVitestTestConfig({ name: '@openharness/cli' }),
})
