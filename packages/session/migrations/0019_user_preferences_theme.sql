-- 0019_user_preferences_theme.sql — the web theme on `user_preferences` (#203, epic #201 X3).
--
-- `theme` is which colour scheme the web app paints with: `system` (follow the operating
-- system — the value a user who never chose one gets), `light`, `dim` or `dark`. It is a
-- *choice*, not a resolved value: a `system` row stays `system` when the operating system
-- flips, because the following happens in the browser. The set is the protocol's
-- `UserThemeSchema`, which is where the shape is validated; this column stores the name.
--
-- **Every existing row takes `system`.** That is what those users were seeing before this
-- migration — the app followed `prefers-color-scheme` and had no switcher — so the default
-- is not a guess, it is the behaviour that was already in effect. The column has a real
-- default rather than the "NULL means the default" rule `0018_credential_key_provider.sql`
-- uses, because here the default is a value a new write always supplies: an insert without
-- it is a bug, not a legitimate older shape.
--
-- The file is one `add column if not exists`, so it is idempotent like every migration here
-- (the runner re-runs every file on every `migrate()` call) and leaves `default_model`,
-- `updated_at` and every other table exactly as they were.

alter table user_preferences
  add column if not exists theme text not null default 'system';
