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

Beside it, `scheduler_instances` holds one row per live instance — `instance_id` and the
`last_seen` of its last heartbeat, both of which the balancing below is computed from. It is
bookkeeping like the lease table, not part of the log.

`acquirePartition` is a single conditional upsert: it matches an unleased row, the same owner,
or an expired lease, and **never a live lease somebody else holds**. Every successful acquire
opens a new tenure, so the epoch never repeats.

**A lapse is stealable, not lost.** `expires_at` is what lets _another_ instance take the
partition over — the acquire above — and not what takes it away from the instance that holds
it. `renewPartition` therefore extends a lease whose row still names this owner at this epoch
whether or not it has lapsed, and a refusal means one thing only: somebody else has the
partition now. Nothing can be written while a lease is lapsed, because a fenced write needs a
live lease at its epoch, so an instance that comes back before anybody takes the partition over
has lost nothing. This is what keeps one long heartbeat cycle — a stalled process, a slow round
trip, a runner under load — from costing an instance every partition it holds: with the refusal
read as "the lease is gone", a cycle that ran past the TTL would drop all of them, abort the
turns in them and re-acquire them at a new epoch, for no reason, since no peer ever wanted them.
Only a genuine takeover moves the owner and the epoch out from under the renewal.

That epoch is what makes a write safe. `runTurn` passes `fence: { partition, epoch }` to every
`appendEvents` it makes — since D9 an append is the only write a turn makes, the claim included
— and the store accepts the write only while that partition's lease is live at that epoch. So a
brain whose lease has been taken over — a
_process that is still running but no longer owns anything_ — cannot append into the log its
successor now owns. It stops at its first refused write with a `FencedError`, and the store is
unchanged by it.

Fencing is opt-in and the API relies on that: `POST …/events` appends without a fence, because
the request has no lease and the event has to be durable regardless. The signal that follows is
how the owner hears about it.

## What an instance does

