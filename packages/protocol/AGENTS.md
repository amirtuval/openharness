# @openharness/protocol

The shared protocol between brain, session, hands and the frontends: the wire types and schemas every package agrees on. Placeholder, implemented in the v1 epic.

## Commands

Run from this folder (`packages/protocol`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`)                  |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | watch mode                                                              |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

## Public API

| `@openharness/protocol` | `PACKAGE_NAME`, `PlaceholderSchema`, `Placeholder` |
| `@openharness/protocol/fixtures` | test fixtures for dependents (placeholder) |

## Allowed `@openharness/*` dependencies

None. This package must stay free of `@openharness/*` dependencies.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Testing

`src/**/*.test.ts` with Vitest (node environment). The placeholder test checks that the zod schema parses — it is the only thing proving the zod wiring works.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/protocol/docs/`.
