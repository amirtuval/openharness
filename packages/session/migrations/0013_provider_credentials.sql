-- 0013_provider_credentials.sql — `provider_credentials`: users' sealed model-provider keys
-- (epic #65, decision A5).
--
-- Every user brings their own provider keys, and the database never holds one that can be
-- used on its own. A row is a *sealed blob* — the AES-256-GCM `ciphertext`, its `nonce`, the
-- per-secret data key wrapped under the master key (`wrapped_key`) and the version of that
-- key (`kek_version`) — produced by `@openharness/vault` and opened only with
-- `OPENHARNESS_SECRETS_KEY` from the server environment. There is no plaintext column, and
-- none may ever be added: grep for a secret column in this file and the only words that come
-- back are ciphertext, nonce and wrapped key. The store that reads and writes this table
-- (`CredentialStore`) never sees a plaintext either — it only moves sealed blobs.
--
-- One row per `(user_id, provider)`: adding a key again replaces it in place, keeping the
-- row's id and `created_at`. `on delete cascade` from `"user"` takes a user's credentials
-- with the user, like their agents and sessions.
--
-- `last4` is the last four characters of the stored secret — what a settings screen shows so
-- a person can tell one key from another. It is the only piece of the secret that is stored
-- unsealed, and deliberately so: it is a recognition aid, not a secret. `validated_at` is
-- when the credential last passed its one cheap provider call on save.
--
-- `id` is a `pcred_` ULID — this package's, like `agent_`/`sesn_`/`sevt_` — so it carries the
-- `C` collation every openharness id column does. `provider` is ordered by when a user's
-- credentials are listed, so it is `C` too, which is what makes the SQL order the byte order
-- the in-memory store compares with.

create table if not exists provider_credentials (
  id text collate "C" primary key,
  user_id text not null references "user" (id) on delete cascade,
  provider text collate "C" not null,
  type text not null,
  ciphertext text not null,
  nonce text not null,
  wrapped_key text not null,
  kek_version text not null,
  last4 text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  validated_at timestamptz not null,
  -- One credential per provider per user: this is what makes `upsert` an upsert, and what
  -- `where user_id = $1 order by provider` seeks into.
  constraint provider_credentials_user_provider_key unique (user_id, provider)
);