```
start()
  refresh: announce · renew · give up what is surplus · take what is free
  then:    heartbeat every OPENHARNESS_HEARTBEAT_MS
           sweep     every OPENHARNESS_SWEEP_MS

acquiring partition p
  1. store.onPartitionSignal(p, …)          subscribe, so nothing from now on is missed
  2. store.findSessionsNeedingWork([p])     what was already waiting, signals or not
  3. queue those sessions; every turn runs under fence {p, epoch}

heartbeat
  announce this instance        → upsert scheduler_instances, read the live members
  renew every held lease        → a refusal means the lease is somebody else's: drop it at once
  give up the surplus           → finish the turns in it first, then release
  scan for free/expired leases  → take them up to the share, never a live one;
                                  recover each as above

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

Membership is explicit (issue #122): every instance upserts its row in `scheduler_instances`
on every heartbeat and deletes it on `stop()`, so a live member is an id seen within one lease
TTL, and **each instance's fair share is `ceil(partitions / live members)`**. The balancing
follows from that share:

- **A scan takes what is free, and never steals**, up to the share. A live lease somebody else
  holds is left alone — a lease is never taken away from a live owner. The walk stops once the
  instance holds its share, because a partition taken beyond it would only be given back a
  heartbeat later: with the members known, the space divides once instead of being claimed
  whole and rebalanced. (An instance whose first read of the membership raced its peers' —
  it booted a moment before them — may claim more first; its next heartbeat counts the truth
  and gives the surplus back.)
- **An instance over its share gives the surplus up**, newest tenure first: the turns running
  in those partitions are allowed to finish writing (up to the drain timeout) and only then is
  the lease released, so the peer that takes them over inherits closed turns. Released
  partitions are left alone by this instance for a heartbeat, so the peer gets the chance to
  take them instead of watching them bounce back.
- **The membership ages out with the leases.** Both windows are one lease TTL: a crash stops
  the heartbeats, so the row is out of every peer's count at the instant the dead instance's
  leases stop being renewed and start being stealable — the survivors' shares grow back to the
  whole space and their scans take over what it held. A graceful `stop()` deletes the row, so
  it stops being counted at once, and the partitions it releases come back at the survivors'
  next heartbeat.
- **Nothing is ever released while its owner is alone.** There is no periodic offer and no
  idle release: an instance whose membership is only itself has the whole space as its share,
  and keeps it. The offer existed because the old balancing inferred peers from _failed
  acquires_ — a peer that held nothing produced none, so it was invisible, and the winner had
  to let half the space go on a timer to give it a door in. Explicit membership sees that
  newcomer the moment it starts — it heartbeats like everyone else — so the share mechanism
  hands it its half instead: an instance that boots into a fully-held space gets its share
  from the holder's next release, however its first scan raced.

What membership buys is that the stand-off is gone in both directions: a newcomer **is**
discovered while the holder is busy (its row is in the count), and an instance that really is
alone keeps everything it holds — nothing is released, so no session loses its owner even for
a heartbeat. A live lease is still never taken, and the fencing above is unchanged.

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
before it stops), **deletes its membership row** — peers stop counting the instance at once, so
their shares grow immediately — and then **releases every lease it still holds**. The next
instance takes the partitions over at its next heartbeat rather than waiting out the TTL. An
acquire that was already in flight when the stop began is included: it cannot be cancelled, so
the scan that holds it releases it the moment it sees the instance stopped — a stopping
instance never leaves a live lease behind.

A crash is the other half of that: nothing is released and nothing keeps the membership row
fresh, so both age out together — after `OPENHARNESS_LEASE_TTL_MS` the row is out of every
peer's count at the instant the leases lapse, and the survivors' scans find the partitions
expired and take them. What they find in the log is the turn the dead instance had opened —
`getTurnState` says `running` or `unfinished` — so the new owner closes the orphaned span with
`brain_lost` and runs the turn again. Nothing is lost, because nothing was ever held in
memory.

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
Short leases are also safe to assert on: a lapse nobody takes over is renewable, so a runner
that stalls a cycle past the TTL cannot make a healthy instance look dead.

| test                                              | what it pins down                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| spread over instances that boot together          | half each, no overlap, and nothing changes hands afterwards                                              |
| a first scan that loses the race                  | the membership gives the loser its share (it takes, or the winner releases)                              |
| three instances boot together                     | each at most `ceil(8/3)`, together the whole space, then stable                                          |
| an idle instance that is alone                    | no release over five TTLs: the held set and every epoch stay put, a lease that lapsed untouched included |
| a cycle that outlives the lease                   | the lapse is renewed, not lost: same held set, same epochs, no "lost partition"                          |
| a member that stops heartbeating                  | dropped after about a TTL, its share taken over                                                          |
| a stop, then a restart                            | the membership row goes with the stop; the restart re-joins and re-takes                                 |
| a live lease cannot be taken, a released one can  | no renewal ever fails, no overlap, a released one moves                                                  |
| a stop racing an acquire                          | the lease it was taking is released, not left to the TTL                                                 |
| leases handed back on shutdown                    | takeover well inside a 30-second TTL                                                                     |
| one turn, in the instance that owns the session   | routed signal, one model request, one reply                                                              |
| every write fenced with the lease the owner holds | `{partition, epoch}` on every append and claim                                                           |
| recovery on acquire, with the signal dropped      | the signal is not the record; the log is                                                                 |
| the sweep finds work no signal mentioned          | the safety net, with the heartbeat slowed down                                                           |
| died mid-turn → taken over → turn finished        | `brain_lost`, re-run, correct order, every span closed                                                   |
| the zombie that wakes up cannot write             | a `FencedError`, nothing stored, the process still alive                                                 |
| a lease that cannot be renewed is dropped         | the turn is aborted and the partition stops being this work                                              |
| interrupts routed across instances                | partial reply, closed span, idle, nothing left queued                                                    |
