# Scheduling, and running one server as several

`LocalScheduler` runs every session in the process that received the request. That is the
whole story for a single server, and it is the default. `PostgresPartitionScheduler` is the
other one: several servers, one database, and the sessions shared between them.

Both are `SessionScheduler`s — the interface in `src/scheduler.ts` a route talks to — and both
run their turns through the same `SessionRunner`, so the only thing that changes is _which_
sessions an instance runs.

```ts
interface SessionScheduler {
  start(): Promise<void>
  stop(options?: { drainTimeoutMs?: number }): Promise<void>
  signal(sessionId: SessionId, kind: 'work' | 'interrupt'): void
}
```

A route never runs a turn. It appends what the user sent to the log — unfenced, because it does
not know who owns the partition — and calls `signal`. Everything after that is the scheduler's.

## Partitions

Every session belongs to one of N partitions, and `N` is 64 unless `OPENHARNESS_PARTITIONS`
says otherwise:

```ts
partitionOf(sessionId, partitions) // @openharness/protocol, a hash of the id
```

The partition's number lives in the session row, so `findSessionsNeedingWork([p])` can ask
"what in partition `p` needs work?" without walking every session. **The store's partition
count and the scheduler's have to be the same number**: the store writes the column, the
scheduler names partitions in `findSessionsNeedingWork` and in the channel a signal travels on.
`main.ts` passes `OPENHARNESS_PARTITIONS` to both, which is what keeps them from drifting.

A partition is the unit of ownership. An instance either holds its lease — and is then the one
that runs its sessions, receives its signals and writes its turns — or it does not, and then
touching those sessions is somebody else's business.

## Leases and epochs

The lease lives in the database (`partition_leases`), not in the process:

| column       | what it is                                                 |
| ------------ | ---------------------------------------------------------- |
| `partition`  | the partition                                              |
| `owner`      | the instance id holding it, `null` when nobody does        |
| `epoch`      | the tenure: it advances on every acquire and every release |
| `expires_at` | when the lease lapses if it is not renewed within the TTL  |

`acquirePartition` is a single conditional upsert: it matches an unleased row, the same owner,
or an expired lease, and **never a live lease somebody else holds**. Every successful acquire
opens a new tenure, so the epoch never repeats.

That epoch is what makes a write safe. `runTurn` passes `fence: { partition, epoch }` to every
`appendEvents` and `markProcessed` it makes, and the store accepts the write only while that
partition's lease is live at that epoch. So a brain whose lease has been taken over — a
_process that is still running but no longer owns anything_ — cannot append into the log its
successor now owns. It stops at its first refused write with a `FencedError`, and the store is
unchanged by it.

Fencing is opt-in and the API relies on that: `POST …/events` appends without a fence, because
the request has no lease and the event has to be durable regardless. The signal that follows is
how the owner hears about it.

## What an instance does

```
start()
  refresh: renew · give up what is surplus · take what is free
  then:    heartbeat every OPENHARNESS_HEARTBEAT_MS
           sweep     every OPENHARNESS_SWEEP_MS

acquiring partition p
  1. store.onPartitionSignal(p, …)          subscribe, so nothing from now on is missed
  2. store.findSessionsNeedingWork([p])     what was already waiting, signals or not
  3. queue those sessions; every turn runs under fence {p, epoch}

heartbeat
  renew every held lease        → a refusal means the lease is gone: drop it at once
  give up the surplus           → finish the turns in it first, then release
  scan for free/expired leases  → take them, never a live one; recover each as above

signal(sessionId, kind)
  store.signalPartition(partitionOf(sessionId), { sessionId, kind })
```

The subscribe-before-recover order in step 1 and 2 is the point of the whole design. Signals
are hints with no durability: one that arrives between the acquire and the subscription is gone
forever. So listening starts first, and whatever was in the log before that is found by the
scan — which is also exactly how a partition whose owner died is recovered. A `FencedError` out
of a turn means the same thing as a refused renewal, arriving the other way round: the lease is
not this instance's any more, so the partition is dropped, its turns are aborted, its
subscription is ended, and nothing more is started for it.

## Balancing

With no way to list the other instances — the lease table is only reachable one partition at a
time — balancing is inferred from lease _outcomes_:

