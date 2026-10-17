-- 0036_skills.sql — a user's imported skills, and the files of each snapshot
-- (epic #349, issue #350; decisions K1, K4).
--
-- A skill is a folder of instructions in the open Agent Skills format (K1) that a user
-- imported from a public git repository and reviewed (K3), stored whole as a **snapshot**: the
-- parsed `SKILL.md`, the source it came from, and every file of the folder. Nothing is read
-- from git after the import (K3), so these two tables are the skill — a refresh replaces them
-- (K5), and a chat that loaded a skill already has its content in its own log.
--
-- `skills` is one row per skill. `owner_id` is a foreign key into Better Auth's `"user"` with
-- `on delete cascade`, so a user's skills go when the user does, and `(owner_id, name)` is
-- unique: a skill's name is what it is run by (K7) and unique among a user's own skills, so the
-- constraint is what makes "names are unique per user" true under two concurrent imports rather
-- than only in the server's check. The number of skills a user may hold is a store rule
-- (`MAX_SKILLS_PER_USER`) — it has no constraint here, like every other bound this package
-- leaves to the caller. `imported_at` and `refreshed_at` are the snapshot's two instants; there
-- is no `created_at`/`updated_at` pair, because those two are exactly what a skill has.
--
-- `frontmatter` holds whatever else the `SKILL.md`'s frontmatter carried (K1) — `license`,
-- `metadata`, `compatibility`, `allowed-tools`, and the honoured `disable-model-invocation` /
-- `user-invocable` / `argument-hint` — as one `jsonb` value. A shape this package does not
-- model: the format allows any field, so a column per field would be a migration per field, and
-- a skill written for another harness must import unchanged.
--
-- `skill_files` is the snapshot's files: one row per file, keyed by `(skill_id, path)`, which is
-- both what makes a path appear once and the index `getFile` seeks by. The content is text —
-- a model reads a skill's files, and one that is not text is stored as the text it was read as
-- (K2) — and `size` is its byte length, computed by the store so it can never disagree with what
-- is stored. `on delete cascade` means a deleted skill takes its whole snapshot, which is the
-- whole of "delete a skill". The contents live in their own table rather than beside the skill
-- because a listing must never read one (K4), and because they are what moves to object storage
-- later without anything above the store noticing — which is why `list` and `get` do not select
-- `content` at all.
--
-- **Migration number.** 0032 follows `0031_mcp_tool_policies.sql`. Every file runs on every
-- `migrate()` in name order, so the numbers have to be unique and ordered.

create table if not exists skills (
  id text collate "C" primary key,
  owner_id text not null references "user" (id) on delete cascade,
  name text collate "C" not null,
  description text not null,
  frontmatter jsonb not null default '{}'::jsonb,
  source_url text not null,
  source_ref text,
  source_path text,
  commit_sha text,
  enabled boolean not null,
  imported_at timestamptz not null,
  refreshed_at timestamptz not null,
  -- A name is unique per user; this is what makes it so under concurrent imports.
  constraint skills_owner_name_key unique (owner_id, name)
);

-- `list()`: one owner's skills, oldest first, ordered by `(imported_at, id)`.
create index if not exists skills_owner_imported_idx
  on skills (owner_id, imported_at, id);

create table if not exists skill_files (
  skill_id text collate "C" not null references skills (id) on delete cascade,
  path text collate "C" not null,
  content text not null,
  size integer not null,
  -- A path appears once in a snapshot, and a read by `(skill, path)` is a lookup.
  primary key (skill_id, path)
);
