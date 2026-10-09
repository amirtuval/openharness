-- 0012_ownership.sql — delete the v1 data, then make every agent and session owned
-- (epic #65, decision A4).
--
-- Until this wave nothing belonged to anybody: an agent or a session was whoever could reach
-- the server. From here on both carry `owner_id`, the `user.id` Better Auth minted for the
-- person who created them, and every user-facing read is scoped to it — another user's
-- resource is answered 404, never 403, so it does not even leak that it exists.
--
-- v1 is unreleased, so there is nothing to backfill: the data is deleted rather than given an
-- owner that would be a lie. The one-shot delete is guarded by the absence of the column it
-- introduces, because this package's migrator re-runs **every** file on every `migrate()`
-- call: without the guard, a server boot months from now would wipe every log in the
-- database. The guard, the deletes and the `alter`s are one transaction (the whole migration
-- run is), so two instances starting together cannot interleave them.
--
-- The order of the deletes follows the references: `events` points at `sessions`, and both
-- `event_claims` and `event_supersessions` are facts about events (no foreign keys, on
-- purpose — see `0007_event_claims.sql`), so they go with them.

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = current_schema()
       and table_name = 'agents'
       and column_name = 'owner_id'
  ) then
    delete from events;
    delete from event_claims;
    delete from event_supersessions;
    delete from sessions;
    delete from agents;
  end if;
end
$$;

-- `not null` without a default is safe here for the same reason the delete is: the only way
-- to reach this statement with rows in the table is a database where the column already
-- exists, and then `if not exists` skips it. `on delete cascade` is what makes deleting a
-- user (a later admin action) take their agents and sessions with it; the referenced id is
-- Better Auth's opaque text, so the column carries no `collate "C"` — it is not one of ours
-- and nothing orders by it.
alter table agents
  add column if not exists owner_id text not null references "user" (id) on delete cascade;

alter table sessions
  add column if not exists owner_id text not null references "user" (id) on delete cascade;

-- Listing the owner's agents, oldest first: `listAgents({ ownerId })`, ordered by
-- `(created_at, id)` like the unscoped list, narrowed by the owner that comes first in the
-- index.
create index if not exists agents_owner_created_idx on agents (owner_id, created_at, id);

-- Listing the owner's sessions, newest first: `listSessions({ ownerId })` reads this index
-- backwards, the same way the unscoped list reads `sessions_created_idx`, and the
-- `agent_id` filter narrows inside it.
create index if not exists sessions_owner_created_idx on sessions (owner_id, created_at, id);
