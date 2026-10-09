-- 0008_event_claims_backfill.sql — one-time: carry the pre-D9 `processed_at` values over.
--
-- Sessions written before D9 recorded their claims as `events.processed_at` on the user event
-- itself. From D9 on that column is not read for a user event: the claim is what a reader
-- derives `processed_at` from. This statement copies every already-claimed user event's
-- `processed_at` into a claim row, so a log written before the change reads exactly as it did
-- — claimed events stay claimed, and the pending ones stay pending.
--
-- It runs after `0007_event_claims.sql` created the table, and it is idempotent: a second run
-- finds every id already claimed and `on conflict do nothing` skips it. The old column value is
-- deliberately left in place rather than cleared: the claim is authoritative from here on, and
-- leaving the column alone keeps a rollback to the previous version working.

insert into event_claims (session_id, event_id, claimed_by_event_id, claimed_at)
select e.session_id, e.id, null, e.processed_at
  from events e
 where e.type in ('user.message', 'user.interrupt')
   and e.processed_at is not null
on conflict (event_id) do nothing;
