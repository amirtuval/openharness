# @openharness/config

Shared configuration for every openharness package: TypeScript `tsconfig` bases, an ESLint
flat config (node and react variants), a Prettier config and a Vitest base config.

This package is a **devDependency everywhere** and is consumed only through its package
exports — never through a `../../` relative path.

## Commands

Run from this folder (`packages/config`):

| command             | what it does                                           |
| ------------------- | ------------------------------------------------------ |
| `yarn build:deps`   | builds the workspace dependencies of this package      |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`) |
| `yarn typecheck`    | `tsc --noEmit`                                         |
| `yarn lint`         | ESLint over this folder                                |
| `yarn format`       | Prettier `--write`                                     |
| `yarn format:check` | Prettier `--check`                                     |
| `yarn test`         | Vitest, single run                                     |
| `yarn dev`          | tsdown in watch mode                                   |

## Public API

Package exports (see `package.json`):

| specifier                                 | what it is                                          |
| ----------------------------------------- | --------------------------------------------------- |
| `@openharness/config`                     | placeholder `PACKAGE_NAME` (built to `dist/`)       |
| `@openharness/config/tsconfig/base.json`  | strict ESM TypeScript base                          |
| `@openharness/config/tsconfig/node.json`  | base + `types: ["node"]`                            |
| `@openharness/config/tsconfig/react.json` | base + DOM libs + `jsx: react-jsx`                  |
| `@openharness/config/eslint`              | `baseConfig`, `nodeConfig`, `reactConfig` factories |
| `@openharness/config/prettier`            | default export: shared Prettier options             |
| `@openharness/config/vitest`              | `nodeVitestTestConfig`, `reactVitestTestConfig`     |

The config files (`tsconfig/`, `eslint/`, `prettier/`, `vitest/`) are shipped as source: they
are read by tools before anything is compiled, so they must not require a build. Only
`src/index.ts` is compiled to `dist/`.

## Allowed `@openharness/*` dependencies

None. `@openharness/config` is the root of the dependency graph.

## Testing

`src/**/*.test.ts` with Vitest, node environment. Config behaviour that matters is verified
by the packages that consume it (they run `tsc`, ESLint and Vitest with it).

## Rules

- Stay inside this folder; do not edit other packages.
- Update this file whenever the exported config surface changes.
- Keep the configs opinionated but minimal — packages may extend them locally.
- Larger docs go in `packages/config/docs/`.
