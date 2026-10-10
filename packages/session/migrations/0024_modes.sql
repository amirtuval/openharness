-- 0024_modes.sql — per-user *modes* and the mode a session follows (epic #245, A4b; decision
-- M6).
--
-- A mode is a user's own named preset — a model, a reasoning effort and a system-prompt
-- addition behind a stable name such as `smart` — that a chat can run instead of a raw
-- `provider/model`. It is a per-user resource like `provider_credentials` and
-- `user_preferences`: `owner_id` is a foreign key into Better Auth's `"user"` with
-- `on delete cascade`, so a mode goes when its owner does, and a name is unique among a
-- user's own modes — the constraint is what makes "names are unique per user" true under two
-- concurrent creates rather than only in the server's check. The number of modes a user may
-- hold is a server rule (`MAX_MODES_PER_USER`); it has no constraint here, like every other
-- bound this package leaves to the caller.
--
-- `id` is a `mode_` ULID — this package's, like `agent_`/`sesn_`/`sevt_`/`pcred_` — so it
-- carries the `C` collation every openharness id column does, which is what makes the SQL
-- order the byte order the in-memory store compares with. `name` is `C` too, so the unique
-- constraint is exact-byte equality and the list order is deterministic. `model` holds either
-- a `provider/model` id or the sentinel `my-default-model`, exactly as the protocol's
-- `ModeModelSchema` spells them; `reasoning_effort` is one of the three effort names or NULL
-- for the provider default, and `system_prompt_addition` is NULL for none. Nothing here
-- validates a model id or a name's length: the protocol schemas do, on the wire, and this
-- package stores what it is given.
--
-- `sessions.mode` is the mode a chat follows, or NULL for a chat without one, and deliberately
-- **The cap is a count then an insert.** The store takes a per-owner `pg_advisory_xact_lock`
-- inside the creating transaction before it counts, so two concurrent creates racing for the
-- last of MAX_MODES_PER_USER slots cannot both read a count below it and both insert. The lock
-- is keyed by the owner, so two users' creates never wait on each other.
--
-- carries **no foreign key**: deleting a mode must not delete a session that ran it, and the
-- store nulls the column itself, in the same transaction as the mode's deletion, so a chat
-- keeps running on the model it last ran (`sessions.model`). It is `C`-collated like the other
-- id columns, and a session created before this migration simply has NULL — there is nothing
-- to backfill, because modes did not exist.
--
-- **Migration number.** 0024 is the next free number on this branch's base (epic #245, branch
-- `a3d-vertex`, whose own tip already carries `0022_credential_name.sql` and
-- `0023_credential_details.sql` from the credential steps of the same stack). Every file runs
-- on every `migrate()` in name order, so the numbers have to be unique and ordered.

create table if not exists modes (
  id text collate "C" primary key,
  owner_id text not null references "user" (id) on delete cascade,
  name text collate "C" not null,
  model text not null,
  reasoning_effort text,
  system_prompt_addition text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  -- A name is unique per user; this is what makes it so under concurrent creates.
  constraint modes_owner_name_key unique (owner_id, name),
  constraint modes_reasoning_effort_check
    check (reasoning_effort in ('low', 'medium', 'high') or reasoning_effort is null)
);

-- `listModes()`: one owner's modes, oldest first, ordered by `(created_at, id)`.
create index if not exists modes_owner_created_idx on modes (owner_id, created_at, id);

-- The mode a chat follows. No foreign key into `modes`: deleting a mode must not delete the
-- session that ran it, and the store nulls the column itself in the same transaction.
alter table sessions add column if not exists mode text collate "C";

-- `deleteMode()` nulls the column for every session that followed the mode, so it needs an
-- index to make that a lookup rather than a scan of every session.
create index if not exists sessions_mode_idx on sessions (mode) where mode is not null;
