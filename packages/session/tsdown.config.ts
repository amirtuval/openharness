import { defineConfig } from 'tsdown'

export default defineConfig({
  // `src/postgres/` is its own entry point: it is the only module that depends on `pg` and
  // `kysely`, and a consumer that only needs the contract or the in-memory store must not
  // load them.
  entry: [
    'src/index.ts',
    'src/postgres/index.ts',
    // The `openharness-session-migrate` bin; see `bin` in package.json.
    'src/postgres/cli.ts',
    'src/testing/index.ts',
  ],
  platform: 'node',
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  // `src/testing/` holds the conformance suite, which is written with Vitest's `describe`/`it`.
  // Vitest is a devDependency of every package that uses that entry point, never a runtime
  // dependency of this one, so it stays an import in the built output instead of being bundled.
  deps: { neverBundle: ['vitest'] },
  // Ship `dist/<entry>.js` + `dist/<entry>.d.ts` (not `.mjs`/`.d.mts`) so the `exports`
  // maps of every package read the same way.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
