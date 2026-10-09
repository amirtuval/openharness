-- 0021_credential_name.sql — the credential's `name`, and uniqueness per name (#248).
--
-- Epic #245 (A3a) gives a credential a **name** rather than a fixed provider key. The name is
-- the `provider` half of the model ids the credential serves: `anthropic` for the eleven
-- API-key providers (one each, their provider id), and a short name the user chose for a named
-- type — `azure`, `azure-eu` — so a single account can hold more than one Azure OpenAI
-- credential. The uniqueness rule therefore moves from one row per `(user_id, provider)` to one
-- row per `(user_id, name)`.
--
-- The rename is a no-op for every existing row: a credential stored before this change was
-- keyed by its provider id, and that id is exactly the name such a credential takes. So there
-- is nothing to backfill and no value changes — the column keeps every value it had, under the
-- name it now carries. The sealed blobs are untouched, and their associated data is unaffected:
-- the server seals with `userId|name`, which for a pre-existing row is the same string it
-- sealed with before.
--
-- Idempotency: `alter table … rename` has no `if exists`, and the runner re-runs every file on
-- every `migrate()`, so each rename is guarded by a check on the catalogue. A second run finds
-- the work done and changes nothing.

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'provider_credentials'
      and column_name = 'provider'
  ) then
    alter table provider_credentials rename column provider to name;
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'provider_credentials_user_provider_key'
      and conrelid = 'provider_credentials'::regclass
  ) then
    alter table provider_credentials
      rename constraint provider_credentials_user_provider_key
      to provider_credentials_user_name_key;
  end if;

  -- A database created before 0013's constraint name was used, or one where the rename above
  -- did not fire, still needs a uniqueness rule keyed on the (possibly just renamed) column.
  if not exists (
    select 1 from pg_constraint
    where conname = 'provider_credentials_user_name_key'
      and conrelid = 'provider_credentials'::regclass
  ) then
    alter table provider_credentials
      add constraint provider_credentials_user_name_key unique (user_id, name);
  end if;
end $$;
