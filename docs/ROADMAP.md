# Roadmap

What comes after v1, in the order we plan to do it, with what is already decided and what is
still open. Specs and work items go into GitHub issues once a phase starts; this page holds the
plan between phases.

For a survey of what other harnesses offer (Claude Code, Managed Agents, OpenCode, Codex, pi),
see the [harness feature inventory](./research/harness-features.md).

_Last updated: 2026-10-07._

## Where we are

- **v1 chat** ([epic #2](https://github.com/amirtuval/openharness/issues/2)) is closed: built,
  QA'd on the mock model and on a real provider (OpenAI), all of their bugs fixed, and the
  maintainer's hands-on test done.
- **The immutable event log** ([#46](https://github.com/amirtuval/openharness/issues/46), decision
  D9 on the epic) is done (PRs #47, #49, #50, #52 and #54):
  - no stored event is ever modified, and the event types are deep-readonly;
  - claims are events (`consumes` on the event that claims);
  - streamed chunks are stored, superseded by the event that finishes them, skipped on replay and
    deleted after a retention window.
- **Authentication** ([epic #65](https://github.com/amirtuval/openharness/issues/65)) is done
  (closed 2026-10-05): Google, GitHub and Microsoft sign-in are verified on the deployed
  environments.
- **Model catalog and model-first chat** ([epic #92](https://github.com/amirtuval/openharness/issues/92))
  are done (closed 2026-10-04): New chat picks a model, sessions carry their own model, and
  agents are optional.
- **Deployment and CI/CD** ([epic #148](https://github.com/amirtuval/openharness/issues/148)) is
  done (closed 2026-10-07): staging at <https://staging.oharness.dev> deploys from `main`,
  production at <https://app.oharness.dev> deploys from the `production` tag, and the CLI is on
  npm as [`@openh/cli`](https://www.npmjs.com/package/@openh/cli).
- **Flaky server tests** ([#43](https://github.com/amirtuval/openharness/issues/43)) are fixed.

## Order

1. Finish v1 — done: the epic is closed.
2. Authentication — done
3. Deployment and CI/CD — done
4. Model selection and provider keys
5. Tools

**Why this order:** identity and a running deployment are the foundations. Every later feature
needs to know who owns what. The features that cost money or can act on the world (paid model
calls, tools) should land on a platform that already has users, environments and a trustworthy
CI.

## 2. Authentication (done: [epic #65](https://github.com/amirtuval/openharness/issues/65))

**Status:** implemented, through a hands-on QA pass (#74) with no security defects, and its
minor findings fixed. All three providers are verified on staging and production.

**Decided** (details and the sub-issues are on the epic):

- **Sign-in** with Google, GitHub or Microsoft, through [Better Auth](https://www.better-auth.com)
  running inside our server against our Postgres. Sign-up is open.
- **A user is a verified email.** Any of the three providers can sign in the same user; only
  provider-verified emails are accepted.
- **Server-side sessions,** not JWTs or refresh tokens: an opaque token checked against the
  database on every request, 7-day sliding expiry, and revocation that takes effect immediately.
  The web app uses an httpOnly cookie; the CLI uses a bearer token.
- **`oh login`** opens the browser on a sign-in page (the device-code flow, RFC 8628) and stores
  a token. `oh logout` and `oh whoami` round it out.
- **Every agent and session belongs to its creator.** Nothing is shared, and there are no
  organizations or teams yet.
- **Users bring their own model keys.** The server has no provider keys of its own:
  - keys are stored in Postgres with envelope encryption (a new `@openharness/vault` package,
    with the master key in `OPENHARNESS_SECRETS_KEY`; a pluggable key provider since #150 —
    Cloud KMS in staging and production);
  - they are write-only and validated on save;
  - they are decrypted only for one model request.
  - Supported now: any provider that takes a single API key (OpenAI, Anthropic, Google,
    OpenRouter, Groq, Fireworks, …).
  - The code that read provider keys from environment variables is removed. Local development
    uses the same encrypted settings.
- **A username/password dev login,** only when the server's public URL is localhost.
- **The static `OPENHARNESS_API_KEY` is removed,** and existing v1 data is deleted.

## 3. Deployment and CI/CD (done: [epic #148](https://github.com/amirtuval/openharness/issues/148))

**Status:** done; the first deploy and the first CLI releases are in #159. How to operate it
is in [`DEPLOYMENT.md`](./DEPLOYMENT.md) and [`RELEASING.md`](./RELEASING.md).

**What shipped:**

- **One GCP project per environment** (staging and production), with Terraform modules and a
  Helm chart (`infra/`, `charts/openharness`). Each project has an Autopilot GKE cluster,
  Cloud SQL for Postgres behind the Cloud SQL Auth Proxy, Secret Manager, and Cloud KMS for
  the vault's master key. The app is exposed through a GKE Gateway with Certificate Manager
  and Cloud CDN.
- **CI identity through Workload Identity Federation,** with least-privilege deploy and plan
  accounts and no service-account keys.
- **Deploys:** staging deploys from `main` after CI passes; production deploys from the
  `production` tag and reuses the image staging built. PRs that touch the infrastructure run
  `terraform plan`.
- **Behind the load balancer:** the client IP is resolved from the trusted hop of
  `x-forwarded-for`, so the sign-in rate limit keys per client; there are readiness probes, and
  CDN cache headers (immutable assets, `no-store` on everything dynamic).
- **Observability:** JSON logs, Cloud Trace, uptime checks and alerts, and a budget.
- **OAuth apps per environment** for Google, GitHub and Microsoft.
- **The CLI on npm** as `@openh/cli` (npm refused the unscoped `openharness` as too close to
  `open-harness`), published by a manual workflow through trusted publishing with provenance.
  It defaults to production and updates itself in the background.

**Follow-ups:**

- run the e2e and QA suites (`e2e/qa`) against staging;
- Cloud Armor in front of the load balancer;
- Cloud SQL high availability for production;
- a preview environment per PR;
- shared rate-limit storage: the counters are per instance today, so the effective limit grows
  with the replica count;
- `HEAD` on the web app's files returns 404 ([#196](https://github.com/amirtuval/openharness/issues/196));
- the CLI's background update can be cut short by quick commands
  ([#197](https://github.com/amirtuval/openharness/issues/197)).

## 4. Model selection

**Scope:**

- **more credential types**, on top of the single-API-key providers that authentication (#65)
  supports:
  - Bedrock (AWS access keys or an assumed role);
  - Vertex (a GCP service account or workload identity);
  - Azure OpenAI (endpoint, key and deployment);
  - custom OpenAI-compatible base URLs, which need SSRF protection first;
  - possibly signing in with a provider subscription, if the terms allow it.

  The credential store keeps a type plus an encrypted payload, so these are new types rather
  than a new design;

- the **model catalog** and **model-first chat** shipped early in
  [epic #92](https://github.com/amirtuval/openharness/issues/92) (closed 2026-10-04):
  - New chat picks a model from the models the user's own keys can use, read live from each
    provider's API and joined with Mastra's registry for filtering and context windows;
  - sessions carry their own model, and agents are optional;
  - customizable agents are hidden from the UI until they return as an advanced feature
    ([#96](https://github.com/amirtuval/openharness/issues/96)).

  What remains in this phase is below;

- **modes** (an idea from Amp): a named preset that bundles a model, a reasoning effort, a
  system prompt addition and a tool set behind a stable name such as `smart`, `fast` or
  `deep`. Users and agents pick a mode instead of a raw `provider/model` id, and an operator can
  change what a mode maps to without touching every agent. A raw model id stays available for
  those who want it;
- **switching the model mid-session** (sessions already carry their own model after #92), and modes;
- usage and cost per user, from the token counts the spans already store, and
  possibly budgets that stop a session at a limit, with usage events so clients can show
  spending live (as Managed Agents' `session.usage` does).

**Decided:**

- **The context budget comes from the model and is chosen per model request,** not per
  session, so a mid-session model switch trims correctly on the next request. Each request
  records its model on `span.model_request_start` (#46). The fixed 32,768-token default becomes
  the fallback for unknown models.
- **Modes are part of this phase.** Each request records the mode it ran under alongside the
  resolved model, so the log stays accurate when a mode's mapping changes later.

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
   - credentials go in the encrypted per-user store from authentication (#65), never in the
     agent config returned by the API.
3. **Pausing for the user** (`session.status_idle {stop_reason: requires_action}`), which
   covers three features with one mechanism:
   - client-run tools (`agent.custom_tool_use` → `user.custom_tool_result`);
   - approvals: a per-tool policy of allow, ask or deny, and `user.tool_confirmation`, with UI in
     the web app and `oh`;
   - **`ask_user`**: a built-in tool the model calls to ask the user a structured question in
     the middle of a task (a question with optional choices, or free text), as Claude Code's
     `AskUserQuestion` and Gemini CLI's `ask_user` do. The turn pauses until the answer
     arrives, and the web app and `oh` render the question and collect the answer.
4. **Sandboxed tools** (`bash`, files) behind the same `hands` interface. The sandbox
   technology, and whether hands run in-process or as a separate worker, are decided then.

**Open:**

- **Crash rule for tool calls.** The proposal: never re-run a tool automatically after a crash.
  Store `agent.tool_result {is_error: true, "execution lost"}` and let the model decide. Tools
  that declare themselves idempotent could opt in to a re-run later.
- Whether `web_search` is in step 1, and with which provider.

## Later: not ordered yet

- **Programmatic access:** personal API keys, SDK and script access (no static server key
  any more).
- **Organizations, teams and sharing:** shared agents and sessions, roles, invitations, and an
  `author` on each user event once a session can have several people.
- **CLI and web polish:** a lot of smaller UX work in both clients, collected while testing v1.
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
  - a tab watching a session started in another tab may not show the new title until reload.

## Ideas from other harnesses (low priority)

Worth knowing when the phase they touch comes up; none of them is planned yet. From the
[harness survey](./research/harness-features.md) and a broader first pass; not re-verified
against each tool's docs.

- **ACP permission rules** (for tools step 3): approval choices of `allow_once`,
  `allow_always`, `reject_once` and `reject_always`, and "an unknown outcome must not be treated
  as approval": a timeout or an unrecognized reply counts as a denial.
- **Gemini CLI's policy engine** (tools step 3): layered rules (admin > project > user) that can
  match tool arguments by pattern; a reference for the shape of per-tool policies.
- **An ACP adapter** (clients): the Agent Client Protocol is the cheapest route to IDE clients
  (Zed, JetBrains, Neovim). Goose serves it over HTTP+SSE, and its replay rules (an inclusive
  cursor, reusing message ids, never re-executing commands) match what #46 built.
- **Shadow-git checkpoints** (tools step 4, from Gemini CLI): snapshot file changes in a hidden
  git repo so a rewind can restore the code and the conversation independently.
- **Environment snapshots** (tools step 4, from Cursor): save a prepared environment and reuse
  it, so a session does not start from a blank container.
- **A repo map** (tools step 4, from Aider): a token-budgeted, ranked map of a codebase's
  symbols, for coding agents.
- **Different models per role** (model selection, from Aider's architect/editor mode): one
  model plans and a cheaper one applies the edits.
- **Recipes** (later, from Goose): saved, parameterized tasks with success checks, retries,
  failure-recovery steps and scheduling; close to outcomes and scheduled runs.
