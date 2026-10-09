-- 0023_credential_details.sql — the public, type-specific facts of a credential (#249, A3b).
--
-- Epic #245 (A3b) adds a credential type whose endpoints a user chooses — a custom
-- OpenAI-compatible base URL. The settings list must show which endpoint a credential points
-- at, but the payload that holds the URL is **sealed** and a metadata read must not open it
-- (see `0013_provider_credentials.sql`), so the safe, publishable part of that payload — the
-- base URL's host — is written beside it, unsealed, in `details`.
--
-- `details` is not a secret and never may be: it is a JSON object of the facts a credential's
-- type chooses to publish (the protocol's `ProviderCredentialDetailsSchema`), and a list read
-- returns it as-is. NULL is legitimate and means "this type has no such facts": every row
-- written before this column holds it, and today `api_key` and `azure_openai` credentials
-- keep holding it, so their metadata is unchanged by this migration. There is nothing to
-- backfill.
--
-- The file is one `add column if not exists`, so it is idempotent like every migration here
-- (the runner re-runs every file on every `migrate()` call) and leaves every existing row —
-- and every sealed blob — exactly as it was.

alter table provider_credentials
  add column if not exists details jsonb;
