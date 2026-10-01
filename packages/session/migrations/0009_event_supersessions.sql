-- 0009_event_supersessions.sql — `event_supersessions`: the chunk ranges later events replace.
--
-- Since D9 a streamed reply is stored twice over: as the `event_start`/`event_delta` chunks it
-- arrived in, and as the finished `agent.message` — or, for a request that ended without one
-- (an interrupt, a lost brain, a reply that streamed no text), the `span.model_request_end` —
-- which carries `supersedes: { from_seq, to_seq }` over the chunks it replaces. A row here is
-- that range as recorded, by the same append that wrote the superseding event.
--
-- It is insert-only: never updated, never deleted. Replay skips what a range covers, and the
-- store's `compact()` deletes those chunks once they are older than the retention window — so
-- the rows outlive the events they name, which is what keeps a compacted log reading the same
-- as one that has not been compacted yet.
--
-- `by_seq` is the superseding event's own `seq`; the constraint `by_seq > to_seq` is what
-- "the range lies before the superseding event" means in the schema. `by_event_id` is the
-- primary key: one event carries one range.
--
-- No foreign keys, for the same reason `0007_event_claims.sql` states at length: the log's
-- tables are truncated wholesale, and a reference would make a bare `truncate events` fail.

create table if not exists event_supersessions (
  session_id text collate "C" not null,
  -- The first replaced `seq` — the reply's `event_start` — and the last: its final delta.
  from_seq integer not null check (from_seq > 0),
  to_seq integer not null check (to_seq >= from_seq),
  by_event_id text collate "C" primary key,
  by_seq integer not null check (by_seq > 0),
  created_at timestamptz not null,
  -- The range always ends before the event that replaces it.
  check (by_seq > to_seq)
);

-- One session's ranges, seekable by the seqs that fall in them: the `not exists` behind
-- replay's skip, and the join behind compaction's delete.
create index if not exists event_supersessions_session_seq_idx
  on event_supersessions (session_id, from_seq, to_seq);
