# Roadmap

What comes after v1, in the order we plan to do it, with what is already decided and what is
still open. Specs and work items go into GitHub issues once a phase starts; this page holds the
plan between phases.

For a survey of what other harnesses offer (Claude Code, Managed Agents, OpenCode, Codex, pi),
see the [harness feature inventory](./research/harness-features.md).

_Last updated: 2026-10-01._

## Where we are

- **v1 chat** ([epic #2](https://github.com/amirtuval/openharness/issues/2)) is built. QA passes
  on the mock model and on a real provider (OpenAI) are done and all of their bugs are fixed. The
  epic is waiting for the maintainer to test it by hand and approve it.
- **The immutable event log** ([#46](https://github.com/amirtuval/openharness/issues/46), decision
  D9 on the epic) is in progress. The protocol, session and client phases are merged. Next are
  the brain and server switch-over, then the cleanup phase. After it:
  - no stored event is ever modified;
  - claims are events;
  - streamed chunks are stored and later superseded and compacted.
- **Flaky server tests** ([#43](https://github.com/amirtuval/openharness/issues/43)) are open.

## Order

1. Finish v1: the maintainer's manual test and approval, and the rest of #46.
2. Authentication
3. Deployment and CI/CD
4. Model selection and provider keys
5. Tools

**Why this order:** identity and a running deployment are the foundations. Every later feature
needs to know who owns what. The features that cost money or can act on the world (paid model
calls, tools) should land on a platform that already has users, environments and a trustworthy
CI.

## 2. Authentication

Today the server has one optional static API key (`x-api-key`).

**Scope:**

- users, and login for the web app;
- personal API keys for the SDK and scripts;
- `oh login` for the CLI, likely an OAuth device flow, as `gh auth login` does;
- ownership of agents and sessions, checked on every route and every SSE stream.

**Decided:**

- A `user.message` records **who sent it**, since several people may share a session.

**Open:**

- **Tenancy model.** One of:
  - (a) self-hosted, one team per deployment;
  - (b) multi-tenant, with organizations, workspaces and roles;
  - (c) one team now, with an `org_id` in the data model so that organizations can be added later.

  Managed Agents scopes product configuration at the agent level and end users at the session
  level, which maps well onto our resources.

- **Login method:** our own OAuth/OIDC (which providers?), or a hosted provider (Clerk, Auth0,
  Keycloak, …).

## 3. Deployment and CI/CD

Today there is CI (lint, typecheck and tests with turbo `--affected`) and `docker compose`.

**Scope:**

- build and publish images (e.g. to GHCR) on merge, and versioned releases;
- environments: staging deployed from `main`, production on release, and possibly a preview per
  PR;
- migrations that are safe when several instances deploy at once (today the server migrates on
  boot);
- run the e2e and QA suites (`e2e/qa`) against staging;
- health checks, logs, metrics and alerts at a basic level, and OpenTelemetry built from the
  spans already in the log;
- **fix the flaky tests (#43) as part of this phase.** A flaky CI cannot gate deploys. The
  partition-lease test must be confirmed as timing-only, because it covers multi-instance
  safety.

**Open:**

- **Deployment target:** a simple platform (Fly.io, Render, Railway), Kubernetes with Helm, or a
  VM with Compose.
- **Postgres:** a managed service (Neon, RDS, Supabase) or self-run.

## 4. Model selection and provider keys

**Scope:**

- provider API keys **per user or organization**, stored encrypted and **write-only** (set,
  never read back). This is the start of the secret store that MCP and tools will need;
- a **model catalog**: the models each configured provider offers, with their context windows;
- choosing the model per agent, per session, and **switching mid-session**;
- usage and cost per user or organization, from the token counts the spans already store, and
  possibly budgets that stop a session at a limit, with usage events so clients can show
  spending live (as Managed Agents' `session.usage` does).

**Decided:**

- **The context budget comes from the model and is chosen per model request,** not per
  session, so a mid-session model switch trims correctly on the next request. Each request
  records its model on `span.model_request_start` (#46). The fixed 32,768-token default becomes
  the fallback for unknown models.

## 5. Tools

The third pillar of the architecture (the "hands"), built in steps that are each useful on their
own.

1. **The tool loop, with server-side tools that need no sandbox.** The brain loops
   `agent.tool_use` → execute → `agent.tool_result` → model until no tool is called. `hands`
   gets its first real implementation, `execute(name, input, ctx)`, run in-process. Tools:
   - `web_fetch`, with SSRF protection: block private and link-local ranges and metadata
     endpoints, re-check on redirects, and limit size and time;
   - `todo`, whose state is computed from the log (the latest result), with no mutable table;
   - possibly `web_search` (it needs a search provider).
2. **Remote MCP servers** (Streamable HTTP) as `agent.mcp_tool_use`:
   - MCP servers are configured on the agent;
   - each request records the tools it offered;
   - credentials go in the write-only secret store from phase 4, never in the agent config
     returned by the API.
3. **Pausing for the user** (`session.status_idle {stop_reason: requires_action}`), which
   covers two features with one mechanism:
   - client-run tools (`agent.custom_tool_use` → `user.custom_tool_result`);
   - approvals: a per-tool policy of allow, ask or deny, and `user.tool_confirmation`, with UI in
     the web app and `oh`.
4. **Sandboxed tools** (`bash`, files) behind the same `hands` interface. The sandbox
   technology, and whether hands run in-process or as a separate worker, are decided then.

**Open:**

- **Crash rule for tool calls.** The proposal: never re-run a tool automatically after a crash.
  Store `agent.tool_result {is_error: true, "execution lost"}` and let the model decide. Tools
  that declare themselves idempotent could opt in to a re-run later.
- Whether `web_search` is in step 1, and with which provider.

## Later: not ordered yet

- **Context compaction:** summarizing old history for the model. This is separate from #46's
  event-store compaction.
- **Agent versioning:** sessions pin a version, and the log records which configuration served
  each request.
- **Steering vs follow-up messages.** Like pi, a follow-up message waits until the turn ends; we
  already have steering. `queue_update` events would keep every client's view of the queue in
  sync.
- **Outcomes** (`user.define_outcome`, as in Managed Agents): work until a rubric is satisfied.
- **Integrations:**
  - an AG-UI endpoint (an adapter like the existing AI SDK one);
  - ACP for IDE clients;
  - an OpenAPI spec at `/openapi.json`;
  - outgoing webhooks;
  - SDKs in more languages.
- **Session features:** rename, archive or delete, fork or branch (#46 does not assume a linear
  log), export and share.
- **Extensibility:** slash commands, skills, custom agents, hooks, plugins.
- **Multiple agents:** subagents, background and parallel agents.
- **Smaller follow-ups:**
  - merge streamed deltas (e.g. every ~50 ms) to cut writes, when performance matters;
  - a tab watching a session started in another tab may not show the new title until reload;
  - the web app's model suggestions lean towards Anthropic models.
