-- 0018_credential_key_provider.sql — which key provider wrapped each credential's data key
-- (#150, deployment epic #148 decision D6).
--
-- A sealed credential (see `0013_provider_credentials.sql`) records the key that wrapped its
-- data key as `kek_version` and, since this migration, *which provider* wrapped it as
-- `key_provider`: `local` (`OPENHARNESS_SECRETS_KEY`) or `gcp-kms` (Cloud KMS, where the
-- master key never leaves KMS). The column is a name, never key material — it exists so a
-- secret can only be opened by the provider that wrapped it, with a clear error instead of a
-- decryption failure, and so a deployment can tell at a glance what a row was sealed under.
--
-- **NULL is a legitimate value and means `local`.** Every row written before this migration
-- holds it: `local` was the only provider then, and there is nothing to backfill — nothing
-- is deployed yet, and a plain `update … set key_provider = 'local'` would keep re-running
-- against rows written for a provider that did not exist at the time. The reader applies the
-- same rule the vault does: a row without a provider is a local row.
--
-- The file is one `add column if not exists`, so it is idempotent like every migration here
-- (the runner re-runs every file on every `migrate()` call) and leaves every existing row —
-- and every sealed blob — exactly as it was.

alter table provider_credentials
  add column if not exists key_provider text;
