-- 0016_user_preferences.sql — `user_preferences`: the settings a user keeps across sessions
-- (#111, epic #116 U1).
--
-- A preference is a choice about *new* sessions, not about one of them: `default_model` is
-- the `provider/model` router id a chat starts with when the user has not picked one for that
-- chat, or `null` — the column's null — when the user has no default. It is stored as given,
-- validated for shape by the protocol (`provider/model`) and never checked against a catalog
-- here; whether the model exists is the catalog's answer, not this table's.
--
-- One row per user, and the row is replaced whole: the store's `putPreferences` upserts it
-- (`on conflict (user_id) do update`), so a user's preferences are one value rather than a
-- log of edits, and `updated_at` — written from the injected clock, never `now()` — is when
-- that value last changed. `on delete cascade` from `"user"` takes a user's preferences with
-- the user, like their agents, sessions and credentials.
--
-- `user_id` is Better Auth's opaque id, the same text `owner_id` carries on `agents` and
-- `sessions`, so it takes no `collate "C"`: nothing orders by it. There is nothing to
-- backfill — a user with no row reads the protocol's default (`{ default_model: null }`),
-- which is what "no preference stored" means — so the file is one `if not exists` and
-- idempotent like every migration here (the runner re-runs every file on every `migrate()`
-- call).

create table if not exists user_preferences (
  user_id text primary key references "user" (id) on delete cascade,
  default_model text,
  updated_at timestamptz not null
);
