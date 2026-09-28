# Development

## Requirements

- **Node 24** (`.nvmrc`; the root `engines` field). tsdown needs Node >= 24.11.
- **Yarn 4** through corepack. Nothing else: no global installs.

```bash
corepack enable          # provides yarn from the "packageManager" field
yarn install --immutable # exact install from yarn.lock
```

## Repository layout

```
apps/      server, web, tui      (things you run)
packages/  config, protocol, session, hands, brain, client
e2e/       cross-package tests
docs/      high level docs, this file included
scripts/   repo scripts (check-deps.mjs)
```

Every package and app has its own `AGENTS.md` (with `CLAUDE.md` symlinked to it) describing its
purpose, commands, public API and allowed dependencies. **Read the one in the folder you are
working in before you start.**

## Root commands

Run from the repo root; they all delegate to turbo:

| command                  | what it does                                                |
| ------------------------ | ----------------------------------------------------------- |
| `yarn build`             | builds every package (turbo, in dependency order)           |
| `yarn typecheck`         | `tsc --noEmit` in every package                             |
| `yarn lint`              | ESLint in every package                                     |
| `yarn test`              | Vitest in every package                                     |
| `yarn format`            | Prettier `--write` over the whole repo                      |
| `yarn format:check`      | Prettier `--check`, per package via turbo                   |
| `yarn format:check:repo` | Prettier `--check` over the whole repo (includes root docs) |
| `yarn dev`               | watch mode for every package that has a `dev` script        |
| `yarn check:deps`        | enforces the `@openharness/*` dependency table              |

`typecheck`, `lint` and `test` depend on `^build`: turbo builds a package's dependencies
before type-checking, linting or testing it, so imports of `@openharness/*` always resolve.

## Working inside one package

Every package folder is self-contained — an agent confined to one folder can do all of this
without touching anything else:

```bash
cd packages/brain
yarn build:deps     # builds only this package's workspace dependencies (turbo filter "pkg^...")
yarn build          # tsdown -> dist/ (.js + .d.ts)
yarn typecheck      # tsc --noEmit
yarn lint           # eslint .
yarn format:check   # prettier --check .
yarn test           # vitest run
yarn dev            # watch mode, where the package has one
```

`yarn build:deps` is the piece that makes isolation work: it uses the root's installed
`node_modules` and turbo to build exactly the packages this one depends on.

Per-package configuration lives in the folder itself (`tsconfig.json`, `eslint.config.js`,
`vitest.config.ts`, `prettier.config.js`, `tsdown.config.ts`). They are all thin wrappers
around `@openharness/config`, which is consumed through package exports — never through
relative paths.

## Tooling

| tool       | why                                                                    |
| ---------- | ---------------------------------------------------------------------- |
| Yarn 4     | workspaces, `nodeLinker: node-modules` (no PnP) so folders stay normal |
| turbo      | task orchestration, `^build` ordering, local caching                   |
| tsdown     | builds every library/app package to `dist/` with `.d.ts`               |
| vite       | dev server + build for the web app                                     |
| TypeScript | strict, ESM only, `moduleResolution: Bundler`                          |
| Vitest     | tests (node for libraries, jsdom for the web app)                      |
| ESLint     | flat config, typescript-eslint type-aware, + Prettier                  |

Notes:

- Vitest 5 declares `vite` as a required peer, so every package that runs tests has `vite` as
  a devDependency.
- The root `format:check` only checks package folders; use `format:check:repo` for root files
  (`README.md`, `docs/`, `turbo.json`, ...).

## CI

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`: Node 24, corepack,
`yarn install --immutable`, `yarn check:deps`, then
`yarn turbo run build typecheck lint format:check test`. Turbo's local cache is restored
between runs; there is no remote cache.
