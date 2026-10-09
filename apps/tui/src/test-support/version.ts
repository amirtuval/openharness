import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The version this package's `package.json` carries.
 *
 * `oh --version` prints the version `vitest.config.ts` injects at test time (and
 * `tsdown.config.ts` at build time), both read from that file, so a test that asserts on the
 * printed line is really asserting the injection worked. Spelling the number out in the test
 * turns every release bump into a failing suite — which is what happened between 0.0.1 and
 * 0.0.3 — so the test reads the same file the injection does.
 *
 * `process.cwd()` is the package folder here: `yarn test` runs from it.
 */
export function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('this package.json must hold an object')
  }
  const version = (parsed as { version?: unknown }).version
  if (typeof version !== 'string' || version === '') {
    throw new Error('this package.json must name a version')
  }
  return version
}
