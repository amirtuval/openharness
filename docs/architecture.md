# Architecture

openharness is an open-source implementation of the architecture described in Anthropic's
[Managed Agents](https://www.anthropic.com/engineering/managed-agents) engineering post. Three
ideas carry the design:

- **Brain** — a stateless harness loop. It holds no conversation state of its own; everything
  it needs is derived from the session it is given.
- **Session** — a durable, append-only event log. It is the source of truth: replaying it
  reconstructs the state of a run.
- **Hands** — the things that actually act on the world (sandboxes, tools) behind a single
  `execute(name, input)` shape, so they can be swapped without touching the brain.

Everything else — the HTTP server, the web app, the TUI, the client — is a way in or out of
that core. This document stays at that level; package details live in each package's
`AGENTS.md`, and specs live in GitHub issues.

## Status

The v1 epic ([#2](https://github.com/amirtuval/openharness/issues/2), "v1 chat") is in
progress: a chat server with a web UI and a TUI. The epic tracks which packages are done. Each
package's `AGENTS.md` describes what that package currently implements.

## Package map

| package                 | folder              | role                                                       |
| ----------------------- | ------------------- | ---------------------------------------------------------- |
| `@openharness/config`   | `packages/config`   | shared tooling config (tsconfig, ESLint, Prettier, Vitest) |
| `@openharness/protocol` | `packages/protocol` | wire types and schemas shared by everything                |
| `@openharness/session`  | `packages/session`  | the append-only session event log                          |
| `@openharness/hands`    | `packages/hands`    | sandboxes and tools behind `execute(name, input)`          |
| `@openharness/brain`    | `packages/brain`    | the stateless harness loop                                 |
| `@openharness/client`   | `packages/client`   | client for the server, used by the web app and the TUI     |
| `@openharness/server`   | `apps/server`       | Hono HTTP server (`GET /health` today)                     |
| `@openharness/web`      | `apps/web`          | Vite + React web app                                       |
| `@openharness/cli`      | `apps/tui`          | Ink + React terminal UI, installed as `oh`                 |
| `@openharness/e2e`      | `e2e`               | cross-package tests                                        |

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
