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

**Status: v1 is built.** The v1 epic
([#2](https://github.com/amirtuval/openharness/issues/2)) is closed: a chat server with a web
UI and a terminal UI. Authentication
([epic #65](https://github.com/amirtuval/openharness/issues/65)) is built — sign-in with
Google, GitHub or Microsoft, per-user ownership, and each user's own encrypted provider keys
— and so are the model catalog and model-first chat
([epic #92](https://github.com/amirtuval/openharness/issues/92)): a new chat picks a model and
needs no agent. Each package's `AGENTS.md` says what it currently implements;
[`docs/ROADMAP.md`](./docs/ROADMAP.md) has what comes next.

## Quick start

Requirements: **Docker** — nothing else. The stack starts with the development login on, so
the first run needs no OAuth app and no provider key: **a way to sign in is required**, and
either one provider or the dev login provides it — the server refuses to boot without one.

```bash
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"       >> .env
echo "OPENHARNESS_SECRETS_KEY=$(openssl rand -base64 32)"  >> .env
docker compose up --build   # then open http://localhost:3000
```

The two secrets are required — the server refuses to boot without them — and are the only
setup. `BETTER_AUTH_SECRET` signs sessions; `OPENHARNESS_SECRETS_KEY` is the master key your
provider credentials are sealed with, so keep it: a lost key means the stored credentials
cannot be read again.

1. Open <http://localhost:3000> and **sign in as the dev user**: `dev@localhost` / `dev`.
   (That login exists only while `OPENHARNESS_DEV_LOGIN=1` and the public URL is localhost —
   the server refuses to start otherwise. It is for local use, e2e and QA.)
2. **Settings → Model providers**: add a key for the provider you want to use (OpenAI,
   Anthropic, Google AI Studio, OpenRouter, Groq, DeepSeek, Fireworks). It is validated with
   one call to the provider, sealed with `OPENHARNESS_SECRETS_KEY`, and never shown again —
   only its last four characters are. **Each user brings their own key**; the server reads no
   provider keys from the environment, not even as a fallback.
3. **New chat**: pick a model — the list is read live from the providers your keys are for,
   with context windows — and send a message. The reply streams in as it is written, and
   pressing Enter while it streams steers it instead of waiting for it to finish.

Agents still exist in the API as optional presets — a name, a model and a system prompt a
session can be created from — but the UI hides them for now
([#96](https://github.com/amirtuval/openharness/issues/96)).

To sign in with Google, GitHub or Microsoft instead, create an OAuth app for the provider,
register `<BETTER_AUTH_URL>/api/auth/callback/<provider>` as its redirect URI, and set the two
`<PROVIDER>_CLIENT_ID`/`_SECRET` variables from `.env.example`. Each provider appears on the
sign-in screen as soon as its credentials are set. At least one provider is required unless
the dev login is on; a provider is enabled only when both its client id and secret are set
(set both empty to hide its button).

No provider key yet? Run the server with the deterministic test model — it echoes your message
back, so the whole app works with no key and no network:

```bash
OPENHARNESS_TEST_MODEL=mock docker compose up --build
```

`docker compose` starts two containers: `postgres` (a named volume, and the server waits for it
to be healthy) and `server`, which applies the database migrations on boot, serves the API
under `/v1`, all of Better Auth at `/api/auth/*`, and serves the built web app at `/`.
`.env.example` documents the server's whole environment — the secrets, the providers, CORS,
the concurrency limit and the scheduler — including the variables this compose file does not
pass through.

## Running it from source

Requirements: **Node 24** (see `.nvmrc`), corepack, and a Postgres for anything durable. Yarn 4
comes from the `packageManager` field — no global install needed.

```bash
corepack enable
yarn install --immutable
yarn check:deps
yarn turbo run build typecheck lint format:check test
```

Then run something. The server refuses to boot without the three required variables and a way
to sign in, so a local run carries them — the dev login is the localhost-only way in:

```bash
BETTER_AUTH_SECRET=$(openssl rand -base64 32) \
OPENHARNESS_SECRETS_KEY=$(openssl rand -base64 32) \
BETTER_AUTH_URL=http://localhost:3000 \
OPENHARNESS_DEV_LOGIN=1 \
DATABASE_URL=postgres://localhost/openharness \
yarn turbo run dev --filter=@openharness/server   # http://localhost:3000
yarn turbo run dev --filter=@openharness/web      # http://localhost:5173, proxying /v1
```

Sign in with `dev@localhost` / `dev`, then add a provider key under **Settings → Model
providers**. Without `DATABASE_URL` the server runs on an in-memory store — fine for a quick
trial, nothing survives a restart (it says so at startup).

### The terminal client, `oh`

```bash
npm i -g openharness                              # the published CLI, as the `oh` command
oh login && oh                                    # once installed

yarn turbo run build --filter=openharness         # from a checkout of this repo
node apps/tui/dist/index.js                       # the same `oh`, built locally
```

The npm package is **`openharness`** and the command stays **`oh`** (#152). It is one
self-contained bundle — Ink, React and the client inlined, nothing resolved from
`node_modules` at runtime — so `npm install -g openharness@next` can replace it on disk while
a running `oh` keeps working.

`oh` signs in with `oh login`: the device flow prints a URL and a code, opens the browser at
it (skipped with `--no-browser`, in CI, over SSH, or when there is no display), and stores
the session token per server in `~/.config/openharness/credentials.json`, mode `0600`.
`oh whoami` prints the signed-in email and server, and `oh logout` revokes the token on the
server and forgets it locally. Every other command sends the stored token as
`Authorization: Bearer`.

`oh` starts a new chat against `http://localhost:3000` (override with `--server`, with
`OPENHARNESS_URL`, or in `~/.config/openharness/config.json`). A new chat opens **your
default model** immediately, with no picker: `oh default-model` prints it, `oh
default-model provider/model` sets it (`--model` overrides it for one run). Without a
default, `oh` asks once — from the models **your own provider keys** can use, grouped by
provider, with context windows, and an "Other model id…" entry for anything the catalog does
not know yet — and offers to save the answer as the default. Add a key in the web app under
**Settings → Model providers**; with none, `oh` says so and stops. `--agent` still starts
from a saved agent preset (`oh agents` lists them).

Inside a chat, `/model` opens the same picker: the choice rides the next message, and the
status line shows the model the session runs. `oh sessions` lists sessions, `oh sessions
delete <id>` deletes one (it asks first; `--yes` skips the question), `oh -c` continues the
most recent one, and `oh -s <id>` resumes a particular one — a chat deleted elsewhere says
so and exits. `apps/tui/AGENTS.md` documents the keys and the exit codes.

The web app and `oh` speak to the server through the same client
([`packages/client`](./packages/client/AGENTS.md)), so a behaviour one of them has, the other
has too.

## Repository map

```
apps/      server, web, tui — the HTTP API + scheduler, the React chat UI, the Ink terminal UI (`oh`)
packages/  config, protocol, vault, session, hands, brain, client — the libraries they run on
e2e/       cross-package tests: real servers, real Postgres
docker/    the image the compose file builds
docs/      architecture, api, development, workflow, decisions, roadmap
```

Every package is self-contained: you can build, typecheck, lint, format-check and test it from
inside its own folder. Each folder has an `AGENTS.md` describing its purpose, commands, public
API and the packages it may depend on; [`docs/architecture.md`](./docs/architecture.md) has
the package map and the allowed dependency graph.

## Documentation

- [`docs/architecture.md`](./docs/architecture.md) — brain / session / hands, the package map,
  the allowed dependency graph, and how the server runs it all.
- [`docs/api.md`](./docs/api.md) — the HTTP API at a glance: routes, events, streaming, auth.
- [`docs/development.md`](./docs/development.md) — tooling, root and per-package commands, how
  to work inside a single package.
- [`docs/workflow.md`](./docs/workflow.md) — issues, epics, PR policy, docs-before-merge.
- [`.env.example`](./.env.example) — every server environment variable, with its default:
  the required secrets, the OAuth providers, the dev login, compaction and the scheduler.
- [`docs/decisions/`](./docs/decisions/README.md) — ADR convention (no ADRs yet).
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — what comes after v1, in order, with what is decided
  and what is still open; [`docs/research/`](./docs/research/harness-features.md) holds the harness
  feature survey behind it.
- [`AGENTS.md`](./AGENTS.md) — repo-wide rules for implementation agents.

## License

MIT — see [`LICENSE`](./LICENSE).
