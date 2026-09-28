# @openharness/client

Client for talking to an openharness server: used by both the web app and the TUI. Placeholder, implemented in the v1 epic.

## Commands

Run from this folder (`packages/client`):

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

| `@openharness/client` | `PACKAGE_NAME`, `PROTOCOL_DEPENDENCY` |
| `@openharness/client/testing` | fake client helpers for dependents (placeholder) |

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Testing

`src/**/*.test.ts` with Vitest (node environment). The placeholder test re-exports a constant from `@openharness/protocol`, which proves the dist-based protocol edge.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/client/docs/`.
