-- 0026_agent_tool_use_usage.sql — the index behind `listToolUses` (epic #303, #305).
--
-- A user's web searches are counted from the log: every `agent.tool_use` named `web_search`
-- that its `agent.tool_result` answered without an error, for one owner and one UTC window. The
-- per-user read is the same shape as the model-request one — the caller's sessions, then a
-- window of instants, then the day grouping in the caller's zone — and it needs the same access
-- path for the same reason: `(session_id, seq)` (0003) seeks a session's log by position, not
-- by time, so without this the window filter would walk every event of every one of the
-- caller's sessions.
--
-- The index is **partial**, like `0021`'s: only `agent.tool_use` rows are ever read this way.
-- What the call asked (`input`) is not in it, and does not need to be — the read selects the
-- name and the instant, and the window is the whole filter. The result a call is answered by is
-- joined on the `tool_use_id` the result's payload carries, which is an event id and so is
-- looked up through the primary key `events` already has.
--
-- Only ever read, never written back: this is an index on an append-only table, and `0007` and
-- `0009` state at length why nothing here is updated or deleted.
--
-- **Migration number.** This is the next free number on the tools epic's base
-- (`tools/x1-loop-304`): the sibling branches of the epic add their own files from the same base
-- (#311 takes 0026 too), and a rebase is what settles it — every file runs on every `migrate()`
-- in name order, so the numbers have to be unique and ordered.

create index if not exists events_agent_tool_use_idx
  on events (session_id, processed_at)
  where type = 'agent.tool_use';
