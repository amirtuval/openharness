import { defineConfig, mergeConfig } from 'vitest/config'
import { reactVitestTestConfig } from '@openharness/config/vitest'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: reactVitestTestConfig({
      name: '@openharness/web',
      setupFiles: ['./vitest.setup.ts'],
    }),
  }),
)
