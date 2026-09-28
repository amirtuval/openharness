-- 0004_partition_leases.sql — `partition_leases`: one row per leased partition.
--
-- A partition's row is created by its first successful acquire. `epoch` starts at 0 — no row
-- means "never leased", and a fence can never match it, because an epoch has to have been
-- handed out by an acquire. Every acquire (same owner or not) and every release advances the
-- epoch, so a tenure never repeats and a write carrying a stale epoch is fenced out.
--
-- A row with `owner is null` is free: the lease was released, and the epoch is what keeps a
-- write from the released tenure out of the next one.

create table if not exists partition_leases (
  partition integer primary key,
  owner text,
  epoch integer not null default 0,
  expires_at timestamptz,
  -- An owned lease always has an expiry; a free one has neither owner nor expiry.
  constraint partition_leases_owner_expiry_check
    check ((owner is null) = (expires_at is null))
);
