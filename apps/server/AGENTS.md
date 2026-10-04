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

| method   | path                                      | body / query                             | answers                                                                            |
| -------- | ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET`    | `/health`                                 | —                                        | `{ status: 'ok' }`; never needs a session                                          |
| `GET`    | `/v1/auth-config`                         | —                                        | `{ providers, dev_login }`; never needs a session                                  |
| `GET`    | `/v1/me`                                  | —                                        | the signed-in `User`                                                               |
| `POST`   | `/v1/agents`                              | `CreateAgentRequestSchema`               | 201, the `Agent`                                                                   |
| `GET`    | `/v1/agents`                              | `ListAgentsQuerySchema`                  | `{ data, next_page }`                                                              |
| `GET`    | `/v1/agents/{agent_id}`                   | —                                        | the `Agent`, or 404                                                                |
| `POST`   | `/v1/agents/{agent_id}`                   | `UpdateAgentRequestSchema`               | the updated `Agent`, or 404                                                        |
| `POST`   | `/v1/sessions`                            | `CreateSessionRequestSchema`             | 201, the `Session`; 404 for an unknown agent; 400 for neither an agent nor a model |
| `GET`    | `/v1/sessions`                            | `ListSessionsQuerySchema`                | `{ data, next_page }`                                                              |
| `GET`    | `/v1/sessions/{session_id}`               | —                                        | the `Session`, or 404                                                              |
| `POST`   | `/v1/sessions/{session_id}/events`        | `SendEventsRequestSchema`                | `{ data: user event[] }`; then signals, and a title                                |
| `GET`    | `/v1/sessions/{session_id}/events`        | `ListEventsQuerySchema`                  | `{ data, next_page }`                                                              |
| `GET`    | `/v1/sessions/{session_id}/events/stream` | `StreamEventsQuerySchema`                | the SSE stream; 404 for an unknown session                                         |
| `POST`   | `/v1/sessions/{session_id}/ai-sdk/chat`   | the AI SDK `useChat` request (see below) | an AI SDK UI message stream — an **extension**                                     |
| `GET`    | `/v1/models`                              | `ListModelsQuerySchema` (`refresh`)      | `{ data, providers }`; 429 for a refresh inside the minute                         |
| `PUT`    | `/v1/provider-credentials/{provider}`     | `PutProviderCredentialRequestSchema`     | the credential's metadata; 422 if the key is refused                               |
| `GET`    | `/v1/provider-credentials`                | —                                        | `{ data: ProviderCredential[] }`, metadata only                                    |
| `DELETE` | `/v1/provider-credentials/{provider}`     | —                                        | 204; never an error for one that is not there                                      |

Every `/v1` route except `auth-config` requires a session (see "Authentication"), and every
resource is scoped to its owner. `/api/auth/*` is Better Auth's own surface: sign-in, sign-out,
the device flow, `/api/auth/error`. Anything else answers 404 in the protocol's error envelope.

`POST …/events` is the only way user input enters the system, and it does two things in a
fixed order: it **stores** the events (`processed_at: null`, which is what makes them queued)
and only then tells the scheduler. The store call is what makes the request durable; the
signal is a latency optimization the scheduler can afford to lose (see "Signals are hints" in
`packages/session`).

Creating a session with `initial_events` goes through the same rules: the protocol says those
events are stored "before it starts running", so a `user.message` among them signals `work` and
a `user.interrupt` signals `interrupt` — exactly what the same events would do posted to
`POST …/events` afterwards.

## Environment variables

| variable                              | default                        | what it does                                                                                  |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | —                              | run on Postgres, migrating on boot; unset means in-memory                                     |
| `SCHEDULER`                           | `local`                        | `local`, or `postgres` for the multi-instance scheduler                                       |
| `BETTER_AUTH_SECRET`                  | — (**required**)               | signs sessions and cookies                                                                    |
| `BETTER_AUTH_URL`                     | — (**required**)               | the public URL: Better Auth's base, the one trusted origin (CSRF)                             |
| `OPENHARNESS_SECRETS_KEY`             | — (**required**)               | base64 32-byte master key the vault seals credentials with                                    |
| `OPENHARNESS_DEV_LOGIN`               | off                            | `1` enables the local dev login; localhost URLs only (A7); the way in when no provider is set |
| `GOOGLE_CLIENT_ID`/`_SECRET`          | —                              | enable Google sign-in (both, or neither; one provider or the dev login is required)           |
| `GITHUB_CLIENT_ID`/`_SECRET`          | —                              | enable GitHub sign-in                                                                         |
| `MICROSOFT_CLIENT_ID`/`_SECRET`       | —                              | enable Microsoft sign-in                                                                      |
| `MICROSOFT_TENANT_ID`                 | `common`                       | the Entra tenant the Microsoft provider authenticates against                                 |
| `PORT`                                | `3000`                         | the port to listen on                                                                         |
| `OPENHARNESS_TEST_MODEL`              | —                              | `mock` swaps in the deterministic test model                                                  |
| `OPENHARNESS_WEB_DIR`                 | —                              | a built web app to serve at `/`                                                               |
| `OPENHARNESS_CORS_ORIGINS`            | —                              | comma-separated origins to allow; unset means no CORS headers                                 |
| `OPENHARNESS_MAX_CONCURRENT_SESSIONS` | `4`                            | how many sessions may be running at once                                                      |
| `OPENHARNESS_DRAIN_TIMEOUT_MS`        | `5000`                         | how long shutdown waits for a turn in flight                                                  |
| `OPENHARNESS_INSTANCE_ID`             | hostname + pid + random suffix | this instance's id in the lease table                                                         |
| `OPENHARNESS_PARTITIONS`              | `64` (the protocol's)          | how many partitions the session space has                                                     |
| `OPENHARNESS_LEASE_TTL_MS`            | `30000`                        | how long a partition lease lasts before it must be renewed                                    |
| `OPENHARNESS_HEARTBEAT_MS`            | `10000`                        | how often leases are renewed and free partitions taken                                        |
| `OPENHARNESS_SWEEP_MS`                | `60000`                        | how often owned partitions are re-scanned for missed work                                     |
| `OPENHARNESS_DELTA_RETENTION_MS`      | `3600000`                      | how long superseded chunks are kept before compaction deletes them                            |
| `OPENHARNESS_COMPACT_INTERVAL_MS`     | `300000`                       | how often the compaction job runs; `0` disables it                                            |

Provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are **not read at all**
(epic #65, A5), and the server keeps none of its own: every model request is made with the
credential the session-bound resolver answered — the owner's stored, sealed key, opened per
request (`credentials.ts`). A session whose owner has no key for the model's provider ends the
turn with the brain's `missing_provider_credential` `session.error`; the environment is never
a fallback. The mock kind resolves a placeholder the deterministic model ignores.

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
  accounts, `xms_edov`, the verified lists) — the nOAuth guard. A provider that cannot prove
  the address refuses the sign-in (`email_not_verified`, 403) before a user or a link is
  created; `databaseHooks.user.create.before` (`refuseUnverifiedUser`) is the last gate, and
  implicit linking follows the same email with no trusted-provider shortcut.
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
  brain's `(provider) => …` question. Nothing caches a plaintext; nothing echoes one.
- **Dev login** (A7): `OPENHARNESS_DEV_LOGIN=1` seeds `dev@localhost` / `dev`
  (`DEV_LOGIN_EMAIL`). Better Auth's email validation refuses a dotless domain, so the row is
  stored as `dev@localhost.localdomain` and a dev-login-only shim (`rewriteDevLoginRequest`)
  maps the documented spelling onto it; sign-up stays disabled, so those are the only password
  credentials that exist. The boot refuses the flag unless `BETTER_AUTH_URL` is localhost.

## The model catalogue (epic #92)

`GET /v1/models` answers **the chat models the caller's own provider credentials can use**,
one entry per model and one status per provider — the list the agent form picks from, and the
context windows the per-model context budget will use later. `catalog/` is the whole of it;
the route (`routes/models.ts`) only parses the query and maps the one error it can raise.

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
- **C2 — the registry join and the filter.** `catalog/registry.ts` reads the provider registry
  bundled in `@mastra/core` through the API that version exports (`getProviderConfig` /
  `PROVIDER_REGISTRY` from `@mastra/core/llm`) — never from the network. **The exact rule**,
  per provider-listed model:
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

  The name, context window and max output of an entry come from the provider's own payload
  where it has them (Gemini's `displayName`/`inputTokenLimit`/`outputTokenLimit`, OpenRouter's
  `name`/`context_length`/`top_provider.max_completion_tokens`), from the registry where it
  has them, and from the model id otherwise; `null` is a legitimate value for the two limits.
  **What the installed registry actually carries** — verified against `@mastra/core@1.71.0`,
  not assumed: provider configuration (display name, base URL, API-key variable) and **model
  ids**, plus the `attachment`/`temperature`/`structuredOutput` capability lists. It has no
  per-model names, context windows or chat flag (the models.dev payload it is generated from
  does; the package reduces it). So on this version the join contributes the id knowledge and
  the fallback lists, the provider's own payload supplies the limits where there are any, and
  step 3 is what classifies. `RegistryModel` carries `name`/`contextWindow`/`maxOutput`/`chat`
  so that a registry version which attaches them is a one-place change; the tests inject a
  registry stub with them to pin the join itself.

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
  so the field is never absent;
- `: ping` comments every 15 seconds when nothing else is happening;
- `event: error` is the one named event, and it is the goodbye: the session behind the
  connection was revoked or expired, the payload is the protocol's `authentication_error`
  envelope, and the connection closes right after (see "Authentication and ownership" and
  `SESSION_INVALID_MESSAGE` in `sse.ts`).

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
them at the end of the turn. There is no preview snapshot to keep: the text that used to live
in `session_previews`, and the text-overlap de-duplication it needed, went with it in P3, and
the table itself was dropped in P4. A client resuming from inside a reply's chunks gets the
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

## Scheduler

```ts
interface SessionScheduler {
  start(): Promise<void>
  stop(options?: { drainTimeoutMs?: number }): Promise<void>
  signal(sessionId: SessionId, kind: 'work' | 'interrupt'): void
}
```

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
- **Balancing** is inferred from lease outcomes, because the store cannot list instances: a
  scan takes free or expired partitions and never a live one, a fresh instance stops its first
  scan at half the space so instances booting together share it, and an instance holding more
  than `ceil(partitions / (1 + peers))` gives the surplus up — finishing the turns in it first,
  then releasing.
- **Losing a lease** — a refused renewal, or a `FencedError` out of a turn — aborts that
  partition's turns, ends its subscription and stops it running work for it. It never crashes
  the process.
- **`stop()`** drains the turns in flight and then releases every lease, so the next instance
  takes over at its next heartbeat instead of waiting out the TTL.
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

## The test model hook

`OPENHARNESS_TEST_MODEL=mock` swaps the brain's Mastra router for a deterministic model, so the
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

`session.status_idle` is also the only thing in the log that ends the response. A turn that
dies without writing one (a store failure mid-turn, which the scheduler logs and drops) leaves
the request open until the client disconnects: the client's own abort signal is what closes
it. The protocol's SSE stream has the same stay-open-until-disconnected property.

The session can also end the response (A2; issue #76): the adapter registers with the app's
revocation registry and re-checks the session on a timer, exactly as the SSE stream does, and
a revoked or expired session ends the response with an `error` chunk carrying
`SESSION_INVALID_MESSAGE` — the same fact the SSE stream says with a final `event: error`.

`trigger: 'regenerate-message'` is treated as "send the last user message again": v1 has no
regenerate semantics, and answering the same prompt again is the closest honest reading.

## Static web assets

With `OPENHARNESS_WEB_DIR` set, the server serves that directory at `/`: a request that names a
file gets it, and any other GET outside `/v1` gets `index.html`, because the web app routes on
the URL hash. Paths that climb out of the directory are refused. The one exception is the
plain device path: `GET /device?user_code=…` answers a `302` to `/#/device?user_code=…`, the
hash route the device-approval page actually lives on (an older `verification_uri` shape, or
someone retyping the URL, lands on the page the reader meant instead of the app's home
screen). Without the variable there is no static serving at all, `/device` included: `/`
answers the API's 404.

## CORS

Off by default. `OPENHARNESS_CORS_ORIGINS` (comma-separated) enables it for exactly those
origins — nothing else, and no wildcard. A browser talking to this API needs it; the web app
served from the same origin does not.

## Shutdown

`SIGTERM` / `SIGINT` shut down in a fixed order: stop accepting requests, drain the scheduler
(abort the turns in flight, give them `OPENHARNESS_DRAIN_TIMEOUT_MS` to write their last
events), drop the connections still open — including SSE streams, which would otherwise never
end — and close the store. A second signal is ignored rather than allowed to interrupt the
drain.

## Public API

| `@openharness/server`                                                                                                | what it is                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `createApp(options)`                                                                                                 | the Hono app: routes, auth, errors, static assets — against any store/scheduler/auth |
| `startServer(options)`                                                                                               | store, migrations, model, scheduler, listener and a `shutdown()`                     |
| `main(env, options)`                                                                                                 | `startServer` from the environment, plus the signal handlers                         |
| `DeltaCompactor`                                                                                                     | the periodic compaction of superseded chunks (D9)                                    |
| `DEFAULT_DELTA_RETENTION_MS`, `DEFAULT_COMPACT_INTERVAL_MS`                                                          | `3600000`, `300000` — the compaction defaults                                        |
| `LocalScheduler`                                                                                                     | the single-process `SessionScheduler`                                                |
| `PostgresPartitionScheduler`                                                                                         | the multi-instance `SessionScheduler`: partition leases, epochs, recovery (#11)      |
| `PassQueue`                                                                                                          | the pass queue and concurrency limit both schedulers share                           |
| `SessionRunner`                                                                                                      | the per-session turn loop, reusable: what both schedulers run passes with            |
| `createAuth(config, database, logger)`                                                                               | Better Auth configured for this server (A1/A2/A3/A7), plus `Auth`, `AuthConfig`      |
| `createSessionCredentialResolver(deps)`                                                                              | the session owner's sealed key, opened per model request (A5)                        |
| `sealApiKey` / `openApiKey` / `credentialAad` / `credentialUpsert`                                                   | the credential sealing helpers (A5)                                                  |
| `createAuthGuard(options)`                                                                                           | the `/v1` session + CSRF middleware (A2)                                             |
| `createSessionRevocations(options)`                                                                                  | the registry of open responses a revocation closes, subscribed to the store (#76)    |
| `startSessionRecheck(options)`, `DEFAULT_SESSION_RECHECK_MS`                                                         | the periodic session re-check of a long-lived response (#76)                         |
| `SESSION_INVALID_MESSAGE`, `SSE_SESSION_INVALID`                                                                     | what a stream says when its session is revoked or expires (#76)                      |
| `validateProviderApiKey`, `VALIDATABLE_PROVIDERS`                                                                    | the one cheap provider call a saved key is checked with                              |
| `ModelCatalog`, `ModelCatalogOptions`, `CatalogRefreshLimitedError`                                                  | the model catalogue: provider lists, registry join, cache, fallback (#90)            |
| `createMastraRegistry()`, `emptyRegistry`, `ModelRegistry`, `RegistryModel`                                          | the registry join's seam, over the bundled `@mastra/core` data                       |
| `createProviderFetch()`, `ProviderFetch`, `DEFAULT_PROVIDER_TIMEOUT_MS`                                              | the provider HTTP client: egress-proxy aware, 5 s deadline                           |
| `CatalogCache`, `RefreshLimiter`, `DEFAULT_CATALOG_TTL_MS`, `DEFAULT_REFRESH_INTERVAL_MS`                            | the in-memory per-(user, provider) cache and the refresh rate limit (C4)             |
| `adapterFor()`, `adaptedProviders()`, `isChatModel()`, `isNonChatFamily()`                                           | the fixed endpoint table and the chat filter (C1/C2)                                 |
| `DEV_LOGIN_EMAIL`, `DEV_LOGIN_PASSWORD`, `DEV_LOGIN_STORED_EMAIL`                                                    | the documented dev user (A7)                                                         |
| `OPENHARNESS_CLI_CLIENT_ID`, `DEVICE_CODE_EXPIRES_IN`                                                                | the device flow's client id and code lifetime (A6)                                   |
| `deviceVerificationUri`, `deviceVerificationUriComplete`                                                             | the approval URL the device flow answers with: `#/device` and its `?user_code=` (A6) |
| `SOCIAL_PROVIDERS`, `providerOptions`, `microsoftEmailVerified`, `githubVerifiedPrimaryEmail`, `googleEmailVerified` | the A3 identity rules                                                                |
| `createDevLoginUser`, `rewriteDevLoginRequest`, `refuseUnverifiedUser`                                               | the dev-login seeding and shim, and the verified-email hook                          |
| `createMockModelFactory()`                                                                                           | the deterministic test model, for a host that wires its own                          |
| `defaultInstanceId()`                                                                                                | hostname + pid + random suffix: the id a server leases partitions under              |
| `readServerConfig(env)`, `ServerConfig`, `ENV_VARS`                                                                  | the environment, parsed                                                              |
| `HttpError`, `rateLimitError`, `PACKAGE_NAME`, `Logger`                                                              | the error types, the package name and the logging seam                               |

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
  session-watch.ts      revocation registry + periodic re-check for long-lived responses (#76)
  credentials.ts        sealing, opening and the session-bound credential resolver (A5)
  provider-validation.ts the one cheap provider call a saved key is checked with
  catalog/
    catalog.ts          ModelCatalog: per-provider fetch, join, filter, cache, fallback (#90)
    adapters.ts         the fixed provider endpoint table and each provider's payload shape
    registry.ts         ModelRegistry over @mastra/core's bundled provider registry (C2)
    filter.ts           isChatModel: the never-hide/never-show rule, and the name families
    cache.ts            CatalogCache (one hour per user+provider) and RefreshLimiter (C4)
    provider-fetch.ts   ProviderFetch: fetch over the egress-proxy env, and the 5 s deadline
  config.ts             the environment, parsed and checked
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
  http/
    errors.ts           HttpError and the protocol's error envelope
    request.ts          body/query/path reading, through the protocol's schemas
  routes/               agents.ts, sessions.ts, events.ts, ai-sdk.ts, me.ts, models.ts, provider-credentials.ts
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

Test **files** run one at a time (`fileParallelism: false` in `vitest.config.ts`): the two
suites that run against the same Postgres — `partition-scheduler.test.ts` and
`sse-postgres.test.ts` — each empty the tables they use, so two of them in flight at once would
delete each other's sessions. Packages still run in parallel with each other.

- `app.test.ts` — every route, the error envelopes, auth, CORS, static assets, and the title a
  session gets from its first message.
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
- `scheduler.test.ts` — one turn per session, steering, interrupts (running and idle), a
  message queued behind an interrupt, recovery on start, concurrency, stopping, and the fence
  reaching the store.
- `partition-scheduler.test.ts` — the multi-instance scheduler against real Postgres, several
  instances in one process each with its own store connection: spread and takeover, one turn
  per session, a crash mid-turn and the recovery that finishes it, a zombie that cannot write,
  a lease that cannot be renewed, interrupts routed across instances, the sweep, the fences a
  turn writes with, and shutdown handing its partitions back. `DATABASE_URL` when it is set,
  otherwise a container, otherwise the suite is skipped with a note.
- `ai-sdk.test.ts` — the adapter through `DefaultChatTransport` and `readUIMessageStream`.
- `mock-model.test.ts` — the echo, `__slow__`, both failure markers, fixed usage, and that the
  hook cannot activate without the variable.
- `auth.test.ts` — the front door: the 401 sweep over every route, cookie and bearer, the
  CSRf rule, the device flow end to end (code, approve, token, bearer request), sign-out
  revoking, the dev login and its guard, the rate limiter refusing the fourth sign-in, and
  Better Auth's own origin check run with `enforceOriginCheck` — vitest's `NODE_ENV=test`
  skips it by default, which is the blind spot #79 fixed.
- `auth-profile.test.ts` — the A3 rules with mocked profiles: Microsoft's nOAuth claims,
  GitHub's primary-verified email, Google's `email_verified`, and the 403 each refusal is.
- `isolation.test.ts` — two users, every `/v1` route walked as the second one: 404 for a
  by-id read, empty lists, no credentials of the other's, `/v1/me` answering the caller.
- `credentials.test.ts` — the write-only round trip, the 422 a refused key gets, the fresh
  session rule, the vault's AAD binding, "never in a response or a log", and the env-key test:
  with `OPENAI_API_KEY` set and no stored credential, a turn ends with
  `missing_provider_credential` and no request is made.
- `config.test.ts`, `main.test.ts` — the environment (including the three required variables
  and the dev-login guard), startup, recovery and shutdown, and `SCHEDULER=postgres` wiring
  the partitioned scheduler.
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
  `@mastra/core` (including that this installed version carries ids only), and the TTL /
  invalidation / rate-limit rules on an injected clock.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue. If a contract blocks you, work around it here and say so.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/server/docs/`.
