# The Postgres session store

`@openharness/session/postgres` is the durable implementation of the `SessionStore` contract:
the same log the in-memory fake keeps in `Map`s, in tables, with `LISTEN`/`NOTIFY` for live
delivery. It passes the whole conformance suite unchanged — `src/postgres/postgres.test.ts`
runs it against a real database — so anything the contract promises works the same here as it
does in memory. The subpath also exports `PostgresCredentialStore`, the durable half of the
`CredentialStore` contract, on the same migrations.

This document covers what is specific to these stores: the schema, how the database is
migrated, how `seq`, ownership, claims, supersession, compaction, fencing, leases and delivery
are implemented, and how to run Postgres locally.

---

## Getting started

```ts
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { createPostgresSessionStore, migrate } from '@openharness/session/postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = new Kysely({ dialect: new PostgresDialect({ pool }) })

await migrate(db) // once per database, on deploy
const store = createPostgresSessionStore({ pool }) // or { connectionString }
// …
await store.close() // ends the listening connection
```

- `createPostgresSessionStore({ connectionString } | { pool }, { clock?, partitionCount?, onError? })`
  builds the store. With `connectionString` it opens its own pool and ends it on `close()`;
  with `pool` it borrows one and leaves it alone.
- `migrate(db, { migrationsDir? })` applies the SQL migrations and returns the files it ran.
- `PostgresSessionStore` is the same thing as a class, if you would rather construct it
  directly. It takes the same options as a single object.
- `store.close()` drops the listening connection and, only if the store opened it, the pool.
  Idempotent.

The order is always the same: migrate, then build the store. The store never creates its
schema.

## The schema

Sixteen tables, in `migrations/`. Ten are this package's:

| table                  | what a row is                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `agents`               | an agent configuration: `owner_id`, name, description, model, system prompt, timestamps                 |
| `sessions`             | a log's header: `owner_id`, `status`, `partition`, title, metadata, and the agent snapshot              |
| `events`               | one stored event: `id`, `session_id`, `seq`, `type`, `payload jsonb`, `created_at`, `processed_at`      |
| `event_claims`         | one claim of one user event: `event_id` (primary key), the claiming event or `null`, `claimed_at`       |
| `event_supersessions`  | one recorded chunk range: `from_seq`, `to_seq`, `by_event_id` (primary key), `by_seq`, `created_at`     |
| `partition_leases`     | who holds a partition, at which epoch, until when                                                       |
| `provider_credentials` | a user's sealed model-provider key, one per `(user_id, provider)`: the sealed blob, `last4`, timestamps |

