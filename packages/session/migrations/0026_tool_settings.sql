-- 0026_tool_settings.sql — the per-user *tool settings*, and the tool override a mode carries
-- (epic #303, X4; issue #307).
--
-- Two pieces of the same decision — which built-in tools a chat has, and what a call to one
-- may do — one per user and one per mode:
--
--   * `user_tool_settings` is a per-user row beside `user_preferences`: a `jsonb` map of tool
--     name to `{ enabled, policy }`, where `policy` is one of the protocol's
--     `allow | ask | deny`. A tool **absent** from the map follows its own declared default
--     (the permission its `ToolDefinition` carries), which is why the map is a record of
--     choices rather than a complete list and why a user who has never saved one needs no
--     row at all — the protocol's `{ builtin: {} }` is what an absent row reads as. `jsonb`
--     rather than a column per tool and rather than a row per tool: the tools a build
--     registers are the host's and move with it (the built-ins of #305, an MCP tool of #312),
--     and the shape the column holds is the protocol's `UserToolSettingsSchema` — the one
--     place it is written. Nothing here validates a tool name or a permission: the schemas do,
--     on the wire, and this package stores what it is given.
--
--   * `modes.tools` is a mode's override of which built-in tools are on (on and off, never a
--     permission), or NULL for a mode that says nothing about tools. It is deliberately
--     **not** a foreign key or a second table: a mode's override is one small value that lives
--     and dies with the mode, and the mode row is already replaced whole on every update.
--     **Every existing row takes NULL**, which is not a guess: modes had no tool override
--     before this, so a chat on one followed its owner's settings and still does.
--
-- `on delete cascade` from `"user"` takes a user's tool settings with the user, like their
-- preferences, their modes and their credentials. `user_id` is Better Auth's opaque id, so it
-- takes no `collate "C"`: nothing orders by it. Both statements are idempotent
-- (`create table if not exists`, `add column if not exists`), so the runner can re-run the
-- file — and the column is added before the table's row is ever read, which is what lets a
-- server that has not re-migrated answer `{ builtin: {} }` for everyone rather than fail.

create table if not exists user_tool_settings (
  user_id text primary key references "user" (id) on delete cascade,
  builtin jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null
);

alter table modes add column if not exists tools jsonb;
