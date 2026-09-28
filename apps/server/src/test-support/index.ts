/**
 * Test-only helpers, in the shape `packages/brain` and `packages/session` already use: a
 * `src/test-support/` folder that the build never reaches, importing nothing a test cannot.
 *
 * Nothing here is exported from `src/index.ts`, so none of it ships.
 */
export * from './harness'
export * from './model'
export * from './sse'
