import { nodeConfig } from '@openharness/config/eslint'

export default [
  ...nodeConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    // Two TypeScript programs, because they cover disjoint files: `tsconfig.json` is `src/`
    // (browser-safe, no Node types) and `tsconfig.tooling.json` is the Node-only
    // `*.config.ts` files. The project service would only ever know about the first.
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./tsconfig.json', './tsconfig.tooling.json'],
      },
    },
  },
]
