# @openharness/session

The durable, append-only session event log: the `SessionStore` contract the brain and the
server code against, the in-memory implementation every other package tests against, the
Postgres implementation production runs on, and the conformance suite all of them pass.

A session is a log of events — the user's messages, the agent's replies, the status
transitions that bracket a turn, and the spans around every model request. It is the source of
truth for a run, and it is why the brain holds no state of its own. Around the log sit the
leases that decide who may write to it, and the signals that wake that owner up.

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
  index.ts              the barrel: the contract, the store, clocks, errors
  store.ts              SessionStore, its vocabulary, and the semantics in TSDoc
  memory.ts             InMemorySessionStore: the fake, and the reference behaviour
  clock.ts              Clock, systemClock, timestampAt()
  errors.ts             FencedError, SessionNotFoundError, AgentNotFoundError, DuplicateEventIdError
  inputs.ts             the argument checks both stores share (limits, cursors, lease ttls)
  postgres/
    index.ts            the `@openharness/session/postgres` entry point
    store.ts            PostgresSessionStore and createPostgresSessionStore
    schema.ts           the Kysely table types, row → protocol mapping, channel names
    listen.ts           the dedicated LISTEN connection, and its reconnection
    migrate.ts          migrate(): the SQL-file runner
    cli.ts              the `openharness-session-migrate` bin
    postgres.test.ts    the conformance suite against Postgres, plus extra tests
  testing/
    index.ts            the subpath entry: re-exports, plus the suite and the test clock
    conformance.ts      runSessionStoreConformance()
    clock.ts            createTestClock()
