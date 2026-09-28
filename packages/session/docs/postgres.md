# The Postgres session store

`@openharness/session/postgres` is the durable implementation of the `SessionStore` contract:
the same log the in-memory fake keeps in `Map`s, in tables, with `LISTEN`/`NOTIFY` for live
delivery. It passes the whole conformance suite unchanged — `src/postgres/postgres.test.ts`
runs it against a real database — so anything the contract promises works the same here as it
does in memory.

This document covers what is specific to this store: the schema, how the database is migrated,
how `seq`, fencing, leases and delivery are implemented, and how to run Postgres locally.

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

Four tables, in `migrations/`:

| table              | what a row is                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `agents`           | an agent configuration: name, description, model, system prompt, timestamps                        |
| `sessions`         | a log's header: `status`, `partition`, title, metadata, and the agent snapshot                     |
| `events`           | one stored event: `id`, `session_id`, `seq`, `type`, `payload jsonb`, `created_at`, `processed_at` |
| `partition_leases` | who holds a partition, at which epoch, until when                                                  |

Details that matter:

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
  `processed_at`, which are columns. `events.type` duplicates `payload->>'type'` so that
  filtering, the partial index and integrity checks do not have to read JSON.
- **`events` has `unique (session_id, seq)`** — the ordering key is unique per session — an
  explicit index on `(session_id, seq)`, and a partial index
  `(session_id, seq) where processed_at is null and type in ('user.message', 'user.interrupt')`
  for the queued events the brain reads on every iteration. The unique constraint already
  provides the `(session_id, seq)` access path; the explicit index is kept because the schema
  documents it as part of the contract.
- **`sessions.partition`** is `partitionOf(sessionId)` — stored, not recomputed, so
  `findSessionsNeedingWork` is an index range scan per partition.
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

| file                        | what it creates                                                         |
| --------------------------- | ----------------------------------------------------------------------- |
| `0001_agents.sql`           | `agents`, and the `(created_at, id)` index the agent list pages through |
| `0002_sessions.sql`         | `sessions`, plus the indexes for the three ways sessions are queried    |
| `0003_events.sql`           | `events`, its uniqueness constraint and its two secondary indexes       |
| `0004_partition_leases.sql` | `partition_leases`                                                      |

To run them outside an application:

```sh
DATABASE_URL=postgres://user:pass@localhost:5432/openharness yarn migrate
```

`yarn migrate` runs the built `bin` (`dist/postgres/cli.js`), so build first. The command also
accepts the connection string as its first argument, and exits non-zero when a migration
fails, so a deploy step can gate on it.

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

`markProcessed` claims rather than asserts: one `update … where processed_at is null
returning *` sets `processed_at` for exactly the rows that were still queued, so two callers
racing for the same event cannot both win, and marking twice is a no-op.

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
the two never disagree about case.

**Payloads.** A stored notification is `{"seq": n}` — never the event, which is unbounded
while a notification is not. A subscriber that sees it fetches `seq > lastSeen` in order,
which is what makes coalesced, repeated or missed notifications harmless: the log is the
record, the notification is a nudge. Ephemeral events have no row to fetch, so an `event_start`
or `event_delta` travels in the payload directly; a payload with a `seq` is a stored
notification and anything else is an ephemeral event (neither stream-only event type has a
`seq` field). A payload that would exceed Postgres's 8000-byte limit is **dropped**: deltas are
a preview and best effort, and a dropped one only costs a step of progressive rendering.

**Order.** All notification handling goes through one queue, one notification at a time, and
each subscription remembers the last `seq` each of its listeners was given. So stored events
are delivered in `seq` order, once each, interleaved with ephemeral events where they were
published — and a fetch that happens to bring back rows a listener has already seen skips
them rather than repeating them.

**Signals** travel on the partition's channel, so every instance listening for that partition
hears one — not just the instance that sent it. A signal that nobody is listening for is
dropped, exactly as the contract says. Note that missed signals are _not_ replayed on
reconnect: they are hints, and a partition's new owner recovers by calling
`findSessionsNeedingWork`.

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

The suite truncates every table before each test, so it is happy to share a database with
anything else — but it will empty `agents`, `sessions`, `events` and `partition_leases` in
whatever database `DATABASE_URL` points at. Point it at a scratch database.

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
