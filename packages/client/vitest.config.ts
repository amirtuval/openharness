import { defineConfig } from 'vitest/config'
import { nodeVitestTestConfig } from '@openharness/config/vitest'

export default defineConfig({
  test: nodeVitestTestConfig({ name: '@openharness/client' }),
})
