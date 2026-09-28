# @openharness/web

The openharness web app: Vite + React + TypeScript. It renders a placeholder page; the chat UI lands in the v1 epic.

## Commands

Run from this folder (`apps/web`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds the static site into `dist/` with Vite                           |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | Vite dev server on http://localhost:5173                                |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

## Public API

| `@openharness/web` | not imported by other packages; `yarn build` emits a static site in `dist/` (Vite), `yarn dev` serves it on http://localhost:5173. |

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/client`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Testing

`src/**/*.test.tsx` with Vitest (jsdom environment) + Testing Library: components are queried by role, and `vitest.setup.ts` registers `@testing-library/jest-dom` matchers.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/web/docs/`.
