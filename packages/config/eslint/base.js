import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import importX from 'eslint-plugin-import-x'
import tseslint from 'typescript-eslint'

/** Files that are linted with type information. */
const typeScriptFiles = ['**/*.ts', '**/*.tsx']

const sharedRules = {
  // Packages reach each other through their built output (`exports` + `dist/`), never
  // through a relative path that leaves the package folder. See docs/architecture.md.
  'import-x/no-relative-packages': 'error',
  'import-x/no-duplicates': 'error',
  '@typescript-eslint/consistent-type-imports': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
}

/**
 * Base flat config shared by every package.
 *
 * @param {object} [options]
 * @param {string} [options.tsconfigRootDir] Absolute path of the package folder; used to
 *   locate the package's `tsconfig.json` for type-aware linting.
 * @param {Record<string, boolean | undefined>} [options.globals] Globals for plain JS files.
 * @param {string[]} [options.ignores] Extra ignore patterns.
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function baseConfig({ tsconfigRootDir, globals, ignores = [] } = {}) {
  return tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.turbo/**', ...ignores] },
    js.configs.recommended,
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      languageOptions: { globals: globals ?? {}, sourceType: 'module' },
    },
    {
      // The built-in node resolver without TypeScript extensions cannot resolve
      // `../../other-package/src/index`, which would let that escape `no-relative-packages`.
      settings: {
        'import-x/resolver': {
          node: { extensions: ['.ts', '.tsx', '.mjs', '.js', '.cjs', '.jsx', '.json'] },
        },
      },
    },
    ...tseslint.configs.recommendedTypeChecked.map((config) =>
      config.files ? config : { ...config, files: typeScriptFiles },
    ),
    {
      files: typeScriptFiles,
      languageOptions: {
        parserOptions: {
          projectService: true,
          ...(tsconfigRootDir === undefined ? {} : { tsconfigRootDir }),
        },
      },
      plugins: { 'import-x': importX },
      rules: sharedRules,
    },
    prettier,
  )
}
