import { defineConfig } from 'vitest/config'
import { nodeVitestTestConfig } from './vitest/index.js'

export default defineConfig({
  test: nodeVitestTestConfig({ name: '@openharness/config' }),
})
