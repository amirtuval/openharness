# @openharness/server

The runnable openharness server: the HTTP API the protocol describes, the SSE stream over a
session's event log, sign-in (Better Auth), and the scheduler that runs brains against it.
Hono app served by `@hono/node-server`; the store is Postgres when there is a `DATABASE_URL`
and in-memory when there is not.

```bash
# Three variables are required: see "Authentication" below and `.env.example` at the root.
BETTER_AUTH_SECRET=$(openssl rand -base64 32) \
OPENHARNESS_SECRETS_KEY=$(openssl rand -base64 32) \
BETTER_AUTH_URL=http://localhost:3000 OPENHARNESS_DEV_LOGIN=1 \
DATABASE_URL=postgres://localhost/openharness yarn dev   # http://localhost:3000
```

## Commands

Run from this folder (`apps/server`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`)                  |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | rebuilds on change and restarts the server (http://localhost:3000)      |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

## Routes

Everything under `API_VERSION_PREFIX` (`/v1`). Bodies and queries are validated by the
protocol's schemas, so the shapes are not repeated here — see
[`packages/protocol/AGENTS.md`](../../packages/protocol/AGENTS.md).

| method   | path                                      | body / query                                | answers                                                                                                                                              |
| -------- | ----------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                                 | —                                           | liveness: `{ status: 'ok' }`; never needs a session                                                                                                  |
| `GET`    | `/ready`                                  | —                                           | readiness (#151): `{ status: 'ok' }`, or 503 while draining or when the store does not answer; never needs a session                                 |
| `GET`    | `/v1/auth-config`                         | —                                           | `{ providers, dev_login }`; never needs a session                                                                                                    |
| `GET`    | `/v1/me`                                  | —                                           | the signed-in `User`                                                                                                                                 |
| `GET`    | `/v1/me/preferences`                      | —                                           | the caller's `UserPreferences`, unwrapped                                                                                                            |
| `PUT`    | `/v1/me/preferences`                      | `PutPreferencesRequestSchema`               | the stored preferences; 400 for a malformed `default_model`                                                                                          |
| `POST`   | `/v1/agents`                              | `CreateAgentRequestSchema`                  | 201, the `Agent`                                                                                                                                     |
| `GET`    | `/v1/agents`                              | `ListAgentsQuerySchema`                     | `{ data, next_page }`                                                                                                                                |
| `GET`    | `/v1/agents/{agent_id}`                   | —                                           | the `Agent`, or 404                                                                                                                                  |
| `POST`   | `/v1/agents/{agent_id}`                   | `UpdateAgentRequestSchema`                  | the updated `Agent`, or 404                                                                                                                          |
| `POST`   | `/v1/sessions`                            | `CreateSessionRequestSchema`                | 201, the `Session`; 404 for an unknown agent; 400 for neither an agent nor a model                                                                   |
| `GET`    | `/v1/sessions`                            | `ListSessionsQuerySchema`                   | `{ data, next_page }`                                                                                                                                |
| `GET`    | `/v1/sessions/{session_id}`               | —                                           | the `Session`, or 404                                                                                                                                |
| `DELETE` | `/v1/sessions/{session_id}`               | —                                           | 204; hard delete (U5); 404 for another owner's or an unknown session                                                                                 |
| `POST`   | `/v1/sessions/{session_id}/events`        | `SendEventsRequestSchema`                   | `{ data: user event[] }`; then signals, and a title; 409 for a rewind while running, 400 for a batch whose rewind is not its only first event (#238) |
| `GET`    | `/v1/sessions/{session_id}/events`        | `ListEventsQuerySchema`                     | `{ data, next_page }`                                                                                                                                |
| `GET`    | `/v1/sessions/{session_id}/events/stream` | `StreamEventsQuerySchema`                   | the SSE stream; 404 for an unknown session                                                                                                           |
| `POST`   | `/v1/sessions/{session_id}/ai-sdk/chat`   | the AI SDK `useChat` request (see below)    | an AI SDK UI message stream — an **extension**                                                                                                       |
| `GET`    | `/v1/models`                              | `ListModelsQuerySchema` (`refresh`)         | `{ data, providers }`; 429 for a refresh inside the minute                                                                                           |
| `GET`    | `/v1/sessions/{session_id}/usage`         | —                                           | what one session spent: totals, cost and the per-model breakdown; 404 for another owner's                                                            |
| `GET`    | `/v1/me/usage`                            | `UserUsageQuerySchema` (`from`, `to`, `tz`) | the caller's own usage: totals, cost, by model and by day; 400 for a zone or range it cannot read                                                    |
| `PUT`    | `/v1/provider-credentials/{provider}`     | `PutProviderCredentialRequestSchema`        | the credential's metadata; 422 if the key is refused                                                                                                 |
| `GET`    | `/v1/provider-credentials`                | —                                           | `{ data: ProviderCredential[] }`, metadata only                                                                                                      |
| `DELETE` | `/v1/provider-credentials/{provider}`     | —                                           | 204; never an error for one that is not there                                                                                                        |

Every `/v1` route except `auth-config` requires a session (see "Authentication"), and every
resource is scoped to its owner. `/api/auth/*` is Better Auth's own surface: sign-in, sign-out,
the device flow, `/api/auth/error`. Anything else answers 404 in the protocol's error envelope.

`POST …/events` is the only way user input enters the system, and it does two things in a
fixed order: it **stores** the events (`processed_at: null`, which is what makes them queued)
and only then tells the scheduler. The store call is what makes the request durable; the
signal is a latency optimization the scheduler can afford to lose (see "Signals are hints" in
`packages/session`).

The body carries the user's own events, and one instruction that is not one: a
**`session.rewind`** (#238), "edit and resend". It names the `user.message` the reader edited,
travels with the replaced message in the **same batch** — so the two are one append, and a
rewind the log cannot honour stores neither — and the server writes the event (`session.*` is
the session's domain: it is not queued and never claimed, unlike `user.*`). The append records
the range it replaces, from that message through the end of the log as it stood; the response
carries the stored **user events** alone, and a client reads the rewind back from the log or
the stream. A rewind is accepted **only while the session is idle**: anything else — `running`,
and `unfinished` too, since the next brain to take the partition over will run the inherited
turn — is the **409 `conflict_error`** `requireIdleSession` raises. The store refuses a brain
that wins the race anyway, because a claim naming a superseded message is not a claim the log
accepts, so that turn ends at its next write instead of appending into the range. A `from_seq`
that names no `user.message` this session still shows is the store's `RangeError`, which the
app maps to the 400 `invalid_request_error` every bad-argument refusal gets. The batch carries
**at most one rewind, and only as its first event**: `SendEventsRequestSchema` refuses
`[user.message, session.rewind]` and `[session.rewind, session.rewind]` in `parseBody`, before
the route reads anything, with the same 400 and nothing stored — a message the rewind's range
would swallow is a message no turn would answer.

Creating a session with `initial_events` goes through the same rules: the protocol says those
events are stored "before it starts running", so a `user.message` among them signals `work` and
a `user.interrupt` signals `interrupt` — exactly what the same events would do posted to
`POST …/events` afterwards.

## Environment variables

| variable                              | default                          | what it does                                                                                      |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | —                                | run on Postgres, migrating on boot; unset means in-memory                                         |
| `SCHEDULER`                           | `local`                          | `local`, or `postgres` for the multi-instance scheduler                                           |
| `BETTER_AUTH_SECRET`                  | — (**required**)                 | signs sessions and cookies                                                                        |
| `BETTER_AUTH_URL`                     | — (**required**)                 | the public URL: Better Auth's base, the one trusted origin (CSRF)                                 |
| `OPENHARNESS_SECRETS_KEY`             | — (**required** under `local`)   | base64 32-byte master key the vault seals credentials with; not needed under `gcp-kms`            |
| `OPENHARNESS_KEY_PROVIDER`            | `local`                          | `local` (the environment key) or `gcp-kms` (Cloud KMS): who wraps the vault's data keys (#150)    |
| `OPENHARNESS_KMS_KEY`                 | — (**required** under `gcp-kms`) | the Cloud KMS `projects/…/cryptoKeys/…` key; unused under `local`                                 |
| `OPENHARNESS_KEY_CACHE_TTL_MS`        | `300000`                         | how long unwrapped data keys stay cached in memory; `0` disables the cache                        |
| `OPENHARNESS_DEV_LOGIN`               | off                              | `1` enables the local dev login; localhost URLs only (A7); the way in when no provider is set     |
| `GOOGLE_CLIENT_ID`/`_SECRET`          | —                                | enable Google sign-in (both, or neither; one provider or the dev login is required)               |
| `GITHUB_CLIENT_ID`/`_SECRET`          | —                                | enable GitHub sign-in                                                                             |
| `MICROSOFT_CLIENT_ID`/`_SECRET`       | —                                | enable Microsoft sign-in                                                                          |
| `MICROSOFT_TENANT_ID`                 | `common`                         | the Entra tenant the Microsoft provider authenticates against                                     |
| `PORT`                                | `3000`                           | the port to listen on                                                                             |
| `OPENHARNESS_TEST_MODEL`              | —                                | `mock` swaps in the deterministic test model                                                      |
| `OPENHARNESS_WEB_DIR`                 | —                                | a built web app to serve at `/`                                                                   |
| `OPENHARNESS_TRUSTED_PROXY_HOPS`      | `0`                              | how many proxies append to `x-forwarded-for`; `0` trusts no forwarding header (#151, see below)   |
| `OPENHARNESS_CORS_ORIGINS`            | —                                | comma-separated origins to allow; unset means no CORS headers                                     |
| `OPENHARNESS_MAX_CONCURRENT_SESSIONS` | `4`                              | how many sessions may be running at once                                                          |
| `OPENHARNESS_DRAIN_TIMEOUT_MS`        | `5000`                           | how long shutdown waits for a turn in flight                                                      |
| `OPENHARNESS_INSTANCE_ID`             | hostname + pid + random suffix   | this instance's id in the lease table                                                             |
| `OPENHARNESS_PARTITIONS`              | `64` (the protocol's)            | how many partitions the session space has                                                         |
| `OPENHARNESS_LEASE_TTL_MS`            | `30000`                          | how long a partition lease lasts before it must be renewed                                        |
| `OPENHARNESS_HEARTBEAT_MS`            | `10000`                          | how often leases are renewed and free partitions taken                                            |
| `OPENHARNESS_SWEEP_MS`                | `60000`                          | how often owned partitions are re-scanned for missed work                                         |
| `OPENHARNESS_DELTA_RETENTION_MS`      | `3600000`                        | how long superseded chunks are kept before compaction deletes them                                |
| `OPENHARNESS_COMPACT_INTERVAL_MS`     | `300000`                         | how often the compaction job runs; `0` disables it                                                |
| `OPENHARNESS_LOG_FORMAT`              | `text`                           | `text` (readable) or `json` (Cloud Logging): what stdout carries (#158)                           |
| `OPENHARNESS_TRACING`                 | `off`                            | `off`, or `cloud-trace` to export spans to Cloud Trace (#158)                                     |
| `OPENHARNESS_TRACE_SAMPLE_RATE`       | `0.1`                            | the fraction of root traces kept when tracing is on; `0` keeps none, `1` keeps all (#158)         |
| `GOOGLE_CLOUD_PROJECT`                | —                                | the project a JSON log line's trace id is qualified with; Cloud Logging resolves a bare id (#158) |
| `<NAME>_FILE`                         | —                                | for any secret above: read the value from this path instead of `<NAME>` (#154, see below)         |

Every **secret** in that table — `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`OPENHARNESS_SECRETS_KEY`, and each provider's `*_CLIENT_SECRET` — can be delivered as a file
instead, by setting `<NAME>_FILE` to a path that holds the value (#154). That is how the Helm
chart mounts them from Secret Manager: the container gets
`DATABASE_URL_FILE=/var/run/secrets/openharness/database-url`, not `DATABASE_URL`. The file's
value has **one** trailing newline removed, so `printf '…'` and `echo '…'` are the same
secret. Setting both `<NAME>` and `<NAME>_FILE` fails the boot (they could disagree); so does a
file that cannot be read, with a message naming the variable and the path and never the
content. The rule that an empty value is unset holds here too: an empty file is an unset
setting. Local dev and docker compose are unaffected — with no `_FILE` variable, nothing reads
a file. `OPENHARNESS_KMS_KEY` is a resource name, not a secret, and stays inline.

On GKE the `DATABASE_URL` the chart mounts names **`127.0.0.1`**, not a database host: the
Cloud SQL Auth Proxy runs as a sidecar in the app's own pod and makes the TLS connection to
the instance itself (#159), so the server's `sslmode=disable` there is about a loopback hop
and not about the connection that leaves the pod. See
[`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md#the-database-url-and-why-the-pod-runs-a-proxy-159).
Nothing in this package changes because of it — `readServerConfig` treats the URL as opaque.

Provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are **not read at all**
(epic #65, A5), and the server keeps none of its own: every model request is made with the
credential the session-bound resolver answered — the owner's stored, sealed key, opened per
request (`credentials.ts`). A session whose owner has no key for the model's provider ends the
turn with the brain's `missing_provider_credential` `session.error`; the environment is never
a fallback. The mock kind resolves a placeholder the deterministic model ignores.

**The vault's key provider** (#150, deployment epic #148 decision D6) is
`OPENHARNESS_KEY_PROVIDER`. `local` — the default — wraps each credential's data key with
`OPENHARNESS_SECRETS_KEY`, so dev, docker compose and CI are unchanged; `gcp-kms` wraps it
with a Cloud KMS key (`OPENHARNESS_KMS_KEY`), authenticated by Application Default
Credentials — Workload Identity on GKE — and keeps no key material in the environment at all.
`main.ts` builds the one vault every credential path shares from the configuration
(`createConfigVault`), and the Cloud KMS client is loaded on the _first wrap or unwrap_: a
`local` server never loads `@google-cloud/kms`. Unwrapped data keys are cached in memory for
`OPENHARNESS_KEY_CACHE_TTL_MS` (`0` disables) so a model request does not always make a KMS
round trip; the cache is bounded, nothing else is cached — never a plaintext, never the
master key — and a cached key is zeroed when it expires or is evicted. Each stored row
records which provider wrapped it, so a secret is refused by a provider that did not wrap it
with an error naming both — switching providers means re-saving credentials.

A variable that is set but empty counts as unset. A value that cannot be what it claims — a
`PORT` that is not a port, an `OPENHARNESS_TEST_MODEL` that is not `mock` — fails the boot
with a message naming the variable, rather than coming up in a state nobody asked for. The
boot also needs **a way to sign in**: with no `*_CLIENT_ID`/`*_SECRET` pair configured and
`OPENHARNESS_DEV_LOGIN` off, `readServerConfig` refuses to start — every route is behind a
session nobody could create — and says which variables to set.

**The store.** With `DATABASE_URL`, `main.ts` builds a pool, runs `migrate()` (idempotent, so
two instances starting together are safe) and hands the pool to `createPostgresSessionStore`.
Without it, the server runs on `InMemorySessionStore` and says so loudly at startup: that mode
is for local development and quick trials, and nothing survives a restart.

## Authentication and ownership (epic #65)

**Better Auth** (1.7.6 — one version for the whole repo, `apps/web` included) is mounted at
`/api/auth/*` in this app (`app.ts`), configured in
`auth.ts` and run against the same database the log uses — the Kysely handle `main.ts` already
built for the migrations, or Better Auth's in-memory adapter when there is no `DATABASE_URL`.
Its own migrator is never called: the tables (`user`, `session`, `account`, `verification`,
`deviceCode`) are created by `@openharness/session`'s migrations 0011–0013, generated from
exactly this plugin list — core + `google`/`github`/`microsoft` + `device-authorization` +
`bearer` — so the configuration and the schema have to keep matching; a Postgres test asserts
Better Auth's own schema check passes on the migrated database.

- **Providers** are enabled only when their `*_CLIENT_ID`/`*_SECRET` are set — both, or
  neither; with both empty (i.e. unset) the provider has no button — and `/v1/auth-config`
  reports the list (the interface agreed with the web app, #62). **At least one provider, or
  the dev login, has to be configured**: with neither the boot fails, naming the variables to
  set, because nobody could ever sign in.
- **Identity is the verified email** (A3), enforced by `auth-profile.ts`: Google's
  `email_verified`, GitHub's _primary verified_ address, and Microsoft's claims (personal
  accounts, `xms_edov`, the verified lists) — the nOAuth guard. The two boolean-shaped flags
  (`email_verified`, `xms_edov`) are read through `affirmativeClaim`: Microsoft documents
  `xms_edov` as a Boolean but a token carries it as a string (`"1"`/`"0"`), so `true`, `1`, and
  (trimmed, case-insensitively) `"true"`/`"1"` are affirmative and **everything else** —
  `false`, `0`, `"0"`, `"false"`, empty, any other string, absent — is not. A **personal**
  Microsoft account is vouched for by `xms_edov` alone (the `verified_*` lists are an Entra
  work/school thing), which the app registration must request as an optional **ID** claim
  alongside `email` (`docs/DEPLOYMENT.md`). A provider that cannot prove the address refuses
  the sign-in (`email_not_verified`, 403) before a user or a link is created;
  `databaseHooks.user.create.before` (`refuseUnverifiedUser`) is the last gate, and
  implicit linking follows the same email with no trusted-provider shortcut. A **Microsoft
  refusal also logs one `WARNING`** (`MICROSOFT_REFUSAL_LOG`, via the logger `createAuth`
  passes into `providerOptions`): the decoded token's claim **names** (sorted), the `tid` and
  `iss` values, the **type** of each claim the rule reads (`absent` / `boolean` / `string` /
  `array(n)`), whether the lowercased `email` is in either verified list, and `hasEmail` — plus
  the one claim value that is a flag and never personal data, `xmsEdovValue`: the raw `xms_edov`
  value when it is a boolean, a number, or a string of at most eight characters, and
  `'<omitted>'` otherwise (an absent claim included). No address, name or token ever reaches the
  line, which is what tells the "the optional claim is configured in the portal" case (a name
  present, a type that is not `absent`) from the "Microsoft never sent it" one.
- **Sessions** are opaque tokens in the database: 7 days, sliding at most once a day, and
  **fresh** (created within a day) for credential writes. The device-authorization plugin
  accepts the CLI's `openharness-cli` client id and approves at the web app's hash route
  `<BETTER_AUTH_URL>/#/device` — `verification_uri` is exactly that, and
  `verification_uri_complete` carries `?user_code=…` **inside the fragment**, where the app's
  router reads it (`auth.ts` rewrites the field Better Auth built, whose query lands before
  the `#`; see the after-hook there). Its codes live ten minutes. Rate limiting is on, with
  counters owned by each instance.
- **`/v1` needs a session** (cookie or bearer), else 401: `auth-guard.ts` resolves it through
  Better Auth and puts `user`/`session` on the request. A cookie-authenticated **write** also
  needs an `Origin` of `BETTER_AUTH_URL`'s origin — CSRF, because a browser attaches cookies to
  any page's request; bearer requests are exempt, since a page cannot set that header
  cross-origin. `/v1/auth-config` is registered ahead of the guard; `/api/auth/*` is Better
  Auth's own.
- **Better Auth's own origin check is on outside a test process.** `/api/auth/*` refuses a
  sign-in POST whose `Origin` is not `trustedOrigins`' entry — the public URL — and a
  cookieless one that carries Fetch-Metadata headers (Node's `fetch` sends
  `sec-fetch-mode: cors`) with no `Origin` at all (`MISSING_OR_NULL_ORIGIN`, 403). Better
  Auth skips the whole check when `NODE_ENV=test` — which is what vitest sets — so
  `AuthConfig.enforceOriginCheck` (tests only; nothing sets it in production, and nothing
  anywhere turns the check off) forces it on for `auth.test.ts`, and the e2e suite runs its
  servers with `NODE_ENV=production` for the same reason (#79).
- **Revocation is immediate, and reaches open responses** (A2; issue #76). The guard validates
  once per request, and an SSE stream is one long request — so the stream and the AI SDK
  adapter watch their own session. `session-watch.ts` holds both halves:
  `createSessionRevocations` keys every open response by the session **id** (`session.id`,
  never the token) and is the app's `RouteDeps.revocations`; `startSessionRecheck` re-validates
  the session with Better Auth (`auth.api.getSession` on the caller's own headers — the row
  exists and has not expired) every `DEFAULT_SESSION_RECHECK_MS` (15 s, the "at most 30 s"
  backstop), which is what closes a stream for an **expired** session and for a notification
  that was missed. A revocation is published on the store's revocation channel
  (`notifyAuthSessionRevoked`) by two sources: Better Auth's
  `databaseHooks.session.delete.after` — sign-out, bearer `oh logout`, `revoke-other-sessions`,
  every Better Auth deletion — wired in `auth.ts`/`main.ts`, and on Postgres a trigger on
  `"session"` (`packages/session` migration `0014`), which is what catches an operator's plain
  `delete`. Postgres announces with `NOTIFY`, so **every instance** closes its streams whichever
  instance handled the revocation; the in-memory store does the same in-process. Payloads and
  logs carry the session id only.
- **Ownership** (A4): routes create with `c.get('user').id` and read through the store's
  **required** owner scope (`getAgent(…, { ownerId })`, `listAgents({ ownerId })`, …); another
  user's resource is a 404. The brain and the scheduler use the explicitly unscoped methods.
  `apps/server/src/isolation.test.ts` sweeps every `/v1` route with a second user.
- **Provider credentials** (A5) live in `credentials.ts`: a `PUT` validates the key with one
  cheap provider call (`provider-validation.ts`, injectable so tests never hit a network),
  seals `{ type: 'api_key', api_key }` with `@openharness/vault` under AAD `userId|provider`,
  and stores it through `CredentialStore`. `createSessionCredentialResolver` — the resolver the
  runner hands the brain, bound to the session — looks up the session's owner (unscoped read:
  a turn acts for a session), opens the sealed row for the one request, and answers the
  brain's `(provider) => …` question. Nothing caches a plaintext; nothing echoes one. Both
  credential writes also maintain the caller's automatic default model (epic #116, U4) — see
  "Preferences and the automatic default" — and `GET`/`PUT /v1/me/preferences` are that
  default's settings screen.
- **Dev login** (A7): `OPENHARNESS_DEV_LOGIN=1` seeds `dev@localhost` / `dev`
  (`DEV_LOGIN_EMAIL`). Better Auth's email validation refuses a dotless domain, so the row is
  stored as `dev@localhost.localdomain` and a dev-login-only shim (`rewriteDevLoginRequest`)
  maps the documented spelling onto it; sign-up stays disabled, so those are the only password
  credentials that exist. The boot refuses the flag unless `BETTER_AUTH_URL` is localhost.

## The model catalogue (epic #92)

`GET /v1/models` answers **the chat models the caller's own provider credentials can use**,
one entry per model and one status per provider — the list the clients' model pickers offer
(#91/#92, model-first chat), and the context windows the per-model context budget resolves
against (#246, below). `catalog/` is the whole of it; the route (`routes/models.ts`) only
parses the query and maps the one error it can raise.

- **C1 — the list comes from the provider, with the caller's key.** Per provider the server
  calls that provider's own list endpoint with the credential stored for the caller, decrypted
  for that call only (`openApiKey`, the same vault path the brain's resolver uses). The
  endpoints are a fixed table in `catalog/adapters.ts` — OpenAI `GET /v1/models`, Anthropic
  `GET /v1/models` (`x-api-key` + `anthropic-version`), Gemini `GET /v1beta/models` (the key in
  the `x-goog-api-key` header, never the URL), OpenRouter `GET /api/v1/models`, and the
  OpenAI-compatible family (`GET <base>/models`, bearer) for Groq, DeepSeek, Fireworks,
  Mistral, Together, xAI and Cerebras. Every URL is a constant of that module: **no request
  ever supplies a URL**, so there is no SSRF surface. Each call has a 5-second deadline
  (`AbortSignal.timeout`), shared by all pages of one provider. The catalogue asks for a page
  size of 1000 and follows Anthropic's `has_more`/`last_id` and Gemini's `nextPageToken`;
  OpenRouter and the OpenAI-compatible family answer in one page. A provider that pages
  forever stops at `MAX_PAGES`.
- **C2 — the registry join and the filter.** `catalog/registry.ts` reads
  `apps/server/src/catalog/models-dev.json`, a snapshot of models.dev committed to this
  package and bundled into `dist/index.js` — never read from the network, and never from a
  path that could be missing at runtime. **The exact rule**, per provider-listed model:
  1. **An explicit non-chat verdict drops it** — the registry's classification, or the
     provider's own capability data (Gemini's `supportedGenerationMethods` without
     `generateContent`).
  2. **An explicit chat verdict keeps it** — the registry's classification, OpenRouter's
     chat-only catalogue, Gemini with `generateContent`.
  3. **Otherwise the conservative name filter decides** (`catalog/filter.ts`): an id naming a
     known non-chat family is dropped, every other id is kept. The families are `embed`,
     `tts`, `whisper`, `transcri*`, `speech`, `dall-e`/`dalle`, `gpt-image`, `image`, `imagen`,
     `moderation`, `realtime`, `audio`, `search`, `rerank`, `sora`, `babbage`/`davinci`, and
     `instruct` — word-like patterns, so `gpt-4o-search-preview` goes and `o3-deep-research`
     stays. The principle is asymmetric on purpose: an unfamiliar id is **kept**, because
     hiding a usable chat model is the failure the epic is about.

  **The price** comes from the snapshot alone (`cost` on a `ModelEntry`, #247): no provider's
  list-models payload carries what it charges. models.dev publishes rates per million tokens,
  and the refresh script keeps the ones it has — `input` and `output` for every priced model,
  the two cache rates where they exist. It is what a client prices a reply with, so a model the
  snapshot does not price reports `cost: null` and its requests keep their tokens and report no
  money. The name, context window and max output of an entry come from the provider's own payload
  where it has them (Gemini's `displayName`/`inputTokenLimit`/`outputTokenLimit`, OpenRouter's
  `name`/`context_length`/`top_provider.max_completion_tokens`), from the snapshot where it
  has them, and from the model id otherwise; `null` is a legitimate value for the two limits.
  **What the snapshot actually carries** — the model's own `name`, `limit.context` and
  `limit.output`, for the 11 providers whose keys this server can validate; it is keyed by our
  provider ids, so `fireworks`/`together` are models.dev's `fireworks-ai`/`togetherai` mapped
  at generation time. It carries **no chat flag, and could not**: models.dev has none, and the
  fields it does have are not one — `modalities.output` is `["text"]` for
  `text-embedding-3-small` too, and `family` is a name family. So step 3 is what classifies,
  and its principle is unchanged. `RegistryModel` still carries `name`/`contextWindow`/
  `maxOutput`/`chat`, so a registry that finds a real chat signal is a one-place change; the
  tests inject a stub with all four to pin the join itself. The limits the snapshot supplies
  are what fill the `null`s the provider's own list leaves for OpenAI, Anthropic and the rest
  (`model-catalog.test.ts` pins the OpenAI and Anthropic entries end to end).

  Regenerate it with `yarn workspace @openharness/server catalog:refresh`
  (`scripts/refresh-models-dev.mjs`), which fetches https://models.dev/api.json, maps the
  provider keys and writes the file; the snapshot's date is in the file (`SNAPSHOT_DATE`). It
  is a source file like any other — nothing fetches at build, test or boot time, and a sandbox
  with no network still builds. The data is only as fresh as a commit.

- **C3 — fallback is visible, never silent.** A provider that times out (5 s), fails (non-2xx,
  an unreadable body, a transport error), cannot have its credential opened, or has no adapter
  at all is answered from the registry instead: `status: "fallback"`, `fetched_at: null`, and a
  `message` saying why — the provider's status and a bounded snippet of what it said, or the
  plain reason. The registry's own list goes through the same C2 filter (it lists embeddings
  too), and its entries carry `source: "registry"`.
- **C4 — the cache.** `catalog/cache.ts` holds one entry per (user, provider) in this process
  for an hour (`CatalogCache`, `DEFAULT_CATALOG_TTL_MS`), nothing in Postgres. Saving or
  deleting a credential calls `ModelCatalog.invalidate(userId, provider)` from the
  PUT/DELETE routes — this instance only; other instances expire by TTL. `refresh=true`
  bypasses the cache for every provider the caller has a key for and is rate-limited to once a
  minute per user (`RefreshLimiter`): inside the window the request is the protocol's 429
  `rate_limit_error`, raised as `CatalogRefreshLimitedError` inside the catalogue and mapped
  in the route.
- **C5 — only providers with a key are listed.** The providers come from
  `credentials.list({ userId })`; a caller with none gets `{ data: [], providers: [] }` and not
  one outbound request. Another user's keys are never read: the owner is `c.get('user').id`,
  always, and `model-catalog.test.ts` has the case — two callers, one key each, every recorded
  provider request carrying the right one.
- **Security.** The key is opened per provider call and lives for that call; nothing caches a
  plaintext. Anything the provider said is scrubbed with `redactSecret` (the brain's redaction:
  the whole key, minus four leading or trailing characters) before it reaches a `message` or a
  log line. `provider-validation.ts` gained the family's providers (Mistral, Together, xAI,
  Cerebras) so a key that can be stored can also be listed — `model-catalog.test.ts` pins the
  invariant that every `VALIDATABLE_PROVIDERS` entry has an adapter.
- **The egress proxy.** Provider calls go through `catalog/provider-fetch.ts`: Node's `fetch`
  over undici's `EnvHttpProxyAgent`, which reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` —
  the documented egress-proxy variables (`e2e/AGENTS.md`) — so a deployment behind a proxy
  works without also remembering `NODE_USE_ENV_PROXY=1`, which plain `fetch` would need. With
  no proxy configured it is an ordinary direct connection. `provider-validation.ts` (the call
  a saved key is checked with) goes through the same client: one outbound path for the whole
  server. `ProviderFetch` is the one seam the tests replace: no test reaches a provider, and
  the harness's default catalogue is inert (an empty registry and a fetch that refuses).

## The context budget, per model (#246)

Every model request is trimmed to a history budget, and the budget is the request's **model's**
— not one number for every model, and not the session's. Before #246 the brain trimmed
everything to `DEFAULT_CONTEXT_TOKEN_BUDGET` (32,768): a 200k-token model forgot a long chat
early, and a model smaller than the default could be handed more than it can take. The rule is

```
budget = contextWindow − min(maxOutput, 25% of contextWindow)
```

— what is subtracted is room for the reply: the model's own output ceiling when the registry has
one, and 25% of the window when it does not. The numbers come from the bundled models.dev
registry (`catalog/registry.ts`, the same snapshot the catalogue joins for its model pickers),
so this costs no network call. The trimming itself is the brain's, unchanged: oldest complete
turns dropped first, never the newest turn.

`catalog/context-budget.ts` is the whole of it: `contextTokenBudget` is the rule, and
`createTokenBudgetResolver(registry)` answers `(modelId) => budget | undefined` — a `find` over
the registry's list for the id's provider. It is a **resolver rather than a record** because the
registry holds hundreds of models and the snapshot is refreshed wholesale: a record would mean
enumerating all of it to answer for the one id a request runs, and rebuilding it whenever the
snapshot changed. `undefined` is a real answer — an unknown provider, a model the snapshot
predates, a free-text id a host accepts (C5), or a model with no window — and the brain's
`DEFAULT_CONTEXT_TOKEN_BUDGET` is what such a model gets; the fallback lives in one place rather
than being repeated here.

`main.ts` builds one resolver from the same registry the catalogue and the automatic default
(U4) use, and hands the strategy to whichever scheduler the config asks for. The brain re-reads
the session at every request boundary (`span.model_request_start.model` is that request's
model), so the lookup is per request and a **mid-session model switch trims to the new model
from the next request on** — `model-switch.test.ts` pins it end to end. Nothing stores the
resolved budget: it is not on the span, and it does not need to be, the prompt a request was
built with being the observable — `test-support/model.ts`'s scripted model records each
request's whole prompt (`ScriptedModel.histories`) for the tests that read it. The harness
(`createTestApp`) wires the same strategy as `main.ts`, against the injected registry, so a test
with none gets the brain's 32,768-token fallback, exactly as it did before the budget was per
model.

## Usage and cost (epic #245, A2; issue #247)

`GET /v1/sessions/{session_id}/usage` and `GET /v1/me/usage` answer what was spent, and `usage.ts`
is the whole of it. Both are **reads of the log**: a model request is a
`span.model_request_start` (which names the model) followed by the `span.model_request_end` that
reports its tokens, so `createUsageReader` pairs the two — through the store's replay read, which
skips what a supersession covers, so a branch a `session.rewind` replaced is **not billed** —
prices each request with the registry's rates, and assembles the totals and the per-model split.

- **Cost is computed on read and never stored.** `registryPrices(registry)` builds the price
  lookup over the same bundled snapshot the catalogue joins (`cost` on a `RegistryModel`), and
  the arithmetic is the protocol's `usageCost`/`totalCost` — the same functions the frontends
  price a reply with. A model the snapshot does not price contributes its tokens and no cost, and
  a total **sums the requests it can price and counts the rest** (`cost` plus
  `unpriced_requests`, #247 decided 2026-10-09): one such request no longer turns a whole total
  into `—`, the unknown part is named rather than guessed, and `cost` is `null` only when nothing
  in the total could be priced. A request whose span start named no model (a log from before the
  field existed) is in the totals and in no breakdown, and counts among the unpriced ones.
- **The per-session route** is owner-scoped (another user's session is the store's
  `SessionNotFoundError`, which `app.onError` maps to the 404) and reads that session's whole
  log. **The per-user route** has no id in its path — it is always the caller — and is **one
  store read**, not a walk: the range's local days become a UTC window (`utcWindowOf`), the
  store's `listModelRequests` answers the caller's own model requests in it in one query, and
  what comes back is grouped by local day. Walking the caller's sessions and reading each log
  page by page — what this did first — read every event of a month of heavy use on every
  request, which is the cost the store method exists to remove. Usage is broken down **by
  model, never by mode**, and days are **absent rather than zero** where nothing ran.
- **Local days** are `local-day.ts`: `usageRange` reads the `tz` query parameter (400 for a zone
  the runtime does not know — never a silent UTC), defaults the range to the current month so
  far in that zone, and refuses a `from` after `to`. `localDayOf` reads an instant as the day it
  fell on there with `Intl`, rather than with Postgres' `AT TIME ZONE`: the in-memory store has
  no SQL at all, the frontends read their own zone from the same `Intl` data, and the semantics
  (which day an instant belongs to, DST included) are identical. `utcWindowOf` turns the range
  into the half-open UTC window the store read takes — local midnight of `from` to local
  midnight after `to` — by asking `localDayOf` for a day's first instant rather than by adding
  offsets, so a 23- or 25-hour DST day and a zone whose day does not begin at midnight are both
  exact. Nothing is rolled up or stored, so two readers in two zones get two right answers from
  one log.
- `usage.test.ts` (the routes: ownership, ranges, zones, a rewind not billed, unpriced models,
  and the one store read — the store counts its calls, so a `listSessions`/`listEvents` walk
  would fail the test) and `local-day.test.ts` (the day arithmetic on its own, DST-window
  conversion included) are the in-process halves; `e2e/src/usage.test.ts` is the same routes
  against a real server process and Postgres.

## Errors

Every failure is the protocol's envelope — `{ type: 'error', error: { type, message } }` with
the status `API_ERROR_STATUS_BY_TYPE` gives that type — and every response carries a
`request-id` header the body repeats as `request_id`.

| what happened                                               | type                          | status |
| ----------------------------------------------------------- | ----------------------------- | ------ |
| a body, query or path id that does not match a schema       | `invalid_request_error`       | 400    |
| a store cursor that is valid but not for this endpoint      | `invalid_request_error`       | 400    |
| no session, or an invalid, expired or revoked one           | `authentication_error`        | 401    |
| a cookie-authenticated write from an untrusted origin       | `permission_error`            | 403    |
| a provider key the provider refused on save (A5)            | `invalid_provider_credential` | 422    |
| a `?refresh=true` inside the minute since the last one (C4) | `rate_limit_error`            | 429    |
| an id that names no agent or session                        | `not_found_error`             | 404    |
| a route that does not exist                                 | `not_found_error`             | 404    |
| anything else                                               | `api_error`                   | 500    |

A malformed path id is a 400 rather than a 404: it could not name a resource even if one
existed. Anything unrecognised is logged server-side and answered with a fixed message — a
stack trace is never part of a response.

## SSE

`GET …/events/stream` is the live half of the log, in the format `packages/client` reads:

- one message per event, `data: <the JSON StreamEvent>`;
- every event carries `id: <seq>` — the resume position; every event is a stored one since P4,
  so the field is never absent — except the stream-only `session.deleted`, which carries none;
- `: ping` comments every 15 seconds when nothing else is happening;
- `event: error` is the one named event, and it is the goodbye: the session behind the
  connection was revoked or expired, the payload is the protocol's `authentication_error`
  envelope, and the connection closes right after (see "Authentication and ownership" and
  `SESSION_INVALID_MESSAGE` in `sse.ts`).

A hard-deleted session ends its streams differently (epic #116, U5): the store hands every
subscriber one final `session.deleted` `StreamEvent` naming the session and ends the
subscription, and the stream delivers that event and closes with it — the event _is_ the
goodbye, and there is no `event: error` frame after it, because a deletion is not a revocation
or an expiry. A connection whose replay read finds the session already gone ends the same way.
The stream never fetches anything for a deleted log: a `SessionNotFoundError` out of the
replay moves straight to the flush and the end.

The replay position comes from `after_seq` if the query carries it, otherwise from the
`last-event-id` header a reconnecting client sends back, otherwise from nowhere — and "nowhere"
means **live only**, which is the client's documented default. A header that is not a position
this server handed out (a `sevt_` id, say) is ignored rather than refused.

Replay and live delivery are stitched together so a client cannot tell where one ended:

1. **subscribe first** — the store starts buffering everything that happens from here;
2. **replay** the log after the resume position, page by page — `listEvents`, the replay read,
   which skips superseded chunks;
3. **flush the buffer**, dropping anything at or below the last `seq` the replay covered,
   which is exactly the overlap — whether the replay wrote an event or filtered it out.

`event_start` / `event_delta` — a reply's chunks — go only to a connection that asked for them
with `event_deltas[]=agent.message`, in **both** halves: a connection that did not opt in never
sees a chunk in a replay either. Disconnecting cancels the body stream, and that is what ends
the store subscription and the keepalive timer — there is nothing left running for a client
that has gone away.

The stream also ends when the **session** behind it does (A2; issue #76): the route registers
the connection with the app's revocation registry and gives the stream a re-check, so a
revocation closes it promptly — on every instance — and an expired session closes it within
the re-check interval. The connection's last frame is `SSE_SESSION_INVALID`
(`event: error`, the protocol's `authentication_error` envelope) whenever the stream ends for
a session reason; a client disconnect sends nothing, because there is nobody to send it to.
The AI SDK adapter follows the same rules with an `error` chunk carrying
`SESSION_INVALID_MESSAGE`.

### Mid-reply connections (D9)

Since D9 (issue #46) the brain stores each chunk as it streams, so a reply in flight **is** the
log: a connection that opens mid-reply — a reloaded page, a second tab — replays the chunks
already written under `seq` like any other event, and the stored `agent.message` supersedes
them at the end of the turn. A client resuming from inside a reply's chunks gets the
remaining chunks and then the message; after compaction has deleted the chunks it gets the
message alone, which is the same conversation (the message's position is where its range
started).

`GET …/events` — the list the clients load history with — is the same replay read: it skips
superseded chunks and returns the chunks of a reply still in flight, which is exactly what a
client that opens mid-reply needs before it continues on the stream.

### Compaction

The other half of D9's superseding is physical: `DeltaCompactor` (`compaction.ts`) calls
`store.compact({ olderThan: now − OPENHARNESS_DELTA_RETENTION_MS })` every
`OPENHARNESS_COMPACT_INTERVAL_MS` and logs what it deleted at debug. It runs in **every
scheduler mode** and on every instance — compaction is idempotent and safe from several
instances at once, so there is nothing to coordinate — and its timer is `unref`'d, so a job
that only deletes old rows never keeps a process alive. `stop()` clears the timer and waits for
a run in flight, which is what makes shutdown safe to close the store right after. A failing
run is logged and retried next tick; it never takes the server down. An interval of `0`
disables the job.

Deleting changes no reader's answer — replay already skips superseded chunks — so nothing in
the API depends on the window, and a client never needs to know whether compaction has run.

### Session titles (#29)

A session is named after the first `user.message` it is sent: `POST …/events`, and the
`initial_events` of `POST /v1/sessions`, derive a title from it and set it, in the same request
that stores the message — the creation response carries the title it just set. The rule is
`deriveSessionTitle` in `titles.ts`: the first non-empty line, whitespace collapsed, trimmed
and cut to the protocol's `SESSION_TITLE_MAX_LENGTH` with an ellipsis. It is written **once**:
a title supplied at creation, and one an earlier message produced, is never replaced, and a
message with no text leaves the title `null`.

### Model-first sessions (#94)

Chatting does not require an agent (epic #92). `POST /v1/sessions` takes an agent, an inline
`model`, or both — the protocol's `CreateSessionRequestSchema` refinement refuses a request
naming neither, and the server answers it as the 400 `invalid_request_error` it is. What the
session _stores_ is its effective configuration, `model` and `system`, always: with an agent
those are the agent's, copied at creation (the snapshot stays in `agent`, whose four fields are
the agent's own values), and an inline `model`/`system` overrides either field. Without an
agent, `agent` is `null`, `model` is required and `system` defaults to `null` — and `routes/sessions.ts`
checks the inline id has the router's `provider/model` shape, at least two non-empty
slash-separated parts, or the request is a 400. It is a shape check, not a catalogue lookup:
the router accepts models the catalog does not know yet (C5).

The route passes the request's `model`/`system` into `SessionStore.createSession`'s options
(#93), and `effectiveSessionConfig` — shared by both stores — is the one place the merge
happens. **Creating a session never calls a provider and never needs a stored credential**: it
is a store write, so a key the owner lacks is not learned here. The turn is where it surfaces
— the brain reads `session.model` for the request and the owner's credential for its provider,
and a session whose owner has no key for it ends with the brain's `missing_provider_credential`
`session.error`, exactly as before. The AI SDK adapter and the title fallback (`titles.ts`
derives from the first message, whatever the session was created from) do not read the agent,
so both already work with `agent: null`.

A model can also be switched mid-chat (epic #116, U3): a `user.message` carrying `model`
projects onto `sessions.model` in the append transaction (#111), and the brain resolves the
session's **current** model at every request boundary, so the switch — a different provider
included — applies from the next message. `POST …/events` and the `initial_events` of
`POST /v1/sessions` check that id's `provider/model` shape (`model-id.ts`) and answer 400
otherwise; the check is shared with the session's inline model.

## Preferences and the automatic default (U1/U4)

`GET`/`PUT /v1/me/preferences` are `routes/me.ts` over the store's `getPreferences`/
`putPreferences`: the caller's `{ default_model }`, read and written whole, owner-only by
construction (the resource is the caller — there is no id in the path), with a malformed
`default_model` refused as the protocol's 400. A `PUT` is always the user's own choice, and
`DefaultModelPicker.markExplicit` is what tells the automatic default so.

`default-model.ts` is the whole of the automatic default (U4), and one instance lives per
`createApp` — its record of which users the _server_ picked for is in-process, the same
trade-off the catalog cache makes (the protocol's `UserPreferences` has no field for it), so
across a restart or another instance an automatic pick reads as an explicit one; the
behavioural difference is confined to one branch of a credential delete, below.

- **On credential `PUT`** (`routes/provider-credentials.ts`, after the catalogue
  invalidation): when the user has no `default_model`, one is picked. An existing default is
  never touched — not the user's own while its provider has a key, and not an automatic one
  either.
- **The pick** reads the user's **live catalog** (`catalog.list` — the `GET /v1/models` logic,
  with the key that was just saved and its cache entry just dropped): the first entry of
  `RECOMMENDED_DEFAULT_MODELS[provider]` (the curated table in `default-model.ts`, a
  capable-but-affordable everyday tier — **update it when better everyday models ship**)
  that the catalog lists, provider-by-provider, the saved provider first; otherwise the
  registry fallback: the newest model (`newestModelId`, by the version numbers in the id —
  the registry carries no dates) that `isEverydayModel` accepts, i.e. a chat model per the
  catalogue's own filter that is neither expensive nor reasoning-only by name. No pick at all
  leaves the default `null`.
- **On credential `DELETE`**: a default whose provider (its id's part before the first slash)
  still has a key is left alone. One whose provider is gone is **re-picked** from the
  providers that remain (or cleared when none does) **if it was automatic**, and **cleared**
  if the user chose it — their model can no longer run, and substituting another for their
  choice is not the server's to do. All of this runs only when the delete removed a row (#139):
  deleting a provider the account has no credential for deletes nothing, and a delete that
  deleted nothing leaves the stored preferences exactly as they were.
- A pick that fails (a store error, an unreadable catalog) is logged and swallowed: the
  credential write has already succeeded, and a settings screen is where a user fixes it.

## Scheduler

```ts
interface SessionScheduler {
  start(): Promise<void>
  stop(options?: { drainTimeoutMs?: number }): Promise<void>
  signal(sessionId: SessionId, kind: 'work' | 'interrupt'): void
  stopSession(sessionId: SessionId, options?: { drainTimeoutMs?: number }): Promise<void>
}
```

`stopSession` is `DELETE /v1/sessions/{id}`'s first half (U5): it aborts the turn running for
the session **and keeps the pass from starting another** (unlike a plain `interrupt`, which
ends its turn and then looks for more work — a queued message behind it must not start a turn
for a session being deleted), and it resolves once the pass has written its last events or the
drain timeout passed. A `LocalScheduler` stops its own runner; `PostgresPartitionScheduler`
does the same for a partition it holds, and for one it does not, routes the stop to the owner
through the partition's channel — where the same tolerance for a vanished session applies
below, because the delete may commit before the signal is handled.

Routes only ever call `signal`, and nothing else. Whether that reaches a brain in this process
or in another instance is the scheduler's business, which is what keeps the handlers unchanged
when ownership stops being trivial:

| implementation                   | how a signal reaches the owner                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `LocalScheduler` (this package)  | in-process: this server owns every partition                                                      |
| `PostgresPartitionScheduler` #11 | `store.signalPartition` onto the partition's channel, `store.onPartitionSignal` on the owner side |

`LocalScheduler` owns a queue and a `SessionRunner`. On `start()` it recovers: every session
`findSessionsNeedingWork` reports — queued user events, or a turn some dead process left open —
is queued. `work` enqueues the session, or wakes the pass already running for it; `interrupt`
aborts that pass's turn, and _starts a turn if none was running_, because a queued
`user.interrupt` still has to be claimed (the turn's idle event carries the claim, P4). At
most `OPENHARNESS_MAX_CONCURRENT_SESSIONS` sessions run at once; the rest wait their turn.
`stop()` accepts nothing more, aborts the turns in flight and gives them the drain timeout to
write their last events.

### `PostgresPartitionScheduler`

```ts
new PostgresPartitionScheduler({
  store,
  model,
  instanceId, // unique among the servers sharing the database
  partitions = 64, // must match the store's partition count
  ttlMs = 30000, // how long a lease lasts before it must be renewed
  heartbeatMs = 10000, // renew held leases, take free ones, give up surplus
  sweepMs = 60000, // re-scan owned partitions for work no signal mentioned
  maxConcurrentSessions = 4,
  drainTimeoutMs = 5000,
  retry,
  contextStrategy,
  runner,
  onError,
  onNotice, // a failure, a line about what it is doing
})
```

`SCHEDULER=postgres` builds it; `local` (the default) is the `LocalScheduler`. The one line
that changes for a route is the other way round: it does not change at all. Ownership is by
partition lease — `sessionId` hashes to one of `partitions`, and an instance runs a session
only while it holds that partition's lease, writing every turn under `fence: {partition, epoch}`.

- **Acquiring a partition** subscribes to its signals first and then recovers it
  (`findSessionsNeedingWork`), so a partition whose previous owner died is picked up, and
  whatever arrived before the subscription is found rather than lost.
- **Balancing is by explicit membership** (issue #122): every heartbeat upserts the instance's
  row in `scheduler_instances` (`heartbeatInstance`) and reads the members seen within one
  lease TTL back (`listLiveInstances`), so **share = `ceil(partitions / live members)`** and a
  scan takes free or expired partitions — never a live one — up to that share. An instance
  holding more than its share gives the surplus up, finishing the turns in it first and then
  releasing. There is **no periodic idle release**: an instance whose membership is only
  itself has the whole space as its share and keeps it; a newcomer is visible the moment it
  heartbeats, so the holder's next heartbeat releases the surplus for it — a release, not a
  steal, and never more than the share.
- **The membership ages out with the leases** — both windows are one lease TTL: a crashed
  instance stops heartbeating, so after a TTL it is out of every peer's count at the instant
  its leases stop being renewed, and the survivors' shares grow back to the whole space.
- **Losing a lease** — a refused renewal, or a `FencedError` out of a turn — aborts that
  partition's turns, ends its subscription and stops it running work for it. It never crashes
  the process. A refusal means the partition is **somebody else's** now: a lease that merely
  lapsed, with nobody taking it over, is renewable and kept (a lapse is stealable, not lost —
  see `@openharness/session`), so a refresh cycle that runs past the TTL because the process
  stalled or a round trip was slow costs an instance nothing. Without that rule an instance
  would drop every partition it held on one late cycle — aborting and re-running the turns in
  them — for no reason, since no peer ever wanted them.
- **`stop()`** drains the turns in flight, deletes the membership row (so peers stop counting
  the instance at once) and then releases every lease, so the next instance takes over at its
  next heartbeat instead of waiting out the TTL. A lease whose acquire was in flight when the
  stop began is released too, as soon as the scan sees the instance stopped — a stop never
  leaves a live lease (and so a stranded, unserved partition) behind.
- **`pause()`/`resume()`** stop and restart the timers without giving anything up: what a
  wedged process looks like from the outside, and what the zombie tests use.
- **`heldPartitions()`** is what an instance owns right now.

[`docs/scheduling.md`](./docs/scheduling.md) is the long version: partitions, leases, epochs,
signals, balancing, crashes and shutdown.

```ts
class SessionRunner {
  run(
    sessionId: SessionId,
    options?: { fence?: PartitionFence; signal?: AbortSignal },
  ): Promise<TurnOutcome>
  isRunning(sessionId: SessionId): boolean
  wake(sessionId: SessionId): boolean
  abort(sessionId: SessionId): boolean
  runningSessions(): SessionId[]
  stop(options?: { drainTimeoutMs?: number }): Promise<void>
}
```

`SessionRunner` is the reusable half: **one turn per session at a time**, and after a `runTurn`
resolves it looks at the log again — `getPendingUserEvents` and `getTurnState` — to run another
one if there is work (a message queued behind an interrupt, an open turn). It stops on `noop`,
which is what keeps a session that cannot make progress from spinning — but a `wake` that
arrived during that `noop` turn is honored first, because the brain reads the log before it
decides and a signal for an event appended in that window would otherwise be lost. Calling
`run()` while a pass is in flight does not start a second one: it wakes the pass and answers
with its outcome.

**This is the seam the partitioned scheduler reuses.** A `PostgresPartitionScheduler` acquires
partition leases, listens with `onPartitionSignal`, and calls the same
`runner.run(sessionId, { fence })` with the lease it holds — the `fence` goes straight to
`runTurn`, so a brain whose lease has been taken over stops at its first refused write. The
scheduler above decides _which_ sessions are owned; the runner decides _how_ they are run.

`run`'s optional `signal` is the other half of that: "this process should not be running this
session any more" — a shutdown, or a lease given up. A pass whose signal is already aborted
writes nothing and answers `noop`; one aborted mid-turn lets the turn end the way an interrupt
does and then stops instead of looking for more work. Nothing is lost either way: the work is in
the log, and the next owner finds it with `findSessionsNeedingWork`.

**A session that vanishes is not a failure** (U5). A hard delete removes the session while a
pass may still be running for it, so the runner treats `SessionNotFoundError` as an answer
rather than a rejection throughout: a turn that finds its session gone (the brain re-reads the
session at each request boundary and throws) ends the pass quietly, `#hasMoreWork` answers
`false` for a deleted session, and `run` never rejects for one — so a delete can never become
a crash loop or a retry.

## The test model hook

`OPENHARNESS_TEST_MODEL=mock` swaps the brain's provider factory for a deterministic model, so the
whole server — scheduler, brain, store, SSE, the AI SDK adapter — runs with no provider keys
and no network. It is an AI SDK `MockLanguageModelV4`, streamed through the same `streamText`
path a real provider goes through, and it lives in `mock-model.ts`; `resolveModelFactory` is
the only thing that constructs it, and it only does so when the variable says `mock`:

| last user message    | what happens                                                                |
| -------------------- | --------------------------------------------------------------------------- |
| anything else        | echoed back in 4 chunks, 25 ms apart                                        |
| `__slow__`           | 40 chunks, 250 ms apart — about 10 seconds, for interrupt and restart tests |
| `__fail_retryable__` | HTTP 503 (`model_overloaded_error`) on the **first** attempt, then the echo |
| `__fail_terminal__`  | HTTP 400 (`model_request_failed_error`) on every attempt                    |

A marker matches the _start_ of the message, so `__slow__ tell me something` still streams
slowly. Usage is fixed (`MOCK_MODEL_USAGE`: 42 input, 17 output, no cache) so a test can assert
the exact numbers a `span.model_request_end` carries. The retry marker counts attempts per
prompt, which is what lets it fail once and succeed on the retry inside one turn.

The mock needs no credential and ignores whatever it is handed, but the brain asks for one
before every request, so the mock path runs with `resolveMockCredential`, which answers a
placeholder for every session — without it the mock's turns would end with
`missing_provider_credential` like any other credential-less turn. The router path gets the
real session-bound resolver (`createSessionCredentialResolver`) instead.

The startup log says which model the process is running with, and the in-memory store warns
just as loudly: a server quietly answering with fixed text would be a bad surprise.

## The AI SDK adapter

`POST /v1/sessions/{id}/ai-sdk/chat` is a **compatibility extension**, not part of the
protocol: nothing in `@openharness/protocol` mentions UI message chunks, and
`packages/client` does not use this endpoint. It exists so a React app built on `useChat` can
talk to a session without knowing about the event log.

It takes the last `user` message's text out of the AI SDK request (`parts`, or a `content`
string), appends it as a `user.message`, signals the scheduler, and answers with a UI message
stream built from the session's live events: a reply's chunks become `text-start` / `text-delta` /
`text-end` under the `sevt_` id the brain announced, the stored `agent.message` closes the
block (streaming any tail the previews shed), a `session.error` becomes an `error` chunk, and
`session.status_idle` ends the response. The subscription is opened _before_ the message is
appended, so a turn that starts and finishes while the handler is still running is still seen —
and it is released in a `finally` however the response ended, because a subscription that
outlives its reader would keep buffering every later event of the session for nobody.

`session.status_idle` is also the only stored thing in the log that ends the response. A turn
that dies without writing one (a store failure mid-turn, which the scheduler logs and drops)
leaves the request open until the client disconnects: the client's own abort signal is what
closes it. The protocol's SSE stream has the same stay-open-until-disconnected property.

The session can also end the response (A2; issue #76): the adapter registers with the app's
revocation registry and re-checks the session on a timer, exactly as the SSE stream does, and
a revoked or expired session ends the response with an `error` chunk carrying
`SESSION_INVALID_MESSAGE` — the same fact the SSE stream says with a final `event: error`.

And a hard-deleted session ends it too (epic #116, U5): the store sends the subscription one
final `session.deleted` event, and the adapter's translation ends the response quietly on it
(any text block in flight is closed) — the UI-message-stream shape of the SSE stream's own
goodbye.

`trigger: 'regenerate-message'` is treated as "send the last user message again": v1 has no
regenerate semantics, and answering the same prompt again is the closest honest reading.

## Static web assets

With `OPENHARNESS_WEB_DIR` set, the server serves that directory at `/`: a request that names a
file gets it, and any other read outside `/v1` gets `index.html`, because the web app routes on
the URL hash. Paths that climb out of the directory are refused. The one exception is the
plain device path: `GET /device?user_code=…` answers a `302` to `/#/device?user_code=…`, the
hash route the device-approval page actually lives on (an older `verification_uri` shape, or
someone retyping the URL, lands on the page the reader meant instead of the app's home
screen). Without the variable there is no static serving at all, `/device` included: `/`
answers the API's 404.

Every served file carries the `Cache-Control` class it belongs to (see "Behind a load
balancer"): the content-hashed files under `assets/` are immutable for a year, `index.html`
(and the fallback that serves it) revalidates every time, and the other root files get an
hour — decided by the file that is actually served, so a request for a missing asset falls
back to the shell and is cached like the shell.

`HEAD` is served wherever `GET` is (#196), the `/device` redirect included: the same status,
the same `content-type`, `content-length` and `Cache-Control`, and no body. Browsers only
`GET`, but a link checker, an uptime probe, `curl -I` and a CDN revalidating a cached entry
all ask with `HEAD`, and the `404 no-store` it used to fall through to is what stopped Cloud
CDN from caching the file the `GET` beside it serves. The body is left out in `static.ts`
rather than by Hono's own `HEAD` handling, so the response this module builds is honest about
what it is; a path that is not the web app's still 404s exactly as before.

## CORS

Off by default. `OPENHARNESS_CORS_ORIGINS` (comma-separated) enables it for exactly those
origins — nothing else, and no wildcard. A browser talking to this API needs it; the web app
served from the same origin does not.

## Behind a load balancer (deployment epic #148, #151)

The target deployment is GKE behind Google's global external HTTPS load balancer — a **GKE
Gateway** (GatewayClass `gke-l7-global-external-managed`, #159), not an Ingress — with Cloud CDN
on the backend (`cacheMode: USE_ORIGIN_HEADERS`), one image serving the API at `/v1` and the
built web app at `/`. Three things in this package exist for it.

**The client IP.** `x-forwarded-for` is a list proxies append to, so the leftmost entries are
the client's to write and only what the deployment's own proxies appended can be trusted.
`OPENHARNESS_TRUSTED_PROXY_HOPS` says how many of those there are; the client IP is the entry
**one further from the right** (`trustedProxyHops + 1` entries from the right) — behind GCLB,
which appends `<client-ip>, <lb-ip>`, hops `1` picks `<client-ip>`, the entry no client could
have written. `client-ip.ts` is the one helper (`resolveClientIp`); the app resolves the IP
once per `/api/auth/*` request — or falls back to the connection's own address when the chain
is short, malformed or untrusted, so junk can never mint a rate-limit bucket — and hands it to
Better Auth on the one header it reads (`x-openharness-client-ip`, via `advanced.ipAddress`) —
see "Authentication". With the default `0` no forwarding header is read at all and the socket
address is the client IP; a client that sends `x-forwarded-for` cannot move itself — or anyone
else — between the rate-limit buckets Better Auth keys (the QA bug this fixed: behind a proxy
everyone shared one bucket, so one user's failed sign-ins blocked everyone). The
refresh rate limit (`RefreshLimiter`) is per user, so it needs nothing from this.

**The probes.** `/health` is **liveness** and does nothing — 200 while the process lives,
draining included; point the liveness probe at it. `/ready` is **readiness**: 200
`{status:"ok"}` only while the store answers `select 1` (about a 2 s deadline; the in-memory
store answers trivially) **and** the instance is not draining, 503 `{status:"unavailable"}`
otherwise — point the startup and readiness probes, and the load balancer's health check, at
it. `startServer` flips the drain flag the instant `shutdown()` is called, before the listener
closes, so the load balancer stops sending new requests while the turns in flight finish.
Neither probe needs a session and neither logs a hit. (The Kubernetes probe manifests, and the
`HealthCheckPolicy` that points the load balancer's health check at `/ready` — a Gateway does
not infer it from the readiness probe — belong to the Helm chart, #154/#159.)

**The cache headers.** Cloud CDN with `USE_ORIGIN_HEADERS` caches exactly what a response
says, so every response class has a directive:

| response class                                                                | `Cache-Control`                       |
| ----------------------------------------------------------------------------- | ------------------------------------- |
| Vite's content-hashed assets (`/assets/*`)                                    | `public, max-age=31536000, immutable` |
| `index.html` and the SPA fallback                                             | `no-cache`                            |
| other root static files (favicon, manifest, …)                                | `public, max-age=3600`                |
| `/v1/*`, `/api/auth/*`, `/health`, `/ready`, `/device`, and **every** non-2xx | `no-store`                            |

The last row is the safety rule, applied in one place (`app.ts`): nothing dynamic — a
session, an error body, an auth redirect — is ever stored by a shared cache, whatever route or
handler produced it. `/api/auth/*` responses also carry `Vary: Cookie` (they are built from
the session cookie), and a CORS-enabled response carries `Vary: Origin`, so anything reading
them without honouring `no-store` is told what they vary by.

## Observability (deployment epic #148, #158)

Two switches, both off on a laptop, both set by Terraform in the deployment. `observability/`
is the whole of it — nothing a route imports, and nothing that changes a route's behaviour.

**Logs.** `OPENHARNESS_LOG_FORMAT=json` makes the server write one Cloud Logging-shaped JSON
object per line to stdout instead of the readable one-line format: `severity`
(`DEBUG`/`INFO`/`WARNING`/`ERROR`), `message`, `time`, and the two `logging.googleapis.com/*`
keys when the line was written inside a request. A `detail` object a call site passes is merged
in as top-level fields — which is why `app.onError` now passes `{ error, method, path, status,
request_id }` rather than the bare `Error`: a failed request is findable in Logs Explorer by
path and status, joined to its trace. Nothing sensitive is ever written (`redact()` replaces
`authorization`, `cookie`, `*_secret`, `*_token`, `*_api_key`, passwords and credentials with
`[REDACTED]`, at any depth); the test that asserts this is `logging.test.ts`. `loggerFor()`
builds the logger the format asks for, and `main.ts`/`startServer` call it — a caller that
passes its own logger keeps it.

**Traces.** `OPENHARNESS_TRACING=cloud-trace` exports spans to Cloud Trace, sampling
`OPENHARNESS_TRACE_SAMPLE_RATE` (default `0.1`) of root traces. `initTracing()` is the one
entry point: `off` answers `noopTracer` without importing anything, and the Cloud Trace path
`await import()`s the OpenTelemetry SDK and the exporter, so an untraced server never loads
them. The exporter is `@google-cloud/opentelemetry-cloud-trace-exporter` — it authenticates
with ADC and refreshes its own OAuth token, which is what keeps a long-running pod exporting
(an OTLP header cannot be refreshed; see the TSDoc in `tracing.ts`).

Spans come from two places:

- **`app.ts`** opens one **server span** per request, as the outermost middleware. It honours
  the load balancer's `traceparent` / `X-Cloud-Trace-Context` (`parseTraceContext`), and puts
  the resulting ids in an `AsyncLocalStorage` (`runWithTraceContext`) for the whole request —
  which is exactly what the JSON logger reads, so a log line and its trace agree. With tracing
  off the header's ids still reach the log: a client's trace is not this server's to drop.
- **`session-traces.ts`** turns the session log into spans: a **turn span** per
  `session.status_running`…`session.status_idle`, and a **child span per model request** from
  `span.model_request_start`/`_end` with its token usage and error. It is fed by
  `withSessionTraces()`, a store proxy that intercepts `appendEvents` and forwards everything
  else — applied in `startServer` only when tracing is on, so an untraced server passes its
  store around unchanged. v1 has no tool-call events (`hands` is unused), so none are traced.

`initTracing` failing (an SDK that will not load) logs and answers `noopTracer`: a server that
cannot trace is still a server. `shutdown` flushes the tracer last of all, after the store.

## Shutdown

`SIGTERM` / `SIGINT` shut down in a fixed order: stop accepting requests, drain the scheduler
(abort the turns in flight, give them `OPENHARNESS_DRAIN_TIMEOUT_MS` to write their last
events), drop the connections still open — including SSE streams, which would otherwise never
end — and close the store. A second signal is ignored rather than allowed to interrupt the
drain. The drain starts the instant `shutdown()` is called — before the listener closes —
and `GET /ready` answers 503 from that moment, so a load balancer stops sending traffic
before the instance stops serving it (#151).

## Public API

| `@openharness/server`                                                                                                            | what it is                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `createApp(options)`                                                                                                             | the Hono app: routes, auth, errors, static assets — against any store/scheduler/auth      |
| `startServer(options)`                                                                                                           | store, migrations, model, scheduler, listener and a `shutdown()`                          |
| `main(env, options)`                                                                                                             | `startServer` from the environment, plus the signal handlers                              |
| `DeltaCompactor`                                                                                                                 | the periodic compaction of superseded chunks (D9)                                         |
| `DEFAULT_DELTA_RETENTION_MS`, `DEFAULT_COMPACT_INTERVAL_MS`                                                                      | `3600000`, `300000` — the compaction defaults                                             |
| `LocalScheduler`                                                                                                                 | the single-process `SessionScheduler`                                                     |
| `PostgresPartitionScheduler`                                                                                                     | the multi-instance `SessionScheduler`: partition leases, epochs, recovery (#11)           |
| `PassQueue`                                                                                                                      | the pass queue and concurrency limit both schedulers share                                |
| `SessionRunner`                                                                                                                  | the per-session turn loop, reusable: what both schedulers run passes with                 |
| `createAuth(config, database, logger)`                                                                                           | Better Auth configured for this server (A1/A2/A3/A7), plus `Auth`, `AuthConfig`           |
| `createSessionCredentialResolver(deps)`                                                                                          | the session owner's sealed key, opened per model request (A5)                             |
| `sealApiKey` / `openApiKey` / `credentialAad` / `credentialUpsert`                                                               | the credential sealing helpers (A5)                                                       |
| `createAuthGuard(options)`                                                                                                       | the `/v1` session + CSRF middleware (A2)                                                  |
| `createSessionRevocations(options)`                                                                                              | the registry of open responses a revocation closes, subscribed to the store (#76)         |
| `startSessionRecheck(options)`, `DEFAULT_SESSION_RECHECK_MS`                                                                     | the periodic session re-check of a long-lived response (#76)                              |
| `SESSION_INVALID_MESSAGE`, `SSE_SESSION_INVALID`                                                                                 | what a stream says when its session is revoked or expires (#76)                           |
| `validateProviderApiKey`, `VALIDATABLE_PROVIDERS`                                                                                | the one cheap provider call a saved key is checked with                                   |
| `ModelCatalog`, `ModelCatalogOptions`, `CatalogRefreshLimitedError`                                                              | the model catalogue: provider lists, registry join, cache, fallback (#90)                 |
| `createBundledRegistry()`, `emptyRegistry`, `SNAPSHOT_DATE`, `ModelRegistry`, `RegistryModel`                                    | the registry join's seam, over the bundled models.dev snapshot                            |
| `contextTokenBudget`, `createTokenBudgetResolver`, `OUTPUT_RESERVE_RATIO`                                                        | the per-model context budget: `contextWindow − min(maxOutput, 25%)`, per request (#246)   |
| `createProviderFetch()`, `ProviderFetch`, `DEFAULT_PROVIDER_TIMEOUT_MS`                                                          | the provider HTTP client: egress-proxy aware, 5 s deadline                                |
| `CatalogCache`, `RefreshLimiter`, `DEFAULT_CATALOG_TTL_MS`, `DEFAULT_REFRESH_INTERVAL_MS`                                        | the in-memory per-(user, provider) cache and the refresh rate limit (C4)                  |
| `adapterFor()`, `adaptedProviders()`, `isChatModel()`, `isNonChatFamily()`                                                       | the fixed endpoint table and the chat filter (C1/C2)                                      |
| `DefaultModelPicker`, `DefaultModelPickerOptions`, `RECOMMENDED_DEFAULT_MODELS`                                                  | the automatic default model: the picker, and the curated table it picks from (U4)         |
| `isEverydayModel()`, `isExpensiveModel()`, `isReasoningModel()`, `newestModelId()`                                               | the registry fallback's rule: everyday chat models, newest first (U4)                     |
| `DEV_LOGIN_EMAIL`, `DEV_LOGIN_PASSWORD`, `DEV_LOGIN_STORED_EMAIL`                                                                | the documented dev user (A7)                                                              |
| `OPENHARNESS_CLI_CLIENT_ID`, `DEVICE_CODE_EXPIRES_IN`                                                                            | the device flow's client id and code lifetime (A6)                                        |
| `deviceVerificationUri`, `deviceVerificationUriComplete`                                                                         | the approval URL the device flow answers with: `#/device` and its `?user_code=` (A6)      |
| `SOCIAL_PROVIDERS`, `providerOptions`, `microsoftEmailVerified`, `githubVerifiedPrimaryEmail`, `googleEmailVerified`             | the A3 identity rules                                                                     |
| `affirmativeClaim`                                                                                                               | the boolean-shaped claim parser: `true`/`1`/`"true"`/`"1"`, and nothing else (A3)         |
| `microsoftRefusalDetail`, `microsoftClaimType`, `xmsEdovLogValue`, `MICROSOFT_REFUSAL_LOG`, `MicrosoftRefusalDetail`             | what a refused Microsoft sign-in logs — names, types, and the `xms_edov` flag             |
| `createDevLoginUser`, `rewriteDevLoginRequest`, `refuseUnverifiedUser`                                                           | the dev-login seeding and shim, and the verified-email hook                               |
| `createMockModelFactory()`                                                                                                       | the deterministic test model, for a host that wires its own                               |
| `defaultInstanceId()`                                                                                                            | hostname + pid + random suffix: the id a server leases partitions under                   |
| `readServerConfig(env)`, `ServerConfig`, `ENV_VARS`, `readSecret`, `secretFileVar`                                               | the environment, parsed; a secret from `<NAME>` or its `<NAME>_FILE` (#154)               |
| `createConfigVault(config)`, `KeyProviderKind`                                                                                   | the vault the config asks for: the env key or Cloud KMS (#150)                            |
| `HttpError`, `rateLimitError`, `PACKAGE_NAME`, `Logger`                                                                          | the error types, the package name and the logging seam                                    |
| `resolveClientIp`, `withClientIpHeader`, `CLIENT_IP_HEADER`, `FORWARDED_FOR_HEADER`                                              | the client IP behind a proxy: one resolution, one header (#151)                           |
| `Readiness`, `alwaysReady`                                                                                                       | what `GET /ready` asks, and the no-database answer (#151)                                 |
| `checkDatabase`, `READINESS_QUERY_TIMEOUT_MS`                                                                                    | the Postgres side of `/ready`: `select 1` inside about 2 s (#151)                         |
| `DEFAULT_TRUSTED_PROXY_HOPS`                                                                                                     | `0` — no forwarding header trusted (#151)                                                 |
| `loggerFor`, `jsonLogger`, `redact`, `redactError`, `isSensitiveKey`, `detailFields`, `REDACTED`                                 | the Cloud Logging JSON logger and its redaction (#158)                                    |
| `parseTraceContext`, `parseTraceparent`, `parseCloudTraceContext`, `activeTraceContext`, `runWithTraceContext`, `TraceContext`   | the request's trace, and the async context the logger reads (#158)                        |
| `initTracing`, `noopTracer`, `Tracer`, `Span`, `StartSpanOptions`, `TracingMode`, `TracingOptions`, `AttributeValue`, `SpanKind` | the tracer seam, its no-op, and the lazy Cloud Trace implementation (#158)                |
| `SessionTraces`, `withSessionTraces`                                                                                             | the session log as turn and model-request spans, and the store proxy that feeds it (#158) |
| `DEFAULT_LOG_FORMAT`, `DEFAULT_TRACING`, `DEFAULT_TRACE_SAMPLE_RATE`, `LogFormat`                                                | `text`, `off`, `0.1` — the observability defaults (#158)                                  |

`node dist/index.js` runs `main()`, which reads the environment and starts the server.

## Layout

```
src/
  index.ts              the barrel; `node dist/index.js` starts the server
  main.ts               env → store (migrations) → auth → credentials → model → catalog → scheduler → listener → shutdown
  app.ts                createApp: middleware, the /api/auth mount, routes, error mapping, static fallback
  auth.ts               createAuth: Better Auth for this server (providers, plugins, sessions, dev login)
  auth-profile.ts       the A3 identity rules, and the provider options that enforce them
  auth-guard.ts         the /v1 session + CSRF middleware
  client-ip.ts          the client IP behind a proxy: which x-forwarded-for entry, and why (#151)
  session-watch.ts      revocation registry + periodic re-check for long-lived responses (#76)
  credentials.ts        sealing, opening and the session-bound credential resolver (A5)
  provider-validation.ts the one cheap provider call a saved key is checked with
  local-day.ts        local calendar days: the zone a request named, the day of an instant, and
                        the UTC window a range's days span (#247)
  usage.ts            what a session or a user spent: the log priced on read (#247)
  catalog/
    catalog.ts          ModelCatalog: per-provider fetch, join, filter, cache, fallback (#90)
    adapters.ts         the fixed provider endpoint table and each provider's payload shape
    registry.ts         ModelRegistry over the bundled models.dev snapshot (C2)
    context-budget.ts   the per-model context budget: the rule, and the resolver (#246)
    filter.ts           isChatModel: the never-hide/never-show rule, and the name families
    cache.ts            CatalogCache (one hour per user+provider) and RefreshLimiter (C4)
    provider-fetch.ts   ProviderFetch: fetch over the egress-proxy env, and the 5 s deadline
  config.ts             the environment, parsed and checked
  key-provider.ts       the vault the configuration asks for: the env key or Cloud KMS (#150)
  default-model.ts      the automatic default: the recommendation table, and the picker (U4)
  model-id.ts           the provider/model shape check the routes share (U1/U3)
  model.ts              which model factory the process runs (the router, or the mock)
  mock-model.ts         the deterministic test model and its markers
  runner.ts             SessionRunner: one turn per session, re-run while there is work
  compaction.ts         DeltaCompactor: the periodic deletion of superseded chunks (D9)
  scheduler.ts          SessionScheduler, LocalScheduler, partition helpers
  pass-queue.ts         PassQueue: the queue and the concurrency limit, shared by both
  partition-scheduler.ts PostgresPartitionScheduler: leases, epochs, signals, recovery (#11)
  sse.ts                the SSE body of a stream request
  titles.ts             naming a session after its first message (#29)
  static.ts             serving a built web app from OPENHARNESS_WEB_DIR
  types.ts              AppEnv (the Hono environment) and the Logger seam
  observability/
    logging.ts          the Cloud Logging JSON logger, and the redaction (#158)
    trace-context.ts    the request's trace, in an AsyncLocalStorage (#158)
    tracing.ts          the Tracer seam, the no-op, and the Cloud Trace exporter (#158)
    session-traces.ts   the session log as spans, and the store proxy that feeds it (#158)
  http/
    errors.ts           HttpError and the protocol's error envelope
    request.ts          body/query/path reading, through the protocol's schemas
  routes/               agents.ts, sessions.ts, events.ts, ai-sdk.ts, me.ts, models.ts, usage.ts,
                        provider-credentials.ts, plus deps.ts (RouteDeps) and signals.ts
                        (what a stored user event tells the scheduler)
  test-support/         test-only: scripted model, SSE reader, the server harness, Postgres
docs/scheduling.md      the multi-instance scheduler: partitions, leases, epochs, recovery
```

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/session`
- `@openharness/brain`
- `@openharness/hands`
- `@openharness/vault`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Testing

`src/**/*.test.ts` with Vitest (node environment), against `InMemorySessionStore` and a
scripted model. Route tests call the Hono app in-process (`app.request()`); the SSE and AI SDK
tests start a real listener on an ephemeral port, because what they assert — frames on a
socket, the client transport's own request shape — only exists over one.

Test **files** run one at a time (`fileParallelism: false` in `vitest.config.ts`): the three
suites that run against the same Postgres — `partition-scheduler.test.ts`,
`sse-postgres.test.ts` and `sse-revocation-postgres.test.ts` — each empty the tables they use,
so two of them in flight at once would delete each other's data. Packages still run in
parallel with each other.

- `app.test.ts` — every route, the error envelopes, auth, CORS, static assets (HEAD answered
  exactly like GET — status, headers, no body — for the shell, an asset, an SPA route, a
  missing asset and the `/device` redirect, #196), and the title a session gets from its first
  message.
- `sse.test.ts` — replay and live with no gaps or duplicates, `last-event-id` resume, the
  chunk opt-in (live and replay), keepalive, disconnect cleanup, and the D9 paths: a connection
  that opens mid-reply replaying the chunks in flight, a resume from inside a reply's chunks
  that gets the rest and then the message, and the same resume position being answered by the
  message alone once the chunks have been compacted away. The replies those tests hold open are
  held by the test (`defer`), not paced by a clock.
- `sse-postgres.test.ts` — the same mid-reply replay over a real Postgres store, where the
  chunks are rows another instance can read, plus compaction against the real SQL. Same
  database rule as `partition-scheduler.test.ts`: `DATABASE_URL`, otherwise a container,
  otherwise skipped.
- `sse-revocation.test.ts` — issue #76 over a real socket: a stream closes within about a
  second when the session behind it signs out (cookie and bearer), is deleted through Better
  Auth, or expires (the re-check, with its interval shortened); other sessions' and other
  users' streams keep delivering; and the AI SDK adapter ends with the same error chunk.
- `sse-revocation-postgres.test.ts` — the same closure where only a database can prove it:
  two instances on one Postgres, the stream on one and the sign-out on the other (the
  `NOTIFY` channel), and an operator's raw `delete from "session"` (the `0014` trigger).
  Same database rule as the other Postgres suites.
- `compaction.test.ts` — the job around `store.compact`: the retention window (nothing goes
  inside it, the superseded chunks go past it, idempotent), a reply still in flight staying
  put, the interval starting and stopping cleanly, `0` disabling it, a failing run that is
  logged rather than thrown, and `stop()` waiting for a run in flight.
- `titles.test.ts` — the derivation: first non-empty line, whitespace, truncation with an
  ellipsis, and the write path that never replaces a title that exists.
- `model-first-sessions.test.ts` — issue #94: creating from a model alone, from an agent, and
  from an agent plus an override (per field); the 400s (neither an agent nor a model, a
  malformed model id) and the 404 for another user's agent; `agent: null` round-tripping
  through GET and the list; and a turn on a model-first session, whose span names the session's
  model and whose request was built with the owner's credential for that model's provider.
- `preferences.test.ts` — `GET`/`PUT /v1/me/preferences` (U1): the null default, the round
  trip, the free-text id allowance, the 400s for a malformed `default_model` and a body
  without one, and isolation between two users.
- `default-model.test.ts` — the automatic default (U4): the first key setting a
  recommendation, an explicit choice never overridden, an automatic one re-picked from the
  remaining providers on a delete and cleared when none remain, an explicit one cleared, the
  registry fallback choosing the newest non-expensive non-reasoning model (with
  `newestModelId`’s version comparison), and the same flows over HTTP through the credential
  routes.
- `model-switch.test.ts` — U3 over HTTP: `user.message.model` stored on the event and
  projected onto the session, a 400 for a malformed id in `POST …/events` and in a creation's
  `initial_events` (nothing appended, no session created), and a message without a model
  leaving the session's model alone — plus the context budget of #246: a session that switches
  from a wide model to a narrow one carries the whole conversation into the wide model's
  request and only the newest message into the narrow one's (read off the prompts the scripted
  model recorded).
- `scheduler.test.ts` — one turn per session, steering, interrupts (running and idle), a
  message queued behind an interrupt, recovery on start, concurrency, stopping, and the fence
  reaching the store.
- `session-delete.test.ts` — U5: the 204 and the whole-log cascade (every read of the
  session throws or 404s), the 404 for another user and for an unknown id, a 400 for a
  malformed one, a running turn stopped with nothing appended after the delete resolved and
  no second request, `SessionRunner.stopSession` keeping a queued message from starting
  another turn, the noop a pass for a deleted session answers (and the `SessionNotFoundError`
  `runTurn` itself throws), a late signal for a deleted session not disturbing the scheduler,
  the final `session.deleted` an open SSE stream receives before it closes, and the AI SDK
  adapter’s response ending on it too.
- `partition-scheduler.test.ts` — the multi-instance scheduler against real Postgres, several
  instances in one process each with its own store connection: spread and takeover, the
  membership that gives an instance its share after a lost first-scan race (and three
  instances settling at theirs), a single idle instance releasing nothing over several TTLs
  (#122) and keeping every partition through a heartbeat cycle that outlives its lease (#185,
  deterministically, with a store whose first renewal is delayed past the TTL), a member that
  stops heartbeating dropped after about a TTL, `stop()` deleting the
  membership row and a restart re-joining, one turn per session, a crash mid-turn and the
  recovery that finishes it, a zombie that cannot write, a lease that cannot be renewed,
  interrupts routed across instances, the sweep, the fences a turn writes with, and shutdown
  handing its partitions back. Tests that are not _about_ lease loss run with long leases
  (`LONG_TTL_MS`), so a loaded runner cannot make a healthy instance look dead and turn their
  assertions into crash-recovery ones; only the pause/death/renewal and idle-release tests
  keep the short TTL. `DATABASE_URL` when it is set, otherwise a container, otherwise the
  suite is skipped with a note.
- `ai-sdk.test.ts` — the adapter through `DefaultChatTransport` and `readUIMessageStream`.
- `mock-model.test.ts` — the echo, `__slow__`, both failure markers, fixed usage, and that the
  hook cannot activate without the variable.
- `auth.test.ts` — the front door: the 401 sweep over every route, cookie and bearer, the
  CSRf rule, the device flow end to end (code, approve, token, bearer request), sign-out
  revoking, the dev login and its guard, the rate limiter refusing the fourth sign-in, and
  Better Auth's own origin check run with `enforceOriginCheck` — vitest's `NODE_ENV=test`
  skips it by default, which is the blind spot #79 fixed.
- `auth-profile.test.ts` — the A3 rules with mocked profiles: Microsoft's nOAuth claims,
  GitHub's primary-verified email, Google's `email_verified`, and the 403 each refusal is —
  the `affirmativeClaim` parser spelled out value by value (`true`/`"true"`/`"TRUE"`/`"1"`/`1`
  accepted; `false`/`"false"`/`"0"`/`0`/`""`/`"yes"` refused), the staging token (a consumer
  tenant with `xms_edov: "1"` and no verified lists) accepted and the same token with `"0"`
  refused — plus the refusal warning, parsed off a real `jsonLogger`: its `WARNING` severity,
  the sorted claim names, the `tid`/`iss` of a consumer-tenant token, each claim's type
  (`absent` beside `boolean`/`string`/`array(n)`), `xmsEdovValue` (the flag verbatim, or
  `'<omitted>'`), `hasEmail`, that an accepted sign-in writes nothing, and that no address or
  name appears anywhere in the serialized line.
- `isolation.test.ts` — two users, every `/v1` route walked as the second one: 404 for a
  by-id read, empty lists, no credentials of the other's, `/v1/me` answering the caller.
- `credentials.test.ts` — the write-only round trip, the 422 a refused key gets, the fresh
  session rule, the vault's AAD binding, "never in a response or a log", and the env-key test:
  with `OPENAI_API_KEY` set and no stored credential, a turn ends with
  `missing_provider_credential` and no request is made.
- `config.test.ts`, `main.test.ts` — the environment (including the three required variables
  and the dev-login guard), startup, recovery and shutdown, and `SCHEDULER=postgres` wiring
  the partitioned scheduler.
- `chart-values.test.ts` — the deployment's environment, booted: the chart's staging CI values
  (`charts/openharness/ci/staging-values.yaml`) with a `_FILE` for each `secrets` entry, the
  `OPENHARNESS_DEV_LOGIN=0` that crash-looped staging refused (#159), and the file's variables
  equal to the ones `infra/modules/app/locals.tf` sets for every environment.
- `client-ip.test.ts` — the helper behind #151: the socket address with no trusted hops (the
  header is not read at all), the `trustedProxyHops + 1`-from-the-right entry with hops (the
  GCLB shape, spoofed entries to the left ignored, whitespace, IPv6), the socket fallback for
  a short or malformed chain, and `withClientIpHeader` replacing a value a client set.
- `trusted-proxy.test.ts` — the same rule through the real stack: the sign-in rate limiter's
  buckets (a spoofed `x-forwarded-for` cannot move a client between them; with one trusted hop
  a GCLB chain keys by the client entry and a forged prefix changes nothing; garbage never
  mints a bucket), the `ipAddress` recorded on a session, and — over a real listener, from a
  loopback alias — that with no trusted hop the _socket_ address is the key whatever the
  header says.
- `ready.test.ts` — `GET /ready` (#151): 200 while the store answers, 503 while draining
  (without asking the store) or when the check fails, `/health` staying 200 either way,
  neither probe logging a hit, the drain flip on a real `startServer` (200 before
  `shutdown()`, 503 from the call on), and `checkDatabase`'s three answers — resolves,
  rejects, times out at about two seconds — which a stub pool can ask without a database; the
  Postgres suite runs against a real one when there is one.
- `cache-headers.test.ts` — the CDN classes (#151): immutable hashed assets, a revalidating
  shell (and the fallback that serves it, even for a missing `assets/` file), an hour for
  other root files, and `no-store` for `/v1`, `/api/auth/*` (with `Vary: Cookie`), the
  probes, the `/device` redirect and every error response — plus `Vary: Origin` where CORS
  makes a response vary by origin.
- `model-catalog.test.ts` — `GET /v1/models` (issue #90) over a **scripted fetch** and a
  registry stub: only the caller's providers are listed and only their URLs called, OpenAI's
  list filtered of embeddings/tts/whisper/dall-e/moderation, Gemini filtered by
  `supportedGenerationMethods` (both pages read), the registry joined for names and limits,
  a timeout and a 5xx answered from the registry as `fallback`, the cache hit / one-hour TTL /
  credential-write invalidation, `refresh=true` bypassing the cache and its 429 inside the
  minute, one user's keys never used for another's request, an unknown provider served from
  the registry without dialing anything, a tampered credential degrading to a fallback, and
  the key absent from every response, `message` and captured log line. No test ever reaches a
  provider: the catalogue's `fetch` seam is the only way out, and the harness's default
  catalogue refuses.
- `catalog/filter.test.ts`, `catalog/adapters.test.ts`, `catalog/registry.test.ts`,
  `catalog/cache.test.ts` — the pieces on their own: the name families and the verdict
  precedence, the endpoint table (constant URLs, each provider's header and payload shape,
  the `VALIDATABLE_PROVIDERS` ⊆ adapters invariant), the bundled registry read through
  the bundled models.dev snapshot (including that it carries no chat flag), and the TTL /
  invalidation / rate-limit rules on an injected clock.
- `catalog/context-budget.test.ts` (#246) — the budget rule on its own: the model's own output
  ceiling when it is under a quarter of the window, a quarter when none is declared, and the
  quarter as a ceiling however large the declared one is; and the resolver: a known window with
  and without `maxOutput`, a tiny model, a model id with a slash of its own, an unknown model
  and a known model with no window (both `undefined`, the brain's 32,768-token fallback), and
  the bundled snapshot answering a real window for a real model.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue. If a contract blocks you, work around it here and say so.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/server/docs/`.
