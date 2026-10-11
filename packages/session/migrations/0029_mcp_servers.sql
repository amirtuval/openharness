-- 0029_mcp_servers.sql — a user's remote MCP servers, and their pending OAuth states
-- (epic #303, X10).
--
-- A remote MCP server is a per-user resource like `provider_credentials` and `modes`: a URL,
-- how requests authenticate, whether the server is on by default, and the signed-in user it
-- belongs to. `owner_id` is a foreign key into Better Auth's `"user"` with `on delete cascade`,
-- so a user's servers go when the user does, and a name is unique among a user's own servers —
-- the constraint is what makes "names are unique per user" true under two concurrent creates
-- rather than only in the server's check. The number of servers a user may hold is a server
-- rule (`MAX_MCP_SERVERS_PER_USER`); it has no constraint here, like every other bound this
-- package leaves to the caller.
--
-- **The secrets are sealed.** `sealed_headers`, `sealed_tokens` and `sealed_oauth_client` hold
-- `@openharness/vault` output — one JSON value each (`ciphertext`, `nonce`, `wrappedKey`,
-- `kekVersion`, `keyProvider?`), opaque to this package. The header values, the OAuth access
-- and refresh tokens and the registered client's secret live only inside those blobs; nothing
-- here is a plaintext column, and none may ever be added. `header_names` and `tools` carry the
-- public half — the header names a settings screen shows, and the tool summaries a connection
-- check listed (with the token cost of their definitions, X6) — which a `list` may read without
-- opening a blob. A metadata read (list/save/update answers) selects every column but the three
-- sealed ones.
--
-- `id` is an `mcps_` ULID — this package's, like `agent_`/`sesn_`/`sevt_`/`pcred_`/`mode_` — so
-- it carries the `C` collation every openharness id column does, which is what makes the SQL
-- order the byte order the in-memory store compares with. `name` is `C` too. `auth` and
-- `status` are checked against the protocol's vocabularies, so a hand-edited row cannot read
-- back as a shape no reader accepts.
--
-- **Migration number.** 0029 follows `0028_paused_confirmation_work.sql`, the newest file
-- #311's stack phase wrote; `0027_mcp_oauth_state_client.sql` moved with it to `0030`, so the
-- pair stays adjacent. Every file runs on every `migrate()` in name order, so the numbers have
-- to be unique and ordered.

create table if not exists mcp_servers (
  id text collate "C" primary key,
  owner_id text not null references "user" (id) on delete cascade,
  name text collate "C" not null,
  url text not null,
  auth text not null,
  enabled boolean not null,
  status text not null,
  last_error text,
  header_names jsonb not null default '[]'::jsonb,
  tools jsonb not null default '[]'::jsonb,
  definition_tokens integer not null default 0,
  last_tested_at timestamptz,
  sealed_headers jsonb,
  sealed_tokens jsonb,
  sealed_oauth_client jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  -- A name is unique per user; this is what makes it so under concurrent creates.
  constraint mcp_servers_owner_name_key unique (owner_id, name),
  constraint mcp_servers_auth_check check (auth in ('none', 'headers', 'oauth')),
  constraint mcp_servers_status_check check (status in ('connected', 'needs_reconnect', 'error'))
);

-- `list()`: one owner's servers, oldest first, ordered by `(created_at, id)`.
create index if not exists mcp_servers_owner_created_idx
  on mcp_servers (owner_id, created_at, id);

-- The pending OAuth authorizations of a user's servers: one row per in-flight `connect`.
--
-- Keyed by the opaque `state` the authorization server echoes back and consumed in the same
-- statement that deletes it, so a callback replay finds nothing. `expires_at` is checked
-- against the injected clock on the way out, and both foreign keys cascade — a deleted server
-- takes its pending states, and so does a deleted user. `code_verifier` is the PKCE verifier
-- **in the clear**: it is a nonce for one round trip — useless once the code it is bound to has
-- been redeemed — rather than a durable credential, and the tokens that come out of the flow
-- are what get sealed.
create table if not exists mcp_oauth_states (
  state text collate "C" primary key,
  user_id text not null references "user" (id) on delete cascade,
  server_id text collate "C" not null references mcp_servers (id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);

-- `createOAuthState` replaces every state for a `(user, server)`, and `consumeOAuthState`
-- deletes by `state`; the delete-by-pair needs an index to be a lookup rather than a scan.
create index if not exists mcp_oauth_states_owner_server_idx
  on mcp_oauth_states (user_id, server_id);
