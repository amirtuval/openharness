# openharness — agent instructions

openharness is an open-source implementation of Anthropic's
[Managed Agents](https://www.anthropic.com/engineering/managed-agents) architecture: a
stateless **brain** (harness loop), a durable append-only **session** event log, and pluggable
**hands** (sandboxes/tools behind `execute(name, input)`).

The v1 epic ("v1 chat", issue #2) is in progress: a chat server with a web UI and a TUI. Each
package's `AGENTS.md` describes what that package implements today.

## How to work here

1. **Read the issue first.** All work is an issue (see [`docs/workflow.md`](./docs/workflow.md)).
   Sub-issue briefs are complete; you should not need context from outside them.
2. **Stay in your folder.** Each implementation agent is confined to one package folder. Do
   not edit another package — cross-package changes are a separate issue.
3. **Check your package's rules.** Every folder has an `AGENTS.md` listing its commands, public
   API and the `@openharness/*` packages it may depend on (also enforced by
   `yarn check:deps`).
4. **Consume packages through built output.** `exports` points at `dist/`, never at `src/`.
   Relative imports that leave a package are rejected by ESLint.
5. **Update the docs in the same change.** Root docs and the package's `AGENTS.md` before
   merge; larger package docs go in `<package>/docs/`.
6. **Verify before you finish.** At minimum: `yarn build:deps && yarn build && yarn typecheck
&& yarn lint && yarn format:check && yarn test` from inside your package, and
   `yarn check:deps` at the root.

## Commands

| command                                                            | where   | what it does                                     |
| ------------------------------------------------------------------ | ------- | ------------------------------------------------ |
| `yarn install --immutable`                                         | root    | install exactly what `yarn.lock` pins            |
| `yarn check:deps`                                                  | root    | enforce the allowed `@openharness/*` graph       |
| `yarn turbo run build typecheck lint format:check test`            | root    | the full CI run                                  |
| `yarn build:deps`                                                  | package | build just this package's workspace dependencies |
| `yarn build`                                                       | package | tsdown (or Vite for `apps/web`) → `dist/`        |
| `yarn typecheck` / `yarn lint` / `yarn format:check` / `yarn test` | package | the checks                                       |

Node 24 and Yarn 4 (corepack) are required; see [`docs/development.md`](./docs/development.md).

## Repo map

```
apps/      server (@openharness/server), web (@openharness/web), tui (@openharness/cli)
packages/  config, protocol, session, hands, brain, client
e2e/       @openharness/e2e — cross-package tests
docs/      architecture.md, development.md, workflow.md, decisions/
scripts/   check-deps.mjs
```

Dependency direction — `protocol` → `session`/`hands`/`client` → `brain` → `server`, with the
frontends (`web`, `cli`) on `protocol` + `client`. The full table is in
[`docs/architecture.md`](./docs/architecture.md).

## Rules

- Keep `docs/` high level. Package details belong in `<package>/AGENTS.md` or
  `<package>/docs/`; specs belong in issues.
- Never commit build output, and never add a dependency on another package's `src/`.
- `@openharness/config` is a devDependency everywhere, consumed through package exports.
- Prefer the smallest change that satisfies the issue; do not design APIs or schemas that the
  issue does not ask for.
