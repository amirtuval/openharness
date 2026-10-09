-- 0017_scheduler_instances.sql — `scheduler_instances`: the live members of the partition
-- scheduler (issue #122).
--
-- One row per running scheduler instance, written by the instance itself: `heartbeatInstance`
-- upserts it on every heartbeat, and `removeInstance` deletes it on `stop()`. A membership is
-- *live* while `last_seen` is within one lease TTL of now — the same window after which the
-- instance's partition leases stop being renewals and start being stealable — so a process
-- that dies stops being counted exactly when the partitions it held become takeable, and one
-- that stops gracefully is gone at once. `listLiveInstances(withinMs)` is that read.
--
-- The table is bookkeeping beside the log, like `partition_leases`, not part of it: losing a
-- row costs nothing durable — the instance announces itself again on its next heartbeat — and
-- the only reader is the scheduler's share computation (`ceil(partitions / live members)`).
-- `last_seen` is written from the injected clock, never `now()`, so the conformance suite can
-- move time through a membership's lifetime.
--
-- `instance_id` is the same id `partition_leases.owner` carries (hostname + pid + random
-- suffix by default). It is ordered by (`listLiveInstances` answers in id order), so it
-- carries `collate "C"` like this package's other ordered id columns.

create table if not exists scheduler_instances (
  instance_id text collate "C" primary key,
  last_seen timestamptz not null
);
