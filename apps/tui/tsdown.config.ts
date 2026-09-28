import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  entry: ['src/index.tsx'],
  platform: 'node',
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  // Ship `dist/<entry>.js` + `dist/<entry>.d.ts` (not `.mjs`/`.d.mts`) so the `exports`
  // maps of every package read the same way.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
})
