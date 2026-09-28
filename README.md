# openharness

An open-source implementation of the architecture described in Anthropic's
[Managed Agents](https://www.anthropic.com/engineering/managed-agents) engineering post. It has
three parts:

- a stateless **brain** — the harness loop;
- a durable, append-only **session** event log — the source of truth;
- pluggable **hands** — sandboxes and tools behind `execute(name, input)`.

**Status: early development.** The v1 epic ([#2](https://github.com/amirtuval/openharness/issues/2))
is building a simple chat server with a web UI and a terminal UI. It isn't usable end to end yet.
Each package's `AGENTS.md` says what it currently implements.

## Quick start

Requirements: **Node 24** (see `.nvmrc`) and corepack. Yarn 4 comes from the
`packageManager` field — no global install needed.

```bash
corepack enable
yarn install --immutable
yarn check:deps
yarn turbo run build typecheck lint format:check test
```

Run something:

```bash
yarn turbo run dev --filter=@openharness/server   # http://localhost:3000/health
yarn turbo run dev --filter=@openharness/web      # http://localhost:5173
node apps/tui/dist/index.js --version             # after `yarn build`
```

## Repository map

```
apps/
  server/    @openharness/server   Hono HTTP server (GET /health)
  web/       @openharness/web      Vite + React web app
  tui/       @openharness/cli      Ink terminal UI, installed as `oh`
packages/
  config/    @openharness/config   shared tsconfig / ESLint / Prettier / Vitest config
  protocol/  @openharness/protocol shared wire types and schemas
  session/   @openharness/session  the append-only session event log
  hands/     @openharness/hands    sandboxes and tools
  brain/     @openharness/brain    the stateless harness loop
  client/    @openharness/client   client used by the web app and the TUI
e2e/         @openharness/e2e      cross-package tests
docs/        architecture, development, workflow, decisions
```

Every package is self-contained: you can build, typecheck, lint, format-check and test it from
inside its own folder. Each folder has an `AGENTS.md` describing its purpose, commands, public
API and the packages it may depend on.

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — brain / session / hands, package map,
  allowed dependency graph.
- [`docs/development.md`](./docs/development.md) — tooling, root and per-package commands,
  how to work inside a single package.
- [`docs/workflow.md`](./docs/workflow.md) — issues, epics, PR policy, docs-before-merge.
- [`docs/decisions/`](./docs/decisions/README.md) — ADR convention (no ADRs yet).
- [`AGENTS.md`](./AGENTS.md) — repo-wide rules for implementation agents.

## License

MIT — see [`LICENSE`](./LICENSE).
