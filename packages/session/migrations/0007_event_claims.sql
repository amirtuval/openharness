-- 0007_event_claims.sql — `event_claims`: the claim on a user event, as its own fact (D9, #46).
--
-- Before D9 a claim was an edit: `markProcessed` wrote `events.processed_at`, and a client that
-- already held the event never learned it had changed. Now the claim is a row of its own, and
-- it is insert-only — nothing here is ever updated and nothing is ever deleted. The primary key
-- on `event_id` is what makes claiming a claim: two writers racing for the same event both
-- insert, one commits and the other's `on conflict do nothing` writes nothing, exactly as the
-- old conditional write decided, with the same fencing around it.
--
-- `claimed_by_event_id` is the `span.model_request_start` that made the claim when an append
-- carried `consumes` (the D9 shape, from phase P3 on the only writer), and `null` for a claim
-- `markProcessed` recorded for the writers that have not moved yet.
--
-- `claimed_at` is the injected clock's instant at the claim, and is what a reader sees as the
-- event's `processed_at`: both stores derive it on every read — list, pending, subscription
-- payloads — so the events table is never written to for a user event again. The
-- `events.processed_at` column keeps its pre-D9 values (0008 copies them here) and is dropped
-- in phase P4.
--
-- No foreign keys, on purpose. These are facts about events, not a second copy of the log, and
-- the log's tables are truncated wholesale — every test harness that empties `events` for the
-- next test does it in one statement (this package's own tests and `apps/server`'s both do),
-- and Postgres refuses to truncate a table a foreign key points at. The store is the only
-- writer and every read joins back to `events`, so a row here whose event is gone is an orphan
-- a truncation left behind: it matches nothing and no reader sees it. The uniqueness the
-- contract needs is the primary key, and that needs no reference.

create table if not exists event_claims (
  session_id text collate "C" not null,
  -- An event id is unique across the whole table (0005), and an event is claimed at most once.
  event_id text collate "C" primary key,
  claimed_by_event_id text collate "C",
  claimed_at timestamptz not null
);

-- One session's claims, in claim order: the join behind `listEvents`, the anti-join behind
-- "pending", and the read `markProcessed` answers with.
create index if not exists event_claims_session_idx on event_claims (session_id, claimed_at);
