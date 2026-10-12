# Architecture

openharness is an open-source implementation of the architecture described in Anthropic's
[Managed Agents](https://www.anthropic.com/engineering/managed-agents) engineering post. Three
ideas carry the design:

- **Brain** — a stateless harness loop. It holds no conversation state of its own; everything
  it needs is derived from the session it is given.
- **Session** — a durable, append-only event log. It is the source of truth: replaying it
  reconstructs the state of a run. The protocol is that log's schema, and a writer checks an
  event against it before appending: one row in a shape no reader accepts makes the whole
  session unreadable, so a turn that cannot write a valid event ends with an error instead
  (see [`packages/brain/AGENTS.md`](../packages/brain/AGENTS.md)). The log is immutable: a
  stored event is never modified — the types are deep-readonly, so writing to one is a
  compile error — and the only deletion is compacting what a later event superseded: the
  streamed chunks a finished reply replaced (D9, [#46](https://github.com/amirtuval/openharness/issues/46)),
  and the tail of the log an edit rewound ([#238](https://github.com/amirtuval/openharness/issues/238)). Every agent and
  session belongs to exactly one user (epic [#65](https://github.com/amirtuval/openharness/issues/65),
  A4): it carries the owner's id, the reads a user-facing route makes are scoped to it, and
  another user's resource is answered 404, never 403. `@openharness/session` also owns the SQL
  everything else sits on: Better Auth's own tables (A1) and the sealed
  `provider_credentials` users' model keys live in (A5).

  What a model request answers is a fact in the log, not state beside it: the events that
  claim user input — a `span.model_request_start` claims the messages its request folds in,
  the `span.model_request_end` and `session.status_idle` that end a request or a turn claim
  the interrupts they answer — carry a `consumes` list, and a user event's `processed_at` is
  derived from the claim that took it. A streamed reply is stored as it streams, chunk by
  chunk, so a reply in flight is as resumable as anything else; the event that finishes it
  carries a `supersedes` range over those chunks, replay skips the range, and a compaction job
  deletes it after a retention window without changing what any reader sees. Edit and resend
  is the same machinery over a wider range: a `session.rewind` supersedes everything from the
  edited `user.message` on, and the edited text is appended after it as a new message.

- **Hands** — the things that actually act on the world (tools, and later sandboxes) behind a
  single `execute(name, input)` shape, so they can be swapped without touching the brain. What a
  tool may reach, and what the model is allowed to make of what came back, is
  [`docs/threat-model.md`](./threat-model.md).

Everything else — the HTTP server, the web app, the TUI, the client — is a way in or out of
that core. This document stays at that level; package details live in each package's
`AGENTS.md`, and specs live in GitHub issues.

## Status

The v1 epic ([#2](https://github.com/amirtuval/openharness/issues/2), "v1 chat") is closed: a
chat server with a web UI and a TUI. Authentication
([epic #65](https://github.com/amirtuval/openharness/issues/65)) is built — sign-in, ownership
and per-user provider keys — and so are the model catalog and model-first chat
([epic #92](https://github.com/amirtuval/openharness/issues/92)). What works end to end today:
agents and sessions, a chat turn whose streamed chunks are stored events, a turn whose model
calls a tool — the call, the execution and the result are all events — steering a turn in
flight, interrupting it,
automatic retries of a failed model request, and sessions that survive the process that was
running them — a turn a dead server left open is closed as `brain_lost` and run again by the
next one. Several servers can share one database (`SCHEDULER=postgres`): they split the session
space into leased partitions, and when one dies another takes its partitions over and finishes
its turns (see `apps/server/docs/scheduling.md`). [`docs/ROADMAP.md`](./ROADMAP.md) has the
phases and what comes next.

## How it runs

One process serves the whole thing. `@openharness/server` is a Hono app that answers the HTTP
API under `/v1`, streams a session's log over SSE, serves the built web app at `/`, and runs
the brains: a scheduler picks up the sessions that need work and runs a turn against each of
them. The store is Postgres when there is a `DATABASE_URL` (the server applies the migrations
on boot) and in memory when there is not — which is for a quick trial, and says so at startup.

```
  web app ─┐                                     ┌─ brain ──► hands
           ├─► @openharness/client ──► server ───┤
  oh ──────┘   (HTTP + SSE)          (API, SSE, └─ session (append-only log)
                                      scheduler)      │
                                                      ▼
                                                 Postgres
```

The clients — the web app and the TUI — talk to the server only through
`@openharness/client`, and every piece of chat state in both of them comes from the same
transcript reducer over the same events. That is why the end-to-end suite in
[`e2e/`](../e2e/AGENTS.md) can drive the real server with the real client and say something
about both frontends at once.

The deployment in `docker-compose.yml` is the same shape in two containers: Postgres, and this
server serving the web build it was built with (`OPENHARNESS_WEB_DIR`). One origin, one port,
no CORS to configure.

## Authentication and accounts

Sign-in is the server's, not the protocol's: [Better Auth](https://www.better-auth.com) runs
at `/api/auth/*` against the same Postgres as the log, with Google, GitHub or Microsoft as the
providers. A user is a **provider-verified email** — any of the three providers can sign in
the same person — and the web app carries a session cookie while `oh` carries a bearer token
from the device flow (`oh login`). The server refuses to boot without a way to sign in: at
least one OAuth provider, or the localhost-only dev login (`OPENHARNESS_DEV_LOGIN=1`).

Everything under `/v1` is scoped to the signed-in user. Agents and sessions carry an owner,
another user's resource is answered 404 rather than 403, and there is no static server API
key. Model-provider keys are each user's own: a key is validated on save, sealed with
envelope encryption from `@openharness/vault` under a master key that comes from
`OPENHARNESS_SECRETS_KEY` (`OPENHARNESS_KEY_PROVIDER=local`, the default) or from Cloud KMS
(`gcp-kms`, #150), and never returned.
[`docs/api.md`](./api.md#authentication) has the routes and rules;
[`apps/server/AGENTS.md`](../apps/server/AGENTS.md) has the implementation.

## Package map

| package                 | folder              | role                                                       |
| ----------------------- | ------------------- | ---------------------------------------------------------- |
| `@openharness/config`   | `packages/config`   | shared tooling config (tsconfig, ESLint, Prettier, Vitest) |
| `@openharness/protocol` | `packages/protocol` | wire types and schemas shared by everything                |
| `@openharness/vault`    | `packages/vault`    | envelope encryption for user secrets                       |
| `@openharness/session`  | `packages/session`  | the append-only session event log, its owners, and the SQL |
| `@openharness/hands`    | `packages/hands`    | sandboxes and tools behind `execute(name, input)`          |
| `@openharness/brain`    | `packages/brain`    | the stateless harness loop                                 |
| `@openharness/client`   | `packages/client`   | client for the server, used by the web app and the TUI     |
| `@openharness/server`   | `apps/server`       | Hono HTTP server: the chat API, SSE, the scheduler         |
| `@openharness/web`      | `apps/web`          | Vite + React chat UI (Tailwind + shadcn/ui)                |
| `@openh/cli`            | `apps/tui`          | Ink + React terminal UI, installed as `oh`                 |
| `@openharness/e2e`      | `e2e`               | cross-package tests: real servers, real Postgres           |

The TUI is the one workspace published to npm — as **`@openh/cli`**, its bundle self-contained
(#152; the name is scoped because npm refuses the unscoped `openharness`, #194) — which is why
its name is not `@openharness/cli`; the other workspaces are private to the repo.

`@openharness/hands` holds the tool registry behind `execute(name, input)` — a tool's name,
description, input schema, default permission and timeout, and one place to run it — and the
three built-in tools ([#304](https://github.com/amirtuval/openharness/issues/304),
[#305](https://github.com/amirtuval/openharness/issues/305)): `web_fetch`, which reads a URL the
model chose through `safeFetch` and answers it as Markdown; `web_search`, which a deployment
offers only where an operator configured a search API, behind an adapter and under a per-user
daily allowance; and `todo_write`, whose list is the newest call in the log and nothing else.
Every deployment gets the first and the third. The MCP client will live here too
([#312](https://github.com/amirtuval/openharness/issues/312)); the loop they run in is the
brain's, and what they may reach is [`docs/threat-model.md`](./threat-model.md).

## Allowed dependency graph

The rules cover `dependencies`, `devDependencies`, `peerDependencies` and
`optionalDependencies`. `@openharness/config` is allowed everywhere as a **devDependency**.

| package                 | may depend on                          |
| ----------------------- | -------------------------------------- |
| `@openharness/protocol` | (none)                                 |
| `@openharness/vault`    | (none)                                 |
| `@openharness/hands`    | protocol                               |
| `@openharness/session`  | protocol                               |
| `@openharness/client`   | protocol                               |
| `@openharness/brain`    | protocol, session, hands               |
| `@openharness/server`   | protocol, session, brain, hands, vault |
| `@openharness/web`      | protocol, client                       |
| `@openh/cli` (the CLI)  | protocol, client                       |
| `@openharness/e2e`      | anything                               |

`yarn check:deps` enforces this table and fails with the offending package, the dependency and
the allowed list. ESLint (`import-x/no-relative-packages`, configured in
`@openharness/config/eslint`) blocks the other way to cheat the graph: importing another
package through a relative path.

## Why the graph is a table and not a diagram

Each package is owned by one implementation agent confined to one folder. A dependency it may
not have is a folder it may not open. Keeping the table explicit means an agent can tell, from
its own `AGENTS.md` alone, what it is allowed to import — and `yarn check:deps` can tell the
maintainer the same thing without reading any code.

## Consuming a package

Packages consume each other **only through built output**: the `exports` map points at
`dist/` (`dist/index.js` + `dist/index.d.ts`), never at `src/`. Importing
`@openharness/protocol` in `@openharness/brain` therefore requires protocol to be built first;
turbo's `^build` dependency (and the per-package `yarn build:deps`) takes care of that.

The `e2e` package follows the same rule in a different way: it does not import another
package's internals, it _runs_ them — the built server in its own process, reached through
`@openharness/server`'s exports.
