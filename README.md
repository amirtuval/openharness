# openharness

An open-source implementation of the architecture described in Anthropic's
[Managed Agents](https://www.anthropic.com/engineering/managed-agents) engineering post. Three
ideas carry it:

- a stateless **brain** — the harness loop;
- a durable, append-only **session** event log — the source of truth;
- pluggable **hands** — sandboxes and tools behind `execute(name, input)`.

```
        web app  ·  oh (terminal)          the ways in: @openharness/client, over HTTP and SSE
              │
              ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ @openharness/server                                              │
   │   /v1 API   ·   SSE stream   ·   scheduler   ·   the web build   │
   │        │                             │                           │
   │        ▼                             ▼                           │
   │   @openharness/brain ──────► @openharness/hands                  │
   │   the harness loop           execute(name, input)                │
   │        │                                                         │
   │        ▼                                                         │
   │   @openharness/session — the append-only event log                │
   └────────┬─────────────────────────────────────────────────────────┘
            ▼
       Postgres (or, for a quick trial, in memory)
```

The brain holds no state of its own: everything it needs is in the session, which is why a
turn can be resumed by a different process after the one that started it dies. See
[`docs/architecture.md`](./docs/architecture.md) for the package map and the dependency rules,
and [`docs/api.md`](./docs/api.md) for the HTTP API.

**Status: early development.** The v1 epic ([#2](https://github.com/amirtuval/openharness/issues/2))
is building a chat server with a web UI and a terminal UI. Working end to end today: agents and
sessions, streaming replies whose chunks are stored as they arrive, steering a running turn,
interrupting it, automatic retries, and sessions that survive a server restart. Each package's
`AGENTS.md` says what it currently implements.

## Quick start

Requirements: **Docker** and a model provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …).

```bash
cp .env.example .env      # put your provider key in it
docker compose up --build # then open http://localhost:3000
```

1. Open <http://localhost:3000>.
2. **Agents → New agent**: give it a name and pick a model. An agent is the configuration a
   session runs with — a model and, if you want one, a system prompt.
3. **New chat**: pick the agent and send a message. The reply streams in as it is written, and
   pressing Enter while it streams steers it instead of waiting for it to finish.

No provider key? Run the server with the deterministic test model instead — it echoes your
message back, so the whole app works with no key and no network:

```bash
OPENHARNESS_TEST_MODEL=mock docker compose up --build
```

`docker compose` starts two containers: `postgres` (a named volume, and the server waits for it
to be healthy) and `server`, which applies the database migrations on boot, serves the API
under `/v1` and serves the built web app at `/`. `.env.example` documents every variable the
compose file passes through (the API key, CORS, the concurrency limit, …).

## Running it from source

Requirements: **Node 24** (see `.nvmrc`), corepack, and a Postgres for anything durable. Yarn 4
comes from the `packageManager` field — no global install needed.

```bash
corepack enable
yarn install --immutable
yarn check:deps
yarn turbo run build typecheck lint format:check test
```

Then run something:

```bash
DATABASE_URL=postgres://localhost/openharness yarn turbo run dev --filter=@openharness/server
yarn turbo run dev --filter=@openharness/web      # http://localhost:5173, proxying /v1
```

Without `DATABASE_URL` the server runs on an in-memory store: fine for a quick trial, and
nothing survives a restart (it says so at startup).

### The terminal client, `oh`

```bash
yarn turbo run build --filter=@openharness/cli
node apps/tui/dist/index.js                       # oh, from the repo
oh                                                # the same thing, once installed
```

`oh` starts a new chat against `http://localhost:3000` (override with `--server`, or with
`OPENHARNESS_URL`, or in `~/.config/openharness/config.json`; same for `--api-key`).
`oh sessions` lists sessions, `oh -c` continues the most recent one, `oh -s <id>` resumes a
particular one. `apps/tui/AGENTS.md` documents the keys and the exit codes.

The web app and `oh` speak to the server through the same client
([`packages/client`](./packages/client/AGENTS.md)), so a behaviour one of them has, the other
has too.

## Repository map

```
apps/
  server/    @openharness/server   Hono HTTP API + SSE, the scheduler, and the web build
  web/       @openharness/web      Vite + React chat UI
  tui/       @openharness/cli      Ink terminal UI, installed as `oh`
packages/
  config/    @openharness/config   shared tsconfig / ESLint / Prettier / Vitest config
  protocol/  @openharness/protocol shared wire types and schemas
  vault/     @openharness/vault    envelope encryption for user secrets
  session/   @openharness/session  the append-only session event log
  hands/     @openharness/hands    sandboxes and tools
  brain/     @openharness/brain    the stateless harness loop
  client/    @openharness/client   client used by the web app and the TUI
e2e/         @openharness/e2e      cross-package tests: real servers, real Postgres
docker/      the image the compose file builds
docs/        architecture, api, development, workflow, decisions, roadmap
```

Every package is self-contained: you can build, typecheck, lint, format-check and test it from
inside its own folder. Each folder has an `AGENTS.md` describing its purpose, commands, public
API and the packages it may depend on.

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — brain / session / hands, the package map,
  the allowed dependency graph, and how the server runs it all.
- [`docs/api.md`](./docs/api.md) — the HTTP API at a glance: routes, events, streaming, auth.
- [`docs/development.md`](./docs/development.md) — tooling, root and per-package commands, how
  to work inside a single package.
- [`docs/workflow.md`](./docs/workflow.md) — issues, epics, PR policy, docs-before-merge.
- [`docs/decisions/`](./docs/decisions/README.md) — ADR convention (no ADRs yet).
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — what comes after v1, in order, with what is decided
  and what is still open; [`docs/research/`](./docs/research/harness-features.md) holds the harness
  feature survey behind it.
- [`AGENTS.md`](./AGENTS.md) — repo-wide rules for implementation agents.

## License

MIT — see [`LICENSE`](./LICENSE).
