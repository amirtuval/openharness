# @openharness/session

The durable, append-only session event log: the `SessionStore` contract the brain and the
server code against, the in-memory implementation every other package tests against, the
Postgres implementation production runs on, and the conformance suite all of them pass. It also
owns the **Better Auth tables** the server signs users in against, the `CredentialStore` that
holds users' sealed model-provider keys (epic #65, A1/A4/A5), and the SQL every one of those
tables comes from.

A session is a log of events — the user's messages, the agent's replies, the status
transitions that bracket a turn, and the spans around every model request. It is the source of
truth for a run, and it is why the brain holds no state of its own. The log is immutable
(D9, issue #46): events are appended and never modified, and its two deletions — compaction of
superseded stream chunks, and deleting a whole session (#111) — are deliberate contract
methods, each documented as the exception it is. Around the log sit the leases that decide who
may write to it, the membership rows that say which scheduler instances are alive, and the
signals that wake the owner up.

Since the authentication epic (#65) every agent and session belongs to exactly one user:
creating one takes the owner's `user.id`, the stored resource carries it as `owner_id`, and the
reads a user-facing route makes are **owner-scoped** — another user's resource answers `null`
or `SessionNotFoundError`, never 403. A user's provider credentials live in the same database,
sealed by `@openharness/vault` before this package ever sees them.

## Commands

Run from this folder (`packages/session`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`)                  |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | watch mode                                                              |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |
| `yarn migrate`      | applies `migrations/` to `DATABASE_URL` using the built `bin`           |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

`yarn test` runs the Postgres tests against a real database — `DATABASE_URL` if it is set,
otherwise one brought up by testcontainers, and skipped with a note when neither is available.
See [Running Postgres](#running-postgres) below.

## Layout

```
src/
  index.ts              the barrel: the contracts, the stores, clocks, errors
  store.ts              SessionStore, its vocabulary, and the semantics in TSDoc
  credentials.ts        CredentialStore: sealed blobs, metadata, and the semantics in TSDoc
  memory.ts             InMemorySessionStore and InMemoryCredentialStore: the fakes, and the reference behaviour
  clock.ts              Clock, systemClock, timestampAt()
  errors.ts             FencedError, SessionNotFoundError, AgentNotFoundError, DuplicateEventIdError, ClaimConflictError
  inputs.ts             the argument checks both stores share (limits, cursors, lease ttls)
  events.ts             the event rules both stores share (claims' types, supersession ranges)
  freeze.ts             deepFreeze(): how the immutability of the log is enforced at runtime
  postgres/
    index.ts            the `@openharness/session/postgres` entry point
    store.ts            PostgresSessionStore and createPostgresSessionStore
    credentials.ts      PostgresCredentialStore and createPostgresCredentialStore
    schema.ts           the Kysely table types, row → protocol mapping, channel names
    listen.ts           the dedicated LISTEN connection, and its reconnection
    migrate.ts          migrate(): the SQL-file runner
    cli.ts              the `openharness-session-migrate` bin
    postgres.test.ts    the conformance suites against Postgres, plus extra tests
    no-updates.test.ts  the source scan proving no SQL path writes back to the log
  testing/
    index.ts            the subpath entry: re-exports, plus the suites and the test clock
    conformance.ts      runSessionStoreConformance(), and the suite's two owners
    credentials-conformance.ts  runCredentialStoreConformance()
    clock.ts            createTestClock()
migrations/             the SQL the Postgres stores need, applied by `migrate()`:
                        0001–0010 the log, 0011 Better Auth, 0012 ownership, 0013 credentials,
                        0014 the auth-session revocation trigger (#76),
                        0015 the effective session model/system (#93),
                        0016 the per-user preferences (#111),
                        0017 the scheduler-instance membership (#122),
                        0018 the credential key provider (#150)
docs/postgres.md        the Postgres stores: schema, migrations, delivery, local setup
```

## Public API

### `@openharness/session`

| export                                                                                                                                              | what it is                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStore`                                                                                                                                      | the storage and signaling contract; every method is async, and documented below. Since #111 it also carries `getPreferences`/`putPreferences` (the per-user settings beside the log) and `deleteSession` (the owner-scoped hard delete); since #122 the scheduler membership (`heartbeatInstance`, `listLiveInstances`, `removeInstance`) |
| `UserPreferences`                                                                                                                                   | a user's stored preferences, `{ default_model: string \| null }` (#111, epic #116 U1) — the vocabulary of `getPreferences`/`putPreferences`                                                                                                                                                                                               |
| `AppendableEvent`                                                                                                                                   | an event a caller appends: a `StoredEvent` minus `seq` and `processed_at`, plus an optional `id` the caller supplies                                                                                                                                                                                                                      |
| `CreateSessionOptions`, `ListAgentsOptions`, `ListSessionsOptions`, `ListEventsOptions`                                                             | the options objects of the list and create methods (`CreateSessionOptions` carries the effective `model`/`system`, #93)                                                                                                                                                                                                                   |
| `OwnerScope`                                                                                                                                        | `{ ownerId }`: how a read is scoped to one owner (A4) — required, so forgetting it is a compile error; see [the contract](#the-contract)                                                                                                                                                                                                  |
| `UnscopedListEventsOptions`                                                                                                                         | the filters of `listEventsUnscoped`, the brain's replay                                                                                                                                                                                                                                                                                   |
| `CredentialStore`                                                                                                                                   | the sealed-blob credential contract; see [The CredentialStore](#the-credentialstore-epic-65-a5)                                                                                                                                                                                                                                           |
| `SealedSecret`, `CredentialKey`, `UpsertCredentialInput`, `ListCredentialsOptions`, `SealedProviderCredential`                                      | the credential contract's vocabulary: the sealed form, the key, what `upsert` writes, and what `get` returns                                                                                                                                                                                                                              |
| `UpdateSessionRequest`                                                                                                                              | what `updateSession()` changes: the title, or nothing                                                                                                                                                                                                                                                                                     |
| `AppendEventsOptions`, `PartitionFence`                                                                                                             | the optional fence a brain attaches to a write                                                                                                                                                                                                                                                                                            |
| `CompactOptions`                                                                                                                                    | what `compact()` takes: the retention cutoff (`olderThan: Date \| number`)                                                                                                                                                                                                                                                                |
| `PartitionLease`, `PartitionSignal`, `PartitionSignalInput`, `PartitionSignalKind`                                                                  | leases over a partition, and the signals sent to its owner                                                                                                                                                                                                                                                                                |
| `TurnState`, `TurnStateKind`                                                                                                                        | what `getTurnState()` answers                                                                                                                                                                                                                                                                                                             |
| `SessionEventListener`, `PartitionSignalListener`, `AuthSessionRevocationListener`, `Unsubscribe`                                                   | subscription plumbing                                                                                                                                                                                                                                                                                                                     |
| `AuthSessionId`                                                                                                                                     | a Better Auth session id (A2) — deliberately not a `SessionId`, which names a log                                                                                                                                                                                                                                                         |
| `InMemorySessionStore`, `InMemorySessionStoreOptions`                                                                                               | the in-memory implementation and its `{ now, partitionCount }` options                                                                                                                                                                                                                                                                    |
| `InMemoryCredentialStore`, `InMemoryCredentialStoreOptions`                                                                                         | the in-memory credential store and its `{ now }` option                                                                                                                                                                                                                                                                                   |
| `Clock`, `systemClock`, `timestampAt()`                                                                                                             | the injectable time source, and how an instant is written as a timestamp                                                                                                                                                                                                                                                                  |
| `FencedError`, `FencedErrorDetails`, `SessionNotFoundError`, `AgentNotFoundError`, `DuplicateEventIdError`, `ClaimConflictError`, `isFencedError()` | the typed failures a store raises, and what a fence reports                                                                                                                                                                                                                                                                               |
| `FENCED_ERROR_CODE`, `SESSION_NOT_FOUND_ERROR_CODE`, `AGENT_NOT_FOUND_ERROR_CODE`, `DUPLICATE_EVENT_ID_ERROR_CODE`, `CLAIM_CONFLICT_ERROR_CODE`     | the stable `code` of each error, for detection across bundles                                                                                                                                                                                                                                                                             |
| `PACKAGE_NAME`                                                                                                                                      | this package's name; lets a dependent prove the import resolved                                                                                                                                                                                                                                                                           |

### `@openharness/session/postgres`

| export                                                                                                                                                                                     | what it is                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PostgresSessionStore`, `createPostgresSessionStore(config, options?)`                                                                                                                     | the durable implementation; `{ connectionString }` or `{ pool }`, plus options                                                       |
| `PostgresSessionStoreOptions`, `PostgresSessionStoreConfig`                                                                                                                                | its options (`now`, `partitionCount`, `onError`) and the two ways to reach a DB                                                      |
| `PostgresCredentialStore`, `createPostgresCredentialStore(config, options?)`                                                                                                               | the durable credential store; `{ connectionString }` or `{ pool }`, plus `now`                                                       |
| `PostgresCredentialStoreOptions`, `PostgresCredentialStoreConfig`                                                                                                                          | its options, and the two ways to reach a DB                                                                                          |
| `migrate(db, options?)`                                                                                                                                                                    | applies `migrations/` — the log, Better Auth and `provider_credentials` — idempotently, in one locked transaction; returns the files |
| `MigrateOptions`                                                                                                                                                                           | `{ migrationsDir? }`, for a migrations directory that is not this package's                                                          |
| `PostgresSchema`, `AgentsTable`, `SessionsTable`, `EventsTable`, `EventClaimsTable`, `EventSupersessionsTable`, `PartitionLeasesTable`, `ProviderCredentialsTable`, `UserPreferencesTable` | the Kysely table types, for a caller that wants to query alongside the stores                                                        |
| `ProviderCredentialRow`, `ProviderCredentialMetadataRow`                                                                                                                                   | the two shapes a `provider_credentials` read has: with the sealed blob, and without                                                  |

This entry point is a separate subpath on purpose: it is the only module that depends on `pg`
and `kysely`, and a consumer that only needs the contract, the fake or the suite must not load
them. `store.close()` releases the listening connection and ends the pool **only if the store
opened it**. See [`docs/postgres.md`](./docs/postgres.md).

### `@openharness/session/testing`

| export                                                     | what it is                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `runSessionStoreConformance(makeStore, options?)`          | the suite every `SessionStore` implementation must pass       |
| `runCredentialStoreConformance(makeStore, options?)`       | the suite every `CredentialStore` implementation must pass    |
| `MakeSessionStore`, `SessionStoreConformanceOptions`       | the session factory, and how to name the suite                |
| `MakeCredentialStore`, `CredentialStoreConformanceOptions` | the credential factory, and how to name the suite             |
| `OWNER_A`, `OWNER_B`                                       | the two users everything in the session suite belongs to (A4) |
| `createTestClock(startMs?)`, `TestClock`                   | a clock a test advances by hand                               |
| everything from `@openharness/session`                     | re-exported, so a test imports a store and its suite together |

This entry point is for test code only: the suites call `describe`/`it` from `vitest`, which
is therefore a devDependency of any package that uses it, and never a runtime dependency of
this one. Both suites take an optional `ensureUsers(userIds)`, which a store whose schema
references Better Auth's `"user"` row (Postgres) uses to seed the owners the suite creates
things as.

## The contract

`SessionStore` in `src/store.ts` is the complete, documented contract; this section is the
summary a caller — or a new implementation — needs before writing a line against it.

**Everything is asynchronous**, and nothing may assume synchronous delivery. A store built on
`LISTEN`/`NOTIFY` notifies after it commits, and a subscription or a signal arrives a tick
later than the append that caused it. Read state; do not assume a listener has run.

**Ownership** (epic #65, A4). Every agent and session belongs to exactly one user:
`createAgent(input, ownerId)` and `createSession(agentId, { ownerId, … })` take the owner's
Better Auth `user.id`, the stored resource carries it as `owner_id`, and it never changes.
The reads a user-facing route makes take an **`OwnerScope` `{ ownerId }` that is required** —
forgetting the owner is a compile error, not a silent unscoped read (#61's security fix) — and
a resource belonging to somebody else is answered as if it did not exist, because a 404 must
not leak that it does:

| method                                  | scoped form                                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAgent(agentId, { ownerId })`        | `null` for another owner's agent                                                                                                                                                                                                  |
| `listAgents({ ownerId, … })`            | `data: []` for another owner; `[]`, never somebody else's                                                                                                                                                                         |
| `getSession(sessionId, { ownerId })`    | `null` for another owner's session                                                                                                                                                                                                |
| `listSessions({ ownerId, … })`          | only the owner's sessions; the `agentId` filter narrows inside them                                                                                                                                                               |
| `listEvents(sessionId, { ownerId, … })` | `SessionNotFoundError` for another owner's session — the user-facing events route's 404                                                                                                                                           |
| `createSession(agentId, options)`       | `ownerId` is **required**, and the agent — when one is passed — must belong to that owner or it is an `AgentNotFoundError`; a session may not snapshot somebody else's agent. `agentId: null` creates a model-first session (#93) |
| `deleteSession(sessionId, { ownerId })` | `false` for another owner's session — the same answer as for an id nothing has, so the refusal leaks nothing (#111)                                                                                                               |

Everything else is **unscoped**, and deliberately so:

- `createAgent` takes its owner as an argument rather than an option: a resource cannot be
  created without one.
- the brain's and scheduler's paths — `appendEvents`, `getSessionUnscoped`,
  `listEventsUnscoped`, `getPendingUserEvents`, `getTurnState`, `compact`, `subscribe`,
  `signalPartition`, `onPartitionSignal`, `findSessionsNeedingWork`, the leases — act _for a
  session_, never for a user, and must not be narrowed by one. The two reads that need an
  arbitrary owner's session are **separate, explicitly named methods** (`getSessionUnscoped`,
  `listEventsUnscoped`) rather than an optional argument, so a route cannot reach them by
  forgetting a field; they still refuse an id nothing has.
- `updateAgent` and `updateSession` are not reads and take no scope: a user-facing route calls
  the scoped read first and answers 404 for a `null`. Nothing can go stale between the two
  calls, because no method writes `owner_id` after creation.

**Ordering.** `seq` is the ordering key, not time: it starts at `1` and increases by one per
event, per session, in append order. Timestamps are metadata. Reads return events in `seq`
order (`asc` by default); a subscription delivers stored events in `seq` order, with no gaps
and no duplicates.

**Assigned fields.** `appendEvents` assigns `seq` and an internal creation time in one
transaction, and `id` too unless the event brought one. The events it returns, and every event
a read returns, are exactly `StoredEvent`s — no extra field, and specifically no `created_at`:
the protocol has none. `seq` is the resume position, `id` is the identity, and a replayed log
is a faithful record.

**Caller-supplied ids.** An `AppendableEvent` may carry an `id`, and the store then writes the
event under exactly that id. This is what keeps a reply's stored chunks and its `agent.message`
on one `sevt_` id: the brain mints it, appends the `event_start`/`event_delta` chunks under it,
and appends the finished message with the same id, so a client matches what it accumulated to
what was stored. Two rules come with it, and an append that breaks either is refused **whole**
— nothing in that batch is stored:

- the id must be a valid `sevt_` id, or the append throws `RangeError`;
- the id must be free, both in the log (an id identifies one event for the whole store, not one
  per session) and within the batch itself, or the append throws `DuplicateEventIdError`.

`seq` stays the store's either way: a supplied id changes which event an append writes, not
where in the log it lands.

**The log is immutable** (D9, issue #46). No stored event is ever modified: the contract has
no method that edits one, the protocol's event types are deep-readonly (so a write is a
compile error), and both stores deep-freeze the events they keep and hand out, so a mutation
throws instead of forking a reader's copy from the log the store wrote. The two deletions are
compaction and `deleteSession`, below — each a deliberate, documented exception and nothing
else. A brain reads what it needs and appends what it learns; nothing rewrites history.

**`processed_at` is derived from a claim.** A user event is stored with `processed_at: null` —
the stored event never changes — and the claim taken on it is a fact recorded beside it: the
`consumes` list of the event that answers it. Three event types carry the list (P4): a
`span.model_request_start` claims the `user.message`s its request folds in, a
`span.model_request_end` claims the `user.interrupt`s that cut its request short, and a
`session.status_idle` claims the `user.interrupt`s a turn that had nothing running ended on.
Every read — the events list, the pending list, a subscription payload — returns a user
event's `processed_at` as the claim's `claimed_at`, or `null` while no claim has it.
"Pending" means exactly "no claim"; `getPendingUserEvents` lists those in `seq` order.
Claiming twice is a no-op and two callers racing for the same event cannot both win — claims
are insert-only and the event id's primary key decides. A `consumes` claim that cannot be
made refuses the whole append with `ClaimConflictError`, because an event may not say it
answers something that is not waiting: a foreign id, a non-user event, an already-claimed
event, or an id the batch names twice. Every event that is not a user event is stored with
`processed_at` already set, and keeps it; the `events.processed_at` column is **never written
for a user event** (P4) — the append leaves it out — and a user event's value comes from the
claim alone. The column stays for the other event types, and for rows written before that.

**Stored chunks.** Since D9 a streamed reply is stored as it streams: `event_start` and
`event_delta` are ordinary events — `seq`, `processed_at`, delivery and all — appended like
anything else, and the stored form is the only one. The chunks of a reply in flight
are resumable by `seq` like every other event.

**Supersession.** The event that finishes a reply — the stored `agent.message`, or the
`span.model_request_end` when the request ended without one — carries `supersedes:
{ from_seq, to_seq }` over the chunks it replaces. `appendEvents` records the range,
insert-only, after checking it lies within the session and ends before the superseding event's
own `seq`; a range that does not fit is a `RangeError` and the whole append is refused. Replay
then skips it: `listEvents` leaves out stored chunks whose `seq` a recorded range covers,
while the chunks of a message still in flight — nothing supersedes them — come back like any
other event. `includeSuperseded: true` reads the raw log instead, for debugging and tests.
Cursors stay `seq` positions, and skipped chunks leave gaps in them; nothing else changes.

**Compaction** — `compact({ olderThan })` — is one of the only two code paths that delete from
a log: it removes stored chunks a recorded supersession covers, once the store wrote them
strictly before the cutoff, and nothing else, ever. It returns how many events it deleted, is
idempotent, and is safe to run from several instances at once. It changes no reader's answer —
replay already skips those chunks — so a client never needs to know whether, or how recently,
it ran; the retention window only keeps raw chunks around for debugging. `seq` values are
never reused (a superseded chunk is always followed by the event that superseded it, which is
not a chunk and is never deleted), so gaps in the sequence are the normal state of a compacted
log.

**Deletion** — `deleteSession(sessionId, { ownerId })` — is the other, and the only one that
removes a session itself (epic #116 U5, issue #111). It is **owner-scoped**: it answers `true`
when the session existed and belonged to `options.ownerId`, and `false` for an id nothing has
and for somebody else's session alike, exactly as `getSession` answers `null` for both. It is
irreversible — one transaction removes the session row and every row keyed by the session in
every table that has a session column: its `events`, their `event_claims` and their
`event_supersessions` — so afterwards `getSession` and `getSessionUnscoped` answer `null`,
`listEvents`, `appendEvents`, `getPendingUserEvents` and `getTurnState` throw
`SessionNotFoundError`, and an event id the deleted session held is free again for a later
append. A deleted session's subscribers receive one final `session.deleted` `StreamEvent`
naming it — the one stream event that was never stored, and therefore outside the `seq` order
— and the subscription ends with it.

**Status.** `session.status_running` sets the session's `status` to `running` and
`session.status_idle` sets it to `idle` — in the same transaction as the append. A
`session.status_rescheduled` does not end a turn and leaves the status alone; v1 has no
resting `rescheduling` status. Every append also advances the session's `updated_at`.

**The model projection** (#111). A `user.message` carrying a `model: { id }` sets the
session's `model` to it, in the same transaction as the append — the other projection of the
log onto the session's header, beside `status`, so the session keeps running what its last
model-carrying message asked for. Within a batch the later message wins; a message without a
`model` leaves the session's model alone; and `initial_events` go through the same append
path, so a model-carrying message among them is already what the created session runs. The
log stays the source of truth: the message's `model` is stored on the event either way, and a
`span.model_request_start` records the model each request actually used.

**Creation, and what a session runs** (issue #93). A session is created from an agent, a
model, or both, and always stores the configuration it _runs_ — `model` and `system` — beside
the agent preset it snapshotted, if there was one:

| caller                            | stored `agent`                            | stored `model` / `system`                                            |
| --------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| `createSession(agentId, options)` | the agent's `{ id, name, model, system }` | the agent's, or `options.model`/`options.system` when given          |
| `createSession(null, options)`    | `null`                                    | `options.model` (required), and `options.system` — `null` if omitted |

The resolution is one rule in one place — `effectiveSessionConfig`, shared by both stores — so
the two implementations cannot disagree: an explicit `model` or `system` wins over what the
agent contributes, and what is omitted falls back to the agent's. An override is per field:
passing `model` alone keeps the agent's `system`. Without an agent there is nothing to fall
back to, so a missing `model` is a `RangeError` — the protocol's request refinement is what
keeps a caller from getting there, and the store refuses to invent a configuration. The
`agentId` lookup stays owner-scoped exactly as it was (A4); `null` skips it, because there is
no agent to own.

**The title.** A session's `title` is the one field that changes after creation:
`updateSession(sessionId, { title })` sets it, `{ title: null }` clears it, and an omitted
title keeps what is stored. `updated_at` moves; nothing else does — not the status, not the
agent snapshot, not the log — and `getSession`, `updateSession` answer `null` for an id nobody
has. It is the piece a frontend that only learns what a chat is about after the first message
needs (the server derives a title from that message and calls this — see `apps/server`). The
title is stored as given — the protocol's `SESSION_TITLE_MAX_LENGTH` is the caller's business,
like every other bound this package does not enforce.

**Turn state** (`getTurnState`) is derived from the log alone — no lease, no clock, no
in-memory bookkeeping — so it means the same thing in every store, and a server that has just
taken a partition over can ask before it has done anything:

| state        | when                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| `idle`       | no turn is open: the last status event is `session.status_idle`, or there is none |
| `running`    | a turn is open and a model request is in flight (`openSpan` is reported)          |
| `unfinished` | a turn is open with nothing in flight: the brain that opened it is gone           |

A turn is open when nothing closed it: the last status event is `session.status_running` or
`session.status_rescheduled`, and no `session.status_idle` follows. So a brain that inherits a
session acts on anything other than `idle`: it closes `openSpan` if there is one
(`span.model_request_end` with `error: { type: "brain_lost" }`, pointing at it) and runs the
turn again. `findSessionsNeedingWork` treats both open states as work.

**Pagination** is the protocol's, passed through untouched. `page` and `next_page` are the
opaque cursor strings the API uses: `seq` cursors for the event log
(`encodeSeqCursor`/`decodePageCursor`), keyset cursors for the resource lists
(`encodeKeyCursor({ created_at, id })`). The next page is the items strictly after the cursor's
position in the list's own order: sessions newest first (`(created_at, id)` descending),
agents oldest first (ascending), ties on `created_at` broken by `id`. `next_page` is `null`
only when nothing follows the page. A cursor of the wrong kind, or one this package did not
encode, is a `RangeError`. `limit` is clamped into `[1, MAX_PAGE_LIMIT]`;
`DEFAULT_PAGE_LIMIT` applies when it is omitted. On the events list, `after_seq` and `page`
both narrow the result and `types` filters it — `types: []` returns none.

**Leases and fencing.** A session belongs to exactly one of the protocol's
`partitionOf(sessionId, 64)` partitions, and a server holds that partition's lease while it
runs the session's turn. `acquirePartition` succeeds when the partition is free, when the
previous lease has expired (`now >= expires_at`, inclusive), or when the same owner asks
again — and every successful acquire opens a **new tenure**, so the epoch advances even for
the same owner and an older one is fenced. `renewPartition` extends a lease the owner still
holds at that epoch — **a lapse is stealable, not lost**: the row still naming this owner at
this epoch is the whole test, `expires_at` included, because expiry is what lets _another_
owner acquire the partition (a new tenure, so a new owner _and_ a new epoch), and nothing can
be written under a lapsed lease. An owner whose own heartbeat cycle ran long — a stalled
process, a slow round trip — therefore keeps its partitions by renewing them instead of
dropping them and re-acquiring them at a new epoch. `releasePartition` frees it and advances
the epoch, so a write still in flight from the released tenure is fenced rather than landing in
the next one. `currentEpoch` is `0` until the first acquire, and never repeats a tenure.

A write carrying `fence: { partition, epoch }` is accepted only while that partition's lease is
live and at that epoch; otherwise it fails with `FencedError`. That is what stops a zombie
brain — one whose lease expired, was released, or was taken over — from appending to a session
somebody else now owns. Fencing is **opt-in**: a write without a fence is never refused, which
is how the API appends a user event before it knows who owns the partition. The brain always
fences.

**Scheduler membership** (issue #122) is the second piece of bookkeeping beside the leases:
`heartbeatInstance(instanceId)` upserts the instance's row (`last_seen` from the injected
clock), `listLiveInstances(withinMs)` answers the ids seen within the window in instance-id
order — live while `last_seen > now - withinMs`, the same inclusive expiry a lease has at
`expires_at`, so a caller passing its lease TTL counts exactly the instances whose leases are
being renewed — and `removeInstance(instanceId)` deletes a row (a no-op when there is none).
The partition scheduler computes each instance's fair share from that list; the contract
promises nothing more than the rows, and a membership that is lost costs one heartbeat's
announcement.

**Signals are hints.** `signalPartition` delivers a signal to the listeners attached to that
partition at that moment, once each; a signal nobody is listening for is dropped, because
signals are a latency optimization and not a durable queue. No flow may depend on one
arriving: a partition's new owner recovers by asking `findSessionsNeedingWork`, which reports
the sessions with pending user events or an open turn, oldest first.

**Auth-session revocations are hints too** (epic #65, A2; issue #76).
`notifyAuthSessionRevoked(authSessionId)` announces that a Better Auth session's row is gone —
next to `signalPartition`, it reaches the listeners attached at that moment, once each, and a
notification nobody is listening for is dropped. It carries the session's **id** and never its
token. `onAuthSessionRevoked(listener)` is the subscription; on Postgres every instance
listening hears a revocation whichever instance published it, which is what lets a server
close the open streams of a session revoked elsewhere. Like a signal, a missed notification is
recoverable rather than fatal: the server re-validates the session periodically.

**Preferences.** `getPreferences(userId)` and `putPreferences(userId, preferences)` are the
per-user settings beside the log (#111, epic #116 U1), keyed by `userId` like the
`CredentialStore` is. `UserPreferences` is one value, `{ default_model: string | null }` — the
`provider/model` a new chat starts with, or `null` for no choice — and a user who has never
saved one reads `{ default_model: null }`: there is no null answer and no throw, so a settings
screen always has a value. `putPreferences` writes the value whole (one row per user, replaced
in place; `{ default_model: null }` clears it), stamps `updated_at` from the injected clock,
and answers what was stored. Both answers are deep-frozen, like a credential's.

**Errors.** `SessionNotFoundError` (every session-scoped method except `getSession`,
`getSessionUnscoped` and `updateSession`, which answer `null`),
`AgentNotFoundError` (`createSession` with an unknown agent), `FencedError` (`appendEvents`),
`DuplicateEventIdError` (`appendEvents` carrying an id the log already
holds, or the same id twice) and `ClaimConflictError` (`appendEvents` whose `consumes` names
an event that is not a pending user event of the session). A `supersedes` range that does not
fit before its own event is a `RangeError`, like the other argument checks — `page` cursors,
supplied event ids, lease ttls, and `compact()`'s cutoff. `getSession`, `getSessionUnscoped`,
`updateSession`, `getAgent` and `updateAgent` answer `null` instead.
Each error is a real class with a stable `name` and `code`, so `instanceof` works from the
built output and `isFencedError()` recognises one that crossed a bundle boundary.

**Time is injected.** A store takes a `Clock` (`new InMemorySessionStore({ now })`) and derives
every timestamp, `processed_at` and lease expiry from it via `timestampAt()`. Nothing reads the
wall clock: that is what lets the conformance suite test expiry by moving time instead of
sleeping, and what a Postgres store has to do too — it must use the injected clock rather than
the database's `now()` for anything the suite moves time through.

**The store does not validate.** Inputs are stored as given; the protocol schemas are what
validate the wire, and callers (the API, the brain) run them. `InMemorySessionStore` is the
one exception, and only to be _stricter_: it rebuilds each appended event through
`StoredEventSchema`, so the fake cannot hand back anything but the exact wire shape.

## The CredentialStore (epic #65, A5)

`CredentialStore` in `src/credentials.ts` is the second contract: where a user's
model-provider keys live. It stores **only sealed blobs**. The server seals a plaintext with
`@openharness/vault` and hands the store a `SealedSecret` — `{ ciphertext, nonce, wrappedKey,
kekVersion, keyProvider? }`, all strings — which the store writes down as given; it never sees
a plaintext, never opens a blob, and this package deliberately does **not** depend on
`@openharness/vault` (the sealed shape is restated here so the two are structurally
interchangeable without one importing the other). `keyProvider` names the key provider that
wrapped the data key (`local` or `gcp-kms`, #150) and is **optional**: a blob stored before
the field existed simply does not have it, and the vault is what reads an absent provider as
`local`. The store writes and reads it faithfully either way — it knows no provider names.

| method                         | what it does                                                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsert(input)`                | writes `{ userId, provider, type, sealed, last4, validatedAt }` and answers the metadata; replaces in place for the same `(user, provider)` |
| `get({ userId, provider })`    | the record **including the sealed form**, or `null` — the one read the server's model path uses, and the only one that hands a blob back    |
| `list({ userId })`             | metadata only, ordered by `provider`; the sealed columns are not even selected                                                              |
| `delete({ userId, provider })` | `true` when one was deleted, `false` when there was none                                                                                    |

The answers are the protocol's `ProviderCredential` metadata (`pcred_` id, `type`, `provider`,
`last4`, `created_at`, `updated_at`, `validated_at`); `get` adds `sealed`, as a
`SealedProviderCredential`. Every method is keyed by `userId` — there is no unscoped read of a
credential — and implementations deep-freeze what they return, because a sealed blob is a
value. One credential per `(user, provider)`, and two users may each hold the same provider:
the upsert replaces (keeping the stored `id` and `created_at`) rather than accumulating rows.

Both implementations pass `runCredentialStoreConformance`: `InMemoryCredentialStore` (in
`memory.ts`, for tests) and `PostgresCredentialStore`
(`@openharness/session/postgres`, on the `provider_credentials` table). This package never
sees the plaintext, so the credential's _validation_ — the one cheap provider call on save —
and its decryption are the server's (`apps/server`, #61).

## The Postgres store

`@openharness/session/postgres` implements the same contract against Postgres, with Kysely and
`pg`, and passes `runSessionStoreConformance` unchanged — `src/postgres/postgres.test.ts` runs
the whole suite against a real database. [docs/postgres.md](./docs/postgres.md) is the long
version; this is the shape of it.

**Schema.** Fourteen tables, all created by `migrations/`. Nine are this package's: `agents`
and
`sessions` (each with the `owner_id` an agent or session belongs to, `sessions` also with the
`partitionOf` partition, the `status` the log's last status event implies, the effective
`model jsonb`/`system` the session runs, and the nullable agent snapshot columns beside them —
`agent_id`, `agent_name`, `agent_model_id`, `agent_system`, all NULL together for a model-first
session; #93), `events` (`id`,
`session_id`, `seq`, `type`, `payload jsonb`, `created_at`, `processed_at`, `unique
(session_id, seq)`, an index on `(session_id, seq)` and a partial index for queued user
events), `event_claims` (one row per claim of a user event: `event_id` primary key,
`claimed_by_event_id` — the event whose `consumes` claimed it, `null` only on pre-P4 rows —
and `claimed_at`; the primary key is what makes double-claiming fail atomically),
`event_supersessions` (one row per
recorded `{ from_seq, to_seq }` range: `by_event_id` primary key, `by_seq`, and a `check
(by_seq > to_seq)`), `partition_leases` (`partition`, `owner`, `epoch`, `expires_at`),
`scheduler_instances` (one row per live scheduler instance: `instance_id` primary key and the
`last_seen` of its last heartbeat; see `0017`), `provider_credentials` (a sealed credential per
`(user_id, provider)`, with the key provider that wrapped its data key — NULL meaning `local`;
see `0013` and `0018`) and
`user_preferences` (one row per user: the stored `default_model`, or NULL; `on delete cascade`
from `"user"`; see `0016`). Five are
**Better Auth's**, created by the same migrations and read and written by Better Auth itself
(decision A1): `user`, `session`, `account`, `verification` and `deviceCode`.

Ids of this package's tables are `text collate "C"`, so SQL ordering is the byte order the
protocol's keyset cursors use; every timestamp is `timestamptz` written from the injected
clock, never from `now()`. Better Auth's tables are the exception to both rules: their columns
are camelCase and their timestamps are `timestamptz default CURRENT_TIMESTAMP`, because Better
Auth writes them and the schema has to be exactly what it expects. `owner_id` is Better Auth's
opaque text, so it carries no special collation either — nothing orders by it.

`events.processed_at` is written for everything **except** a user event (P4): a user event is
queued, its `processed_at` is derived from the claim on read, and the append leaves the column
out for one — `undefined` in the insert type, `NULL` in the row. The column stays for the
other event types, and for rows written before that.

`event_claims` and `event_supersessions` deliberately carry **no foreign keys**. They are facts
about events, not a second copy of the log, and the log's tables are emptied wholesale — every
harness that truncates `events` for the next test does it in one statement, and Postgres
refuses to truncate a table a foreign key points at, so a reference here would break tooling
outside this package (it did, until the reference came out). The store is the only writer and
every read joins back to `events`; a row whose event a truncation removed is an orphan that
matches nothing. What the contract needs is uniqueness, and the primary keys provide that on
their own.

**The events table is written once per event and never touched again.** There is no SQL path
that writes back to a row of `events`: claims and supersessions are rows of their own, a user
event's `processed_at` is derived by joining `event_claims`, and the only two deletes are
`compact()` — superseded chunks, and nothing else — and `deleteSession`, which removes a whole
session's rows, its log included, at the owner's request (`0016`/#111). Both are the
contract's documented exceptions and nothing else ever goes.
`src/postgres/no-updates.test.ts` scans this package's source (tests excluded) for the
spellings such a write would use — raw `update` on `events` however it is quoted or qualified,
and `updateTable(...)` naming it, `as const` included — and fails on any of them, so the rule
cannot come back in a later change unnoticed. The patterns are themselves pinned against
spellings that must be caught and near-misses that must not, and the same file asserts the
compaction delete's `WHERE` clause by clause.

**Migrations.** Plain SQL files in `migrations/`, applied in name order by `migrate(db)` — one
transaction under an advisory lock, every statement idempotent (`if not exists`, or a guard),
so it is safe to run from two instances at once. There is no ledger: a file that has been
applied anywhere must never be edited. `yarn migrate` runs the built bin. D9 added
`0007_event_claims`, `0008_event_claims_backfill` (one-time: the pre-D9 `events.processed_at`
of user events is copied into claim rows, so a log written before the change reads exactly as
it did) and `0009_event_supersessions`.

Wave 2 of the authentication epic (#65, issue #58) added `0011_better_auth`, `0012_ownership`
and `0013_provider_credentials`:

- **`0011_better_auth.sql` — Better Auth's tables** (decision A1): `user`, `session`,
  `account`, `verification` and the device-authorization plugin's `deviceCode`, for a config
  with the core library, the `google`, `github` and `microsoft` social providers and the
  `device-authorization` and `bearer` plugins. The SQL is **generated, not hand-written**: it
  came out of **Better Auth 1.7.6**'s CLI (`npx @better-auth/cli generate`, with the
  Postgres/Kysely adapter) in a scratch directory, and is committed verbatim but for
  whitespace and the `if not exists` the migrator needs. The server sub-issue (#61) mounts
  Better Auth against these tables with its own migrator disabled, so if the Better Auth
  version moves, regenerate and diff: **they have to match exactly.** The file's header
  records the same provenance — and records that the 1.7.6 regeneration was diffed against
  the file and matched (only whitespace, statement order and the `if not exists` differ).
- **`0012_ownership.sql` — delete the v1 data, then ownership** (decision A4): v1 is
  unreleased, so there is no backfill — all rows of `events`, `event_claims`,
  `event_supersessions`, `sessions` and `agents` are deleted, and `agents` and `sessions` gain
  `owner_id text not null references "user"(id) on delete cascade` plus an
  `(owner_id, created_at, id)` index for each list. The delete is guarded by the absence of
  the column it introduces, because the runner re-runs every file on every `migrate()` call:
  without the guard a later server boot would wipe every log in the database.
- **`0013_provider_credentials.sql` — the sealed credential table** (decision A5): id
  (`pcred_`), user, provider, type, the four sealed fields, `last4`, the timestamps and
  `validated_at`, unique on `(user_id, provider)` and `on delete cascade` from `"user"`. There
  is no plaintext column, and none may ever be added.
- **`0014_auth_session_revocation.sql` — the revocation trigger** (A2; issue #76): an
  `after delete … for each row` trigger on `"session"` that `pg_notify`s the deleted session's
  **id** (never its token) on the `ohr_auth_session_revoked` channel
  (`AUTH_SESSION_REVOCATION_CHANNEL`). Better Auth's own deletions are also announced by the
  server's `session.delete.after` hook; the trigger is what catches an operator's plain SQL
  and the cascade from a `"user"` delete. TRUNCATE does not fire row triggers, so a harness
  emptying `session` announces nothing.

Wave 1 of the catalog epic (#92, issue #93) added one more:

- **`0015_session_model.sql` — the effective model and system, agent optional** (issue #93):
  `sessions` gains `model jsonb not null` and `system text`, backfilled from the stored agent
  snapshot (`model = { id: agent_model_id }`, `system = agent_system`) because sessions created
  since the auth epic already exist in real databases; the four agent snapshot columns become
  nullable together, so a model-first session stores none of them. The `update … where model is
null` backfill is a no-op on a re-run — a session created after the change always writes its
  own `model` — which is what keeps the file idempotent like the rest. `postgres.test.ts`
  proves it over a row written the pre-#93 way.

Wave 1 of the chat-UX epic (#111) added one more:

- **`0016_user_preferences.sql` — the per-user preferences** (#111, epic #116 U1): the
  `user_preferences` table, one row per user — `user_id` primary key, `on delete cascade` from
  `"user"` — holding `default_model text` (NULL for no default) and `updated_at`. One
  `create table if not exists`, and nothing to backfill: a user with no row reads the
  protocol's default, `{ default_model: null }`. `putPreferences` upserts the row
  (`on conflict (user_id) do update`), so the table is a value rather than a log.

The partition scheduler's membership (issue #122) added another:

- **`0017_scheduler_instances.sql` — the scheduler membership** (#122): the
  `scheduler_instances` table, one row per live scheduler instance — `instance_id text collate
"C"` primary key and the `last_seen timestamptz` of its last heartbeat, from the injected
  clock. One `create table if not exists`; the rows are bookkeeping beside the log, written by
  `heartbeatInstance`, read by `listLiveInstances(withinMs)` (a membership is live while
  `last_seen > now - withinMs`) and deleted by `removeInstance` on a graceful `stop()`. There
  is nothing to backfill — an absent row means nobody has announced that id — and a lost row
  costs one heartbeat's announcement rather than anything durable.

The vault's key provider (issue #150, deployment epic #148 decision D6) added the latest one:

- **`0018_credential_key_provider.sql` — which provider wrapped a credential** (#150): one
  `add column if not exists key_provider text` on `provider_credentials`, holding `local` or
  `gcp-kms` — a provider name, never key material. **NULL is legitimate and means `local`**:
  every row written before the column holds it, when `local` was the only provider, and the
  vault reads an absent provider as `local` — so there is nothing to backfill and a re-run of
  the migrator leaves every row (and every sealed blob) exactly as it was. The column is what
  lets `@openharness/vault` refuse a secret under a provider that did not wrap it with a clear
  error — a deployment that switches `OPENHARNESS_KEY_PROVIDER` cannot read its old rows,
  which is exactly what should be said loudly. `runCredentialStoreConformance` pins the round
  trip of the field and that an absent one stays absent, in both stores.

**Appending.** `seq` is assigned inside the append transaction, under `select … for update` on
the session row, so concurrent appends — from any number of connections, stores or processes —
serialize and the numbers are gap-free and ordered. `initial_events` go through the same path
in the creation transaction. An event's id is the caller's when it supplied one: `events.id` is
unique across the whole table, so a taken id fails the insert and rolls the append back — the
store answers `DuplicateEventIdError`, and the id is the one the log already holds.

The append also follows the batch's projections onto the session row, in the same transaction:
the `status` a status event implies, and the `model` a `user.message` carrying one switches to
(#111) — one more `update sessions …` beside the `updated_at` bump.

The same transaction records what the batch carries beside its events: an insert into
`event_claims` for every `consumes` id (the joined select is what refuses a foreign, non-user
or already-claimed id, and `on conflict … do nothing` decides a race with a concurrent claim),
and an insert into `event_supersessions` for every `supersedes` range. Both are insert-only,
and a batch whose claims cannot all be made rolls back whole — a claim that says more than the
log holds is never half-recorded.

**Fencing and leases.** A fenced write checks `partition_leases` in its own transaction and
throws `FencedError` on a mismatch. `acquirePartition` is a single conditional upsert that
matches an unleased, self-owned or expired row, so testing and taking are atomic, and every
successful take advances the epoch — the same owner included.

**Titles.** `updateSession` reads, patches and writes the session row in one transaction, like
`updateAgent`.

**Deleting a session.** `deleteSession` locks the session row — the same lock an append takes,
so a write in flight is serialized against the delete — checks the owner, and one transaction
later removes the rows of `events`, `event_claims` and `event_supersessions` for the session
and then the session row itself. The last statement is a `pg_notify` on the session's channel,
delivered on commit: the payload is the session's id, the subscriber delivers a final
`session.deleted` and ends the subscription (forgetting its position and `UNLISTEN`ing when
that was the last listener), so nothing is ever fetched for the deleted log.

**Live delivery.** One dedicated `LISTEN` connection per store, `LISTEN`/`UNLISTEN` per session
as its first and last listener come and go, and per partition for signals. A notification
carries the `seq` of the event that was appended (never the event itself — payloads are capped
at 8 KB) and the subscriber fetches the range after the last `seq` it delivered, so coalesced
or repeated notifications cannot duplicate or drop anything.
The connection reconnects with backoff and then catches up from the last delivered `seq`.
Signal channels are per partition, so every instance listening for that partition hears a
signal, not just the sender. Auth-session revocations travel on the one
`ohr_auth_session_revoked` channel with the session id as the payload — a revocation lost
while the connection was down is not replayed, which is why the server's re-check exists
(issue #76). A session's deletion rides the session's own channel with `{"sessionId": "sesn_…"}`
instead of a `seq`, so a subscriber tells the two apart and ends rather than fetching.

**Time.** The store takes the same `Clock` and derives every `created_at`, `updated_at`,
`processed_at`, lease `expires_at` and lease-expiry comparison from it. Nothing reads the
database's `now()`.

## Running Postgres

- **In CI** there is a `postgres` service in the workflow, and `DATABASE_URL` is set for the
  test steps, so the Postgres tests always run there.
- **Locally** set `DATABASE_URL`, or have a Docker daemon running and let the tests start
  `postgres:18-alpine` with testcontainers. With neither, the suite is skipped with a note —
  a skip is not a pass.
- The tests truncate every table this package owns — `provider_credentials`,
  `user_preferences` and `scheduler_instances` included — before every test, so point
  `DATABASE_URL` at a scratch
  database. Better Auth's tables are not truncated; the two `"user"` rows the suites seed are
  re-inserted as needed.

## Running the conformance suite against a new implementation

Every implementation must pass the same suite. Write a test file with a factory that builds a
fresh store on the clock it is handed, and let the suite do the rest — `src/postgres/postgres.test.ts`
is a worked example:

```ts
import { runSessionStoreConformance } from '@openharness/session/testing'
import { PostgresSessionStore } from '../src/postgres'

runSessionStoreConformance(async (clock) => new PostgresSessionStore({ pool, now: clock.now }), {
  name: 'PostgresSessionStore',
})
```

- **The factory is called once per test**, with a fresh `TestClock` starting at a fixed
  instant, and may be asynchronous. It must not hand out state it shares with an earlier
  store — a new schema, a new transaction, a truncated table.
- **The store must take its time from that clock.** Timestamps, `processed_at` and lease
  expiry all have to move when the clock moves; a store that reads the database's `now()`
  will fail the lease and `processed_at` tests. Store absolute instants, computed in the
  store from the injected clock, and compare against them in SQL.
- **Delivery may be asynchronous, and the suite allows for it.** It polls (bounded by real
  time) for subscription, signal and revocation deliveries, and waits a moment before
  asserting that nothing arrived. Nothing requires synchronous notification.
- **Partitions must match**: the suite uses the protocol's `partitionOf(sessionId)` with the
  default partition count, so a store's partition space has to be the server's.
- **A supplied id has to be the stored event's id, and it has to be refused when it cannot
  be one**: `RangeError` for something that is not a valid event id, and `DuplicateEventIdError`
  for an id the store already holds — anywhere in it, not just in that session — or one that
  appears twice in the same batch. Either way the batch stores nothing.
- **Owners have to exist** where the schema says so: both suites create everything as
  `OWNER_A` or `OWNER_B`, and a store whose tables reference Better Auth's `"user"` row must
  seed them through `ensureUsers`. An in-memory store has no users and leaves the hook out.
- Name the suite (`{ name: '…' }`) so a failure says which implementation broke.

`runCredentialStoreConformance` works the same way: a factory that takes the clock the store
must use (`(clock) => new InMemoryCredentialStore({ now: clock.now })`), the same optional
`ensureUsers`, and the same rule that the factory hands out no state an earlier store could
see. What it asks for is what the `CredentialStore` contract promises — replace-in-place
upsert, metadata-only lists with no sealed field in them, `null`/`false`/`[]` for another
user, delete, one row per `(user, provider)`, clock-derived timestamps, and deep-frozen
answers. `validated_at` is the caller's instant, so the suite passes its own and checks it
comes back unchanged.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

## Testing

`src/**/*.test.ts` with Vitest (node environment):

- `testing/conformance.test.ts` and `testing/credentials-conformance.test.ts` run the two
  suites against the in-memory stores — the acceptance tests of this package. The session
  suite now also asks for the per-user preferences (#111), the model projection a
  `user.message` carrying one applies, `deleteSession` — its rows gone from every read,
  the ids it held free again, and the final `session.deleted` a subscriber receives — and the
  scheduler membership (#122): a heartbeat's row, the window that keeps it live (gone at
  exactly the edge), a re-heartbeat refreshing it, removal, and the window's argument check.
- `postgres/postgres.test.ts` runs both suites against Postgres — the acceptance tests of the
  durable stores — and adds what only a shared store can be asked: concurrent appends from
  two stores, a supplied event id two of them try to take, fencing across stores, a burst that
  must be delivered exactly once, catching up after the listening connection is killed, a
  chunk another store appended delivered to this store's subscriber, a deleted session's rows
  really gone from `events`, `event_claims` and `event_supersessions` while another session's
  are untouched, its `session.deleted` announced to a different store's subscriber,
  idempotent migrations (`0016`, `0017` and `0018` included — the tables and the column they
  add are exercised after a re-run),
  the #93 backfill over a session row written the pre-#93 way (the agent's model and system
  copied into the new columns, the row read back as the protocol's session), `close()` leaving
  a borrowed pool alone, the raw `events.processed_at` column staying `NULL`
  for a user event (a claim is a row of its own), the append-only guarantee against the real
  SQL (a snapshot of every `events` row is compared before and after claims, a supersession
  and a compaction, and no surviving row may differ by a field), two stores racing to `upsert`
  one provider (one row, whatever happens), and the user-delete cascade: deleting the `"user"`
  row takes that user's agents, sessions, events and credentials and leaves the other user's
  alone. Since `owner_id` is a foreign key into `"user"`, the factory seeds the suite's owners
  (`ensureUsers`) on empty tables. The harness truncates every table this package owns,
  `user_preferences` included, so preferences cannot leak between tests.
- `postgres/no-updates.test.ts` scans this package's source (tests excluded) for the spellings
  a write back to `events` would use and fails on any of them; the patterns carry self-tests
  for what they must catch and must not, and the compaction delete's `WHERE` is asserted
  clause by clause. It needs no database, so the append-only rule is guarded even where the
  Postgres suite is skipped.
- `memory.test.ts` covers what the fakes promise _on top of_ the contracts: the injected
  clocks, the copies they hand out (events deep-frozen, sessions and agents mutable clones,
  credentials frozen), microtask delivery, error identity, and that two stores share nothing.
- `index.test.ts` and `testing/clock.test.ts` cover the entry points and the test clock.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- `SessionStore` and `CredentialStore` are contracts: the Postgres stores, the brain and the
  server are written against them, so they change only when v1 as a whole does. Add to the
  TSDoc with every change.
- The Better Auth schema is **generated, not ours**: it is committed as SQL exactly as
  Better Auth's CLI produced it (see `0011_better_auth.sql`), and a Better Auth upgrade means
  regenerating and diffing it, never editing it by hand. The version that produced it is in
  that file's header and in this document.
- `CredentialStore` stores sealed blobs and nothing else: no plaintext column, no plaintext
  parameter, no dependency on `@openharness/vault`, and no sealed field in a `list` answer.
- An implementation detail belongs in the implementation's TSDoc, not in the contract's; the
  conformance suites test only what the contracts promise.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/session/docs/`.
