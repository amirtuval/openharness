-- 0003_events.sql — `events`: the append-only log itself.
--
-- One row per stored event. `payload` holds the event body — everything the caller sent —
-- and `type` is the same value projected into a column so that filtering, the pending-user
-- partial index and integrity checks do not have to read the JSON. `id` and `seq` are the
-- store's, assigned inside the append transaction; `created_at` is when the store wrote the
-- row, which the protocol deliberately does not expose.
--
-- `processed_at` is null exactly while a user event is queued; every event the server
-- produces is written with it already set.

create table if not exists events (
  id text collate "C" primary key,
  session_id text collate "C" not null references sessions (id) on delete cascade,
  seq integer not null check (seq > 0),
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  processed_at timestamptz,
  -- The log's ordering key. Appends take the session row lock first, so `seq` is assigned
  -- gap-free and in commit order.
  constraint events_session_seq_key unique (session_id, seq)
);

-- Reading a session's log, and the `max(seq)` an append starts from. The unique constraint
-- above already provides this access path; the index is spelled out because the schema
-- documents it as part of the contract for readers, and the planner may pick either.
create index if not exists events_session_seq_idx on events (session_id, seq);

-- `getPendingUserEvents()`, `markProcessed()` and the pending half of
-- `findSessionsNeedingWork()`: the queued user events of one session, in `seq` order. Only
-- user events are ever stored unprocessed, so the predicate is exactly "queued".
create index if not exists events_pending_user_idx
  on events (session_id, seq)
  where processed_at is null and type in ('user.message', 'user.interrupt');