- **A scan takes what is free, and never steals.** A live lease somebody else holds is left
  alone and counted: it is the only evidence this instance has that the other instance exists.
  `blocked` (live leases held elsewhere) over `held` (this instance's own) is how many peers it
  estimates, and `share = ceil(partitions / (1 + peers))` is what it holds.
- **The first scan of a fresh instance stops at half the space.** That is what lets two
  instances that boot together each end up with a set of partitions instead of whichever one
  won the race taking all of them. Every later scan takes everything free, because a partition
  nobody owns is a session nobody runs.
- **An instance over its share gives the surplus up**, newest tenure first: the turns running
  in those partitions are allowed to finish writing (up to the drain timeout) and only then is
  the lease released, so the peer that takes them over inherits closed turns. Released
  partitions are left alone by this instance for a heartbeat, so the peer gets the chance to
  take them instead of watching them bounce back.
- **The estimate is not sticky.** When a peer dies its leases expire, the survivor takes them,
  `blocked` falls back to zero and its share grows back to the whole space — rather than half of
  it being left unowned because the survivor still remembered a peer that is gone.

What this cannot do is _discover_ a peer that holds nothing: an instance that joins a space
that is already fully held live stays idle until a lease is released or expires. Leases are
released on shutdown and expire on a crash, so that is a property of when work becomes
available, not a dead end — and it is the price of never taking a lease away from a live owner.

## Signals

`signal()` is routed through the store, never handled locally:

```ts
store.signalPartition(partitionOf(sessionId, partitions), { sessionId, kind })
```

The store announces on the partition's channel (`LISTEN`/`NOTIFY`), so every instance listening
for that partition hears it — including the owner in another process, and including the
instance that raised it. On the owner's side, `onPartitionSignal` answers a `work` by waking the
session's pass (or starting one), and an `interrupt` by aborting the turn in flight — or, when
nothing is running, by starting a turn anyway, because a queued `user.interrupt` still has to
be claimed by a brain.

A signal nobody is listening for is dropped. That is allowed, and it is why nothing depends on
one arriving: every partition is scanned when it is acquired, and the slow sweep re-scans the
partitions this instance holds for work that no signal mentioned. Both paths end in the same
place — `findSessionsNeedingWork` — which is derived from the log alone, so a partition that
has just changed hands gets the same answer as one that has been running all along.

## Shutdown and crashes

`stop()` stops the timers, drains the turns in flight (they are aborted, so a brain cuts its
model request short and writes the partial reply, the closed span and `session.status_idle`
before it stops), and then **releases every lease it still holds**. The next instance takes the
partitions over at its next heartbeat rather than waiting out the TTL.

A crash is the other half of that: nothing is released, so the partitions sit until
`OPENHARNESS_LEASE_TTL_MS` passes and the survivors' scans find them expired and take them.
What they find in the log is the turn the dead instance had opened — `getTurnState` says
`running` or `unfinished` — so the new owner closes the orphaned span with `brain_lost` and runs
the turn again. Nothing is lost, because nothing was ever held in memory.

## Configuration

| variable                   | default                        | what it does                                     |
| -------------------------- | ------------------------------ | ------------------------------------------------ |
| `SCHEDULER`                | `local`                        | `local`, or `postgres` for partition leases      |
| `DATABASE_URL`             | —                              | required by `SCHEDULER=postgres`                 |
| `OPENHARNESS_INSTANCE_ID`  | hostname + pid + random suffix | this instance's id in the lease table            |
| `OPENHARNESS_PARTITIONS`   | `64` (the protocol's)          | how many partitions the session space has        |
| `OPENHARNESS_LEASE_TTL_MS` | `30000`                        | how long a lease lasts before it must be renewed |
| `OPENHARNESS_HEARTBEAT_MS` | `10000`                        | how often leases are renewed and free ones taken |
| `OPENHARNESS_SWEEP_MS`     | `60000`                        | how often owned partitions are re-scanned        |

The instance id has to be unique among the instances sharing a database: two live instances
leasing under one id would fence each other's writes.

`SCHEDULER=postgres` without a `DATABASE_URL` fails the boot, because partition leases are a
table and the in-memory store has no database to put them in. A heartbeat at or above the TTL
fails it too: that is a lease that lapses between two renewals, which is a partition handing
itself over every cycle rather than a configuration.

Two instances sharing a database is all it takes to run the partitioned scheduler — nothing
else coordinates them:

```bash
SCHEDULER=postgres DATABASE_URL=postgres://localhost/openharness PORT=3000 \
OPENHARNESS_INSTANCE_ID=server-a node dist/index.js
SCHEDULER=postgres DATABASE_URL=postgres://localhost/openharness PORT=3001 \
OPENHARNESS_INSTANCE_ID=server-b node dist/index.js
```

## Tests

`src/partition-scheduler.test.ts` runs several schedulers in one process, each with its own
store (its own `LISTEN` connection) on a shared pool, against real Postgres: `DATABASE_URL` when
it is set, otherwise a container, otherwise the suite is skipped with a note. The leases are
short (a few hundred milliseconds) and the heartbeats a tenth of that, so a takeover happens
inside a test; every wait is a `waitFor` with a bounded timeout rather than a fixed sleep.

| test                                              | what it pins down                                           |
| ------------------------------------------------- | ----------------------------------------------------------- |
| spread over instances that boot together          | half each, no overlap, and nothing changes hands afterwards |
| a live lease cannot be taken, a released one can  | the starved instance waits; the lease holder may give up    |
| leases handed back on shutdown                    | takeover well inside a 30-second TTL                        |
| one turn, in the instance that owns the session   | routed signal, one model request, one reply                 |
| every write fenced with the lease the owner holds | `{partition, epoch}` on every append and claim              |
| recovery on acquire, with the signal dropped      | the signal is not the record; the log is                    |
| the sweep finds work no signal mentioned          | the safety net, with the heartbeat slowed down              |
| died mid-turn → taken over → turn finished        | `brain_lost`, re-run, correct order, every span closed      |
| the zombie that wakes up cannot write             | a `FencedError`, nothing stored, the process still alive    |
| a lease that cannot be renewed is dropped         | the turn is aborted and the partition stops being this work |
| interrupts routed across instances                | partial reply, closed span, idle, nothing left queued       |
