import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  // Ship `dist/index.js` + `dist/index.d.ts` (not `.mjs`/`.d.mts`) so the `exports`
  // maps of every package read the same way.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
