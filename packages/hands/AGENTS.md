# @openharness/hands

Placeholder for pluggable _hands_: the sandboxes and tools behind `execute(name, input)`. It
is **not implemented yet** — this package ships no tools, no sandbox and no `execute()`.
Today it exports only `PACKAGE_NAME` and a constant proving the `@openharness/protocol` edge
resolves; the real hands land in the v1 chat epic.

## Commands

Run from this folder (`packages/hands`):

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

| export                | what it is                                                             |
| --------------------- | ---------------------------------------------------------------------- |
| `PACKAGE_NAME`        | `'@openharness/hands'`                                                 |
| `PROTOCOL_DEPENDENCY` | `@openharness/protocol`'s `PACKAGE_NAME`; proves the built-output edge |

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

## Testing

`src/**/*.test.ts` with Vitest (node environment). The placeholder test imports the two
constants and asserts their values; what the protocol edge proves is that `src/index.ts`
resolves `@openharness/protocol` through its `exports` → `dist/`.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/hands/docs/`.
