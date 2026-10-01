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
  stored event is never modified — a claim on a user message is a record of its own, not a
  write to the event — and the only deletion is compacting the streamed chunks a finished
  reply superseded (D9, [#46](https://github.com/amirtuval/openharness/issues/46)).
- **Hands** — the things that actually act on the world (sandboxes, tools) behind a single
  `execute(name, input)` shape, so they can be swapped without touching the brain.

Everything else — the HTTP server, the web app, the TUI, the client — is a way in or out of
that core. This document stays at that level; package details live in each package's
`AGENTS.md`, and specs live in GitHub issues.

## Status

The v1 epic ([#2](https://github.com/amirtuval/openharness/issues/2), "v1 chat") is in
progress: a chat server with a web UI and a TUI. What works end to end today: agents and
sessions, a chat turn with streamed previews, steering a turn in flight, interrupting it,
automatic retries of a failed model request, and sessions that survive the process that was
running them — a turn a dead server left open is closed as `brain_lost` and run again by the
next one. Several servers can share one database (`SCHEDULER=postgres`): they split the session
space into leased partitions, and when one dies another takes its partitions over and finishes
its turns (see `apps/server/docs/scheduling.md`).

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

## Package map

| package                 | folder              | role                                                       |
| ----------------------- | ------------------- | ---------------------------------------------------------- |
| `@openharness/config`   | `packages/config`   | shared tooling config (tsconfig, ESLint, Prettier, Vitest) |
| `@openharness/protocol` | `packages/protocol` | wire types and schemas shared by everything                |
| `@openharness/session`  | `packages/session`  | the append-only session event log                          |
| `@openharness/hands`    | `packages/hands`    | sandboxes and tools behind `execute(name, input)`          |
| `@openharness/brain`    | `packages/brain`    | the stateless harness loop                                 |
| `@openharness/client`   | `packages/client`   | client for the server, used by the web app and the TUI     |
| `@openharness/server`   | `apps/server`       | Hono HTTP server: the chat API, SSE, the scheduler         |
| `@openharness/web`      | `apps/web`          | Vite + React chat UI (Tailwind + shadcn/ui)                |
| `@openharness/cli`      | `apps/tui`          | Ink + React terminal UI, installed as `oh`                 |
| `@openharness/e2e`      | `e2e`               | cross-package tests: real servers, real Postgres           |

## Allowed dependency graph

The rules cover `dependencies`, `devDependencies` and `peerDependencies`.
`@openharness/config` is allowed everywhere as a **devDependency**.

| package                 | may depend on                   |
| ----------------------- | ------------------------------- |
| `@openharness/protocol` | (none)                          |
| `@openharness/hands`    | protocol                        |
| `@openharness/session`  | protocol                        |
| `@openharness/client`   | protocol                        |
| `@openharness/brain`    | protocol, session, hands        |
| `@openharness/server`   | protocol, session, brain, hands |
| `@openharness/web`      | protocol, client                |
| `@openharness/cli`      | protocol, client                |
| `@openharness/e2e`      | anything                        |

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
