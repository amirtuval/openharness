# openharness — agent instructions

openharness is an open-source implementation of Anthropic's
[Managed Agents](https://www.anthropic.com/engineering/managed-agents) architecture: a
stateless **brain**, a durable append-only **session** event log, and pluggable **hands**.
See [`docs/architecture.md`](./docs/architecture.md) for the package map and
[`docs/api.md`](./docs/api.md) for the HTTP API.

v1 (chat server, web UI, TUI), authentication (epic #65: sign-in, ownership, per-user provider
keys), model-first chat (epic #92), deployment (epic #148), Chat and TUI UX pass 1 (epic
#201), model selection (epic #245), context compaction (epic #277) and the tools phase's loop,
built-in tools, context management, per-user settings and pausing for the user (epic #303,
[#304](https://github.com/amirtuval/openharness/issues/304),
[#305](https://github.com/amirtuval/openharness/issues/305),
[#306](https://github.com/amirtuval/openharness/issues/306),
[#307](https://github.com/amirtuval/openharness/issues/307) and
[#309](https://github.com/amirtuval/openharness/issues/309)) are built; the rest of that phase —
MCP — is next
([`docs/ROADMAP.md`](./docs/ROADMAP.md)), and what a tool may reach is
[`docs/threat-model.md`](./docs/threat-model.md). Each package's `AGENTS.md` describes what that
package implements today.

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

## Learnings

[`docs/LEARNINGS.md`](./docs/LEARNINGS.md) is the living record of what building openharness
taught us that the code does not say out loud: provider quirks, configuration traps, dead ends,
and decisions whose reason is not visible in the source. [`AGENTS.md`](./AGENTS.md) says what the
code does; this file says what surprised us and why things are the way they are. It is written
for people building an agent harness, a chat-with-tools product, an MCP client, a multi-provider
LLM app or a deployment like this one, and for contributors and agents on this repo — read it
before you re-derive something.

**Every agent, when it finishes an issue, adds any non-obvious learning to
`docs/LEARNINGS.md` in the same PR** — in the right section, in that file's format: a bold
one-line lesson, then two to six sentences of what happened or what is true, why it matters, and
what was done, with issue/PR references and file paths. A learning is a surprise, a provider
quirk, a dead end, or a decision whose reason is not visible in the code. Update or delete
entries the change makes wrong. Do **not** add what the code or `AGENTS.md` already make obvious
— the value of the file is exactly what you could not have read off the source.

## Commands

Node 24 and Yarn 4 (corepack) are required. From the root: `yarn install --immutable`,
`yarn check:deps` (the allowed `@openharness/*` graph), and
`yarn turbo run build typecheck lint format:check test` (the full CI run). Inside a package:
`yarn build:deps` builds its workspace dependencies first, then `yarn build`, `yarn typecheck`,
`yarn lint`, `yarn format:check`, `yarn test`. The full reference — every root command and
what each one does — is in [`docs/development.md`](./docs/development.md).

## Repo map

`apps/` (server, web, tui) and `packages/` (config, protocol, vault, session, hands, brain,
client) hold the packages; `e2e/` the cross-package tests. Dependency direction —
`protocol` → `session`/`hands`/`client` → `brain` → `server`, with the frontends (`web`,
`cli`) on `protocol` + `client`; `vault` depends on nothing, and `server` may depend on it.
The full package map and the allowed-dependency table are in
[`docs/architecture.md`](./docs/architecture.md).

## Rules

- Keep `docs/` high level. Package details belong in `<package>/AGENTS.md` or
  `<package>/docs/`; specs belong in issues.
- Never commit build output, and never add a dependency on another package's `src/`.
- `@openharness/config` is a devDependency everywhere, consumed through package exports.
- Prefer the smallest change that satisfies the issue; do not design APIs or schemas that the
  issue does not ask for.
