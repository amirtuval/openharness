# Threat model — notes

This file records the trust boundaries behind decisions that would otherwise only live in a
pull request. It is deliberately short: each note says what a caller is authenticated by, what
it can reach, and what the server refuses. It is not a full threat model of openharness yet.

## MCP OAuth: the callback is authenticated by `state`

A user's remote MCP servers (epic #303, X10) are connected with OAuth 2.1, and the flow's
callback (`GET /v1/me/mcp_servers/oauth/callback`) is the one `/v1` route — besides
`/v1/auth-config` — that runs **outside** the session guard (#311). It has to: decision X10 has
`oh` start the flow by opening the authorization URL in the **system browser**, and that browser
may never have signed in to this server, because `oh` itself authenticates with a bearer token
from the device flow.

- **What authenticates it** is the `state`: 32 random bytes, single use (redeeming it deletes
  the row), ten minutes old at most, and bound in `mcp_oauth_states` to the user **and** the
  server it was minted for. The flow is completed for that user and server and for nobody else,
  and the state is consumed whether or not the completion succeeds — so a replayed, expired,
  refused or misused callback cannot be retried.
- **What a browser with a session changes** is nothing but a refusal: a session that is present
  and belongs to a **different** user than the state's refuses the callback rather than
  completing it for the wrong person (a confused flow). No route here reads its owner from the
  request — the owner is the state's user.
- **What it exposes** is one thing a stranger could not otherwise get: completing a flow seals
  an OAuth token for a server the state's user already owned and started connecting. It cannot
  create, read, list, update or delete a server, and it never echoes a token.
- **What it answers** is a page, not the protocol's envelope, because a browser is what arrives:
  everything echoed into one — a server name the user chose, the authorization server's
  `error`/`error_description` — is HTML-escaped, and every page carries `Cache-Control: no-store`.

Every other `/v1/me/mcp_servers` route stays behind the guard and is owner-scoped like the rest
of the API; the callback is the exact method and path and nothing more.
