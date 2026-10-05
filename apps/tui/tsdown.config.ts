import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'
import type { TsdownPlugin } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

/**
 * Strip ink's optional React DevTools client out of the bundle.
 *
 * `ink/build/reconciler.js` dynamically imports `./devtools.js` when `process.env['DEV']` is
 * `'true'`; that module statically imports `react-devtools-core` and `ws`, neither of which
 * is installed here (devtools is opt-in for someone developing against ink from a checkout).
 * Resolving it to an empty module drops the devtools client, `ws` and the
 * `bufferutil`/`utf-8-validate` requires `ws` carries — the one path that would otherwise
 * leave a bare `import "react-devtools-core"` in `dist/index.js` and stop `oh` from loading
 * at all outside this repo's `node_modules` (and the D10 auto-update's whole premise is a
 * bundle with nothing left to resolve). The `DEV=true` branch still runs; it just finds a
 * module with nothing in it, the same shape as ink's "react-devtools-core is not installed"
 * case, which it already handles.
 */
function stripInkDevtools(): TsdownPlugin {
  const stripped = '\0ink-devtools-stripped'
  return {
    name: 'strip-ink-devtools',
    resolveId(source, importer) {
      if (
        source === './devtools.js' &&
        importer?.replaceAll('\\', '/').endsWith('/ink/build/reconciler.js')
      ) {
        return stripped
      }
      return undefined
    },
    load(id) {
      return id === stripped ? 'export {}' : undefined
    },
  }
}

/**
 * The settings the two builds share: one entry, Node ESM, `.js`/`.d.ts` extensions so the
 * `exports` maps of every package read the same way, the shebang kept, and `#152`'s single
 * self-contained file.
 *
 * `outputOptions.codeSplitting: false` folds the one dynamic import (`src/dev/fake.ts`'s
 * lazy `@openharness/client/testing`) into the bundle. The package has no runtime
 * `dependencies` to externalize — they are devDependencies — so every import is inlined and
 * nothing is left to resolve from `node_modules` at runtime, which is what makes
 * `npm install -g` replacing the file on disk safe while an `oh` process is running (the
 * auto-update of D10). Ink's layout engine needs no asset handling: the `yoga-layout` build
 * this package resolves ships its wasm base64-encoded inside `yoga-wasm-base64-esm.js`, so
 * the wasm travels in `dist/index.js` like any other module.
 * `scripts/check-pack.mjs` proves the result packs, installs and runs with nothing else
 * present.
 */
const shared = {
  entry: ['src/index.tsx'],
  platform: 'node',
  format: 'esm',
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  plugins: [stripInkDevtools()],
  deps: {
    // Bundling everything is the point — `onlyBundle: false` says so and turns off tsdown's
    // "consider whether these should be bundled" hint. The outcome is not left to
    // self-restraint: `scripts/check-pack.mjs` greps the packed bundle for anything it
    // would still have to resolve.
    onlyBundle: false,
  },
  outputOptions: {
    codeSplitting: false,
    // The bundle is generated code: only the legal comments (`@license`/`@preserve`) are
    // kept, so the third-party licences travel with the file. Dropping the rest — including
    // rolldown's `//#region ../../node_modules/...` markers and the copied JSDoc — also
    // leaves the bundle with no `node_modules` or `@openharness/` string in it at all,
    // which is what `scripts/check-pack.mjs` asserts about the published file.
    comments: { legal: true, jsdoc: false, annotation: false },
  },
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    // The CLI ships to users, so React and Ink are built as production (their checks fold
    // away and the dev-only code paths — `react/jsx-dev-runtime`, the warning machinery —
    // are dropped). Nothing in this repo reads `process.env.NODE_ENV` at runtime.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
} satisfies Parameters<typeof defineConfig>[0]

/**
 * Two builds, because one cannot be both.
 *
 * With `dts: true` in the same build, `rolldown-plugin-dts` adds a virtual entry for the
 * declaration file, and rolldown — which cannot inline *entries* the way
 * `codeSplitting: false` inlines dynamic imports — answers with an extra shared chunk
 * (`dist/chunk-*.js`), so `dist/` is no longer one file. So the JS bundle gets a build of
 * its own here (`dts: false`, which emits exactly `index.js` + its map), and the
 * declarations get a second, declaration-only build (`emitDtsOnly`, which drops every
 * non-declaration chunk) writing into the same `dist/` (`clean: false` there, so it cannot
 * wipe the first build's output).
 */
export default defineConfig([
  {
    ...shared,
    name: 'openharness',
    dts: false,
    clean: true,
    sourcemap: true,
  },
  {
    ...shared,
    name: 'openharness:dts',
    dts: { emitDtsOnly: true },
    clean: false,
  },
])