and six are **Better Auth's**, created by the same migrations and read and written by Better
Auth itself (epic #65, decision A1): `user`, `session`, `account`, `verification` and
`deviceCode`. They are the generator's schema, not this package's design — camelCase columns
and all — because the server mounts Better Auth against them with its own migrator disabled.
See [Better Auth's tables](#better-auths-tables) below.

`session_previews`, the table of pre-D9 previews in flight, was dropped by
`0010_drop_session_previews.sql` (P4); the chunks of a reply are rows of `events` since D9.

Details that matter:

- **`owner_id` is the user an agent or a session belongs to** (epic #65, A4): `text not null
references "user" (id) on delete cascade`, written once at creation and never updated. The
  reads a user-facing route makes filter on it (`where owner_id = $caller`), which is why both
  tables carry an `(owner_id, created_at, id)` index beside their unscoped one — the same
  `(created_at, id)` order, narrowed by the owner that comes first. It is Better Auth's opaque
  id, so unlike this package's ids it carries no `collate "C"`: nothing orders by it. Deleting
  the `"user"` row takes the user's agents, sessions and credentials with it, and the events
  go with the sessions — one `delete from "user"` and nothing of that user is left.

- **`id` columns are `text collate "C"`.** The ids are ASCII (`agent_`, `sesn_`, `sevt_` plus
  a ULID), and the lists are ordered and paged by `(created_at, id)`. Under the `C` collation
  SQL compares those ids byte for byte, which is exactly what the protocol's keyset cursors
  encode and what `InMemorySessionStore` compares with `<` — so a cursor taken from one page
  seeks into the next one identically in both stores, whatever the database's locale is.
- **Every timestamp is `timestamptz`, and the store never reads `now()`.** `created_at`,
  `updated_at`, `processed_at` and a lease's `expires_at` are all built from the store's
  injected `Clock` and passed as parameters. Lease expiry is compared against the clock's
  instant too (in SQL for `acquirePartition`, in JavaScript for a fence check). That is what
  makes the conformance suite's "move the clock forward" tests work against Postgres.
- **`events.payload` is the event body** — what the caller sent, without `id`, `seq` and
  `processed_at`, which are columns; a caller-supplied id is written to `events.id` and is not
  repeated in the JSON. `events.type` duplicates `payload->>'type'` so that filtering, the
  partial index and integrity checks do not have to read JSON.
- **`events` has `unique (session_id, seq)`** — the ordering key is unique per session — an
  explicit index on `(session_id, seq)`, and a partial index
  `(session_id, seq) where processed_at is null and type in ('user.message', 'user.interrupt')`
  for the queued events the brain reads on every iteration. The unique constraint already
  provides the `(session_id, seq)` access path; the explicit index is kept because the schema
  documents it as part of the contract.
- **`events.id` is unique across the whole table** — an event id identifies one event for the
  whole store, because it is what a reply's chunks share with the message they become (see
  [caller-supplied ids](#caller-supplied-ids)). The primary key already enforces it, and
  `0005_events_id_unique.sql` declares a `unique` index named `events_id_key` beside it.
- **`event_claims.event_id` is the primary key** — claiming is `insert … on conflict do
nothing`, so two writers racing for the same event cannot both win, and nothing here is ever
  written a second time or deleted (see [claims](#claims-are-rows-not-columns)). A claim names
  the user event it takes and the event whose `consumes` made it — a
  `span.model_request_start`, a `span.model_request_end` or a `session.status_idle` (P4); the
  column is nullable only for rows the pre-P4 `markProcessed` wrote.
- **`event_supersessions` is insert-only too**, and `by_event_id` is its primary key: one
  event carries one `supersedes` range. `check (to_seq >= from_seq)` and `check (by_seq >
to_seq)` are the range rules in the schema's own words (see
  [supersession and compaction](#supersession-and-compaction)).
- **Neither of the two new tables has a foreign key**, on purpose. The log's tables are
  truncated wholesale — a test harness that empties `events` for the next test does it in one
  statement, and Postgres refuses to truncate a table a foreign key points at — so a reference
  from `event_claims` or `event_supersessions` would break tooling outside this package. The
  store is their only writer, every read joins back to `events`, and a row a truncation leaves
  behind simply matches nothing. What the contract needs is uniqueness, and the primary keys
  provide that on their own.
- **`sessions.partition`** is `partitionOf(sessionId)` — stored, not recomputed, so
  `findSessionsNeedingWork` is an index range scan per partition.
- **`events.processed_at` is never written for a user event** (P4): a user event is queued,
  the column is left out of the insert, and the `processed_at` a read reports comes from the
  claim row alone. It is still written for every other event type, and rows written before
  the change keep whatever they carry.
- **`partition_leases.owner is null` means free**, and a `check` keeps owner and `expires_at`
  in step: an owned lease always has an expiry, a free one has neither.

## Migrations

Plain SQL files in `migrations/`, applied in file-name order by `migrate(db)`. They are
**idempotent** — every statement is `if not exists` — so a run over an up-to-date database
changes nothing and a run over a fresh one creates everything.

The whole run is one transaction under `pg_advisory_xact_lock(hashtext('@openharness/session
migrations'))`:

- a failure half way leaves the schema as it was, because Postgres DDL is transactional;
- two server instances starting together cannot interleave their DDL — the second waits for
  the lock, then finds everything already there.

There is no ledger table: "already applied" is decided by the statements themselves. The
consequence is that **a migration file must never be edited once it has been applied
anywhere** — the runner will not re-run it, so an edit is silently ignored on existing
databases while applying to new ones. Add a new file instead.

| file                               | what it creates                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `0001_agents.sql`                  | `agents`, and the `(created_at, id)` index the agent list pages through                             |
| `0002_sessions.sql`                | `sessions`, plus the indexes for the three ways sessions are queried                                |
| `0003_events.sql`                  | `events`, its uniqueness constraint and its two secondary indexes                                   |
| `0004_partition_leases.sql`        | `partition_leases`                                                                                  |
| `0005_events_id_unique.sql`        | the `unique` index that states the id guarantee (`events_id_key`) by name                           |
| `0006_session_previews.sql`        | `session_previews`, the `unlogged` table of previews in flight                                      |
| `0007_event_claims.sql`            | `event_claims`, the insert-only record of which events a turn claimed (D9)                          |
| `0008_event_claims_backfill.sql`   | the one-time copy of the pre-D9 `processed_at` values into claim rows (D9)                          |
| `0009_event_supersessions.sql`     | `event_supersessions`, the insert-only record of the ranges events replace                          |
| `0010_drop_session_previews.sql`   | drops `session_previews`, the pre-D9 preview table (P4)                                             |
| `0011_better_auth.sql`             | Better Auth's tables: `user`, `session`, `account`, `verification`, `deviceCode` (epic #65, A1)     |
| `0012_ownership.sql`               | deletes the v1 data once, then `owner_id` on `agents` and `sessions` and the per-owner indexes (A4) |
| `0013_provider_credentials.sql`    | `provider_credentials`, the sealed-blob table (epic #65, A5)                                        |
| `0014_auth_session_revocation.sql` | the `after delete` trigger on `"session"` that announces revoked sessions (#76)                     |

To run them outside an application:

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/openharness yarn migrate
```

`yarn migrate` runs the built `bin` (`dist/postgres/cli.js`), so build first. The command also
accepts the connection string as its first argument, and exits non-zero when a migration
fails, so a deploy step can gate on it.

### Better Auth's tables

`0011_better_auth.sql` creates the schema **Better Auth** needs (epic #65, decision A1): the
core tables — `user`, `session`, `account`, `verification` — plus `deviceCode` from the
`device-authorization` plugin (the one `oh login` uses). The `google`, `github` and `microsoft`
social providers need no tables of their own (their accounts are `account` rows keyed by
`providerId`), and `bearer` adds none either: a bearer token _is_ a `session` row looked up by
`token`. A user's `email` is unique — a user _is_ a verified email (A3), and the same person
through another provider is the same row.

The SQL is **generated, not written**:

```sh
# in a scratch directory, with better-auth@1.7.6 installed (the version the repo pins)
npx @better-auth/cli generate --config ./auth.ts --output ./generated.sql
```

where `auth.ts` configures `betterAuth` with the Postgres/Kysely adapter, the three social
providers and `deviceAuthorization()` + `bearer()`. The output is committed verbatim but for
whitespace and the `if not exists` this package's migrator requires — `0011_better_auth.sql`
reproduces it one statement per construct and records the version in its header.
`npx @better-auth/cli migrate` against a scratch database produces the same schema, and
re-running the generator over it answers "Your schema is already up to date."

**The server sub-issue (#61) mounts Better Auth against these tables with its own migrator
disabled, so they must match what Better Auth expects exactly.** Upgrading Better Auth means
regenerating, diffing and adding a migration — never editing `0011` (no applied migration file
is ever edited).

### Ownership and the credential table

`0012_ownership.sql` (decision A4) deletes every row of `events`, `event_claims`,
`event_supersessions`, `sessions` and `agents` — v1 is unreleased, so there is no ownership to
backfill — and then adds `owner_id text not null references "user" (id) on delete cascade` to
`agents` and `sessions`, with an `(owner_id, created_at, id)` index for each owner-scoped
list. The delete is wrapped in a `do $$ … $$` guard on the absence of the `owner_id` column:
this migrator re-runs every file on every `migrate()` call, and without the guard a server
restart months from now would empty every log in the database. Once the column exists the
guard skips the deletes forever, so data created after the migration is safe.

`0013_provider_credentials.sql` (decision A5) creates the credential table: one sealed key per
`(user_id, provider)`, `on delete cascade` from `"user"`. Its columns are the sealed form
(`ciphertext`, `nonce`, `wrapped_key`, `kek_version`), the `last4` recognition aid and the
timestamps. **There is no plaintext column**, and the store that writes it
(`PostgresCredentialStore`) never sees a plaintext either: the server seals with
`@openharness/vault` and this package only moves blobs.

## `seq`: gap-free, in order, under concurrent appends

`seq` starts at `1` per session and increases by one per event. It is assigned **inside the
append transaction**, after taking the session's row lock:

```
begin
  select … from sessions where id = $1 for update      -- the append lock
  select coalesce(max(seq), 0) from events where session_id = $1
  insert into events …                                  -- seq = max + 1, max + 2, …
  update sessions set status = …, updated_at = … where id = $1
  select pg_notify(…, …)
commit
```

Every append to a session takes the same row lock, so two appends — from two connections, two
stores, or two processes — serialize on it, and each reads the log's end after the previous
one committed. That is what makes the numbers gap-free and ordered, and it is what
`src/postgres/postgres.test.ts` asserts with sixteen concurrent appends from two stores. The
lock also makes the existence check (`SessionNotFoundError`), the status update and the
`updated_at` bump part of the same transaction as the write, so a turn can never observe half
an append.

`createSession`'s `initial_events` go through the same code path inside the creation
transaction: they are in the log before the session is visible.

A claim rides along in the append's own transaction, and since D9 it is a row of its own rather
than a value written onto the event — see [claims](#claims-are-rows-not-columns) below. For a
user event the append writes no `processed_at`: the column is left out of the insert (`NULL` in
the row), because the value a read reports is the claim's.

## Caller-supplied ids

An append may carry its own `sevt_` id (`AppendableEvent.id`) — the one the brain put on the
reply's `event_start`/`event_delta` chunks, so that the finished `agent.message` lines up with
what a client accumulated. The store writes the event under exactly that id; `events.id` is
where it lands, and the payload holds the event body without it, as it does for the ids the
store mints.

The id is checked by the database rather than by a read first, because it is unique across the
whole table and not just within a session:

```
begin
  select … from sessions where id = $1 for update      -- the append lock
  insert into events …                                  -- a taken id fails here
commit
```

A duplicate raises SQLSTATE `23505` — on `events_pkey`, or on `events_id_key`, the unique index
`0005_events_id_unique.sql` declares beside it; Postgres does not promise which one it names,
so the store watches both — the transaction rolls back, and the append is refused with a
`DuplicateEventIdError` that names the id the log already holds. Nothing of that batch is
stored: the events that preceded the offending one in the same append are rolled back with it,
because an append is one transaction.

Naming the id is safe after the rollback: an insert that meets an uncommitted conflicting row
waits for it and only ends in a violation if that row commits, so the conflicting event is in
the table and one read finds it. An id that is not a valid event id (`RangeError`), and the
same id twice in one batch (`DuplicateEventIdError`), are refused by both stores before any of
this — they are argument checks, and `0005_events_id_unique.sql` is what covers the case a
single process cannot see: two appends, to the same session or to different ones, racing for
the same id.

## Claims are rows, not columns

A user event is queued until a turn claims it. Before D9 that claim was the `processed_at`
column on the event itself, and claiming wrote to `events` — a client that already held the
event never learned it had changed. Now the claim is a row of `event_claims`, that table is
insert-only, and `processed_at` is derived on read by joining it. An append whose event
carries `consumes` claims in its own transaction, with `claimed_by_event_id` set to that event
— a `span.model_request_start`, a `span.model_request_end` or a `session.status_idle` (P4):

```sql
insert into event_claims (session_id, event_id, claimed_by_event_id, claimed_at)
select $1, claim.event_id, claim.by_event_id, $2
  from unnest($3::text[], $4::text[]) as claim (event_id, by_event_id)
  join events e
    on e.id = claim.event_id
   and e.session_id = $1
   and e.type in ('user.message', 'user.interrupt')
on conflict (event_id) do nothing
returning event_id
```

The select is the filter and `on conflict (event_id) do nothing` is the race: an id from
another session, an event of another type, or one already claimed matches no row, and two
writers racing for the same event both insert while only one commits — exactly what the old
conditional write decided. This is an assertion, not a best-effort claim: the event states
what it answers, so an id the insert produces no row for — foreign, non-user, already claimed,
or named twice in one batch — fails the store's check, the append throws `ClaimConflictError`,
and the transaction rolls back with the events it had already written. (The pre-P4
`markProcessed`, removed in this phase, was the weaker counterpart: a caller taking whatever
of a list was still there, recording `claimed_by_event_id: null`. Its rows stay as they are.)

**Reading `processed_at`.** Every read that can return a user event joins the claim:
`listEvents` and the subscription fetch `left join event_claims`; `getPendingUserEvents` is
the anti-join — `left join … where c.event_id is null` — which is what "queued" means now,
still in `seq` order. The `events.processed_at` column is never written for a user event (P4)
and not read for one; `0008_event_claims_backfill.sql` copied every pre-D9 value into a claim
row, so logs written before the change read exactly as they did. The column stays for the
other event types.

## Supersession and compaction

Since D9 a streamed reply is stored as it streams (`event_start`, `event_delta`), and the
event that finishes it — the `agent.message`, or the `span.model_request_end` for a request
that ends without one — carries `supersedes: { from_seq, to_seq }`. The append records the
range in `event_supersessions`, after checking in the store that `from_seq` is positive,
`to_seq` is not before it, and `to_seq` is strictly before the superseding event's own `seq`;
anything else is a `RangeError` and the append is refused whole. The table's `check`
constraints say the same thing in the schema's own words.

Readers then skip it. `listEvents` leaves a stored chunk out when a recorded range covers its
`seq`:

```sql
not exists (
  select 1
    from event_supersessions s
   where s.session_id = e.session_id
     and e.type in ('event_start', 'event_delta')
     and e.seq between s.from_seq and s.to_seq
)
```

— so a client resuming at any `seq` sees the reply once, whole, however far into the stream
it had got. `includeSuperseded: true` reads the raw log instead, for debugging. Live delivery
is not filtered: a subscriber hears every event as it happens, and reconciling by id is the
client's business (the protocol's transcript rules are written for exactly that).

`compact({ olderThan })` is the **only** delete in this package, and it deletes only what a
range covers, that is a chunk, and that is older than the cutoff:

```sql
delete from events e
 using event_supersessions s
 where e.session_id = s.session_id
   and e.type in ('event_start', 'event_delta')
   and e.seq between s.from_seq and s.to_seq
   and e.created_at < $1
```

It returns how many events it deleted, is idempotent, and two instances running it at once
simply split the rows between them. Nothing else is ever deleted: `event_claims` and
`event_supersessions` are insert-only and outlive the chunks they name, and a superseded
chunk always has the event that superseded it _after_ it, which is not a chunk and is never
deleted — so `seq` is never reused, and the gaps a compaction leaves are the normal state of
a compacted log. `src/postgres/no-updates.test.ts` scans this package's source for the two
spellings a write back to `events` would use, so "written once, read forever" cannot break
unnoticed.

## The in-flight preview is gone (P4)

A reply's chunks are rows of `events` since D9, so this store never needed a second place to
keep a preview: the `event_start` and `event_delta`s are delivered to a subscriber like any
other event, and a connection that opens mid-reply replays them by `seq`. P4 removed the
contract's `publishEphemeral`, `getPreview` and `SessionPreview`, and
`0010_drop_session_previews.sql` drops the `unlogged` table that held the accumulation — the
table whose `event_id` and `text` a late connection used to be told about. There is nothing
left to read or write, and the `(session_id, seq)` log is the one source of an in-flight
reply.

## Fencing and leases

A write carrying `fence: { partition, epoch }` is checked **in the same transaction** as the
write itself, against `partition_leases`: the lease must be held (an owner, an expiry) at that
epoch and still be live, where "live" means `expires_at > clock()` — a lease is expired from
the instant `expires_at` names, inclusive. Anything else is a `FencedError` carrying the
partition's current epoch, and nothing is written.

`acquirePartition` is one conditional upsert, which is what makes "is it free?" and "take it"
atomic:

```sql
insert into partition_leases (partition, owner, epoch, expires_at)
values ($1, $2, 1, $3)
on conflict (partition) do update
   set owner = excluded.owner,
       epoch = partition_leases.epoch + 1,
       expires_at = excluded.expires_at
 where partition_leases.owner is null                    -- released
    or partition_leases.owner = excluded.owner           -- the same owner asking again
    or partition_leases.expires_at <= $now               -- expired
returning …
```

No row comes back when a live lease is held by somebody else, which is the `null` the contract
asks for. **Every successful acquire increments the epoch**, including the same owner asking
again, so a tenure never repeats and a write from an older one is refused. `renewPartition` is
a conditional `update … where owner = $ and epoch = $ and expires_at > $now`; `releasePartition`
sets the row free and advances the epoch, so a write still in flight from the released tenure
is fenced rather than landing in the next one; `currentEpoch` is the stored epoch, `0` when the
partition has never been leased.

Leases live in the database, so they mean the same thing to every store and every process —
two stores in the same test file share a lease, which is what
"fences a stale epoch across stores" exercises.

## Live delivery

One dedicated `LISTEN` connection per store (`listen.ts`), never a pooled connection per
subscription:

- `subscribe` `LISTEN`s the session's channel when the first listener for that session arrives
  and `UNLISTEN`s it when the last one leaves. The connection is opened lazily, on the first
  subscription of either kind.
- A dropped connection is detected (`pg`'s `error`/`end` events) and reconnected with backoff
  (50 ms doubling to 5 s). On reconnect the store re-issues every `LISTEN` that is still
  wanted and then **catches up**: for every subscribed session it fetches everything after
  the last `seq` it delivered. Notifications that were sent while the connection was down are
  gone — Postgres does not queue them — which is exactly why the catch-up reads the log
  instead of trusting the stream of hints.
- `close()` unlistens everything and ends the connection.

**Channels** are short and safe: `ohs_` plus 32 hex characters of the session id's SHA-256,
and `ohp_<partition>` for a partition's signals. A session id is arbitrary text and a channel
name is a 63-byte identifier, so the session channel is a hash rather than the id itself.
Channel names are quoted in `LISTEN`/`UNLISTEN`, and `pg_notify()` takes them as values, so
the two never disagree about case. The one revocation channel,
`ohr_auth_session_revoked`, is a fixed name: revocations are rare and every listener has to
hear about the sessions it holds open, so they share one channel and the payload names the
session.

**Payloads.** A notification is `{"seq": n}` — never the event, which is unbounded while a
notification is not. A subscriber that sees it fetches `seq > lastSeen` in order, which is
what makes coalesced, repeated or missed notifications harmless: the log is the record, the
notification is a nudge. (The pre-P4 store also announced ephemeral previews in the payload,
and a payload shaped like one is ignored now; there is no preview to deliver.)

**Order.** All notification handling goes through one queue, one notification at a time, and
each subscription remembers the last `seq` each of its listeners was given. So events are
delivered in `seq` order, once each — and a fetch that happens to bring back rows a listener
has already seen skips them rather than repeating them.

**Signals** travel on the partition's channel, so every instance listening for that partition
hears one — not just the instance that sent it. A signal that nobody is listening for is
dropped, exactly as the contract says. Note that missed signals are _not_ replayed on
reconnect: they are hints, and a partition's new owner recovers by calling
`findSessionsNeedingWork`.

**Auth-session revocations** (epic #65, A2; issue #76) travel the same way, on the one
`ohr_auth_session_revoked` channel, with the session **id** in the payload — never the token.
The store's `notifyAuthSessionRevoked` publishes with `pg_notify` and `onAuthSessionRevoked`
subscribes; the trigger test's counterpart in the database is
`0014_auth_session_revocation.sql`, which announces every row deleted from `"session"`,
whoever deleted it. A revocation missed while a listening connection was down is gone — it is
a hint — and the server recovers by re-validating the session periodically.

## Running Postgres for this package's tests

`src/postgres/postgres.test.ts` needs a real database — the acceptance test of this store is
that the conformance suite passes against one — and gets it in this order:

1. **`DATABASE_URL`, if it is set.** Nothing else is started, and the tests run against that
   database. This is what CI does, with the `postgres` service in `.github/workflows/ci.yml`.
2. **Otherwise testcontainers**, if a Docker daemon is reachable: the tests start
   `postgres:18-alpine`, migrate it, and stop it afterwards.
3. **Otherwise the suite is skipped**, with a note in the report. Set `DATABASE_URL` or start
   Docker to run it; a skip is not a pass.

Locally, the shortest path is a container of your own:

```sh
docker run --rm -d --name openharness-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=openharness postgres:18-alpine

cd packages/session
DATABASE_URL=postgres://postgres:postgres@localhost:5432/openharness yarn test
```

The suites truncate every table this package owns before each test, so they are happy to share
a database with anything else — but they will empty all seven of them — `agents`, `sessions`,
`events`, `event_claims`, `event_supersessions`, `partition_leases` and
`provider_credentials` — in whatever database `DATABASE_URL` points at. Better Auth's tables
are left alone apart from the two `"user"` rows the suites insert for their owners (the
`ensureUsers` hook), so a database that also holds real sign-ins keeps them. Point
`DATABASE_URL` at a scratch database anyway.

## Operational notes

- **One store per process** is the shape everything assumes: one listening connection, one
  set of subscriptions. Several stores may share a pool (the tests do), but each opens its own
  listening connection and receives its own notifications.
- **The pool is yours** when you pass one: size it for the app, not for the store. Appends
  hold a session row lock for the length of a transaction, so a burst of appends to one
  session serializes; different sessions do not contend.
- **`close()` is not optional** in a graceful shutdown: an open listening connection keeps the
  process alive and the database busy.
- **`onError`** is called when a listening connection is lost or cannot be re-established.
  The store recovers on its own, so this is for logging rather than for recovery.
