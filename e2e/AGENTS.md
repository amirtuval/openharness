# @openharness/e2e

Cross-package (end-to-end) tests: the **built** server in its own process, a real Postgres, and
`@openharness/client` — the same SDK the web app and the TUI use. They exist to prove the thing
no single package can: that the pieces work together, and that what a deployment does to them
(kill the process, drop the stream, fail the model) leaves the session in the state the
protocol says it should.

## Running them

They need a Postgres the test user may create databases on. CI provides one (the workflow's
`postgres` service and its `DATABASE_URL`); locally:

```bash
docker run --rm -d --name oh-postgres -p 5432:5432 \
  -e POSTGRES_USER=openharness -e POSTGRES_PASSWORD=openharness -e POSTGRES_DB=openharness \
  postgres:18-alpine

DATABASE_URL=postgres://openharness:openharness@localhost:5432/openharness yarn test
```

Without `DATABASE_URL` the suite fails with that instruction rather than skipping: an e2e suite
that quietly passes because nothing ran is worse than one that says what it needs. Two files
can skip, and both say why in their output: the provider smoke test (needs a provider key —
unless `OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1` demands it run, which is how the CI job below
runs it), and the failover test, which guards against a server without the multi-instance
scheduler.

## Commands

Run from this folder (`e2e`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | no-op: this package only holds tests, so it has nothing to build        |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo. The suite runs against `dist/`, so the packages it depends on — server, client, protocol,
web, the `oh` CLI — have to be built before it: `@openharness/e2e` depends on them, which is
what makes turbo's `^build` run first, and what makes `--affected` pick these tests up when the
server changes.

## Public API

Not a published package: it has no `exports` and no build output. What it holds is the tests
and the harness they share (`src/harness/`), which is internal.

## The harness

```ts
const harness = e2eHarness('my-scenario') // registers the teardown itself

const server = await harness.server() // a built server, on a free port
const client = await harness.client(server) // signs in (dev login) and points a client at it

// A second person, for isolation and ownership tests:
const a = personFor(server, await harness.user(server, { email: 'a@example.com', password: '…' }))
const b = personFor(server, await harness.user(server, { email: 'b@example.com', password: '…' }))
```

| module                      | what it is                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                  | `e2eHarness(label)`: the file's database, its servers, its sessions, its teardown                                                                                                                 |
| `database.ts`               | `createE2eDatabase(label)`: one Postgres database per test file, dropped in `afterAll`                                                                                                            |
| `server.ts`                 | `startServerProcess(options)`: the built server as a child process, `/health`-ready                                                                                                               |
| `users.ts`                  | `ensureUser(database, email, password)`: the second account A7 does not seed                                                                                                                      |
| `credentials.ts`            | `seedProviderCredential(...)` / `seedAzureCredential(...)` / `seedOpenAICompatibleCredential(...)` / `seedBedrockCredential(...)`: a stored credential, written the way the `PUT` route writes it |
| `provider-stub.ts`          | `startProviderStub()`: a stub provider at the network boundary (the egress proxy)                                                                                                                 |
| `openai-compatible-stub.ts` | `startOpenAICompatibleStub()`: a real HTTP **OpenAI-compatible** endpoint on loopback — `GET /v1/models` and a streamed `POST /v1/chat/completions` — for a custom credential's base URL (#249)   |
| `errors.ts`                 | `errorOf(work)`: the `ApiError` a call threw, for the tests that are about refusals                                                                                                               |
| `events.ts`                 | reading a session: `readLog`, `collectStream`, `waitForTurnEnd`, the event filters                                                                                                                |
| `wait.ts`                   | `waitFor`, `sleep` — polling that fails with what it was waiting for                                                                                                                              |
| `mock.ts`                   | `expectedSlowReply()`: the mock model's `__slow__` reply, for exact assertions                                                                                                                    |

Six decisions worth knowing before reading the tests:

- **One database per test file.** `createE2eDatabase` creates `openharness_e2e_<label>_<random>`
  on the server `DATABASE_URL` names and drops it in teardown (`with (force)`, so a failed run
  cannot leave one behind). The server under test migrates it on boot — the tests assert the
  boot log says how many migration files it applied. A database rather than a schema, because
  everything shared is per-database: the migration advisory lock, the store's `LISTEN`/`NOTIFY`
  channels and the partition leases.
- **One real process per server.** `startServerProcess` spawns `node <built server>` — resolved
  through `@openharness/server`'s `exports`, never through a path into another package — on a
  free port, with `OPENHARNESS_TEST_MODEL=mock`, the dev login on (`OPENHARNESS_DEV_LOGIN=1`,
  so `harness.client(server)` can sign in as the documented dev user) and fixed
  `BETTER_AUTH_SECRET`/`OPENHARNESS_SECRETS_KEY` values. The child's environment starts from the
  test process's, minus every `OPENHARNESS_*`/`BETTER_AUTH_*` variable, `PORT`/`DATABASE_URL`
  and the test-runner markers (`NODE_ENV`, `TEST`; see below): a leftover variable in a
  developer's shell must not change what a test runs. Provider keys pass through deliberately —
  the smoke test is what needs them, and it stores the key as a credential rather than
  expecting the server to read it (A5). The process is detached (its own group) and
  killed with `SIGKILL` by default, so nothing it spawned outlives it. The port is probed,
  not reserved (#123): another test's probe can be handed it before the child binds, so a
  start trusts only the child's own `listening on …` line — a foreign server answering the
  same port must not pass for it — and retries a child that died of `EADDRINUSE` on a fresh
  port. A caller-chosen `port` is used as-is, never retried.
- **The server runs with `NODE_ENV=production`** (#79), always — only the spawned process;
  vitest keeps its own `NODE_ENV=test`. Better Auth skips its whole origin check when
  `isTest()`, which is `NODE_ENV=test` **or** a set `TEST`, and vitest sets both — so the
  harness drops `TEST` from the copied environment too, or a child would treat itself as a
  test process however `NODE_ENV` was overridden (that inheritance is exactly how the check
  stayed invisible a second time while this was fixed). A server under vitest's environment
  would run with the CSRF rule a deployment enforces switched off, and the suite would never
  exercise a misconfigured `trustedOrigins`. This is the mode a deployment runs
  (`docker/Dockerfile` sets the same), and therefore the mode the tests have to speak to.
  `signIn()` sends the `Origin` a browser sends, which the check demands: Node's `fetch` also
  sends `sec-fetch-mode: cors`, and on a production-mode server a cookieless sign-in POST
  without `Origin` is refused (`MISSING_OR_NULL_ORIGIN`, 403 — correct CSRF behaviour, never
  to be disabled). The device flow is unaffected: its endpoints carry no such middleware.
  `csrf.test.ts` is what proves all of this; nothing in the server reads `NODE_ENV`, so no
  test seam had to move — the seams (`OPENHARNESS_TEST_MODEL`, `OPENHARNESS_DEV_LOGIN`) were
  already explicit variables.
- **Nothing leaks.** Servers are registered as they start and killed in the file's `afterAll`
  (with a process-wide sweep behind that), and the database is dropped last. A test that fails
  half-way through leaves no port bound and no database behind — which matters in CI, where a
  leaked server would hold connections until the job ends.
- **Waits are written against the log.** `waitForTurnEnd(client, id, { afterSeq })` polls the
  session's _status events_, not the session resource: between `POST …/events` and the brain
  writing `session.status_running` the session still reads `idle`, so a test that does not say
  which turn it means can return before that turn started. `afterSeq` (the `seq` of the message
  the test just sent) makes it "the turn after that message ended" — and with no `afterSeq` it
  is "the session has no open turn", which is what a test needs after a restart.
- **One account per person per server, and second people are made the way Better Auth makes
  them.** Every `/v1` call carries a session (A2), so `harness.client(server)` signs in as the
  dev user (A7) and keeps that session for the file — sign-in is rate-limited to three per ten
  seconds, and a file that signed in per request would trip its own limit. A file that trips
  it anyway (several people, several sign-ins) is not failed by it: `signIn` waits the window
  the server named out (`X-Retry-After`) and signs in, the same pattern `qa/support.ts` uses;
  only a 429 is ever retried, and `harness-signin.test.ts` pins it. Tests that need
  more than the one seeded user call `harness.user(server, { email, password })`: the address
  is created in the file's database with Better Auth's own id generator and password hasher
  (`users.ts`), because sign-up is disabled and the dev login seeds exactly one person. That is
  the only seam — the server is a real process, and A7 is the point.

  `seedProviderCredential` is the same idea for credentials: `PUT /v1/provider-credentials` is
  a real provider call to validate, and no seam crosses the process boundary, so the harness
  writes **the row the route writes** — the server's own `sealApiKey`/`credentialUpsert`, the
  same vault key, through a `CredentialStore` — while the route itself is exercised by
  `provider-smoke.test.ts`, which PUTs a real key through it (`credentials.ts` documents this).
  That route's success path is automatic since #120: the CI `provider-smoke` job supplies a
  repository key, so "the PUT works" is not only true of a hands-on QA pass.

- **Provider calls can be stubbed at the one seam a real process has: the network.**
  `startProviderStub()` (`provider-stub.ts`) runs an HTTP proxy on loopback that the server
  under test reaches through the documented **egress-proxy variables** (`HTTPS_PROXY`, read by
  `catalog/provider-fetch.ts` via undici's `EnvHttpProxyAgent`); the CONNECT tunnel is
  terminated with a throwaway certificate from `fixtures/provider-stub/` whose SANs are
  exactly the provider hostnames the stub may impersonate (its README says how it was made and
  why it protects nothing), and the child trusts it because `stub.env` sets
  `NODE_EXTRA_CA_CERTS`. Each provider host is answered from a handler the test wrote:
  `stub.answer('api.anthropic.com', …)`. Pass `stub.env` to `harness.server({ env })` and the
  whole outbound path — the credential validation and the catalogue's list calls — is the
  test's, while everything in the process stays real; `stub.requests` is the request log, for
  asserting which calls a route made. Nothing in the product changes for this: a deployment
  behind a proxy is a documented deployment (`catalog/provider-fetch.ts`), and this is one of
  those, pointed at loopback. `default-model.test.ts` is what needs this: the automatic
  default (U4) is picked when a key is saved _through the route_, and the route validates the
  key with a real provider call.

## Scenarios

| file                        | what it drives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.test.ts`              | a full turn whose chunks are stored under the stored `agent.message`'s id, the documented event order and `MOCK_MODEL_USAGE`; a steering message answered in a second request; an interrupt that keeps the partial reply and is claimed by the span end it stopped; an interrupt with nothing running, claimed by the status idle; a pre-D9 log (no consumes, no supersedes, no chunks) read back correctly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `failures.test.ts`          | `__fail_retryable__`: error, reschedule, a fresh request, the reply; `__fail_terminal__`: error, no reply, idle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `restart.test.ts`           | `kill -9` mid-`__slow__`, a new process against the same database: the orphaned chunks superseded by a `brain_lost` span end, the turn re-run, idle, no ghost previews                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `stream-resume.test.ts`     | a stream aborted mid-turn, more turns while nobody listens, a resume from `afterSeq` with no gaps or duplicates; and one stream iteration across a server restart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `d9-convergence.test.ts`    | D9 (issue #46): a client that followed a reply live, one that joined mid-reply and one that dropped mid-chunks and resumed from there all end deep-equal — before compaction and after the job deleted the chunks; a steered reply in the same order live and after a reload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rewind.test.ts`            | edit and resend (#238): the rewind and the edited message in one request restart the conversation from the edit — the tab that watched the rewind arrive and a fresh read of the log end with the same conversation, the raw rows of the replaced turn are still in the database (append-only) while the replay read holds none of them, compaction (retention 0) deletes them and every view still agrees, and a rewind aimed at a running turn is the protocol's 409 `conflict_error` that stores nothing, accepted once the turn is over                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `auth.test.ts`              | real authentication (A2/A7): `/health` and `/v1/auth-config` open, the 401 envelope on `/v1`, the dev-login sign-in, a turn as a bearer session, a revoked token refused on a **new** stream (the reconnect) while every plain route's 401 lives in the `isolation.test.ts` sweep, and a lapsed session refused. An _already-open_ stream ends when the session behind it does ([#76](https://github.com/amirtuval/openharness/issues/76), fixed in [#77](https://github.com/amirtuval/openharness/pull/77)): a cookie sign-out and a bearer sign-out (the `oh logout` path) each deliver the final `event: error` frame — the protocol's `authentication_error` envelope with `SESSION_INVALID_MESSAGE` — and the body ends within about two seconds, while another user's stream keeps delivering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `csrf.test.ts`              | the origin check a deployment enforces (#79), against a production-mode server: a sign-in POST with a foreign `Origin` is refused (`INVALID_ORIGIN`), one with no `Origin` and `sec-fetch-mode: cors` is refused (`MISSING_OR_NULL_ORIGIN` — Node `fetch`'s shape), the server's own URL signs in and the session authenticates `/v1`, and the `/v1` cookie-write rule (no `Origin` → 403 `permission_error`, trusted `Origin` → 201) is unchanged in production mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `isolation.test.ts`         | two people on one server (A4): B gets 404 — never 403 — for A's agent (get/update), session, events list, `POST …/events`, `DELETE …/sessions/{id}` and the AI SDK adapter; the SSE stream refuses instead of connecting; B's lists are B's; a stored credential is A's alone; and **every `/v1` route answers the 401 envelope without a session** (a forged bearer included) — the one home of each route's plain 401, which is why `auth.test.ts` keeps only the stream variants of the revocation refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `model-first.test.ts`       | a session created from a model alone (#94): `agent: null` round-trips through GET and the list, an inline model/system overrides an agent's per field while the agent snapshot stays, a turn on it is attributed to that model in the stored span, and the 400s (neither an agent nor a model, a malformed id) plus the by-design acceptance of an unknown-but-well-formed one (C5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `usage.test.ts`             | usage and cost across packages (#247): a session's totals priced from the vendored models.dev snapshot, the running totals the brain stored in the log beside them, the per-user read grouping a real request by the caller's own day — with a zone on the other side of the date line giving a different day for the same instant — a deleted session gone from the totals, another person's session usage as the 404 an unknown id gets, and a refused zone and backwards range as the protocol's 400                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `model-catalog.test.ts`     | `GET /v1/models` over the wire (#90), deterministic offline: no stored keys is an empty catalogue **and no provider contact**; a provider with no list endpoint is answered from the registry as a visible `fallback` (C3) with no part of the key in the response; one account's keys are not another's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `preferences.test.ts`       | the per-user default model (U1): `null` before anything is stored, the whole-value round trip and clear, an id the catalogue does not list accepted (C5) and one that is not `provider/model` refused with nothing stored, and one person's default never showing in another's — the resource has no id in the path, so this is the guard and the owner scope under test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `default-model.test.ts`     | the automatic default (U4), both halves. On the first key save — the provider calls answered by the stub proxy — the pick is the recommendation table's first entry the live catalog lists (the validating call and the list call asserted on the stub's request log), or the newest everyday registry model when the provider cannot be listed (asserted against the product's own `isEverydayModel`/`newestModelId` rule, not a hardcoded id), and a save never moves an existing default, automatic or the user's own. On a delete through the real route: an explicit default is left alone while its provider still has a key and cleared — never silently substituted — when it does not, the catalogue drops the provider at once (C4/C5), and a delete that removed nothing (a provider with no credential, #139) leaves the preferences exactly as they were. A key written without the route (the harness's row) leaves the default null while the catalogue lists its models — keys with no default, the clients' #146 state, and proof that reading preferences does not backfill one. `apps/server/src/default-model.test.ts` injects the validator for the in-process half                                                                                                                                                                                    |
| `session-delete.test.ts`    | the hard delete (U5): `204` and the whole cascade checked against Postgres itself (every table `information_schema` reports as session-keyed, discovered rather than listed), the 404 another owner gets together with proof it deleted nothing, a `__slow__` turn stopped before the rows go with nothing written afterwards, both halves of an open stream receiving the final `session.deleted` and closing cleanly, and the delete issued to one instance while another runs the turn (partition scheduler, detected like `failover.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `model-switch.test.ts`      | the mid-chat switch (U3): the message that carries a `model` changes the session in the same transaction as the append, `span.model_request_start` names the model that ran for each request, the switch sticks to the messages after it, one sent while a reply is streaming applies from the next request inside the same turn, and a malformed id is a 400 that appends nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `device-flow.test.ts`       | `oh login` end to end (A6): the code document (`verification_uri_complete` carries the code **inside the fragment**), approve through the API as a signed-in person, poll, use the bearer token; a code redeemed once; deny → `access_denied`; pending → `authorization_pending`; an expired code (`expiresAt` moved into the past) → `expired_token`, and the row is deleted; an unknown code; a code only the person who claimed it may approve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `cli-device-flow.test.ts`   | #119: the CLI half of the same flow, in CI — the **built `oh`**, spawned with an isolated `XDG_CONFIG_HOME` against a harness server: the URL and code it prints are the ones the approval endpoint accepts, the token lands in `credentials.json` with `0600` (dir `0700`) and `oh whoami` reads it back, `oh logout` revokes the session server-side (the token is refused with a 401), a denied login exits non-zero and writes no token, and SIGINT mid-poll exits `130` with nothing written. No tmux; the `qa/` specs stay the UX pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `credentials.test.ts`       | provider credentials (A5): never in any response, event, stream or server log line; sealed at rest (no column holds the plaintext, and a whole-database dump greps clean — `last4` is the deliberate exception); a turn with no key ends `missing_provider_credential` (retry status `exhausted`, the message naming the provider, no model request made); a decoy `OPENAI_API_KEY` in the server's environment changes nothing; a key the provider refuses is refused on save (422) and never stored; deleting one makes the next turn a missing-credential turn; and, for #245 A3a, an Azure credential whose endpoint resolves inside the network is refused on save (422) — the SSRF guard running where it matters — a name a fixed provider id owns or an `api_key` under a named one is a 400, an https-only endpoint is a 400, and a seeded Azure credential contributes one catalog entry per deployment name with the registry's window on a known one and `null` on an unknown one; for #245 A3c, a bedrock region AWS does not serve is the schema's 400 with nothing stored, and a seeded Bedrock credential's catalogue is answered from the registry as a visible `fallback` — deterministic whether AWS refuses the fake keys or is unreachable — with every entry named after the credential and its prices taken from models.dev's `amazon-bedrock` entry |
| `openai-compatible.test.ts` | custom OpenAI-compatible credentials (#245, A3b), the one type where a local happy path exists: on the hosted defaults a loopback/private/metadata base URL is refused on save (422) and a stored one is refused at **request time** (a seeded credential, a failed span, an idle turn, and not one byte reaching the stub); with `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1` the save-time check reaches a real loopback stub, the credential stores with its base URL host as `details`, the catalogue lists the endpoint's own `/models` as `custom/<model>`, and a chat streams the stub's reply with the key in the `Authorization` header — and a **keyless** credential saves and chats with no such header. (`NO_PROXY=127.0.0.1` keeps a developer's egress proxy out of the loopback call.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `dev-login-guard.test.ts`   | the boot refuses `OPENHARNESS_DEV_LOGIN=1` on a non-localhost `BETTER_AUTH_URL` (A7), and with the flag off nothing about the dev credentials works                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `harness-ports.test.ts`     | the harness itself (#123): a start on a port another server already holds fails with its own boot log (`EADDRINUSE`) instead of adopting the occupant a `/health`-only readiness check could take for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `harness-signin.test.ts`    | the harness's sign-in against the sign-in rate limit (#105 review): the window is spent until the server refuses (three per ten seconds, pinned directly), and then more accounts than the window allows sign in back to back — which can only pass because `signIn` waits the window the server named (`X-Retry-After`) out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `web-assets.test.ts`        | `OPENHARNESS_WEB_DIR`: the built web app at `/`, its hashed assets, deep links, and the API still under `/v1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `failover.test.ts`          | two instances with `SCHEDULER=postgres`, one killed mid-turn, the other finishing it — see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `provider-smoke.test.ts`    | the provider-credential success path against a real provider (#120): the environment's key is PUT through the route (validated, sealed, stored), listed back metadata-only, and one turn runs on it through the real router — coarse on the reply, exact on "no response, log or log line echoes the key". The model is the provider's default (`openai/gpt-5-mini` for OpenAI, the everyday tier of the server's curated list) or `OPENHARNESS_SMOKE_MODEL`; without a key the file skips, unless `OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1` makes it fail — what the CI job below sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### The failover test, and how it decides to skip

The test needs the multi-instance scheduler (`SCHEDULER=postgres`, issue #11), so it
**detects** the capability instead of assuming it: on a server that ignores `SCHEDULER`, two
instances would each come up on `LocalScheduler` believing they own every session — not
something this test can assert against. Two checks, in order:

1. the built server's code never mentions `SCHEDULER` — a variable nothing reads cannot change
   what the process does, so there is nothing to test;
2. an instance started with `SCHEDULER=postgres` and short lease timings
   (`OPENHARNESS_LEASE_TTL_MS`, `OPENHARNESS_HEARTBEAT_MS`) holds no partition lease: a running
   partition scheduler is one with `partition_leases.owner` set.

Either way the skip message says which check failed and what would make the test run. When it
runs: both instances start with `SCHEDULER=postgres`, the test looks up which one owns the
session's partition in `partition_leases`, `SIGKILL`s that owner mid-`__slow__`, and the
survivor has to take the partition over and finish the turn.

### The provider smoke test, and the CI job that runs it

`provider-smoke.test.ts` skips without a provider key, because most laptops and most CI jobs
have none — but the route it covers (`PUT /v1/provider-credentials`, the one real provider
call a saved key is validated with) then runs in no automatic test at all (#120). So CI has a
second job, `provider-smoke` in `.github/workflows/ci.yml`, that runs **only** this file with
the repository's low-limit `OPENAI_API_KEY` and `OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1`: the
guard turns a missing key into a failure, never a silent skip, so the job cannot pass without
the route having run. It runs on pushes to `main`, on the nightly and manual fresh runs, and
on pull requests from this repository — a fork PR gets no repository secrets, so the job is
skipped there. The key is that job's alone, is never printed, and is not passed to any other
job or step.

`OPENHARNESS_SMOKE_MODEL` overrides the model (and with it the provider whose key is needed —
the credential is stored for the provider the model names). The default, and so the model CI
runs, is `openai/gpt-5-mini` — the first entry of the server's curated everyday list
(`RECOMMENDED_DEFAULT_MODELS.openai`, `apps/server/src/default-model.ts`): the capable "mini"
tier the server itself would pick for a new chat on this key, cheap enough to run for real on
every CI run. Locally, with a key of your own:

```bash
OPENAI_API_KEY=sk-… DATABASE_URL=postgres://openharness:openharness@localhost:5432/openharness \
  yarn vitest run src/provider-smoke.test.ts
```

## Testing

`src/**/*.test.ts` with Vitest (node environment), against the built packages. The package's
`vitest.config.ts` raises the timeout (a `__slow__` reply is ten seconds on purpose, and a
restart test waits out a whole turn) and keeps file parallelism on: each file owns a database,
and they spend their time waiting rather than computing.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `e2e/docs/`.

## Hands-on QA scripts (`qa/`)

`qa/` holds the Playwright (web) and tmux (CLI) specs used for hands-on QA passes (see issue #14). They are
**not** part of `yarn test` or CI.

- Run: `yarn qa:web` against a running system (default `http://localhost:3000`, override with the base-URL env
  var in `playwright.config.ts`), e.g. `OPENHARNESS_TEST_MODEL=mock docker compose up --build`.
- Opt-ins: `QA_WITH_CLI=1` runs the CLI specs (needs `tmux` and a built `apps/tui`);
  `QA_ALLOW_SERVER_RESTART=1` runs the scenarios that stop, kill and recreate the server.
- Every `oh` a CLI spec runs names its server (`--server`, through `ohCommand`/`ohCommandIn`,
  from `QA_BASE_URL`). The CLI's default is production since #192, so a spec that forgot it
  would talk to the real deployment instead of the stack under test.
- Screenshots go to `e2e/qa-output/` (gitignored; override with `QA_SHOT_DIR`).
- Results of each pass are reported as a comment on the QA issue, not committed.
- A spec marked `test.fail` documents a known bug; remove the marker once the bug is fixed.

### The default model the scenarios run on

A chat is started from a **model** (epic #92), and since epic #116 "New chat" is an empty
composer on the account's **default model** (`GET /v1/me/preferences`, U1/U2): the session is
created with the first message. Since epic #201 (#209) an account with **no provider key at
all** — the state a mock pass starts in — gets the **first-run screen** at the root instead
("Let's get you chatting ✨": tiles, a key form, the default the server picks, "Let's go"),
and once a key exists New chat is what it always was. An account with a key but no default is
shown the catalog's own answer (#146). The default is normally chosen by the server when the
first key is saved (U4), which a mock pass only does if the scenario saves one, so a scenario
that needs one sets it through the API: `ensureDefaultModel(request)` (`support.ts`) does
exactly what Settings → Default model does, and reads it first rather than overwriting a value
the stack already holds.

Provider keys are managed through **Settings → Providers**, whose list adds and replaces through
the **Add-provider dialog** (#209) — `addProviderKey`, `deleteProviderKey`, `openProviders` and
`savedKeys` in `support.ts` are the shared steps, used by W1, W17 and W25. The card's own
`window.confirm`-free delete, and the dialog's tiles, are the two things a spec about keys
touches.

The CLI specs need it for the same reason: a bare `oh` starts on the stored default, and with
none — and no catalog — it says "No model providers yet" instead of opening a chat. `startChat`
in `cli.spec.ts` gives the account one and waits for the status line, which names the model the
chat runs.

### Signing in

Since epic #65 the server is not open, and every spec runs signed in. The stack must have the
dev login on — `OPENHARNESS_DEV_LOGIN=1` and a localhost `BETTER_AUTH_URL`, which
`docker-compose.yml` defaults to and the server refuses otherwise (A7) — and the fixtures sign
in **once per worker** as `dev@localhost` / `dev` (`QA_DEV_EMAIL` / `QA_DEV_PASSWORD` override
the pair):

- the bearer token of that session becomes the `request` fixture's `authorization` header, so
  every API call a spec makes is authenticated;
- the session's cookie is put on the browser context, so the page is signed in before the
  first `goto` and the app never shows its sign-in page to a scenario that is not about it.

One sign-in, not one per test, because `/api/auth/sign-in/email` is rate-limited to three per
ten seconds (A2). The specs that are _about_ signing in open a context of their own
(`w15-sign-in.spec.ts`, `w16-sign-out.spec.ts`) and use `signInWithDevForm`, which waits out
the limit the way a person would if it is hit.

### Signing the CLI in

`oh` needs a token too, and stores it in `$XDG_CONFIG_HOME/openharness/credentials.json`. The
CLI specs give it a config directory of the run's own (`CLI_CONFIG_HOME`, default
`qa-output/oh-config`, override with `QA_OH_CONFIG_HOME`) — never the developer's. When there
is no token there, `ensureCliSignedIn(page)` signs in over the **dev login** and stores the
token exactly where `oh login` stores one — deliberately not another device login, because
the device flow's verify endpoint (`GET /api/auth/device`) allows five requests per ten
minutes (the code's lifetime) and the scenarios that are _about_ the device page spend that
budget (#140): W26a, W26d, W26e and W27b plus C12 are five, and every sign-in after a
scenario logged out would be a sixth. The device page itself is opened through
`openDevicePage(page, url)`, which waits out a rate-limited verify (`X-Retry-After`) instead
of failing on it. C12–C14 verify the flow itself:
the printed URL and code, the approval page, `oh whoami`, `oh logout` revoking the session,
and the "not signed in" errors (with no token, and with a token the server refuses). C15–C17
are the chat-UX flow from the terminal: `/model` in a chat and `--model` at the start (U3),
`oh sessions delete <id>` with its confirmation and `--yes` (U5), and `oh default-model`
reading and writing the account's default (U1).

The web half of the same flow: W10 is the composer's model switch, W18 the delete (in-page
confirm, header and sidebar, and a chat deleted elsewhere), W19 Settings → Default model, and
W1 the first run — the root route's first-run screen (tiles, key form, the default the server
picked, "Let's go"), the skip into New chat's empty state, the default model, and the first
chat the send creates. W1b is the same key form opened from inside an open chat, where the save
must not navigate. W17 covers Settings → Providers and the dialog's refusing, adding, replacing
and deleting.

### What the pass needs on the stack

| variable                            | what it enables                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `QA_BASE_URL`                       | where the system under test lives (`http://localhost:3000`)                                      |
| `QA_DEV_EMAIL` / `QA_DEV_PASSWORD`  | the dev user's credentials, when a stack configures them differently                             |
| `QA_WITH_CLI=1`                     | the `oh` specs (needs `tmux` and a built `apps/tui`)                                             |
| `QA_ALLOW_SERVER_RESTART=1`         | the scenarios that recreate the server container (W11f, W14)                                     |
| `QA_PROVIDER` / `QA_PROVIDER_KEY`   | a key the pass may store for real (W11f, W17b); `QA_PROVIDER_KEY_2` for replace                  |
| `QA_MISSING_MODEL`                  | the model whose provider the pass has no key for — W11e (default `groq/llama-3.3-70b-versatile`) |
| `QA_MODEL=openai/gpt-4.1-mini`      | a real-model pass; without it the stack runs the mock                                            |
| `QA_SHOT_DIR` / `QA_OH_CONFIG_HOME` | where screenshots and the CLI's credentials go                                                   |
| `QA_COMPOSE_ARGS`                   | extra `docker compose` arguments, for a stack that is not plain `docker-compose.yml`             |

The sign-in page's provider buttons only exist when the server has OAuth clients configured
(A1), so W15 skips that half unless the stack was started with them — dummy values are enough,
nothing signs in with them:

```bash
GOOGLE_CLIENT_ID=dummy GOOGLE_CLIENT_SECRET=dummy \
  GITHUB_CLIENT_ID=dummy GITHUB_CLIENT_SECRET=dummy \
  MICROSOFT_CLIENT_ID=dummy MICROSOFT_CLIENT_SECRET=dummy \
  OPENHARNESS_TEST_MODEL=mock docker compose up --build -d

cd e2e
yarn qa:web qa/w*.spec.ts          # the web pass
QA_WITH_CLI=1 yarn qa:web qa/cli.spec.ts   # the CLI pass
```

### The model the scenarios run

Every agent the specs create is created on `QA_MODEL` (`support.ts`), which defaults to the id
the specs have always named — the mock passes set nothing and are unchanged. **A pass against a
real provider sets it**, to a router id, and runs the stack without `OPENHARNESS_TEST_MODEL`:

```bash
QA_MODEL=openai/gpt-4.1-mini yarn qa:web
```

`isRealModel` (the same variable, set at all) is what the specs branch on. The mock answers by
echoing its prompt and by its `__slow__` / `__fail_*__` markers; a real provider does none of
those, so a scenario that leans on them either adapts — waiting for a reply to have arrived
rather than for particular words, asking for a long reply instead of `__slow__` — or skips with
`test.skip(isRealModel, …)`. Mock coverage is never removed: the scripted-failure scenarios
(W11a/W11b) run on the mock and skip on a provider, and the provider-only ones (W11d/W11e/W11f,
C11) do the reverse.

### What a clean screen does not prove

A client that **drops stored events it cannot parse** keeps rendering, so a session that has
become unreadable still looks like a session: pass 3's "0[object Object]" usage (#39) made every
real-provider session unreadable to `@openharness/client` while the scenarios — which watched the
console and the text — passed. The app's own error surface is what says a read failed, so every
scenario that opens, reloads or navigates a session now asserts it is clean:

- `expectNoErrorBanner(page)` (`support.ts`) fails on any `role="alert"` the app is showing —
  the chat's "Request failed" banner and the log's own turn errors are one component — and is
  also checked over a short window, since a failed load renders in the pass that ends the load.
- `expectNoErrorNotice(screen)` (`tmux.ts`) fails on the `error: …` line `oh` writes above its
  status line, matched at the start of a line so a reply's own words cannot trip it.

Scenarios that provoke an error on purpose (W11, W12, C9, C11) do not call either.

W14 asks for `CRASH_REPLY_PROMPT` rather than `LONG_REPLY_PROMPT`: `docker compose kill` takes
seconds, and a reply that streams for two of them is finished before the container is down — so
the crash lands after the turn and the scenario fails on a premise it never had. The reply is
sized to outlast the kill, and that it is still arriving is asserted just before the kill.

### A stack that is not plain `docker-compose.yml`

A scenario that kills or recreates the server has to bring it back the way it was started.
`QA_COMPOSE_ARGS` adds arguments to every `docker compose` the specs run, so a deployment that
needs an override file keeps it. The environment is inherited the same way, so a variable the
stack was started with has to be **exported** in the shell that runs the suite: a one-off
`OPENHARNESS_TEST_MODEL=mock docker compose up -d` is not enough, and a restart scenario would
bring the server back without it (W14's re-run would then be answered by the real router).

```bash
QA_COMPOSE_ARGS="-f docker-compose.yml -f docker-compose.proxy.yml" \
  QA_ALLOW_SERVER_RESTART=1 yarn qa:web qa/w14-recovery.spec.ts
```
