import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/testing/index.ts'],
  platform: 'node',
  format: 'esm',
  dts: true,
  sourcemap: true,
  clean: true,
  // Ship `dist/<entry>.js` + `dist/<entry>.d.ts` (not `.mjs`/`.d.mts`) so the `exports`
  // maps of every package read the same way. The second entry is the test fixtures another
  // package's tests import (`./testing`, epic #349).
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
