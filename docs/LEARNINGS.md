# Learnings

Everything we learned building openharness that the code does not say out loud.

## What this file is, and who it is for

[`AGENTS.md`](../AGENTS.md) and the per-package `AGENTS.md` files say **what the code does**: the
routes, the invariants, the commands, the allowed dependencies. This file says **what surprised
us**, why things are the way they are, and which dead ends we walked into first. It is the repo's
memory of the non-obvious.

It is written for:

- **People building an agent harness** — a stateless loop over a durable event log, with tool
  execution, approval pauses and crash recovery.
- **People building a chat-with-tools product** — the model loop, truncation, compaction,
  streaming into a UI.
- **People building an MCP client** — remote servers, OAuth discovery, transport-level surprises.
- **People building multi-provider LLM apps** — model catalogues, context budgets, reasoning
  effort, Azure/Bedrock/Vertex, OpenAI-compatible endpoints, provider-opaque content.
- **People deploying something similar** — GCP/GKE, a global load balancer, Cloud CDN, Cloud SQL,
  KMS, observability.
- **Contributors and coding agents working on this repo** — the facts that would otherwise cost
  you the same day they cost us. [`CLAUDE.md`](../CLAUDE.md)'s Learnings section has the rule
  that keeps this file current.

Read it before you re-derive something. Every entry is a provider quirk, a configuration trap, a
design decision whose reason is not visible in the code, or a bug we shipped and then fixed.

