# Development

## Requirements

- **Node 24** (`.nvmrc`; the root `engines` field). tsdown needs Node >= 24.11.
- **Yarn 4** through corepack. Nothing else: no global installs.

```bash
corepack enable          # provides yarn from the "packageManager" field
yarn install --immutable # exact install from yarn.lock
```

## Configuration

The server reads its environment in one place (`apps/server/src/config.ts`), and
[`.env.example`](../.env.example) is the reference: every server variable with its default
and purpose — the three required ones (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`OPENHARNESS_SECRETS_KEY`), the OAuth providers, the dev login, CORS, compaction and the
multi-instance scheduler. `BETTER_AUTH_SECRET` and `OPENHARNESS_SECRETS_KEY` want
`openssl rand -base64 32`; a variable that is set but empty counts as unset. For a local run
with the dev login, see [the README](../README.md#running-it-from-source).

## Repository layout

`apps/` (server, web, tui) and `packages/` (config, protocol, vault, session, hands, brain,
client) hold the packages — the map, and the dependency rules between them, are in
[`architecture.md`](./architecture.md) — with `e2e/` for the cross-package tests and
`scripts/` for the repo scripts.

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

### Tests that want a real database

Some suites test against Postgres rather than a fake: `packages/session`'s store tests,
`apps/server`'s Postgres suites (the partition scheduler, SSE replay, revocation), and all of
[`e2e/`](../e2e/AGENTS.md), which runs the built server in its own process. Point them at a
database with `DATABASE_URL`:

```bash
docker run --rm -d --name oh-postgres -p 5432:5432 \
  -e POSTGRES_USER=openharness -e POSTGRES_PASSWORD=openharness -e POSTGRES_DB=openharness \
  postgres:18-alpine

DATABASE_URL=postgres://openharness:openharness@localhost:5432/openharness yarn test
```

Without it those suites start their own container with testcontainers — and skip, with a note,
when there is no Docker either. The e2e suite fails and says what it needs: it is the proof
that the pieces work together, and passing without having run is the worst thing it could do.

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
`yarn install --immutable`, `yarn check:deps`, `yarn format:check:repo`, then
`yarn turbo run build typecheck lint format:check test` against a Postgres service. Pull
requests run turbo with `--affected` (the packages a change touches, and their dependents);
pushes to `main` run everything. Turbo's local cache is restored between runs; there is no
remote cache.

A second job, `provider-smoke`, runs **only** `e2e/src/provider-smoke.test.ts` with the
repository's low-limit `OPENAI_API_KEY` and `OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1`. Saving a
provider key is a real provider call, so no other automatic run exercises the route's success
path ([#120](https://github.com/amirtuval/openharness/issues/120)); the guard makes a missing
key a failure rather than a skip, so the job cannot pass without the test having run. It runs
on pushes to `main`, on the nightly and manual fresh runs, and on pull requests from this
repository — a fork PR receives no repository secrets, so the job is skipped there. The key is
that job's alone and is never printed.
