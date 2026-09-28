-- 0002_sessions.sql — `sessions`: the header of a session's log.
--
-- The agent block is denormalized on purpose: a session snapshots the agent's
-- `{ id, name, model, system }` at creation time, so editing the agent afterwards never
-- rewrites what an existing session ran with (see `SessionAgent` in the protocol).

create table if not exists sessions (
  id text collate "C" primary key,
  -- Mirrors the last `session.status_*` event in the log; kept in the same transaction.
  status text not null check (status in ('idle', 'running')),
  -- `partitionOf(sessionId)`: the partition whose lease gates writes to this session.
  partition integer not null,
  title text,
  metadata jsonb not null default '{}'::jsonb,
  -- The agent snapshot, frozen at creation time.
  agent_id text collate "C" not null references agents (id),
  agent_name text not null,
  agent_model_id text not null,
  agent_system text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

-- `listSessions()`: newest first, ordered by `(created_at, id)` descending. Postgres reads
-- this index backwards for the descending order.
create index if not exists sessions_created_idx on sessions (created_at, id);

-- `listSessions({ agentId })`: the same order, narrowed to one agent.
create index if not exists sessions_agent_created_idx on sessions (agent_id, created_at, id);

-- `findSessionsNeedingWork()`: one partition's sessions, oldest first. Partition is stored
-- rather than recomputed so the lookup is an index range scan, not a full table scan.
create index if not exists sessions_partition_created_idx
  on sessions (partition, created_at, id);