**How to read the references.** Issues and pull requests are linked to
`github.com/amirtuval/openharness`. File paths are relative links to `main` — **unless the entry
says otherwise**. The Tools epic ([#303](https://github.com/amirtuval/openharness/issues/303)) is
still open as a stack of pull requests
([#316](https://github.com/amirtuval/openharness/pull/316)…[#337](https://github.com/amirtuval/openharness/pull/337),
with everything on `tools/x14-native-search-335`), so the tools entries reference the issue or
pull request rather than a path that does not exist yet.

**Adding to it.** A bold claim, then two to six sentences of what happened or what is true, why
it matters, and what we did. Concrete names — headers, status codes, endpoints, env variables. If
it is obvious from the code or from `AGENTS.md`, it does not belong here.

## The event log and replay

**The log is the only state, and one invalid event makes a whole session unreadable.** The brain
holds nothing of its own: a turn can be resumed by a different process because everything it needs
is derived from the session it is handed ([`docs/architecture.md`](./architecture.md)). That makes
validation load-bearing — a writer checks an event against the protocol before appending, and a
turn that cannot write a valid event **ends with an error** instead, because one row in a shape no
reader accepts makes every later read of that session fail. A turn that fails loudly is the
cheaper failure ([`packages/brain/AGENTS.md`](../packages/brain/AGENTS.md)).

**A stored event is never modified, and the only deletion is of what a later event superseded.**
The event types are deep-readonly and the store freezes what it keeps, so writing to a stored
event is a compile error — and `no-updates.test.ts` scans every non-test source file for `update
events` rather than trusting the convention. There are exactly two deletions: the streamed chunks
a finished reply replaced (D9, [#46](https://github.com/amirtuval/openharness/issues/46)) and the
tail of the log an edit rewound ([#238](https://github.com/amirtuval/openharness/issues/238)). The
reply is stored **as it streams** — each chunk is an ordinary event with its own `seq` — and the
`agent.message` that ends it carries a `supersedes: {from_seq, to_seq}` range; replay skips the
range and a compaction job deletes the rows after `OPENHARNESS_DELTA_RETENTION_MS`, so deleting
changes no reader's answer. A connection that opens mid-reply replays the chunks so far and then
the message, and the same conversation results either way.

**"What answered this" is a claim in the log, not a flag beside it — and the claim belongs on the
event that ends the work.** Three event types carry a `consumes` list:
`span.model_request_start` (the user messages its request folds in), `span.model_request_end` and
`session.status_idle` (the interrupts they answer). A user event's `processed_at` is **derived on
read** from the claim that took it, rather than a column that gets rewritten — a rewritten column
is invisible to a client that already holds the event. Claims are rows with `event_id` as the
primary key, claiming is `insert … on conflict do nothing` so two racing writers cannot both win,
and a claim that cannot be made refuses the whole append (`ClaimConflictError`). The first design
claimed an interrupt with a pair of model-request events even though no model was called, which
put a zero-usage span in every trace and inflated request counts; a synthetic event is a lie every
reader downstream then has to be taught about
([`packages/session/src/events.ts`](../packages/session/src/events.ts),
[`packages/session/docs/postgres.md`](../packages/session/docs/postgres.md),
[#46](https://github.com/amirtuval/openharness/issues/46)).

**Appending is the durable step, and `seq` is the only order there is.** `POST …/events` stores
the user events with `processed_at: null` **first**, and only then signals the scheduler: the
store call is what makes the request durable and a signal may be lost, which is why every recovery
path ends in a log-derived `findSessionsNeedingWork`. `seq` starts at 1, increments by one per
event per session, is assigned inside the append transaction under a row lock, and is
simultaneously the ordering key, the SSE resume position and the pagination cursor — a reconnect
with `last-event-id: 7` gets `8` next, never `7` twice and never a gap. Resource lists page by
**keyset** (`{created_at, id}`) rather than offset, because a session listed newest-first shifts
under an offset pager and a millisecond timestamp is not a position; the ULID `id` breaks the tie
([`apps/server/AGENTS.md`](../apps/server/AGENTS.md)).

**Usage counters have to be disjoint, cost has to be computed on read, and "a day" is a local
question.** Providers report cache reads, cache writes, reasoning tokens and audio tokens in
overlapping fields, so the brain normalises each family into disjoint counters at one seam and
`input_tokens` in the API is the **uncached** input — an early version double-charged cached
tokens because it was the total instead. The totals are derived from the log's spans and priced
against the bundled registry, so a price change re-prices history and a branch a `session.rewind`
replaced is not billed; a model the snapshot does not price contributes its tokens and no cost,
and the total carries `cost` plus `unpriced_requests` rather than turning into `—`, because naming
the unknown part beats guessing and beats nuking a month's total over one request. Days are
computed with `Intl` rather than Postgres' `AT TIME ZONE`: the range becomes a half-open UTC window
by asking for a local day's first instant rather than by adding offsets, so a 23- or 25-hour DST
day and a zone whose day does not begin at midnight are both exact. And the per-user route is
**one** store query over that window, not a walk of the caller's sessions reading each log page by
page — which is what it did first, and which read every event of a month of heavy use on every
request; the store counts its calls in the test, so a walk would fail it
([#247](https://github.com/amirtuval/openharness/issues/247),
[`apps/server/src/local-day.ts`](../apps/server/src/local-day.ts)).

**Replay and live delivery are stitched so a client cannot tell where one ended.** The store
subscribes **first**, then the log is replayed page by page, then the buffer is flushed with
everything at or below the last replayed `seq` dropped — which is exactly the overlap. The resume
position is `after_seq`, else the `last-event-id` header, else **live only** (the client's
documented default), and a header that is not a position this server handed out is ignored rather
than refused. A reply's chunks go only to a connection that opted in with
`event_deltas[]=agent.message`, in the replay half too, or a client that only wants finished
messages would have to filter history.

**A deleted session and a revoked session say goodbye differently, and a revocation has to reach
responses that are already open.** A hard delete delivers one stored `session.deleted`
`StreamEvent` — the only event with no `seq` — and no error frame follows, because a deletion is
not a revocation; a revocation or expiry ends an SSE stream with a final `event: error` carrying
the protocol's `authentication_error` envelope. The guard validates once per request, but a stream
is one long request, so `session-watch.ts` keys every open response by the **session id** (never
the token, which would be a secret on a shared channel) and works with a 15 s re-check as the "at
most 30 s" backstop. Two sources publish: Better Auth's `databaseHooks.session.delete.after` and a
Postgres trigger on `"session"` (migration `0014`) that catches an operator's plain `delete`. The
leak this fixed was **environment-dependent**, which is what made it nasty: on CI the connection
dropped at sign-out and the reconnect got a 401, while locally — where the connection stayed up —
an open stream received the whole of the next turn after sign-out. A deployment whose streams have
no idle timeout never closes them, which is part of why the server sends a `: ping` every 15
seconds, and that keepalive is also what keeps the leak alive
([#76](https://github.com/amirtuval/openharness/issues/76)).

**The AI SDK adapter is an extension, not the protocol, and it has exactly one terminator.**
`POST …/ai-sdk/chat` exists so a React app built on `useChat` can talk to a session without
knowing about the event log; nothing in `@openharness/protocol` mentions UI message chunks and
`packages/client` does not use it. `session.status_idle` is the only stored thing that ends its
response, so a turn that dies without writing one leaves the request open until the client
disconnects — the client's own abort signal is the real terminator. `trigger:
'regenerate-message'` is honestly read as "send the last user message again", because v1 has no
regenerate semantics.

**A session's title is derived once and never replaced.** `deriveSessionTitle` takes the first
non-empty line of the first `user.message`, collapses whitespace and truncates with an ellipsis to
`SESSION_TITLE_MAX_LENGTH`; a title supplied at creation, or one an earlier message produced, is
never overwritten. There is no `session.updated` event, so a loaded client is never told the title
changed and has to re-read — the reason the web app does exactly one re-read per session instead
of polling ([#29](https://github.com/amirtuval/openharness/issues/29)).

## Scheduling, leases and crash recovery

**A lease lapse is stealable, not lost.** `expires_at` exists so _another_ instance can take the
partition over; it is not what takes it away from the holder. `renewPartition` therefore extends a
lease whose row still names this owner at this epoch **whether or not it has lapsed**, and a
refusal means one thing only: somebody else has the partition now. Read a refusal as "the lease is
gone" and one slow heartbeat cycle — a stalled process, a slow round trip, a runner under load —
drops every partition the instance holds, aborts and re-runs their turns and re-acquires them at a
new epoch, for no reason, since no peer ever wanted them. This is the rule most likely to be
misread as a bug ([#185](https://github.com/amirtuval/openharness/issues/185),
[`apps/server/docs/scheduling.md`](../apps/server/docs/scheduling.md)).

**Signals are hints and the log is the record, which fixes the order acquisition has to happen
in.** Acquisition subscribes to the partition's signals **before** it recovers it
(`findSessionsNeedingWork`), because a signal that arrives between the acquire and the
subscription is gone forever; the scan is also exactly how a partition whose owner died is
recovered, and a slow sweep re-scans for work no signal ever mentioned. Both paths end in a
function derived from the log alone, so a partition that just changed hands gets the same answer
as one that has been running all along.

**Deriving membership from failed acquires does not work.** The old balancing inferred peers from
failed acquires, so a peer holding nothing produced none, was invisible, and the winner had to let
half the space go on a timer to give it a door in — an idle release that could also drop what the
winner was serving. Explicit membership
([#122](https://github.com/amirtuval/openharness/issues/122)) — every instance upserts its row in
`scheduler_instances` on every heartbeat, before it reads the list back, and deletes it on
`stop()` — gives `share = ceil(partitions / live members)`, makes a newcomer visible the moment it
heartbeats, and means **nothing is ever released while its owner is alone**. The membership ages
out with the leases, both windows being one TTL, so a crash needs no separate timeout. A scan
takes only free or expired partitions and stops at the share, with a start offset hashed from the
instance id so instances do not all walk the space in the same order.

**Fencing is what makes a zombie harmless, and it has to be opt-in.** Every append a turn makes
carries `fence: {partition, epoch}`, and the store accepts the write only while that partition's
lease is live at that epoch — so a process that is still running but no longer owns anything stops
at its first refused write with a `FencedError`, and the store is unchanged by it. Fencing cannot
be mandatory, because `POST …/events` holds no lease and the event must be durable regardless. A
`FencedError` out of a turn and a refused renewal are the same fact from opposite directions: drop
the partition, abort its turns, end its subscription, never crash the process over it. A crash
loses nothing because nothing was ever in memory — the new owner finds the turn the dead instance
opened (`getTurnState` says `running` or `unfinished`), closes the orphaned span with `brain_lost`
and runs it again, making a model request only if some claimed message still lacks a reply.

**Configuration that is self-defeating is refused at boot, and shutdown has to hand back both
halves in order.** A heartbeat at or above the lease TTL is a partition handing itself over every
cycle, and `SCHEDULER=postgres` without a `DATABASE_URL` fails too, because partition leases are a
table the in-memory store does not have. The instance id must be unique per database, since two
live instances leasing under one id would fence each other, and the store's partition count and
the scheduler's must be the same number — `main.ts` passes `OPENHARNESS_PARTITIONS` to both.
`stop()` then drains the turns in flight, **deletes its membership row** so peers stop counting the
instance at once and their shares grow, and releases every lease; an acquire already in flight
cannot be cancelled, so the scan that holds it releases it the moment it sees the instance stopped,
and a stopping instance never leaves a live lease behind.

**The runner is where "one turn at a time" and "keep going while there is work" live, and a session
that vanishes is an answer rather than a failure.** It re-reads the log when a turn resolves, stops
on `noop` but honours a `wake` that arrived during that `noop` turn (the brain reads the log before
it decides, so a signal for an event appended in that window would otherwise be lost), and calling
`run()` while a pass is in flight wakes that pass rather than starting a second one. Deleting a
session uses a separate verb from interrupting it — `stopSession` keeps the pass from starting
another turn, while a plain `interrupt` ends its turn and then looks for more work — and
`SessionNotFoundError` is treated as an answer throughout the runner, or a delete becomes a crash
loop ([epic #116](https://github.com/amirtuval/openharness/issues/116), U5).

## Authentication and identity providers

**Identity is the provider-verified email, and boolean-shaped claims are not booleans.** Microsoft
documents `xms_edov` as a Boolean but a token carries it as the string `"1"`/`"0"`, and Google's
`email_verified` has the same shape. Everything is read through `affirmativeClaim`: `true`, `1`,
and (trimmed, case-insensitively) `"true"`/`"1"` are affirmative and everything else — `false`,
`0`, `"0"`, `"false"`, empty, any other string, absent — is not. A naive truthiness test here is
the nOAuth account-takeover bug. GitHub additionally needs the **primary** verified address, not
any verified one, and a refusal is a 403 `email_not_verified` before a user or a link is created,
with `databaseHooks.user.create.before` as the last gate
([`apps/server/src/auth-profile.ts`](../apps/server/src/auth-profile.ts),
[epic #65](https://github.com/amirtuval/openharness/issues/65)).

**A personal Microsoft account is vouched for by `xms_edov` alone, and a refused sign-in has to be
diagnosable from one log line that contains no personal data.** The `verified_*` claim lists are an
Entra work/school thing, so a consumer-tenant token has `xms_edov: "1"` and no verified lists —
which means the app registration must request `xms_edov` as an optional **ID** claim alongside
`email`, and the rule must accept a verified personal account without a verified-emails list, or
consumer sign-in breaks while work/school keeps working. `MICROSOFT_REFUSAL_LOG` then carries the
decoded token's claim **names** (sorted), `tid`, `iss`, the **type** of each claim the rule reads
(`absent` | `boolean` | `string` | `array(n)`), whether the lowercased `email` is in either
verified list, `hasEmail`, and `xmsEdovValue` — the raw `xms_edov` only when it is a boolean, a
number or a string of at most eight characters, and `'<omitted>'` otherwise. That is what
distinguishes "the optional claim is misconfigured in the portal" (a name present, a type that is
not `absent`) from "Microsoft never sent it", with no address, name or token ever reaching the
line ([#74](https://github.com/amirtuval/openharness/issues/74)).

**Better Auth turns its own origin check off under `NODE_ENV=test` — or a set `TEST` — and vitest
sets both.** The check silently stopped being covered, so `AuthConfig.enforceOriginCheck` (tests
only; nothing sets it in production and nothing turns the check off) forces it on, and the e2e
suite runs its servers with `NODE_ENV=production` for the same reason
([#79](https://github.com/amirtuval/openharness/issues/79)). Outside a test process `/api/auth/*`
also refuses a cookieless request carrying Fetch-Metadata headers with no `Origin`
(`MISSING_OR_NULL_ORIGIN`, 403) — and Node's own `fetch` sends `sec-fetch-mode: cors`, so a
server-side script calling your own sign-in route is a 403 unless it sets an origin. Separately,
CSRF applies only to cookie-authenticated writes: a page can make a browser attach a cookie, but it
cannot set an `Authorization` header cross-origin, so bearer requests are exempt.

**The device-flow verification URI has to be a hash route, and the flow has its own rate limit.**
`verification_uri` is exactly `<BETTER_AUTH_URL>/#/device`, and `verification_uri_complete` must
carry `?user_code=…` **inside the fragment**, where the web app's router reads it — so `auth.ts`
rewrites the field Better Auth built, whose query lands before the `#`. The static file server also
redirects a plain `GET /device?user_code=…` to the hash form, so an older URI shape or someone
retyping the URL lands on the page they meant, and the approval page shows the code the terminal
printed and compares it, so a phishing page cannot show a code the terminal did not. The device
endpoint is rate-limited to about five requests per ten minutes — the code's own lifetime — and
answers `slow_down` with an `x-retry-after` in **seconds**, which the polling client has to honour
by backing off (the CLI adds five seconds), or a user who mistypes a code locks themselves out of
the flow they are standing in front of
([#74](https://github.com/amirtuval/openharness/issues/74)).

**A dev login hits the auth library's own validation rules, and a server nobody can sign in to must
not boot.** Better Auth rejects a dotless email domain, so `dev@localhost` exists in the database
as `dev@localhost.localdomain` and a dev-login-only shim rewrites the documented spelling on the
way in; sign-up stays disabled, so those are the only password credentials that exist, and the flag
refuses to boot on a non-localhost public URL. With no OAuth provider and no dev login,
`readServerConfig` refuses to start and names the variables — every route is behind a session
nobody could create, and failing loudly beats a deployment whose every request is a 401.

**Sealed credentials are bound to their owner by the AAD, and the environment is never a
fallback.** The vault uses AAD `userId|name`; a `local` deployment wraps each credential's data key
with `OPENHARNESS_SECRETS_KEY` and `gcp-kms` wraps it with a Cloud KMS key, keeping no key
material in the environment at all, and each row records which provider wrapped it — so switching
`OPENHARNESS_KEY_PROVIDER` means re-saving every credential rather than a migration. Unwrapped data
keys are cached in memory for `OPENHARNESS_KEY_CACHE_TTL_MS` (bounded, nothing plaintext, nothing
else cached, zeroed on eviction) and the Cloud KMS client is loaded on the first wrap or unwrap, so
a `local` server never loads `@google-cloud/kms`. No `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is
read at all: a session whose owner has no key for the model's provider ends the turn with
`missing_provider_credential`, and a test sets `OPENAI_API_KEY` and asserts no request was made
([#150](https://github.com/amirtuval/openharness/issues/150),
[epic #65](https://github.com/amirtuval/openharness/issues/65), A5).

## Postgres, migrations and the store

**A migration must never be edited once it has been applied anywhere, and because every file
re-runs, a data-changing one needs a guard on the state it changes.** The migrator re-runs every
file on every `migrate()` call and there is no ledger table, so editing an applied file is silently
ignored on existing databases and applied on new ones — the two drift apart with no error.
`0012_ownership.sql` deletes all v1 data **wrapped in a check for the absence of the `owner_id`
column it introduces**, without which a server restart months later would empty every log in the
database. The same asymmetry is why `0012` may delete where `0015` has to backfill
(`update … where model is null`, a no-op on re-run). Migrations run in one transaction under
`pg_advisory_xact_lock(hashtext('@openharness/session migrations'))`, so a half-way failure leaves
the schema as it was and two instances booting together cannot interleave DDL. Better Auth's own
SQL is generated verbatim from its CLI with its migrator disabled, and a plugin list that changes
without a matching migration is a runtime failure rather than a startup one — a Postgres test
asserting Better Auth's schema check passes on the migrated database is the only thing that catches
it ([`packages/session/docs/postgres.md`](../packages/session/docs/postgres.md)).

**Never read `now()` in the store; take a `Clock`, and make ids compare byte-for-byte.** Every
timestamp and lease-expiry comparison comes from an injected clock, which is what makes the
conformance suite's "move the clock forward" tests work against Postgres — a store reading the
database's `now()` fails the lease and `processed_at` tests and makes short-lease tests untestable.
`id` columns are `text collate "C"`, which is exactly what the protocol's keyset cursors encode and
what the in-memory store compares with `<`, so a cursor taken from one store seeks identically in
the other whatever the database's locale.

**Postgres decides several shapes, and each reason is the failure you get otherwise.** `NOTIFY`
payloads are `{"seq": n}` and never the event, because a payload is capped at 8 kB and an event is
not — a subscriber fetches `seq > lastSeen` in order, which makes coalesced, repeated or missed
notifications harmless, and two separate watermarks (one advancing with the query, one per listener)
mean a late joiner cannot cause a refetch or a duplicate. Notifications sent while the listener was
down are gone, because Postgres does not queue them, so a reconnect re-issues every `LISTEN` and
catches up by reading the log. Channel names are hashes because a session id is arbitrary text and
a channel name is a 63-byte identifier (`ohs_` plus 32 hex of the session id's SHA-256,
`ohp_<partition>` for signals, one fixed `ohr_auth_session_revoked`). `event_claims` and
`event_supersessions` carry no foreign keys, because test harnesses truncate `events` in one
statement and Postgres refuses to truncate a table an FK points at. And row triggers do not fire on
`TRUNCATE`, so a truncating test cannot prove the revocation path.

**Two conventions for "the default" live side by side, and a count-then-insert is not made atomic
by a transaction.** A stored value that could equal the default must be NULL
(`compaction_threshold`, `summary_max_passes`, `key_provider`), because a stored `0.7` cannot be
told apart from a deliberate choice of `0.7` and a later change to the deployment's value would
leave the user behind; a column whose writer always supplies a value gets a real column default
(`summary_model`'s `'same-as-chat'`, the theme), where an absent value would be a bug rather than an
older shape. And the per-user mode cap takes a per-owner `pg_advisory_xact_lock` before counting, so
exactly `MAX_MODES_PER_USER` creates succeed under concurrency — the in-memory store is serial by
construction and hides the bug entirely if you only test against it, which is why the conformance
suite fires `MAX_MODES_PER_USER + 5` concurrent creates.

## Deployment on GCP and GKE

**`node-postgres` reads `sslmode=require` as verify-full, and Cloud SQL's certificate is signed by
a per-instance Google CA that is not in Node's trust store.** Verification therefore cannot succeed
by configuration alone, and the first staging deploy died on `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The
fix is not to loosen TLS but to run the **Cloud SQL Auth Proxy** as a native sidecar in the app's
own pod — an init container with `restartPolicy: Always` and a `startupProbe`, so the app neither
starts nor runs its boot migrations until it is up. The `database_url` then names `127.0.0.1:5432`
with `sslmode=disable`, which describes only the pod-local loopback hop and is not a downgrade of
the connection that leaves the pod; tightening the instance to
`TRUSTED_CLIENT_CERTIFICATE_REQUIRED` was deliberately left as its own reviewed plan
([#159](https://github.com/amirtuval/openharness/issues/159),
[`docs/DEPLOYMENT.md`](./DEPLOYMENT.md)).

**An Ingress naming an `IngressClass` that does not exist renders fine and does nothing.** The first
staging deploy reserved the static IP, pointed DNS at it and had no load balancer at all: no
controller created a forwarding rule, backend service or target proxy, and nothing reported an
error. Moving to the Gateway API is the fix, because a `GatewayClass` is owned by GKE's controller
by name and the lookup cannot come back empty. Two consequences: a Gateway with a
`networking.gke.io/certmap` annotation must **not** also carry `tls.certificateRefs`, and TLS
arrives after the release does — Certificate Manager needs a DNS authorization, so the chart hands
back a `_acme-challenge.<host>` CNAME pointing at `certificatemanager.goog`, and until the
certificate leaves `PROVISIONING` the load balancer serves its default certificate
([#159](https://github.com/amirtuval/openharness/issues/159)).

**A Gateway does not infer the load balancer's health check from the readiness probe, and draining
has to start before the listener closes.** The `HealthCheckPolicy` pointing at `/ready` is a
separate object, and the two probes answer different questions: `/health` is liveness and does
nothing (200 while the process lives, draining included), while `/ready` is readiness — 200 only
while the store answers `select 1` inside about two seconds **and** the instance is not draining.
Point them at the same handler and either a slow database restarts healthy pods or a wedged process
keeps receiving traffic. `shutdown()` flips the drain flag the instant it is called and `/ready`
answers 503 from that moment, so the load balancer stops sending new requests while the turns in
flight finish. The timing chain is real configuration: `terminationGracePeriodSeconds` 60 >
`drainingTimeoutSec` 30 > `OPENHARNESS_DRAIN_TIMEOUT_MS` (5 s), and `backend.timeoutSec` 3600
because an SSE stream lives for a whole turn.

**Cloud CDN with `USE_ORIGIN_HEADERS` caches exactly what a response says, and `no-store` is
absolute.** Only `FORCE_CACHE_ALL` overrides it, and this deployment does not ask for that. The
server puts `no-store` on `/v1/*`, `/api/auth/*`, `/health`, `/ready`, `/device` and **every**
non-2xx in one place, so no dynamic surface is ever stored; an `Age` header climbing on such a
response means the cache filter is not in the chain. `HEAD` is not optional in front of a CDN: a
browser only sends `GET`, but a link checker, an uptime probe, `curl -I` and the CDN revalidating a
cached entry all send `HEAD`, and the `404 no-store` it used to fall through to is what stopped
Cloud CDN from caching the file the `GET` beside it serves. `HEAD` is now answered wherever `GET`
is, with the same status, `content-type`, `content-length` and `Cache-Control`, and no body
([#196](https://github.com/amirtuval/openharness/issues/196)).

**The global external load balancer appends exactly one hop to `x-forwarded-for`.**
`OPENHARNESS_TRUSTED_PROXY_HOPS` says how many proxies are in front, and the client IP is the entry
`hops + 1` from the right — behind GCLB (`<client-ip>, <lb-ip>`) hops `1` picks the entry no client
could have written. With the default `0` no forwarding header is read at all and the socket address
is used, and a value is trusted only if it is a real IP literal. The resolved address is handed to
Better Auth on exactly one server-set header (`x-openharness-client-ip`), which the server replaces
or deletes, so no client can choose its own rate-limit bucket. The QA bug this fixed: behind a proxy
every user shared one bucket, so one person's failed sign-ins blocked everyone
([#151](https://github.com/amirtuval/openharness/issues/151)).

**A secret delivered as a file has exactly one trailing newline removed, and a KMS key name is
recorded without its version.** `printf '…'` and `echo '…'` therefore produce the same secret,
which is what makes Secret Manager's files usable at all; setting both `<NAME>` and `<NAME>_FILE`
fails the boot because they could disagree, as does an unreadable file — with a message naming the
variable and the path and never the content — and an empty file counts as unset. The chart names
each secret's `versions/latest` rather than a pinned version, because the CSI driver resolves that
at pod start, so a replaced secret reaches the next rollout's pods with no extra step. Omitting
`/cryptoKeyVersions/…` from the stored KMS key name means rotating the key version needs no data
migration: KMS keeps old versions for `Decrypt` and the next `Encrypt` picks the new primary
([#154](https://github.com/amirtuval/openharness/issues/154)).

**The very first deploy of a project is a different operation from every later one, and providers
are turned on _between_ deploys.** The `helm` and `kubernetes` providers are configured from a
cluster endpoint that does not exist on a first plan, so the workflow targets the services, VPC,
cluster and registry first — the registry because the image push needs it and Terraform creates it
— and then runs the full apply; every later deploy is a single apply. Production's first apply is
**expected** to fail with `ImagePullBackOff`: its node service account does not exist until that
apply and staging has not yet granted it registry read, so the release rolls itself back and the
remaining steps finish the bootstrap, with `TF_PRODUCTION_NODE_SA` staying empty until then because
naming a member GCP does not know yet fails the apply. Staging must be applied before production
for a real dependency: staging's zone exports the name servers production writes, and staging holds
the one Artifact Registry repository every environment pulls from. All three provider secret
containers are created unconditionally and empty on the first deploy — doing it the other way round
meant the turning-on deploy created an _empty_ secret, and a secret with no version blocks the pod,
so that deploy failed and rolled back
([#159](https://github.com/amirtuval/openharness/issues/159)).

**`atomic = true, cleanup_on_fail = true` changes how you debug a failed deploy, and a rollback does
not revert Terraform state.** A failed install is uninstalled and a failed upgrade returns to the
last good revision, so "look at the pods" is no longer a diagnosis — they are gone. Both deploy
workflows therefore run a Rollout diagnostics step on failure that prints `helm history`, pods,
events (which survive about an hour) and Cloud Logging (which outlives the rollback entirely),
never a secret value. In the release train the `production` tag is a moving pointer that rollback
re-points at an earlier SHA, and a schema migration is not undone by an older image — so a rollback
means "run the previous server build" and a migration fix has to go forward. Production's GCP
project **ID** is `openharness-510710`; `openharness` is only its display name.

**Some cloud-side values are dictated by somebody else's validation rules, and a smoke test that
asserts "not 200" proves nothing.** GitHub rejects an Actions configuration variable whose name
starts with `GITHUB_`, so the OAuth variables are spelled `OAUTH_GITHUB_CLIENT_ID_*`. A billing
budget's amount is in the **billing account's** currency (ILS here) because the Budgets API rejects
any other with a 400, and `TF_BILLING_ACCOUNT_ID` is the bare ID with no `billingAccounts/` prefix,
which the provider adds itself. Every Terraform workflow value is repository-level, because the
plan job runs outside any GitHub environment and cannot read the environment-scoped copies — the
`_STAGING`/`_PRODUCTION` suffix is an environment marker, not a scope. The deploy smoke test asserts
`/v1/sessions` returns exactly **401**, because `/health` is served whether or not the database is
reachable: a deployment whose `database-url` secret is wrong passes `/health` and fails
`/v1/sessions`. `curl -k` is deliberately absent, so a certificate that does not validate is a
failure this catches, and a first production deploy that fails this way is the bootstrap rather
than a broken release — the workflow prints the exact `gh variable set TF_PRODUCTION_NODE_SA` fix.

**An alert that is too broad is an alert nobody reads, and an empty alert email is a supported
state.** Autopilot's `OPTIMIZE_UTILIZATION` profile replaces nodes often and GKE's own DaemonSet
containers restart once per new node, so a cluster-wide restart alert pages on every routine node
replacement; the alert watches the app namespace only
([#325](https://github.com/amirtuval/openharness/issues/325)). An empty `alert_email` creates no
notification channel and no alert policies, which is what lets an environment's first apply succeed
before anyone is on call — the uptime check is created regardless.

**Observability has to be free when it is off and correctly attributed when it is on.** The JSON
logger and the OpenTelemetry SDK are imported lazily, so an untraced server (the default) never
loads either. The request's trace ids live in an `AsyncLocalStorage` for the whole request, which is
what the JSON logger reads, so a log line and its trace agree — and with tracing off the header's
ids still reach the log, because a client's trace is not this server's to drop. The exporter is
`@google-cloud/opentelemetry-cloud-trace-exporter` rather than OTLP because it authenticates with
ADC and refreshes its own OAuth token, which is what keeps a long-running pod exporting; an OTLP
header cannot be refreshed. Load-balancer request logging is deliberately off — the most expensive
thing in the picture, and the server's own logs already carry path and status joined to the trace.
And the self-host escape hatch, `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS`, is set nowhere in the
infrastructure on purpose: it applies only to the `openai_compatible` credential type, and staging
and production run behind a public load balancer with open sign-in, where the SSRF guard is doing
its job ([#249](https://github.com/amirtuval/openharness/issues/249)).

## Providers and models

**A bundled snapshot beats a live registry, and its staleness is the price.** The model registry is
a models.dev snapshot committed to `apps/server` and bundled into `dist/index.js` — never read from
the network and never from a path that could be missing at runtime, so a sandbox with no network
still builds and boots. Regenerate it with `yarn workspace @openharness/server catalog:refresh`,
which reads `PROVIDERS` **from `@openharness/protocol`'s build output** (build the workspace first)
and writes the file; the snapshot's date is in the file as `SNAPSHOT_DATE`. It is a source file like
any other, and the data is only as fresh as a commit
([`apps/server/src/catalog/registry.ts`](../apps/server/src/catalog/registry.ts)).

**models.dev has no chat flag, and could not have one.** `modalities.output` is `["text"]` for
`text-embedding-3-small` too, and `family` is a name family. Classification therefore falls to a
conservative **name** filter, and the rule is asymmetric on purpose: an explicit non-chat verdict
drops a model, an explicit chat verdict keeps it, and otherwise an id naming no known non-chat
family is **kept**, because hiding a usable chat model is the failure the epic is about. The
patterns are word-like, so `gpt-4o-search-preview` goes and `o3-deep-research` stays. Don't restate
a provider list in five places either: since #245 every table is a `Record<ProviderId, …>` over the
protocol's list, so a missing provider is a compile error, and the old five copies plus an agreement
test are gone — though `PROVIDERS`'s **order** is still a contract, because frontends draw tiles in
it and the snapshot is keyed in it ([epic #92](https://github.com/amirtuval/openharness/issues/92),
[`apps/server/src/catalog/filter.ts`](../apps/server/src/catalog/filter.ts)).

**No catalogue request ever supplies a URL, which is why there is no SSRF surface — with one
deliberate exception.** Every endpoint is a constant of `catalog/adapters.ts`; Bedrock's and
Vertex's hosts derive from a validated region or location, and Azure's contributes the deployments
the user named without fetching anything. The exception is a custom OpenAI-compatible credential's
`base_url`, which is the user's, and it goes through `safeFetch` and only `safeFetch`. Provider
calls also go out through undici's `EnvHttpProxyAgent`, which reads
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, so a deployment behind a proxy works without also
remembering `NODE_USE_ENV_PROXY=1`, which plain `fetch` would need. One outbound path for the whole
server, and one seam the tests replace.

**Which cheap call validates a credential depends entirely on the credential type, and a stub that
answers anything proves nothing.** An `api_key` gets the provider's model list; an `azure_openai`
gets one chat request (`max_completion_tokens: 1`, no streaming) to its **first deployment**; an
`openai_compatible` gets `GET {base_url}/models`; Bedrock gets one SigV4-signed
`ListFoundationModels` read; Vertex signs an OAuth token with the credential's own service-account
key and reads one page of `projects.locations.endpoints`. The URL-typed two go through the SSRF
guard **on save**, so a loopback or metadata endpoint is refused before it can be stored — the
guard on the model path is the second line, not the first. A refusal also has to be useful without
quoting a secret: Bedrock's carries AWS's own reason bounded to 200 characters and scrubbed of all
three secrets, because a provider that quotes a rejected request can quote a key. The lesson that
cost us a release: Vertex's check shipped calling a route that does not exist — the publishers
surface is global and its listing is `v1beta1/publishers/{publisher}/models`, so
`…/publishers/google/models` is a 404 on every save — and **every Vertex credential was refused
while the tests passed**, because the stub servers had answered that route as if it existed. The
stubs now refuse paths they do not know
([#251](https://github.com/amirtuval/openharness/issues/251),
[#273](https://github.com/amirtuval/openharness/issues/273)).

**Claude on Vertex must be enabled per project, and the model listing cannot tell you.** Every
chat-capable Anthropic candidate is checked against
`POST …/v1beta1/projects/{project}/modelGardenEula:check` with body `{publisherModel}`, and only
models whose `publisherModelEulaAcked` is `true` are listed — an unenabled Claude model is not
offered rather than failing on the user's first message. The residual path (an id a chat already
runs, a model disabled after the catalogue's hour was taken) is rewritten by
`vertexModelGardenMessage` into "Claude models must be enabled for this Google Cloud project in
Vertex AI Model Garden (<model>) …", and **only** that message is rewritten: every other provider's
and publisher's error text is left exactly as written
([#273](https://github.com/amirtuval/openharness/issues/273)).

**Many of the newest Bedrock models are reachable only through a cross-region inference profile,
and the two control-plane reads have to degrade independently.** `ListInferenceProfiles`
contributes each ACTIVE profile as `<name>/<inferenceProfileId>` — the id a Converse request
actually names — with the profile's underlying foundation model as the key models.dev is read by
for name, window and price. A failed **profile** read (a key without `bedrock:ListInferenceProfiles`,
an `AccessDeniedException`) logs a scrubbed warning and leaves the on-demand list in place with
`status: 'ok'`, so a credential is never turned into the registry fallback over the profiles alone.
Two filters look like policy and are not: a model whose `inferenceTypesSupported` names only
`INFERENCE_PROFILE` is not callable in that region, and a `LEGACY` model is left out. Because a
profile's own id may not be in the registry, the lookup falls back to the foundation model it
wraps — guarded to the `bedrock` credential type, since stripping a geography prefix off another
provider's id would turn one model into another
([#274](https://github.com/amirtuval/openharness/issues/274)).

**A named credential's type is not its name, and Azure has no endpoint that lists deployments.**
`azure-eu/gpt-5.4` must read models.dev's single `azure` entry, so the catalogue and the reasoning
resolver read the credential **type**'s models.dev key first
(`credentialTypeInfo('azure_openai').modelsDevKey`). Azure's models come from the credential's own
typed `deployments`, one per deployment name, with the registry supplying a window only on an exact
name match and `null` otherwise rather than a guessed number. Joining a custom endpoint's models has
to be exact and unambiguous or not at all — `gpt-4o` is filed under both `openai` and `azure`, so a
loose match borrows the wrong name, window and price. A custom endpoint's key is genuinely optional,
so its `GET {base_url}/models` goes out with no `Authorization` header and `isUsableCredential`
checks that type's **base URL** rather than its key; a "key required" rule would refuse a local
Ollama that never had one ([#249](https://github.com/amirtuval/openharness/issues/249)).

**A `last4` must be an identifier a human recognises and nothing more.** For Bedrock it is drawn
from the **access key ID**, never the secret access key or session token; for Vertex it is the
service-account **private key id**, an identifier Google prints in the console. Non-secret per-type
facts ride in the credential's `details` — the base URL's **host**, the region, the
email/project/location — and a type with nothing to report carries none. Anything a provider said in
an error goes through `redactSecret`, which replaces the whole value minus its first four and last
four characters and leaves a secret shorter than eight characters alone.

**A resolved context budget has to be the same number the request is trimmed to.** The rule is
`contextWindow − min(maxOutput, 25% of contextWindow)` — what is subtracted is room for the reply —
and before #246 the brain trimmed everything to one 32,768-token constant, so a 200k model forgot a
long chat early and a small model could be handed more than it can take. Every `GET /v1/models`
entry reports the answer as `context_budget`, resolved by the very resolver `main.ts` hands the
scheduler, because a meter deriving a budget from `context_window` would measure against a number no
request is trimmed to — exactly the bug for a named credential or a custom endpoint that describes a
window the resolver knows nothing about. It is a **resolver and not a record** because the registry
holds hundreds of models and is refreshed wholesale, and `undefined` is a real answer (unknown
provider, a model the snapshot predates, a free-text id a host accepts) with the fallback living in
one place ([#246](https://github.com/amirtuval/openharness/issues/246),
[#280](https://github.com/amirtuval/openharness/issues/280)).

**Reasoning effort is data, and hand-written model patterns rot.** Which `low | medium | high` a
model takes is read from models.dev's `reasoning_options`, and only an `{type: 'effort', values}`
option is an effort knob — a `budget_tokens` or `toggle` knob carries no efforts however
reasoning-capable the model is. Before this, a new reasoning model silently got no effort and a
renamed one could be sent a level its API rejects with a 400. `undefined` (unknown) and `[]` (known
to take none) are kept apart and both mean "do not send it", because a level a model's API does not
know is a 400 rather than an ignored parameter; a level the model does not take is clamped to the
nearest it does (DeepSeek runs `medium` at `high`; Mistral has only `none` and `high`), and Azure
OpenAI's effort rides the `openai` options key because `azure.chat` **is** the OpenAI chat model
under an Azure URL, so `providerOptions.azure` would never be looked at. The same rot hit the
OpenRouter assumption — it used to get the effort for every model on the promise that it maps or
drops a level it does not know, which was a hand-maintained guess about a third party — and it
follows the data now ([#252](https://github.com/amirtuval/openharness/issues/252),
[`packages/brain/src/reasoning.ts`](../packages/brain/src/reasoning.ts)).

**Pass the key as a constructor argument, and seal the environment variables that would override
it.** A falsy `apiKey` silently becomes "no key given" and hands the request to the process
environment, and base URLs are pinned in the same table because a `*_BASE_URL` variable would move a
request and its key to a host nobody chose. Two providers need an explicitly **empty** `apiKey`: a
non-blank one — or a set `AWS_BEARER_TOKEN_BEDROCK` — flips the Bedrock client to bearer auth and
skips SigV4, so that path passes `apiKey: ''` to seal it, and Vertex passes `apiKey: ''` empty
rather than absent because a truthy one, or `undefined`, lets the provider read
`GOOGLE_VERTEX_API_KEY` and switches the client into "express mode". Vertex never uses ADC at all,
because the server runs on GCP and an ADC fallback would run a user's chat on openharness's own
service account. No decoy `AWS_*` or `GOOGLE_*` variable changes anything, and there are tests that
set them and assert nothing moved. Azure needs `.chat(id)` rather than the provider default, because
the default Responses API is unsupported by older deployments and the deployment name is user-typed.

**Own the retry, and check what your abstraction hides.** In `ai@7`, `maxRetries` defaults to 2,
which is up to three provider calls the turn loop never sees — and `onError` reports an
`AI_RetryError` wrapper with `statusCode`/`isRetryable` gone, so a retry policy written on those
fields silently stops working. Both knobs are set to 0 and the loop is the only retrier, writing the
events an SDK retry would skip. The larger version of the lesson is Mastra, which was tried and
removed ([#234](https://github.com/amirtuval/openharness/issues/234),
[#237](https://github.com/amirtuval/openharness/pull/237)) because `Agent.stream()` swallowed
everything the loop needed, retried underneath it and did not hand back a `LanguageModel`. An agent
framework whose loop you cannot see is the opposite of what a harness needs. And a shape bug in a
provider adapter can make every real session unreadable while every test passes: the removed router
declared the v2 provider spec while streaming v3-shaped usage, so `streamText` accumulated `0 + {…}`
and the total became the literal string `"0[object Object]"`
([#39](https://github.com/amirtuval/openharness/issues/39)).

**Visible, never silent.** A provider that times out (5 s), fails, cannot have its credential opened
or has no adapter is answered from the registry with `status: "fallback"`, `fetched_at: null` and a
`message` saying why — the provider's own status and a bounded snippet. The catalogue cache is per
(user, provider) in this process for an hour, invalidated on a credential write **on the serving
instance only**, and `refresh=true` bypasses it once per minute per user, answering the protocol's
429 `rate_limit_error` inside the window. A caller with no credentials gets
`{data: [], providers: []}` and **no outbound request at all**, which is what makes the route safe
to call from a first-run screen.

## Context compaction

**Two different things in this repo are called compaction, and confusing them wastes an afternoon.**
Context compaction ([#277](https://github.com/amirtuval/openharness/issues/277)) summarizes history
for the model and writes a `session.context_summary`; the delta compactor
([`apps/server/src/compaction.ts`](../apps/server/src/compaction.ts)) deletes the streamed chunks
replay already skips (D9) and summarizes nothing. They share a word and nothing else — the env
variable named for the second (`OPENHARNESS_COMPACT_INTERVAL_MS`) has nothing to do with the first.

**Compaction is once per turn, not per request, so it cannot loop.** A model request that overflows
the context — a per-family payload (OpenAI/Azure `context_length_exceeded`, Anthropic "prompt is too
long", Bedrock `ValidationException: Input is too long`, Gemini "exceeds the maximum number of
tokens allowed") — triggers one summarization pass with tighter caps, and a second refusal ends the
turn with an `exhausted` error whose message says whether there was no older history or the
summarizer failed. Summarize-then-retry-forever is the obvious loop and it is a hard hang.

**The threshold triggers on the _chat_ model's budget, the passes are sized to the _summary_
model's, and the plan is decided before any request.** The trigger is a share (default `0.7`) of the
chat model's budget, and the summary cap is the smallest of 12% of the chat model's budget, the
summary model's output ceiling, and a quarter of the summary model's own budget — with a running
summary already over the cap summarized **alone** first, as one extra pass the plan counts. If the
chosen summary model would need more passes than the limit, the chat model takes over and the event
records why; the chat model is never refused for needing many passes, and the refusal is arithmetic
rather than vague — a small summary model against a large context produced "…would take about **301
passes**, over your limit of 3…". Sizing both halves from one model is how a small summarizer gets
handed a prompt it cannot finish ([#281](https://github.com/amirtuval/openharness/issues/281),
[`packages/brain/src/summarize.ts`](../packages/brain/src/summarize.ts)).

**A summary supersedes nothing; it is a lens, not a replacement.** The transcript and replay stay
whole, and the only reader is the context strategy, which sends the system prompt, then the latest
un-superseded summary **as a second system message** (so trimming can never drop it), then every
event after `covers.to_seq` — which means a rewind to before a summary takes the summary with it, as
a consequence rather than a special case. A `purpose: 'summary'` span is the one exception to the
session's model projection, because projecting the summarizer would silently move the chat onto the
model that summarized it; each pass opens a span claiming nothing and writes a `session.usage`, so a
summary's tokens and cost are visible in the log like any other request, and progress is a stored
event per pass so a client that reconnects mid-compaction sees the same progress as the live stream.

**A message too big to send is shortened with a marker, never dropped, and where the history may be
cut is one replaceable function.** The newest item is capped to a head-and-tail with an
`[… N tokens omitted …]` marker and the request's span records
`truncated: {seq, tokens_before, tokens_after}` so a client can tell the reader — silently sending a
different prompt than the one that was typed is worse than saying what was cut. `trimToBudget` keeps
every system message and drops oldest turns two at a time, never the newest, and the size estimate
uses the newest span end's **real** prompt tokens where a baseline exists, but only when that
baseline ran on the same model, was not a summary request and was not superseded by a rewind, or the
number measures something else. The cut point is a seam that widens the tail to start at a
`user.message`, returns `0` for "nowhere to cut", never splits a turn, and is where tool call/result
pairs are kept together — a call and its result must never be separated by trimming or compaction,
because providers reject the request ([#278](https://github.com/amirtuval/openharness/issues/278),
[#276](https://github.com/amirtuval/openharness/issues/276)).

**A client-requested compaction has to be idempotent while it is pending, and a stored NULL means
"follow the deployment's default".** `POST …/compact` reads the newest of the
`session.compact`/`session.compaction` pair first and returns an unanswered request rather than
appending a second, so a double-tap on `/compact` does not queue two summarizations; the optional
`instructions` are capped at `COMPACT_INSTRUCTIONS_MAX_LENGTH` (2000 characters) and refused as a
400 before anything is stored. The server's controls are resolved per **owner** per request, and the
preferences response carries a `defaults` object saying what a `null` means, because a client cannot
know the server's threshold on its own. Compaction is also off unless a host asks for it: `runTurn`'s
`compaction` option absent means no trigger and no overflow handling, which is what the brain's own
tests run with ([#282](https://github.com/amirtuval/openharness/issues/282),
[#283](https://github.com/amirtuval/openharness/issues/283)).

**The summarization prompt is original text, and a prompt's provenance is a real question.** It
lives in the package in six fixed sections and is versioned; the code records that the Apache-2.0
Codex prompt was **not** adapted (so no third-party notice is owed) and that Claude Code's
proprietary prompt was not consulted. Two rules are baked into it — keep every user instruction,
and quote identifiers verbatim — because those are the two things a summary loses first and a
reader notices last.

## The tool loop

The Tools epic ([#303](https://github.com/amirtuval/openharness/issues/303)) is not merged. Every
entry here is open as one of
[#316](https://github.com/amirtuval/openharness/pull/316)…[#337](https://github.com/amirtuval/openharness/pull/337),
with everything together on `tools/x14-native-search-335`, so these reference the issue or pull
request instead of a path.

**Own the loop: give the AI SDK tool definitions with no `execute` on any of them, and disable its
retries.** A tool the SDK can run is a tool it runs itself, looping underneath the loop that owns
the log. Without `execute` the SDK stops after the step and hands the calls back, and the brain
stores the call, runs it through `@openharness/hands` and makes the next request as its own step —
one request per step, each with its own span and stored events, which is exactly what makes a turn
durable, resumable and observable. The same reasoning sets both SDK retry knobs to 0: `maxRetries`
defaults to 2, which is up to three provider calls the loop never sees, and leaving it surfaces an
`AI_RetryError` wrapper instead of the provider's error
([#304](https://github.com/amirtuval/openharness/issues/304),
[PR #316](https://github.com/amirtuval/openharness/pull/316)).

**A step's calls run concurrently, but their results are stored in call order, in one append.** The
calls are all stored before anything runs, then run via `Promise.all`, then their results are
appended in the model's own order — so three fetches take one fetch's time, and the log reads as the
model asked its questions rather than as they happened to finish. Each call event records the
permission it was **evaluated under**, not the current setting, so a policy change mid-turn cannot
rewrite history ([#304](https://github.com/amirtuval/openharness/issues/304)).

**A step cap has to be a visible error, and "stuck" is a different condition from "long".**
`DEFAULT_MAX_TOOL_STEPS` is 50 (`OPENHARNESS_MAX_TOOL_STEPS`), and going over ends the turn with
`tool_steps_exhausted_error`, `retry_status: terminal` — a runaway is stopped, not hidden. A
separate detector catches a loop that keeps failing without growing: a one-time reminder at 5
consecutive failures, the turn ended with `tool_loop_stuck_error` at 8, with old tool output cleared
before messages because that is what a request can most afford to give up. A `deny`, the user's own
denial and an interrupt are explicitly **not** failures
([#331](https://github.com/amirtuval/openharness/issues/331),
[#333](https://github.com/amirtuval/openharness/pull/333)).

**The brain words every refusal, and it never stores something a reader cannot parse back.** A
denied call is answered `Permission to use <name> has been denied.`, an unknown one `No tool named
<name> is registered.`, a call cut short `Interrupted by the user.`, a timeout `Tool <name> timed
out after <n> ms.` — an empty answer would make the model guess — and a call naming a tool the
request was not built with is answered exactly like one nothing carries, because the tool is not in
the registry that step was handed. Tool inputs are walked once to pure JSON to a depth limit of 32,
with a `Date`, a function, a `BigInt`, a cycle or a non-finite number dropped and a non-object
argument becoming `{}`. One reader abstraction covers built-in and MCP tool calls, because the two
pairs differ only in their event type strings, their id field and `mcp_server_name` — a duplicated
branch is exactly how a reader silently handles one pair and not the other
([#312](https://github.com/amirtuval/openharness/issues/312)).

## Pausing for the user

**A pause is written down, not held in memory.** A call evaluated as `ask` (or any `ask_user` call)
is stored with nothing running it and the turn ends idle with
`stop_reason: {type: 'requires_action', event_ids}`. That is what makes the wait survive a restart,
a compaction and a replay without storing anything beside it, and it is why a paused turn holds no
lease and no concurrency slot — the session is simply idle until a `user.tool_confirmation` arrives,
on any instance. Holding the wait in memory would block slots and not survive restarts
([#305](https://github.com/amirtuval/openharness/issues/305),
[PR #320](https://github.com/amirtuval/openharness/pull/320)).

**Never re-run a tool automatically after a crash.** A tool can have side effects, and a call with
no result is one whose effect nobody recorded — repeating it would duplicate a write, a purchase or
a message. The call is answered `execution lost` and the **model decides** what to do next. Three
refinements make the rule correct rather than merely cautious: a call still **waiting on the user**
is not answered, because the question is open and a resumed brain keeps waiting, while a call the
user did answer and which then went unanswered **is** lost; a **provider-executed** call is exempt
entirely, because nothing of ours ran it and `execution lost` would be a sentence about a call that
succeeded; and the rule covers remote tools, since an MCP call may have had an effect nobody
recorded just as a built-in may, with the answer written in the call's own pair. The same log looks
different depending on which turn reads it, so an approved-but-unrun call is answered as lost by the
turn that **inherited** the branch and run by the turn the confirmation started — the discriminator
is captured at the start of the turn ([#307](https://github.com/amirtuval/openharness/issues/307),
[#314](https://github.com/amirtuval/openharness/issues/314),
[PR #319](https://github.com/amirtuval/openharness/pull/319)).

**A message that arrives while calls wait resolves every one of them, worded as a message.** Each
waiting call gets an error result reading `The user sent a message instead.` — the sentence names the
message rather than the act that ended the waiting, because an interrupt does the same thing and the
model should not be told the user "denied" tools they simply moved past. The web composer says so
before Enter, in a dashed row above the box: sending declines what waits, and the status then reads
`dismissed`, because the reader moving on is not a failure.

**A confirmation is not a queued user event, and an approval's memory lives in the log.** It is a
`user.*` event, but the server writes it with a real `processed_at` only after checking the named
call is really waiting, and nothing claims it — so a session sitting on one looks idle to everything
that reads the store's pending list, which is why `answeredWaiting` exists. Validation is
server-side before storage: the named call must be an unanswered tool use of **this** session with
`evaluated_permission: 'ask'`, answers must fit the questions, `remember` is refused for `ask_user`,
and any mismatch is a 400 that stores nothing. `remember` is `once` | `session` | `always`, and
`session`/`always` are read back off the log on every request — so a rewind past the confirmation
takes the approval back with it, and `always` also writes the user's stored per-tool policy.
`ask_user` is the one pause that is **not** a permission question, so the wait predicate is
`registered && (permission === 'ask' || name === ASK_USER_TOOL_NAME)`. Finally, "Allow all" over
several pending approvals is deliberately the _once_ approval for each: answering several at once
must not hand out a remembered permission
([#309](https://github.com/amirtuval/openharness/issues/309),
[PR #321](https://github.com/amirtuval/openharness/pull/321)).

## Provider-opaque content and reasoning

**Opaque provider content needs its own event, one per model request.** `agent.opaque_content`
carries the provider family, the model, the parts and a `dropped` count, because the step it matters
for — a thinking model's tool call — streams no text, so a field on `agent.message` could not carry
it ([#334](https://github.com/amirtuval/openharness/issues/334),
[PR #336](https://github.com/amirtuval/openharness/pull/336)).

**Replay opaque content only to the same provider family and the same model, keep its position, and
replay Claude's signature contiguously.** A thinking signature, an encrypted payload and a stored
item id are all bound to the model that produced them, so every row is `sameModel: true` and a
provider switch or a model switch within a provider drops the entry. `text_before` — the character
offset into the step's own text — rebuilds the provider's own order, and replaying in a different
order broke text/search ordering. Anthropic's preserved-thinking check accepts a contiguous window
of blocks, so **every** matching entry is replayed rather than just the newest, because "newest turn
only" leaves a gap mid-sequence and the block after the gap fails. Capture is all-or-nothing at
65,536 characters: a cut signature is not one the provider accepts and dropping one part mid-sequence
is exactly the hole the check refuses, so a step over the cap keeps none and records how many it
dropped.

**DeepSeek thinking mode rejects a tool turn that does not echo `reasoning_content` back.** That is
why an `openai-compatible` family row exists at all: the `deepseek` provider id is unaffected
because its own client sends the empty key, but the OpenAI-compatible client skips an empty
`reasoning_content`, so a step that streamed none stores nothing and an endpoint demanding it then
refuses — roughly one turn in four against the DeepSeek endpoint before the family row
([#330](https://github.com/amirtuval/openharness/issues/330)). Never hand a model another model's
thoughts: cross-provider, a provider-executed search **result** is downgraded to plain text while a
reasoning block never is, however much text it carries. A stored entry for a family this version
does not know is dropped rather than guessed at, and a keyed family's reasoning part **without** its
payload refuses the whole entry rather than sending half of it. Gemini is deliberately not a family,
because its thought signature rides the tool-call part, so a reasoning-only row would half-answer.

## Provider-native web search

**A provider-native search beats a search API key.** There is no operator key to hold, no per-user
quota to enforce and no extra request: the provider runs the search inside the model request, and
the loop attaches the chat model's own provider's tool. `web_search` is the one built-in this build
does not run — there is no `hands` `ToolDefinition` for it and nothing for the approval flow or the
crash rule to act on ([#335](https://github.com/amirtuval/openharness/issues/335),
[PR #337](https://github.com/amirtuval/openharness/pull/337)).

**Per provider, a native search costs money, has a tool version, or is impossible.** Anthropic bills
a flat **$10 per 1,000 searches** on top of tokens (OpenAI's and xAI's absence from the price table
means "no separate fee", priced through the model's own rates, not "unknown"), and its `maxUses`
defaults to unlimited, so this build caps it at `MAX_SEARCHES_PER_REQUEST = 10` — otherwise one
request becomes a research session. The same model id on Vertex gets the **older** tool revision
(`webSearch_20250305`) while the direct API gets `webSearch_20260318`. Gemini gets no search at all,
and the reason is a terms requirement rather than a technical one: Google's grounding terms require
rendering `groundingMetadata.searchEntryPoint`, an HTML widget, wherever the grounded answer
appears, and a terminal cannot. Azure has no equivalent because this build's Azure client is the
chat-completions one.

**A search that runs inside the provider's request cannot be paused for approval, so an `ask` policy
is meaningless.** `deny` therefore means "do not attach the tool at all" — an ordinary tool with
`deny` is still offered so the model can be told no, but a provider-executed one has no moment at
which this build could refuse — and a stored `ask` is read as `allow` while the settings route
refuses a new one. A switch that says "ask me" and can never ask is worse than no switch.

**Don't assume a tool's inputs are where the inputs usually are.** Anthropic's search carries
`{query}` on the call, but OpenAI's and xAI's carry no query there at all: the query lives on the
**answer**, as `action.query`/`action.queries` or the `url` of an `openPage` action. xAI's `xSearch`
— which searches X posts, not the web — is deliberately not offered.

**Count a provider-executed search once, and let a search that cited nothing answer instead of ending
the turn.** It also appears in the log as a readable `agent.tool_use`/`tool_result` pair, so counting
both double-counted every search — it read 4 for two searches in both usage routes, the chat header
and `oh`'s status line; the counter takes only non-provider calls and then adds `event.searches` from
each span end ([#338](https://github.com/amirtuval/openharness/issues/338)). An empty text block
fails the protocol's `TextBlockSchema`, so a provider search with no citations ended an already-paid
turn with `session.error {type: "unknown_error", retry_status: "terminal"}` — the fix stores a
written-out result, `The provider ran a web search and cited no pages.`
([#339](https://github.com/amirtuval/openharness/issues/339)). A model the search table wrongly
_includes_ is caught by the provider's own refusal, and the loop retries once without the tool: the
test is deliberately narrow — a 4xx (never a 5xx) whose message matches `/web[ _]?search/i` — and the
retry is outside the ordinary budget, once per turn, so a provider rejecting the tool cannot become a
retry storm.

**Capability allowlists by model name go stale, and the asymmetry decides which failure you want.**
The allowlist matched a shipped generation literally, so `gpt-6-astra` was told "no web search" and
`claude-fable-5-1` matched nothing; the fix is a forward-compatible rule (generation ≥ N), or better,
data. The lesson the file records is the asymmetry: **a false positive is a retry, and a false
negative is a feature nobody can use.** Tool support follows the data for the same reason —
models.dev writes `toolCall` only when it is _false_, so an unknown model answers "not known to be
unable" and the tools are offered ([#335](https://github.com/amirtuval/openharness/issues/335)).

## Web fetching and content extraction

**A naive HTML-to-Markdown conversion gives you navigation and cookie banners.** `web_fetch` uses
`linkedom` + `@mozilla/readability` + `turndown` — not jsdom, which would drag in a whole browser's
machinery for no gain — and falls back to a DOM heuristic when Readability's article is not the page.
The trigger is measured rather than guessed: the article must hold at least `ARTICLE_TEXT_RATIO`
(0.25) of the document's text, a number picked because the page that broke it had a byline list worth
about 16% of its text. Readability is handed a clone inside a try/catch, because it mutates its input
and throws.

**Truncating a tool result: keep the beginning, and say what was cut.** Cutting head-and-tail — the
obvious way to keep both ends — kept a page's footer and dropped its headline, and the model then
reported that the page had no headline. The per-result cap therefore keeps the head only, at the
smaller of the tool's own `maxResultTokens` and 20% of the history budget, with a distinct
`[… N tokens omitted …]` marker. The **wording** matters just as much: a truncation notice once told
the reader "your message was too long" when what had been shortened was a tool result, and a reader
who believes they typed too much learns the wrong thing about their own message
([#314](https://github.com/amirtuval/openharness/issues/314),
[PR #329](https://github.com/amirtuval/openharness/pull/329)).

**Charset detection has a fixed order and the HTTP header wins.** Header, then BOM, then a `<meta>`
sniff over the first 2048 bytes decoded as latin1, then UTF-8 — and an unknown name falls back to
UTF-8, because a replacement character is a better answer than a refusal. The rule runs in both
directions and both are tested with an invented 189-byte windows-1255 Hebrew fixture: served as bare
`text/html` the meta is sniffed and the text decodes to `שלום עולם`, but served as
`text/html; charset=utf-8` the **header wins** and it mojibakes. Without that order a Hebrew news
site is unreadable to the model.

**Scrub the DOM, not the output string, and give every fixture exactly one job.** The "no stray
punctuation" fix is two DOM passes rather than a regex over the Markdown: empty elements are dropped
(an `<a>` with no text and no `img[src]`, any `<img>` missing `src` or `alt`) and block-level links
are reflowed so `<a href><h1>X</h1><p>Y</p></a>` renders `# [X](href)` instead of an orphan `[` far
above its `](href)` — which is also what removes empty icon links and spacer GIFs. The fixtures each
prove one thing: `consent.html` (690 bytes — cookie and GDPR banners dropped by a whole-word rule
while `class="mycookierecipe"` survives, the false positive the rule has to avoid),
`hacker-news.html` (31 empty `[](href)` links and the `s.gif` spacer gone), `wikipedia.html`,
`ynet.html` (a Hebrew headline kept and led with) and `windows-1255.html`. A fixture that proves two
things at once hides which one broke.

**A tool's own limits should override the shared guard, deliberately, and an SSRF guard has to
re-check every hop.** `web_fetch` raises the byte cap to 2 MiB against `safeFetch`'s 1 MiB default,
because HTML is mostly markup the Markdown drops, and lowers the timeout to 20 s so it fires **under**
the registry's 30 s tool timeout — the tool's own deadline produces a result that names the fetch,
the registry's a generic timeout. `safeFetch` itself sets `redirect: 'manual'` and reruns the whole
chain per hop (scheme, metadata hostname, resolve-every-address, a per-hop pinned dispatcher whose
`connect.lookup` refuses every other name so a lookup never falls back to an unchecked DNS answer,
while SNI and `Host` stay the original); a cross-origin hop strips `authorization`, `api-key`,
`x-api-key`, `x-goog-api-key`, `cookie` and `proxy-authorization` and they are not picked up again
if a later hop returns to the origin. A DNS answer resolving to even **one** refused address refuses
the name whole, because a public-plus-private pair is an attack rather than a coincidence. One
honest limitation: through an egress proxy the address check still runs but the **pin does not**,
because an HTTP proxy resolves the target itself — so a deployment with a proxy must have the proxy
refuse private ranges, and production egresses via Cloud NAT with no proxy
([`packages/hands/AGENTS.md`](../packages/hands/AGENTS.md)).

## Remote MCP servers and OAuth

**Always send `Authorization: Bearer <token>`, and always carry the RFC 8707 `resource` on the
refresh.** Using the OAuth response's `token_type` verbatim as the scheme made Linear's MCP answer an
empty-bodied 401 — and the difference is diagnostic: Linear answers an empty 401 for a missing or
non-Bearer header and a 401 with `error="invalid_token"` for a bad Bearer token. The official MCP SDK
always uses `Bearer`, so the token type is not a choice this client gets to make. The `resource`
parameter is the other half: naming it on the authorization request and the code exchange but not on
the refresh lets an authorization server serving several APIs mint a refreshed token for the wrong
audience, which Linear refuses with a 401; it is persisted **with the registration** and guarded
same-origin, so a metadata document naming a third party is not followed
([#316](https://github.com/amirtuval/openharness/issues/316),
[#314](https://github.com/amirtuval/openharness/issues/314),
[PR #329](https://github.com/amirtuval/openharness/pull/329)).

**Diagnose a failure by recording the response yourself.** The SDK's error for an empty-bodied 401 is
`Streamable HTTP error: Error POSTing to endpoint: ` — it simply ends at a colon, with no status,
status text, body or `WWW-Authenticate`, so a recording fetch wrapper reads the challenge's `error`
and `error_description` and produces bounded, pinned sentences (`the MCP server answered 401
(invalid_token: the token expired)`, `…answered 401 Unauthorized, with no message`, `no response from
the MCP server: fetch failed`), capped at 500 characters with every value this server sent scrubbed.
A 401 that carried **no** `Authorization` header gets an extra clause saying so, because that is a
differently-shaped fault from a rejected credential and the one distinction that tells a reader which
fix to apply ([#316](https://github.com/amirtuval/openharness/issues/316)).

**The well-known URL goes before the resource path, and the two metadata documents are tried in
order.** Protected-resource metadata is `/.well-known/oauth-protected-resource{path}` — so
`https://mcp.example.com/mcp` discovers at
`https://mcp.example.com/.well-known/oauth-protected-resource/mcp` — and the authorization-server
candidates are `/.well-known/oauth-authorization-server{path}` then
`/.well-known/openid-configuration{path}`. PKCE is always S256, registration is RFC 7591 with
`token_endpoint_auth_method: 'none'`, and a server with no registration endpoint is refused with a
message that names `dynamic client registration` and says a pre-registered client is not supported
yet, rather than failing anonymously ([#311](https://github.com/amirtuval/openharness/issues/311)).

**Don't make the user choose the auth type; probe the URL.** No auth and no headers means probe
unauthenticated: a successful `initialize` is `auth: 'none'`, `status: 'connected'`, and the probe's
tool list is kept. A 401 or 403 whose RFC 9728 metadata advertises an authorization server is
`auth: 'oauth'`, `status: 'needs_reconnect'` — a 403 is a missing scope, not a different problem. A
401 with no such metadata is `'none'`/`'error'` with a message ending "it wants credentials, but it
advertises no OAuth authorization server; add an API key under 'Advanced: custom headers'". Other
harnesses detect this too, which is a good sign it is the right default
([#314](https://github.com/amirtuval/openharness/issues/314)).

**Every MCP and OAuth request goes through the SSRF guard — including discovery, registration and
token calls — and redirects are refused outright.** The MCP SDK takes an injected fetch, which is
what makes that possible; without it, a metadata document pointing at a private host would be dialled
by the SDK before any of our code saw it. `maxRedirects: 0`, because a user-typed MCP URL has no
business following a redirect elsewhere. A guard refusal is a 400 that stores nothing, and the
refusal codes are an explicit list (`blocked_address`, `metadata_host`, `invalid_protocol`,
`invalid_url`) rather than a substring match.

**The OAuth callback is authenticated by `state`, not by a session.** The CLI opens the system
browser, which may never have signed in — and a page could be signed in as somebody else entirely —
so a callback whose browser session belongs to a different user is refused with "this authorization
was started by another user; start the connection again". The state is 32 random bytes with a
10-minute life, consumed on the way out either way, so a refused callback cannot be retried. The
callback route is registered **before** the `/v1` guard and only its `GET` is exempt, and the flow
records whether it was started by the web app or the CLI: the web gets a 302 to
`/?mcp_connected=<id>#/settings` (query before hash) and the CLI an HTML page. Everything echoed into
that page is HTML-escaped and sliced to 300 characters, because an `error_description` is
attacker-controlled text ([#311](https://github.com/amirtuval/openharness/issues/311)).

**Bind a sealed secret to what it belongs to, drop it when that changes, and lead every remote answer
with its provenance.** MCP secrets use a family-specific AAD,
`mcp:{userId}|{serverId}|{purpose}` — the prefix stops an MCP blob decrypting under a provider
credential's AAD, and the **server id** rather than the name means a rename does not invalidate
secrets. Tokens survive a rename but are set to `null` on an auth or URL change, because a token
minted for one server is not sent to another; refresh happens at a 60-second skew; a blob that does
not parse is treated as absent rather than as an error; and a failed connection check is
`needs_reconnect` for an OAuth server and `error` for the others, with a chat never blocked by a
server that is down. Every result is then prefixed with a line naming the server and tool and saying,
in as many words, that it is data from a third party and must be read and never followed — prompt
injection from a server the user connected is the threat, and one line at the top of the result is
the cheapest mitigation there is.

**The offered name has to be a pure function of (server, tool), and a listing has to be cached on the
thing that changes.** `mcpToolOfferedName` joins them with `__`, sanitizes and truncates to 64
characters, and on a collision the **later tool is dropped rather than renamed** — the only reading
that keeps the offered name recomputable from a call event in the log, which is what makes an old
approval or a stored policy still meaningful. Listings are cached per (user, server) keyed on
`server.updated_at` with a 30-second TTL, so an update, a connection check, a token refresh or a
disconnect invalidates immediately wherever it happened; failures are not cached, and a listing
401/403 for an OAuth server calls `disconnect()` so the settings screen offers reconnect
([#323](https://github.com/amirtuval/openharness/issues/323),
[#312](https://github.com/amirtuval/openharness/issues/312)).

**Listing every remote tool in the general tools list is unusable.** Linear has dozens, and a flat
list buries the three built-ins; tools are managed **per server**, with a batch "allow/ask/deny all"
whose aggregate state reads `All tools: Ask (all)` or `All tools: Mixed`, and a server's tools are
set in **one** `PUT /v1/me/tools` carrying an `mcp` map rather than one request per row. Tool
settings are a per-tool merge with deliberately no delete: an absent tool follows its own
declaration, `allow` for a built-in and `ask` for an MCP tool, so deleting a row is not a way to
change a policy. A mode's override is tri-state (`follow | on | off`) on the screen but a boolean map
on the wire, and saving must carry the keys it does not touch. And a prompt must say **whose** tool
it is — `notes__search (mcp: notes)` — because "allowing `search` on a server the reader runs is a
different decision from allowing their own `web_fetch`, and two servers' `search` differ by nothing
else on the line" ([#313](https://github.com/amirtuval/openharness/issues/313),
[#327](https://github.com/amirtuval/openharness/pull/327)).

## Skills: importing from git

**`isomorphic-git`'s `listFiles` walks into a submodule and fails the whole clone; a `TREE` walk that
skips non-blob entries does not.** A tree entry of mode `160000` is a gitlink — a commit whose object
lives in another repository — and `listFiles` reads it, so a repository with one submodule anywhere in
its tree ends the import with `Could not find <sha>` however unrelated the submodule is to the skill.
Walking the tree yourself (`git.walk` with `TREE({ ref })`, keeping entries whose `type()` is `blob`)
reports the type without reading the object, which is what makes "no submodules" (K3) a property of
our code rather than of a library's error path
([#351](https://github.com/amirtuval/openharness/issues/351)).

**Read the ref advert before cloning, because `HEAD` locally does not resolve after a shallow
single-branch clone.** `_init` writes `ref: refs/heads/master`, and a `singleBranch` fetch writes the
branch it fetched as a **remote-tracking** ref (`refs/remotes/origin/main`) — so `resolveRef('HEAD')`
on the fresh clone answers `NotFoundError: master`, and there is no local ref that names what was just
fetched. The way out is one extra `GET /info/refs`: `git.getRemoteInfo` answers the default branch,
and the clone is then made with an explicit `ref`, so the commit the clone landed on is resolvable by
name. That call's own shape is worth knowing too — refs come back as a tree (`refs.heads.main`,
`refs.tags.v1`) while the symref `HEAD` is a **top-level** field holding the target verbatim
(`refs/heads/main`) ([#351](https://github.com/amirtuval/openharness/issues/351)).

**A clone failure has to be classified from more than its error code.** `isomorphic-git` raises
`HttpError` with a status, `NotFoundError` for a ref that is not there, and `RemoteCapabilityError` for
a server that is not a git server at all — but a connection that never opened surfaces as undici's
bare `TypeError: fetch failed` with no `code` at all, so "unreachable" is the case with _nothing_ to
read rather than another code to add. The same lesson from the other side: a download cap enforced
inside the response body is reported by the library as its own `Empty response from git server`, so the
cap records a flag as well as throwing — the flag is what survives the library's translation
([#351](https://github.com/amirtuval/openharness/issues/351)).

**`allowPrivate` is coarser than "loopback", and a sandbox's egress proxy can answer for an address
the guard was supposed to refuse.** The self-host flag lets **every** non-public address through,
link-local and the metadata service included; a test that wants to show a redirect landing on
`169.254.169.254` being refused therefore has to keep its first hop on a **public** name (an injected
resolver plus a transport that connects to the fixture, the pattern `web-fetch.test.ts` uses) rather
than turning the flag on. And with `HTTP_PROXY`/`HTTPS_PROXY` set — as in the sandbox this was built
in — a hop to a link-local address is answered **by the proxy** (`No MMDS token provided`, a 401), so a
refusal test that forgets to delete the proxy variables fails for the wrong reason, or worse, passes
by accident ([#351](https://github.com/amirtuval/openharness/issues/351)).

**A test fixture for smart HTTP is real `git`, not a hand-written packfile.** `git upload-pack
--stateless-rpc --advertise-refs` behind `GET /info/refs` and `--stateless-rpc` behind the `POST` is
all a clone needs, and it is what `git http-backend` runs — so the _client_ is what is under test, and
the fixture cannot agree with a bug in our own idea of the pack format. Two details that cost time:
the responses must be assembled and written as **binary** (a UTF-8 round trip corrupts a packfile only
on the repositories whose deltas hold invalid sequences), and the advertisement needs the
`001e# service=git-upload-pack\n0000` preamble in front of git's own lines. It is exported from
`@openharness/hands/testing` rather than kept in a test file, because the server's import tests and
the QA specs of [#355](https://github.com/amirtuval/openharness/issues/355) want the same repository
([#351](https://github.com/amirtuval/openharness/issues/351)).

**Sort a preview's file listing the way the store does, or the preview and the skill it becomes
disagree.** `SkillStore` lists a snapshot's files in code-point path order (`'SKILL.md'` before
`'reference/tone.md'`), which is **not** `localeCompare`'s order — a locale-aware sort puts
`reference/…` first, so an import that sorted that way showed one order in the preview and another
after the import succeeded ([#351](https://github.com/amirtuval/openharness/issues/351)).

## The HTTP layer

**A route whose path parameter may hold slashes is written `:path{.+}`, not `*` — Hono 4 does not
expose a wildcard's matched text as a parameter.** Serving a skill's files needs the rest of the URL
(`/v1/me/skills/{id}/files/reference/tone.md`), because a skill's paths are relative and nested, and
`app.get('/…/files/*', c => c.req.param('*'))` answers `undefined` in hono 4.13.9: `c.req.param()`
carries only the named parameters. `:path{.+}` is the spelling that works, and Hono **decodes** it —
`a%20b.md` reaches the handler as `a b.md` — while leaving a malformed escape (`%zz`) as it is rather
than throwing, so a lookup by that path is simply a 404 and the handler needs no `try`
(`apps/server/src/routes/skills.ts`, epic #349).

## Frontends: the web app and the TUI

**A 401 is the only "am I signed in?" signal, and it replaces the whole screen — with exactly two
exceptions.** A module-level store means any call returning 401 puts the sign-in page in place of
whatever was on screen, which is why a revoked session cannot leave half-broken panels behind. The
exceptions are a 401 from a **credential write**, which means the session is not _fresh_ (Better
Auth's `freshAge`) and gets an inline "sign in again" prompt, and a failed transport, which is not a
session problem at all. Auth state belongs to a client instance rather than a module, so a rebuilt
client answers `checking` until asked instead of inheriting another client's answer, and the re-check
keeps the previous frame up while it is in flight, so a Save does not flicker the screen. A browser
session is a cookie, so there is nothing to store: `credentials: 'include'` is the entire mechanism
while the CLI's bearer token is the second way into the same API. The two auth surfaces also answer
different error shapes — Better Auth answers `message`, the device endpoints the OAuth pair
`{error, error_description}` with no `message` — so one error mapper has to know both
([`apps/web/docs/auth.md`](../apps/web/docs/auth.md),
[#80](https://github.com/amirtuval/openharness/issues/80)).

**Load history first and open the stream at your last `seq`, and fold a sent message in twice on
purpose.** A stream opened without `afterSeq` is live-only and one opened at `0` replays everything;
the web app folds the history and then opens at `transcript.getState().lastSeq`, which is the
difference between "no gaps and no duplicates" and "usually fine". `sendMessage` returning the stored
event applied immediately, with the stream's copy dropped by the transcript's `seq` rule, is
deliberate: waiting for the stream leaves a visible gap after Enter that reads as a dropped message.

**Streaming markdown needs no "incomplete markdown" pass, and highlighting needs no eager bundle.**
CommonMark closes an unterminated fence at the end of its input, so a streaming fence is a code block
from the first line; GFM's one quirk is that `[the docs](https://exa` leaves the marker as text and
autolinks the address. Shiki's whole-language table is ~30 kB gzip of _metadata_ whose values are
`() => import()` thunks, so only the grammar a fence names is fetched, and `defaultColor: false`
emits all three palettes as CSS variables so a theme switch repaints with no re-highlight. Two React
traps cost real milliseconds: a percentage width inside a shrink-to-fit box resolves back to the
content, so a short code block drew a stub until the bubble got `has-[pre]:w-full`; and the
`components` object handed to `react-markdown` must be a module-level constant, or React remounts the
subtree on every render — the same class of bug as an unmemoized message list re-rendering on every
keystroke and making the status row flicker. The proof is a render-count test rather than a DOM
assertion: it types into the box and asserts the message list did not re-render (~23 ms of scripting
per keystroke on a 27-message chat before memoization, ~5 ms after)
([#227](https://github.com/amirtuval/openharness/issues/227),
[#231](https://github.com/amirtuval/openharness/issues/231),
[#314](https://github.com/amirtuval/openharness/issues/314)).

**A native `<select>` cannot be themed, and a fill colour and a text colour are different problems.**
The model picker is a hand-rolled listbox following the combobox pattern (`aria-activedescendant`,
Escape returning focus to the trigger), because the native popup ignored the theme and was unreadable
in dark mode ([#87](https://github.com/amirtuval/openharness/issues/87)); a refresh's 429 is modelled
as an outcome (`{ok: false, kind: 'rate_limit'}`) shown inline rather than as an error state, because
being rate-limited is something the reader can wait out. On colour: white on `#7C3AED` measures
5.7:1, but the same violet as _text_ on a violet-black page measures 2.9:1, under AA — hence a
separate `--link` token that lifts to `#A78BFA` where the colour is a word and stays vivid where it
is a surface, with coral split the same way in reverse. `background-clip: text` paints over a
colour-emoji glyph's own colours, which is why the hero's ✨ sits outside the clipped span, and a
theme flash is fixed with a five-line inline script in `index.html` that reads `localStorage` before
the first paint — the one place that duplicates the store's `system` resolution, which is a cost
worth paying once. Known contrast failures are written down rather than silently fixed: Dark's
`--destructive-foreground` on `--destructive` measures 2.8:1, below AA, and a visual pass deliberately
leaves it ([#203](https://github.com/amirtuval/openharness/issues/203)).

**Terminal input is not keyboard input, and a terminal's background must not be queried.**
"Shift+Enter" is not a key most terminals can send — both Enter and Shift+Enter send `\r` — so the
newline is bound to Ctrl+J (`0x0A`) and Alt+Enter (`ESC`+`\r`). A bracketed paste is a different event
from typing, so a pasted `\r`/`\r\n` is normalized and cannot send the message; a paste over 2000
characters is drawn collapsed as `[pasted N lines]` but sent in full, and a deletion reaching into
the collapsed label takes the whole paste. A literal slash needs an escape (`//anything` is sent as
`/anything`), an unknown `/name` is echoed with the closest match and sent nowhere, and in a command
menu Enter runs the **highlighted** command rather than the typed text. For the background, an OSC 11
query would swallow a keystroke, leave stray bytes when unanswered and delay the first frame by its
timeout, so `COLORFGBG` is read instead and a config `theme` overrides a terminal that reports
nothing or wrongly; sixteen ANSI colours are used for text and backgrounds are _derived_ from the
terminal's background, because the 16 have no subtle grey
([`apps/tui/docs/prompt.md`](../apps/tui/docs/prompt.md),
[`apps/tui/docs/markdown.md`](../apps/tui/docs/markdown.md)).

**A terminal UI's settled output can never be redrawn, so reserve space for what comes next.** Ink's
`<Static>` writes a block once and never redraws it, which has three consequences: a resize leaves
old output at its original width, a running tool call committed to the scrollback would stay
"running" for the life of the screen, and the last column has to be reserved on **every** message
because the streaming cursor `▌` is its own column and a full-width line pushed it onto a new line.
Wrapping therefore has to be done by hand, ANSI-free and column-accurate (`string-width`), with
double-width characters moved whole. Code blocks have no gutter and no box for a related reason:
selecting the block copied the `│ ` bar with it
([#229](https://github.com/amirtuval/openharness/issues/229)).

**A reply's metadata arrives after the reply, so hold it out of the settled area.** The stored
`agent.message` arrives before `span.model_request_end`, which carries duration and tokens; a
terminal that settles the reply first can never add the footer, so the TUI keeps it live one turn
longer, and the web app reconciles previews on **both** the span end and `session.status_idle` — the
idle half is what stops an empty reply bubble when the span end never arrives
([#40](https://github.com/amirtuval/openharness/issues/40)). Related: nothing in the log
distinguishes "the reader stopped this" from "the turn ended" (the protocol's `StopReasonSchema` is
only `end_turn`), so "Interrupted" is each frontend's own memory of the one action that could only
have come from it — worth knowing before adding a "was this interrupted" field to a query.

**A secret input must not be a general-purpose prompt, a version check must not delay a command, and
exit codes are an interface.** The provider-key prompt is its own component, not `PromptInput`,
because that echoes what it holds, hands every line to the history and treats a pasted file as a
feature — none of which may happen to a secret. Auto-update runs in a detached `unref`'d child,
because a foreground lookup for something quick like `oh whoami` dies with the process before npm
answers, having spent the hour anyway; the foreground only decides _whether_ to spawn, out of free
checks. And the CLI's exit codes mean something: `0` when the command did the task (including a chat
the user ended and a delete answered "no"), `1` for a server, network or sign-in refusal, `2` for a
bad command line or config, and `130`/`143` when signalled
([#197](https://github.com/amirtuval/openharness/issues/197)).

**A terminal's scrollback is write-once, so anything that must change lives in the live area — and
a second column is impossible.** Ink's `<Static>` prints each item once and never rewrites it (it
renders `items.slice(index)` from the last length it saw), which is exactly what stops a streamed
reply from repainting the scrollback on every delta — and also a one-way door. A toggle such as `oh`'s
Ctrl+O detail view can only expand calls still in the live area; calls above it keep their compact
line, so say so rather than letting the key look broken. For the same reason the task list is pinned
at the bottom of the live area, folded and windowed to fit the terminal's height: a panel "on the
right" would have to be part of the live frame, redraw on every delta and narrow — re-wrap — lines
the terminal has already printed. When choosing control keys, remember Ink reports raw bytes
(`Ctrl+O` is `0x0F`, `Ctrl+T` `0x14`) and that some multiplexers swallow keys before they arrive
(epic [#303](https://github.com/amirtuval/openharness/issues/303); on the tools stack:
`apps/tui/src/components/tool-call.tsx`, `todo-panel.tsx`).

**Ink gives `useInput` the last _committed_ render, so a key that acts on what a write just did has
to read a ref — and a screen's own cursor cannot be the only source of truth.** A write is a round
trip, so for the length of it the handler still closes over the value from before the keystroke: two
quick presses of a permission key compute the _same_ next permission and send it twice, which a test
that polls the stored value sees as "the second press did nothing". The fix is the one the command
menu and the provider form already use — the row the key acts on lives in a ref, patched the instant
the write resolves and replaced by the read-back that follows — and it is why every screen in `oh`
keeps an `indexRef` next to its `index`. The same trap has a second face: `ink-testing-library`'s
fake stdout reports `columns = 100` and **no `rows` at all**, so a screen that sizes a list from the
terminal must tolerate `undefined` and fall back to a height of its own, or every test of it runs
against a zero-row window. And a terminal's height changes without Ink re-rendering anything —
`stdout.rows` is updated on the stream's `resize` event, but a component that only _read_ it keeps
the window it computed for the old size until some other state changes, which reads as a list that
stays short in a maximised window; `oh` subscribes in one hook (`useTerminalRows`), so every list
gets the redraw.

**A list that can outgrow the screen has to be windowed against the terminal's height, and the
selected row has to be marked with a glyph.** The `/mcp` tools face drew every tool of the server,
so on a server with sixty of them the reader saw the end of the list and nothing about what was
selected — a list is not a screen, and `rows - chrome` is the arithmetic that turns one into the
other. `oh` now has one place for it (`components/list-viewport.tsx`): the rows that fit after the
title, notices, pinned rows and key hints are subtracted, a floor of three rows so the `↑ N more` /
`↓ N more` markers still fit on a short terminal, the window derived from the cursor so the two
cannot get out of step when a read shortens the list underneath it, and PgUp/PgDn/Home/End for the
rows an arrow key should not have to walk. Colour is never the selection: the marker is a `❯`, which
is the one thing that survives `NO_COLOR`, and a test per screen asserts the frame carries it
([#335](https://github.com/amirtuval/openharness/issues/335)).

## Testing, CI and releasing

**A suite that passes because nothing ran is worse than one that fails.** The Postgres suites take
`DATABASE_URL`, else start a container with testcontainers, else **skip with a note** — but the e2e
suite **fails** and says what it needs, because it is the proof that the pieces work together. Each
e2e test file gets its own Postgres **database** (`openharness_e2e_<label>_<random>`, dropped `with
(force)`), not its own schema, because everything shared is per-database: the migration advisory
lock, the `LISTEN`/`NOTIFY` channels and the partition leases — which also means the CI Postgres user
has to be a superuser. Test **files** run one at a time in the server package
(`fileParallelism: false`), because three suites share one database and each empties the tables it
uses ([`e2e/AGENTS.md`](../e2e/AGENTS.md)).

**Never inherit `NODE_ENV=test` into a spawned server.** Better Auth's `isTest()` is `NODE_ENV=test`
**or** a set `TEST`, and vitest sets both — so the e2e harness spawns servers with
`NODE_ENV=production` and drops `TEST`. This bit twice: once in the unit tests
([#79](https://github.com/amirtuval/openharness/issues/79)) and once again through environment
inheritance, which is the general lesson — an escape hatch meant for a test runner leaks into
anything the test spawns.

**An assertion that cannot fail is worse than no assertion, because it is counted as coverage.** A
test review of every package found them everywhere: `expect(p.partitionOf(id)).toBe(p.partitionOf(id))`,
`expect(history.data).toHaveLength(history.data.length)`, re-parsing a schema's own output, and a
`test.fail` that masked a strict-mode violation while the real assertion had been passing for
releases. The one that mattered was the retry guard: it asserted "never retries on its own" with a
mock that threw a shape the SDK's retry classifier ignores, so it passed vacuously while the SDK
retried underneath, three calls deep, with the documented retry ladder never running at all — probing
with a real retryable `APICallError` 503 is what found it
([#105](https://github.com/amirtuval/openharness/issues/105),
[#117](https://github.com/amirtuval/openharness/issues/117)). "A flake" under load is usually a
timeout, and the number tells you which: one full-graph run produced seven timeouts across three
suites, while the same suite alone passed 318/318 in 98 seconds against 500 under load — the honest
conclusion was "raise the timeout or stop running the whole graph on four cores", not "the tests are
flaky". And a wait can pass vacuously when what it waits for is already true of an empty state — a
wait for "settled" returns immediately on a fresh, idle, _empty_ transcript — so waits have to be
anchored on a `seq`.

**A fake that reimplements a rewrite is telling you the fake is wrong, and a conformance suite run
against both stores is what makes a fake trustworthy.** The web app carried a local
`deriveSessionTitles` because the fake-brain only set titles on create; that local copy is the tell
that every title test in both apps was testing a workaround rather than the contract. The same fake
accepted bare model ids the server rejects with a 400, returned a `?user_code=` URL where the server
uses `#/device` with the code in the fragment, and ignored a wrong-kind cursor where the server
answers 400 ([#132](https://github.com/amirtuval/openharness/pull/132)). The fix that keeps it honest
is structural: roughly 2,500 lines of conformance cases run against the in-memory store and Postgres,
so a drift between them fails the shared suite, with the Postgres file adding only what a shared
store can be asked — concurrent appends, cross-store fencing, exactly-once delivery, `LISTEN`
catch-up, idempotent migrations and the backfill
([#105](https://github.com/amirtuval/openharness/issues/105)).

**Coverage names the risky file, and it is usually the one on the security path.** The lowest figure
in the repo was `provider-validation.ts` — the one cheap provider call that decides whether a key is
good _before it is sealed and stored_ — at 15.4% of lines and 0% of branches, verified by nothing
automatic because its smoke test skips in CI; "a bug here is the difference between 'the key was
validated' and 'we stored whatever was typed'". The same review found two shipped features with
**zero** e2e coverage — `GET /v1/models`, which was also missing from the 401 sweep that claims to
cover every route, and model-first sessions — because QA is not part of CI, so a stale spec had sat
broken since the new-chat screen went model-first
([#105](https://github.com/amirtuval/openharness/issues/105),
[#115](https://github.com/amirtuval/openharness/issues/115)).

**A test that needs a secret needs a flag that makes a missing secret a failure, and a test that
assumes a feature is configured proves nothing.** `OPENHARNESS_REQUIRE_PROVIDER_SMOKE=1` turns a
missing `OPENAI_API_KEY` into a failure rather than a skip, so the job cannot pass by quietly not
running; because a fork PR receives no repository secrets, the job is skipped there instead of
failing ([#120](https://github.com/amirtuval/openharness/issues/120)). On the "assumes" side, the
failover test checks that the built server's code even mentions `SCHEDULER` and that a
`SCHEDULER=postgres` instance holds a `partition_leases` row. Two smaller traps of the same family: do
not reserve a port, probe it (the harness trusts only the child's own `listening on …` line, so a
foreign server cannot pass for ours — [#123](https://github.com/amirtuval/openharness/issues/123)),
and wait on the state **transition** rather than the resource, because between `POST …/events` and
the brain writing `session.status_running` the session still reads `idle`
([`e2e/AGENTS.md`](../e2e/AGENTS.md)).

**A provider stub belongs at the network seam and should refuse what it does not know.** The e2e stub
is reached through the documented egress-proxy variables, its CONNECT tunnel's certificate SANs are
exactly the provider hostnames it may impersonate, and a request no handler claims is a **404** — so
the stub cannot bless a URL the product does not actually ask for. That property is the
counter-example to the Vertex save-time bug above, and it is also what lets a mocked happy path prove
something: a hand-built AWS event stream, length-prefixed and CRC-32 preluded and trailered exactly
as the provider's own decoder reads it, is what makes a Bedrock turn testable without Bedrock.

**A cached CI result replays an earlier outcome, which is exactly what a flake check must not do.**
The nightly and manual runs default to `force: true` and run uncached for that reason, and the
concurrency group is per event so a nightly neither cancels nor is cancelled by a push. Re-running CI
on an unchanged commit therefore proves nothing about a flake — check the log that the suites
actually ran and that `--affected` picked the right packages. `--affected` also needs a base ref,
which needs a full clone: `actions/checkout` only makes remote-tracking refs, so the job sets
`fetch-depth: 0` and `TURBO_SCM_BASE` to the PR's base, and without it turbo compares against nothing
and the affected set is quietly wrong. Turbo also hands a task only the environment variables its
config names, which is why `DATABASE_URL` is passed through in `e2e/turbo.json` while
`packages/session`'s tests do not see it and start their own container — a test reading an undeclared
variable passes locally and fails in CI.

**A chart test that boots the chart's own CI values is what keeps the chart and Terraform honest,
and an unset variable is sometimes the only correct value.** `chart-values.test.ts` boots
`charts/openharness/ci/staging-values.yaml` with a `_FILE` for each `secrets` entry and asserts the
file's variables equal the ones `infra/modules/app/locals.tf` sets for every environment — which is
how `OPENHARNESS_DEV_LOGIN=0` crash-looping staging was caught, since unset is how the dev login is
off and the server refuses any value other than `1`/`true`
([#159](https://github.com/amirtuval/openharness/issues/159)).

**Deploy on `workflow_run.head_sha`, never on `github.sha`, and never cancel a deploy.** On a
`workflow_run` event `github.sha` is the default branch's tip, so deploying it would silently ship
whatever landed on `main` between the CI run and the deploy; the job also gates on
`conclusion == success && event == push`, because `workflow_run` fires on every completion.
Concurrency is `cancel-in-progress: false` so two deploys queue rather than race — and the same choice
is made for publishing, for a related reason.

**Never set `NODE_AUTH_TOKEN` when publishing with npm trusted publishing, and bump the version before
the build.** The job takes an OIDC token and npm exchanges it for an ephemeral credential;
`setup-node` with `registry-url` writes `_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`, so a token
present there makes npm authenticate with it instead and the publish fails. No `NPM_TOKEN` exists
anywhere in this repo. A dry run performs no OIDC exchange and no upload, so it proves the build, the
pack and the version — but **not** the npm side; three traps in that configuration are that the
"Workflow filename" is the bare `publish-cli.yml` and must exist under `.github/workflows/`, that
every field is case-sensitive and npm does not validate on save, and that a new trusted publisher
allows only **staged** publishing until direct publishing is enabled. The very first release of a
package also has to be manual, because the package has to exist on npm before a trusted publisher can
name it — and the name itself may be refused: npm rejected the unscoped `openharness` as too similar
to the existing `open-harness`, which is why this one workspace publishes as `@openh/cli` while the
installed command stays `oh`
([#194](https://github.com/amirtuval/openharness/issues/194),
[`docs/RELEASING.md`](./RELEASING.md)). tsdown then inlines the package version into the bundle, so
`oh --version` can only print the new version if the bump came first, and
`npm version --workspaces-update=false` is required because `apps/tui` is a workspaces member —
without it npm reifies the whole tree and fails outright on Yarn's `workspace:*` protocol
(`EUNSUPPORTEDPROTOCOL`). If `yarn.lock` changes the workflow commits it too, or CI's
`yarn install --immutable` rejects `main`. And a push failure after a successful publish leaves the
registry ahead of the repo, which is why the workflow prints "do not re-run this workflow (it would
publish the same version a second time)" and why a run is never cancelled mid-flight.

**A control-plane tool needs its credential plugin installed explicitly, and `terraform output -raw`
lies on an empty state.** `kubectl` and `helm` need the `gke-gcloud-auth-plugin` exec credential
while `gcloud container clusters get-credentials` itself does not, so the workflow has to
`setup-gcloud` with `install_components: 'gke-gcloud-auth-plugin'` or every client dies with
`executable gke-gcloud-auth-plugin not found`. `terraform output -raw` prints a warning block on an
empty state and still exits 0, so a value read from remote state that way is the warning text; `-json`
prints `{}` and `jq -r '.image_tag.value? // empty'` turns "no such output" into empty either way.
Terraform and tflint are version-pinned for the same reason the rest of this section exists: a new
linter release failing a change nobody touched is a bad Tuesday
([#159](https://github.com/amirtuval/openharness/issues/159)).

**Squash-merging a stack one PR at a time can resurrect what the last PR deleted.** We merged the
tools stack by retargeting each PR to `main` and squashing it; once `main` held earlier squashes,
each head needed `main` merged in, and we resolved the conflicts with `-X ours`. Three-way merges
don't conflict on a file that one side added and the other never had, so files the top PR had
deleted (the operator-key search adapter) and blocks it had rewritten came back — 1,453 lines
nobody tested. Always compare `main`'s final tree with the commit that was tested
(`git diff <tested-sha> main` must be empty) and restore it if not
([#357](https://github.com/amirtuval/openharness/pull/357)). Merging a stack that was integrated
forward by merges is simpler as one integration PR, or by merging each PR into `main` without
squashing.

**A merge to `main` redeploys staging from `main`.** Staging deploys every green `main` commit, so
merging an unrelated docs PR while someone was hand-testing a feature branch on staging silently
replaced that build (the tester saw `404 no route for GET /v1/me/tools`). Redeploy the branch after
any merge to `main` during a branch test, and say so.

## Working with coding agents

**A sub-run's prompt has to be self-contained.** The issue text, the decisions already taken and any
refinement from a previous round have to travel in the prompt, because the agent cannot see the
maintainer's context and will otherwise invent it. Issue briefs here are written to that standard for
the same reason (see [`docs/workflow.md`](./workflow.md)).

**An agent that runs a dev server or Playwright in the foreground can hang for hours, and a spawn
that reports an error may still have started.** Nothing about the task says "this command never
returns", and a foreground `yarn dev` is indistinguishable from a slow build — so require `nohup` or
an explicit `timeout`, ask for per-package tests rather than a root-wide run, and push early so a
stuck agent's work is not trapped on a branch nobody can see. Treat a failed spawn as "check whether
it ran" rather than "nothing happened", or you end up with two agents editing the same files.

**Integrate parallel branches by merging, not rebasing, and merge `main` in before a staging deploy.**
A merge keeps the conflict resolutions in history, so a later merge of the same branch does not
re-litigate them — which matters when several agents work from a common base and all of them are
touching the same documentation. The staging case is sharper: the staging workflow applies Terraform
from the checked-out branch, so deploying a branch that lacks `main`'s infrastructure changes
silently **reverts** them — the tools stack needed a merge whose only non-documentation content was
`infra/modules/monitoring/main.tf` and its variables, undoing the restart-alert scoping from
[#325](https://github.com/amirtuval/openharness/issues/325). A stale branch re-applies a stale module
and nothing anywhere says so.

**A large epic lands as a stacked chain of pull requests, and a hands-on test plan catches what unit
tests cannot.** Context compaction was C1…C6 and the tools epic is X1…X14, each pull request green and
building on the one below, so a reviewer can read them in order and a half-reviewed stack is still
coherent; the price is that the stack integrates as a unit and that "the branch with everything" is
the top of it, which is why the tools entries in this file reference issues and pull requests rather
than paths. Alongside it, every epic carries a plan a person walks through: the authentication QA
pass found four issues no test had caught
([#79](https://github.com/amirtuval/openharness/issues/79),
[#80](https://github.com/amirtuval/openharness/issues/80),
[#81](https://github.com/amirtuval/openharness/issues/81),
[#76](https://github.com/amirtuval/openharness/issues/76)). Writing the plan into the pull request is
what makes a finding reproducible, and what stops a fix from being "looks right to me".