migrations/             the SQL the Postgres store needs, applied by `migrate()`
docs/postgres.md        the Postgres store: schema, migrations, delivery, local setup
```

## Public API

### `@openharness/session`

| export                                                                                                             | what it is                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `SessionStore`                                                                                                     | the storage and signaling contract; every method is async, and documented below                                      |
| `AppendableEvent`                                                                                                  | an event a caller appends: a `StoredEvent` minus `seq` and `processed_at`, plus an optional `id` the caller supplies |
| `CreateSessionOptions`, `ListAgentsOptions`, `ListSessionsOptions`, `ListEventsOptions`                            | the options objects of the list and create methods                                                                   |
| `AppendEventsOptions`, `MarkProcessedOptions`, `PartitionFence`                                                    | the optional fence a brain attaches to a write                                                                       |
| `PartitionLease`, `PartitionSignal`, `PartitionSignalInput`, `PartitionSignalKind`                                 | leases over a partition, and the signals sent to its owner                                                           |
| `TurnState`, `TurnStateKind`                                                                                       | what `getTurnState()` answers                                                                                        |
| `SessionEventListener`, `PartitionSignalListener`, `Unsubscribe`                                                   | subscription plumbing                                                                                                |
| `InMemorySessionStore`, `InMemorySessionStoreOptions`                                                              | the in-memory implementation and its `{ now, partitionCount }` options                                               |
| `Clock`, `systemClock`, `timestampAt()`                                                                            | the injectable time source, and how an instant is written as a timestamp                                             |
| `FencedError`, `SessionNotFoundError`, `AgentNotFoundError`, `DuplicateEventIdError`, `isFencedError()`            | the typed failures a store raises                                                                                    |
| `FENCED_ERROR_CODE`, `SESSION_NOT_FOUND_ERROR_CODE`, `AGENT_NOT_FOUND_ERROR_CODE`, `DUPLICATE_EVENT_ID_ERROR_CODE` | the stable `code` of each error, for detection across bundles                                                        |
| `PACKAGE_NAME`                                                                                                     | this package's name; lets a dependent prove the import resolved                                                      |

### `@openharness/session/postgres`

| export                                                                                  | what it is                                                                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `PostgresSessionStore`, `createPostgresSessionStore(config, options?)`                  | the durable implementation; `{ connectionString }` or `{ pool }`, plus options    |
| `PostgresSessionStoreOptions`, `PostgresSessionStoreConfig`                             | its options (`now`, `partitionCount`, `onError`) and the two ways to reach a DB   |
| `migrate(db, options?)`                                                                 | applies `migrations/`, idempotently, in one locked transaction; returns the files |
| `MigrateOptions`                                                                        | `{ migrationsDir? }`, for a migrations directory that is not this package's       |
| `PostgresSchema`, `AgentsTable`, `SessionsTable`, `EventsTable`, `PartitionLeasesTable` | the Kysely table types, for a caller that wants to query alongside the store      |

This entry point is a separate subpath on purpose: it is the only module that depends on `pg`
and `kysely`, and a consumer that only needs the contract, the fake or the suite must not load
them. `store.close()` releases the listening connection and ends the pool **only if the store
opened it**. See [`docs/postgres.md`](./docs/postgres.md).

### `@openharness/session/testing`

| export                                               | what it is                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `runSessionStoreConformance(makeStore, options?)`    | the suite every implementation must pass                        |
| `MakeSessionStore`, `SessionStoreConformanceOptions` | the factory it takes, and how to name the suite                 |
| `createTestClock(startMs?)`, `TestClock`             | a clock a test advances by hand                                 |
| everything from `@openharness/session`               | re-exported, so a test imports the store and the suite together |

This entry point is for test code only: the suite calls `describe`/`it` from `vitest`, which
is therefore a devDependency of any package that uses it, and never a runtime dependency of
this one.

## The contract

`SessionStore` in `src/store.ts` is the complete, documented contract; this section is the
summary a caller — or a new implementation — needs before writing a line against it.

**Everything is asynchronous**, and nothing may assume synchronous delivery. A store built on
`LISTEN`/`NOTIFY` notifies after it commits, and a subscription or a signal arrives a tick
later than the append that caused it. Read state; do not assume a listener has run.

**Ordering.** `seq` is the ordering key, not time: it starts at `1` and increases by one per
event, per session, in append order. Timestamps are metadata. Reads return events in `seq`
order (`asc` by default); a subscription delivers stored events in `seq` order, with no gaps
and no duplicates, interleaved with ephemeral events at the point they were published.

**Assigned fields.** `appendEvents` assigns `seq` and an internal creation time in one
transaction, and `id` too unless the event brought one. The events it returns, and every event
a read returns, are exactly `StoredEvent`s — no extra field, and specifically no `created_at`:
the protocol has none. `seq` is the resume position, `id` is the identity, and a replayed log
is a faithful record.

**Caller-supplied ids.** An `AppendableEvent` may carry an `id`, and the store then writes the
event under exactly that id. This is what keeps a stored `agent.message` on the same `sevt_` id
as the `event_start`/`event_delta` previews the brain published with `publishEphemeral` before
it appended: a client replaces the preview with the stored event by id. Two rules come with it,
and an append that breaks either is refused **whole** — nothing in that batch is stored:

- the id must be a valid `sevt_` id, or the append throws `RangeError`;
- the id must be free, both in the log (an id identifies one event for the whole store, not one
  per session) and within the batch itself, or the append throws `DuplicateEventIdError`.

`seq` stays the store's either way: a supplied id changes which event an append writes, not
where in the log it lands.

**`processed_at`.** A user event is stored with `processed_at: null`, which is what makes it
_queued_. `getPendingUserEvents` lists the queued ones in `seq` order; `markProcessed` sets
`processed_at` from the clock and returns only the events it actually claimed, so marking twice
is a no-op and two callers racing for the same event cannot both win. Every event the brain
appends is stored with `processed_at` already set.

**Status.** `session.status_running` sets the session's `status` to `running` and
`session.status_idle` sets it to `idle` — in the same transaction as the append. A
`session.status_rescheduled` does not end a turn and leaves the status alone; v1 has no
resting `rescheduling` status. Every append also advances the session's `updated_at`.

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
holds at that epoch. `releasePartition` frees it and advances the epoch, so a write still in
flight from the released tenure is fenced rather than landing in the next one. `currentEpoch`
is `0` until the first acquire, and never repeats a tenure.

A write carrying `fence: { partition, epoch }` is accepted only while that partition's lease is
live and at that epoch; otherwise it fails with `FencedError`. That is what stops a zombie
brain — one whose lease expired, was released, or was taken over — from appending to a session
somebody else now owns. Fencing is **opt-in**: a write without a fence is never refused, which
is how the API appends a user event before it knows who owns the partition. The brain always
fences.

**Signals are hints.** `signalPartition` delivers a signal to the listeners attached to that
partition at that moment, once each; a signal nobody is listening for is dropped, because
signals are a latency optimization and not a durable queue. No flow may depend on one
arriving: a partition's new owner recovers by asking `findSessionsNeedingWork`, which reports
the sessions with pending user events or an open turn, oldest first.

**Errors.** `SessionNotFoundError` (every session-scoped method except `getSession`),
`AgentNotFoundError` (`createSession` with an unknown agent), `FencedError` (`appendEvents`,
`markProcessed`) and `DuplicateEventIdError` (`appendEvents` carrying an id the log already
holds, or the same id twice). `getSession`, `getAgent` and `updateAgent` answer `null` instead.
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

## The Postgres store

`@openharness/session/postgres` implements the same contract against Postgres, with Kysely and
`pg`, and passes `runSessionStoreConformance` unchanged — `src/postgres/postgres.test.ts` runs
the whole suite against a real database. [docs/postgres.md](./docs/postgres.md) is the long
version; this is the shape of it.

**Schema.** Four tables, all created by `migrations/`: `agents`, `sessions` (with the
`partitionOf` partition and the `status` the log's last status event implies), `events` (`id`,
`session_id`, `seq`, `type`, `payload jsonb`, `created_at`, `processed_at`, `unique
(session_id, seq)`, an index on `(session_id, seq)` and a partial index for queued user
events) and `partition_leases` (`partition`, `owner`, `epoch`, `expires_at`). Ids are `text
collate "C"`, so SQL ordering is the byte order the protocol's keyset cursors use; every
timestamp is `timestamptz` written from the injected clock, never from `now()`.

**Migrations.** Plain SQL files in `migrations/`, applied in name order by `migrate(db)` — one
transaction under an advisory lock, every statement `if not exists`, so it is idempotent and
safe to run from two instances at once. There is no ledger: a file that has been applied
anywhere must never be edited. `yarn migrate` runs the built bin.

**Appending.** `seq` is assigned inside the append transaction, under `select … for update` on
the session row, so concurrent appends — from any number of connections, stores or processes —
serialize and the numbers are gap-free and ordered. `initial_events` go through the same path
in the creation transaction. An event's id is the caller's when it supplied one: `events.id` is
unique across the whole table, so a taken id fails the insert and rolls the append back — the
store answers `DuplicateEventIdError`, and the id is the one the log already holds.

**Fencing and leases.** A fenced write checks `partition_leases` in its own transaction and
throws `FencedError` on a mismatch. `acquirePartition` is a single conditional upsert that
matches an unleased, self-owned or expired row, so testing and taking are atomic, and every
successful take advances the epoch — the same owner included.

**Live delivery.** One dedicated `LISTEN` connection per store, `LISTEN`/`UNLISTEN` per session
as its first and last listener come and go, and per partition for signals. A stored
notification carries the `seq` (never the event — payloads are capped at 8 KB) and the
subscriber fetches the range after the last `seq` it delivered, so coalesced or repeated
notifications cannot duplicate or drop anything; ephemeral events travel in the payload, and
one that would not fit is dropped. The connection reconnects with backoff and then catches up
from the last delivered `seq`. Signal channels are per partition, so every instance listening
for that partition hears a signal, not just the sender.

**Time.** The store takes the same `Clock` and derives every `created_at`, `updated_at`,
`processed_at`, lease `expires_at` and lease-expiry comparison from it. Nothing reads the
database's `now()`.

## Running Postgres

- **In CI** there is a `postgres` service in the workflow, and `DATABASE_URL` is set for the
  test steps, so the Postgres tests always run there.
- **Locally** set `DATABASE_URL`, or have a Docker daemon running and let the tests start
  `postgres:18-alpine` with testcontainers. With neither, the suite is skipped with a note —
  a skip is not a pass.
- The tests truncate `agents`, `sessions`, `events` and `partition_leases` before every test,
  so point `DATABASE_URL` at a scratch database.

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
  time) for subscription and signal deliveries, and waits a moment before asserting that
  nothing arrived. Nothing requires synchronous notification.
- **Partitions must match**: the suite uses the protocol's `partitionOf(sessionId)` with the
  default partition count, so a store's partition space has to be the server's.
- **A supplied id has to be the stored event's id, and it has to be refused when it cannot
  be one**: `RangeError` for something that is not a valid event id, and `DuplicateEventIdError`
  for an id the store already holds — anywhere in it, not just in that session — or one that
  appears twice in the same batch. Either way the batch stores nothing.
- Name the suite (`{ name: '…' }`) so a failure says which implementation broke.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Testing

`src/**/*.test.ts` with Vitest (node environment):

- `testing/conformance.test.ts` runs the whole suite against `InMemorySessionStore` — the
  acceptance test of this package.
- `postgres/postgres.test.ts` runs the same suite against Postgres — the acceptance test of
  the durable store — and adds what only a shared store can be asked: concurrent appends from
  two stores, a supplied event id two of them try to take, fencing across stores, a burst that
  must be delivered exactly once, catching up after the listening connection is killed, a
  dropped oversized ephemeral event, idempotent migrations, and `close()` leaving a borrowed
  pool alone.
- `memory.test.ts` covers what the fake promises _on top of_ the contract: the injected
  clock, the copies it hands out, microtask delivery, and error identity.
- `index.test.ts` and `testing/clock.test.ts` cover the entry points and the test clock.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- `SessionStore` is a contract: the Postgres store, the brain and the server are written
  against it, so it changes only when v1 as a whole does. Add to the TSDoc with every change.
- An implementation detail belongs in the implementation's TSDoc, not in the contract's; the
  conformance suite tests only what the contract promises.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/session/docs/`.
