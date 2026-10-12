# issue #314 — hands-on, against the built server (apps/server `dist/`, `OPENHARNESS_TEST_MODEL=mock`,
# `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS=1`, BETTER_AUTH_URL=http://localhost:3100, the built web
# app served from OPENHARNESS_WEB_DIR).

## The lab
`.qa/lab.mjs` starts three real remote MCP servers on loopback (built from
`@modelcontextprotocol/sdk`, the same SDK the product uses) and one authorization server:
an `oauth` one whose tokens are **bound to its own URL** (Linear's shape — a token minted for
another resource is refused) and whose token endpoint **requires** the RFC 8707 `resource`
parameter (so a refresh that forgets it is a 400), an open one, and one that wants a bearer.

## The five create cases (no auth type is sent in any of them)
1. `{"url": "<oauth>"}` → 201, `auth: oauth`, `status: needs_reconnect` — detected from the 401
   and the RFC 9728 metadata; `name` derived as `127-0-0-1`.
2. `{"url": "<open>"}` → 409 duplicate name (the derived name is the host, so two loopback
   servers collide — the message names it and the reader renames one).
3. `{"name":"lab-keyed","url":"<keyed>","headers":{"Authorization":"Bearer sk-lab"}}` →
   `auth: headers`, `status: connected`, `tools: search, ping` — the map implies `headers`.
4. `{"name":"lab-keyed2","url":"<keyed>"}` → `auth: none`, `status: error`, `last_error`:
   `the MCP server answered 401 Unauthorized, with no message — it wants credentials, but it
   advertises no OAuth authorization server; add an API key under "Advanced: custom headers"`.
5. `{"name":"lab-down","url":"http://127.0.0.1:1/mcp"}` → `auth: none`, `status: error`,
   `last_error`: `no response from the MCP server: fetch failed` — a detection that could not
   run says so.

## Test on an unconnected OAuth server
`POST …/{id}/test` → the server is unchanged (`needs_reconnect`, `last_error: null`). That is
the silent no-op the maintainer hit; the web card no longer offers Test until the server is
connected (Connect is the action that exists), and `oh mcp`'s `t` now says
"Connect first — this server needs a sign-in." through the shared `mcpTestOutcome`.

## The OAuth flow, by hand
`POST …/connect` answers the authorization URL (carrying `resource=<the server's own URL>` and
PKCE); the authorization page redirects to `GET /v1/me/mcp_servers/oauth/callback`; the callback
302s to `/?mcp_connected=<id>#/settings`; the server is then `connected` with
`tools: search, ping` — **listed immediately**, no second read.

## The web app, against the real stack
- The dialog's only required field is the URL; the name placeholder shows `127-0-0-1` (what the
  server would derive), and the custom-header disclosure holds the pair.
- After Connect: `Connected linear-lab.` and the row is `Connected · 2 tools, about ~53 tokens.`
- Test on the row draws `Connected. Listed 2 tools, about ~53 tokens.` inline.
- Before Connect there is no Test button at all.

## `oh mcp`, in tmux (CI unset)
- `n` → URL first, with "We check the URL on save and work out how it authenticates."; no auth
  list. Enter through the optional name and the optional header, Enter on `on` → the server is
  registered and listed as `<name> · None · Connected`.
- With a header typed → `<name> · Headers · Connected`.
- Editing opens on the value the server holds (the URL box shows the stored URL, so Enter keeps
  it); adding `X-Lab: yes` to an open server flipped the row from `None` to `Headers` — which is
  the update bug this run fixed (the map was stored but `auth` was left alone).
- `t` on a connected server notes `lab-keyed: 2 tools, about ~53 tokens.`
