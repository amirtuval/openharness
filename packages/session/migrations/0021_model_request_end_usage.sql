-- 0021_model_request_end_usage.sql — the index behind `listModelRequests` (epic #245, A2;
-- issue #247).
--
-- The per-user usage report answers "what did this user spend between these two instants" from
-- the log: it pairs every `span.model_request_end` in a UTC window with the
-- `span.model_request_start` that names the request's model, scoped to the caller's own
-- sessions. Before this it walked the caller's sessions page by page and read each session's
-- span events a page at a time, which read every event of a month of heavy use on every
-- request.
--
-- `events` had no index a window over one session's request ends could use: `(session_id, seq)`
-- (0003) seeks a session's log by position, not by time, so the window filter would have had to
-- walk every event of every one of the caller's sessions. This one is the access path the read
-- needs — the session the query is already narrowed to, then the window — and it is **partial**
-- because only `span.model_request_end` rows are ever read this way: user events carry a NULL
-- `processed_at` (their time is the claim's), and the other span and status events are not part
-- of a usage report. Leaving them out keeps the index a fraction of the log's size.
--
-- Only ever read, never written back: this is an index on an append-only table, and `0007` and
-- `0009` state at length why nothing here is updated or deleted.
--
-- **Migration number.** This is the next free number on the epic #245 stack's base; the other
-- branches of the stack (`a0-provider-list`, `a1-context-budget`) add no migration of their own
-- today, so nothing has to be renumbered *yet* — but a branch that adds one from the same base
-- takes the next free number **at the tip of the stack** (a rebase is what settles it, since
-- every file runs on every `migrate()` in name order and the numbers have to be unique and
-- ordered).

create index if not exists events_model_request_end_idx
  on events (session_id, processed_at)
  where type = 'span.model_request_end';
