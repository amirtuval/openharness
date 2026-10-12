-- 0031_mcp_tool_policies.sql — the per-tool policies a user has for remote MCP tools
-- (epic #303, X10; issue #312).
--
-- `user_tool_settings` gained the built-in half with #307 (`0027_tool_settings.sql`): one
-- `builtin jsonb` map of tool name to `{ enabled, policy }`. A remote MCP tool has no on/off of
-- its own — whether a whole server is in play is the server resource's `enabled`, and a mode's
-- `mcp_servers` override patches it (`0027`'s `modes.tools`) — so the only thing a user chooses
-- per remote tool is the permission a call is evaluated under. This adds that as one more
-- `jsonb` map, keyed by the model-facing offered name the call is recorded under
-- (`<server>__<tool>`, the protocol's `mcpToolOfferedName`), with the permission as its value.
--
-- A second column rather than one map keyed by both kinds: the two halves have different value
-- shapes (a remote tool has no `enabled`), and folding them would make every reader of one
-- parse the other's. The map is a record of **choices** like `builtin` — a tool absent from it
-- follows `DEFAULT_MCP_TOOL_PERMISSION` (`ask`) — so an empty column and an absent row both
-- read as no choices, and a user who has never set one needs no write.
--
-- **Every existing row takes `{}`**, which is not a guess: there were no remote tool policies
-- before this, so every user was following the default. The column is `not null` with a real
-- default because a write always supplies it (the row is replaced whole, like `builtin`), so an
-- absent value would be a bug rather than an older shape. `if not exists` keeps a re-run
-- leaving every row as it was.
--
-- **Migration number.** 0031 follows `0030_mcp_oauth_state_client.sql`. Every file runs on
-- every `migrate()` in name order, so the numbers have to be unique and ordered.

alter table user_tool_settings
  add column if not exists mcp jsonb not null default '{}'::jsonb;
