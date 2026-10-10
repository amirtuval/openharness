-- 0027_mcp_oauth_state_client.sql — where a pending MCP OAuth flow was started (#311).
--
-- A pending OAuth authorization is completed by a **browser**, not by an API caller: the CLI
-- `oh` starts the flow by opening the authorization URL in the system browser, and that browser
-- may never have signed in to this server (`oh` authenticates with a bearer token from the
-- device flow). So the callback is authenticated by the `state` alone — high-entropy, single
-- use, ten minutes old, and bound to the user and the server in this table — and it needs one
-- more fact to answer correctly: where the flow was started. A flow started from the web app is
-- redirected back to its settings screen; one started from the CLI is shown a plain page the
-- user can close, because the CLI is waiting on its own terminal, not on a redirect.
--
-- The column is a name, not key material: `web` or `cli`, the protocol's `McpOAuthClient`
-- vocabulary, checked here so a hand-edited row cannot read back as a value no reader accepts.
-- **Every existing row takes `web`**, which is not a guess: `cli` did not exist, so a pending
-- flow could only have been started from the app. The default is the protocol's own default
-- too, so a reader that ignores the column answers exactly as the server did before #311. There
-- is nothing else to backfill, and `if not exists` keeps a re-run leaving every row as it was.
--
-- **Migration number.** 0027 is the next free number after `0026_mcp_servers.sql`. Every file
-- runs on every `migrate()` in name order, so the numbers have to be unique and ordered.

alter table mcp_oauth_states
  add column if not exists client text not null default 'web';

-- Postgres has no `add constraint if not exists`; the guard makes a re-run a no-op.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'mcp_oauth_states_client_check'
      and conrelid = 'mcp_oauth_states'::regclass
  ) then
    alter table mcp_oauth_states
      add constraint mcp_oauth_states_client_check check (client in ('web', 'cli'));
  end if;
end
$$;
