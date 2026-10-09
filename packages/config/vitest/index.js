/** Settings every package's Vitest run shares. */
const shared = {
  include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 10_000,
}

/**
 * Test settings for Node.js packages.
 *
 * @param {import('vitest/config').TestUserConfig} [overrides]
 */
export function nodeVitestTestConfig(overrides = {}) {
  return { ...shared, environment: 'node', ...overrides }
}

/**
 * Test settings for React packages (jsdom).
 *
 * @param {import('vitest/config').TestUserConfig} [overrides]
 */
export function reactVitestTestConfig(overrides = {}) {
  return { ...shared, environment: 'jsdom', ...overrides }
}
