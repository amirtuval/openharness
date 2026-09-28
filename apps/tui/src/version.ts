/**
 * The CLI version, injected at build time from this package's `package.json` — by
 * `tsdown.config.ts` for `dist/`, and by `vitest.config.ts` for tests. Injecting it (rather
 * than reading the file at runtime) keeps `oh --version` working from any working directory
 * and keeps the version from drifting from `package.json`.
 */
declare const __CLI_VERSION__: string

export function readVersion(): string {
  return __CLI_VERSION__
}
