-- 0032_session_tree.sql — the session tree, and whether a person is on the other end
-- (epic #340, S1/S3; issue #341).
--
-- A subagent is a real session that belongs to another one: the brain, the scheduler,
-- compaction, usage, replay, SSE and crash recovery work on it unchanged, and what makes it a
-- child is four columns here. `interactive` is the other half of the same decision — set at
-- creation, never changed, and the reason a child's model never gets `ask_user` and never
-- pauses on an `ask` policy (S1).
--
--   parent_session_id  the session this one belongs to, or NULL for a top-level chat
--   parent_task_id     the task_ id the parent's `session.task_started` carries (#343), or NULL
--   root_session_id    the top-level chat the whole tree hangs off — a session's OWN id when it
--                      is that chat — so "the live descendants of a root" is one indexed query
--   depth              0 for a top-level chat, one more than the parent's for a child
--
-- **Every existing row is a top-level interactive chat**, which is not a guess: sessions had
-- no parent before this, and every session was as interactive as its client made it (nothing
-- asked). So `interactive` takes a real column default (`true`, the rule `0019` uses: a write
-- always supplies it, so an absent value would be a bug rather than a legitimate older shape)
-- and `root_session_id` is backfilled to the row's own `id`, which is exactly what a top-level
-- chat's root is. `parent_session_id` and `parent_task_id` stay NULL and `depth` takes `0`.
--
-- The backfill is `where root_session_id is null`, so a re-run of the file leaves every row —
-- including a child a later version created — exactly as it is.
--
-- **No foreign key on `parent_session_id`.** One would have to choose between cascade (which
-- would delete a child behind `deleteSession`'s back, outside the owner check and without
-- ending its subscribers' streams) and restrict (which would make deleting a parent fail).
-- Neither is the rule: `deleteSession` removes a session **and its descendants** itself, in
-- one transaction, announcing each one's `session.deleted` — see `SessionStore.deleteSession`.
--
-- Both indexes are partial: only children are ever looked up by parent, and only a root's
-- descendants by root, so a top-level chat (the common case) carries no index entry at all.
--
-- **Migration number.** 0032 follows `0031_mcp_tool_policies.sql`. Every file runs on every
-- `migrate()` in name order, so the numbers have to be unique and ordered.

alter table sessions add column if not exists interactive boolean not null default true;

alter table sessions
  add column if not exists parent_session_id text collate "C";

alter table sessions add column if not exists parent_task_id text collate "C";

alter table sessions add column if not exists root_session_id text collate "C";

alter table sessions add column if not exists depth integer not null default 0;

update sessions set root_session_id = id where root_session_id is null;

alter table sessions alter column root_session_id set not null;

create index if not exists sessions_parent_idx
  on sessions (parent_session_id)
  where parent_session_id is not null;

create index if not exists sessions_root_idx
  on sessions (root_session_id)
  where depth > 0;
