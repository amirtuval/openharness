-- 0028_paused_confirmation_work.sql — the index behind the paused-confirmation work scan
-- (epic #303, X6; #309).
--
-- `findSessionsNeedingWork` now also returns a session whose last turn ended `requires_action`
-- and which holds a `user.tool_confirmation` naming one of the calls it waits on: the
-- confirmation is stored processed (the server writes it once the call is checked), so it is not
-- a queued user event and the session reads idle — no other part of the scan would find it. The
-- signal that would start the answering turn is a hint, and losing it strands the answer until
-- the next message, which is exactly the crash window this read closes.
--
-- The read narrows to one session and one event type, and the log's `(session_id, seq)` index
-- (0003) seeks a session's log by position rather than by type, so without this the confirmation
-- lookup would walk every event of the session. This one is **partial**, like `0021`'s and
-- `0026`'s: only `user.tool_confirmation` rows are ever read this way, so leaving every other
-- event type out keeps it a fraction of the log's size. Only the session is needed — the scan
-- asks "does this session have one?", not "which, and when".
--
-- Only ever read, never written back: this is an index on an append-only table, and `0007` and
-- `0009` state at length why nothing here is updated or deleted.
--
-- **Migration number.** This is the next free number after `0027_tool_settings.sql` — the tip of
-- the tools stack as it stands. Every file runs on every `migrate()` in name order, so the
-- numbers have to be unique and ordered; a later branch that adds one from the same base takes
-- the next free number, and a rebase is what settles it.

create index if not exists events_tool_confirmation_idx
  on events (session_id)
  where type = 'user.tool_confirmation';
