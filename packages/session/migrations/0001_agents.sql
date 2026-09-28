-- 0001_agents.sql — `agents`: reusable agent configurations.
--
-- Every timestamp column in this schema is `timestamptz`, and every value the store writes
-- into one comes from the store's injected clock rather than the database's `now()`. That is
-- what lets the conformance suite move time forward and watch leases, `processed_at` and
-- `updated_at` follow.
--
-- `id` columns carry the `C` collation: a `agent_`/`sesn_`/`sevt_` id is ASCII, and byte order
-- is the order the store's keyset cursors compare in, so SQL and JavaScript agree on the
-- `(created_at, id)` total order the lists are paged by.

create table if not exists agents (
  id text collate "C" primary key,
  name text not null,
  description text,
  model_id text not null,
  system text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- `listAgents()`: oldest first, ordered by `(created_at, id)`.
create index if not exists agents_created_idx on agents (created_at, id);
