# @openharness/hands

Pluggable _hands_: the sandboxes and tools behind `execute(name, input)` — and, until those
land, the one outbound-request guard the rest of openharness uses.

The tools are **not implemented yet**: no sandbox, no `execute()`. What is here is
**`safeFetch`** (epic #245, A3a), the SSRF guard for a URL a **user** supplied, and
**`openMcpClient`** (#303, X10), the remote-MCP client the server's connection check and the
tool loop (#312) share. Everything
else the server fetches is a constant URL it wrote itself, so there is no address to choose
and nothing to guard; a provider credential's endpoint is different — an Azure OpenAI endpoint
is typed by the user, and a URL the user chose is exactly what a guard is for. The tools' own
`web_fetch` will reuse it (epic #245, decision M1), which is why it is built here.

## Commands

Run from this folder (`packages/hands`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`)                  |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | watch mode                                                              |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

## Public API

| export                                                                                                                               | what it is                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `safeFetch(url, init?, options?)`                                                                                                    | fetch a user-supplied URL, refusing everything below                                 |
| `SafeFetchError`, `isSafeFetchError()`, `SafeFetchErrorCode`                                                                         | the refusal, with a stable `code`                                                    |
| `AddressResolver`, `SafeFetchTransport`, `SafeFetchRequest`                                                                          | the two seams: how a host resolves, and how the request is made                      |
| `SafeFetchOptions`                                                                                                                   | `allowPrivate`, `maxBytes`, `timeoutMs`, `idleTimeoutMs`, `maxRedirects`, the seams  |
| `SAVE_TIME_LIMITS`, `STREAMING_LIMITS`, `STREAMING_IDLE_TIMEOUT_MS`                                                                  | the two presets: a tight check, and a streaming-safe model call                      |
| `DEFAULT_MAX_BYTES`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_REDIRECTS`                                                                   | `1 MiB`, `30 s`, `5` — what a call with no options gets                              |
| `isBlockedAddress()`, `isPublicAddress()`, `isMetadataHostname()`, `parseIpAddress()`, `parseIPv4()`, `parseIPv6()`, `ParsedAddress` | the address rules, exported so a caller can reason about one on its own              |
| `openMcpClient(options)`                                                                                                             | open and initialize a Streamable HTTP connection to a remote MCP server              |
| `McpClientSession`, `McpClientOptions`, `McpFetch`                                                                                   | the session (`listTools()`, `client`, `close()`), its options and the injected fetch |
| `mcpToolDefinition(tool)`, `MCP_CLIENT_NAME`, `MCP_CLIENT_VERSION`                                                                   | one SDK tool as this protocol's definition, and the identity this client announces   |
| `PACKAGE_NAME`                                                                                                                       | `'@openharness/hands'`                                                               |
| `PROTOCOL_DEPENDENCY`                                                                                                                | `@openharness/protocol`'s `PACKAGE_NAME`; proves the built-output edge               |

### What `safeFetch` refuses, and how

Every hop — the first request and every redirect — runs the same six steps (`src/safe-fetch.ts`
documents them in full):

1. **Scheme.** `http` and `https` only.
2. **Metadata hostnames.** `metadata.google.internal` and `metadata.goog`, by name (the
   address check refuses what they resolve to as well — belt and braces for a resolver that
   maps one elsewhere).
3. **DNS, resolved here.** Every address the host resolves to is checked; a name that resolves
   to even one refused address is refused **whole**, because a DNS answer carrying both a
   public and a private address is an attack rather than a coincidence. `src/ssrf.ts` holds the
   ranges: loopback, private (RFC 1918), link-local (`169.254.0.0/16`, the cloud metadata
   service among them), carrier-grade NAT, multicast, unspecified, benchmarking and
   documentation ranges, IPv6 unique-local and link-local — and the IPv4-mapped, IPv4-compatible,
   NAT64 and 6to4 forms that carry an IPv4 inside them, judged by that IPv4. An address that
   does not parse is refused: an unknown form is not a public one.
4. **Connect to the address that was checked.** Each hop builds its **own** dispatcher, whose
   `connect.lookup` answers from the addresses that hop was checked against and **refuses every
   other name** — a lookup never falls back to an unchecked DNS answer. The dispatcher is closed
   when the hop's body has been read, failed or been cancelled, so neither a pin nor a socket
   outlives the call, and two calls can never share a connection opened under a different pin;
   two concurrent calls to one hostname keep their own answers. SNI and `Host` stay the original
   hostname; only the socket's address is pinned. The one name a lookup resolves afresh is a
   host the deployment named as its egress proxy (below).
5. **Redirects, one hop at a time.** `redirect: 'manual'`, so undici never follows a
   `Location` for us and steps 1–4 run again for every hop; the number of hops is capped (5).
   303 — and a 301/302 on a POST — becomes a GET with no body, per the fetch spec, and a 307/308
   that would have to resend a body this call cannot replay is refused. A hop that leaves the
   origin the request started on carries **no credential header**: `authorization`, `api-key`,
   `x-api-key`, `x-goog-api-key`, `cookie` and `proxy-authorization` are stripped, and are not
   picked up again if a later hop returns to the origin.
6. **Limits, per call.** `maxBytes`, `timeoutMs` (the whole call, body included) and
   `idleTimeoutMs` (a stalled body).

### The egress proxy

A proxied deployment sets `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`; each hop reads them through
its own undici `EnvHttpProxyAgent`, the same agent the server's `catalog/provider-fetch.ts` uses
for its constant URLs. Through a proxy the **check still runs on the target host** (step 3), but
the **pin does not**: an HTTP proxy resolves the target itself and there is no way to hand it an
address to connect to. The check is the guard; the pin is the hardening on top of it, and it
applies to a direct connection (and to a host `NO_PROXY` exempts). **A deployment that sets a
proxy must have the proxy refuse private ranges itself**: behind one, the pre-check is all that
stands between a user-supplied URL and the internal network. Production egresses through Cloud
NAT with no proxy; the variables exist for e2e's stub and for sandboxes.

### The limits, and who picks them

- **`SAVE_TIME_LIMITS`** (`{ maxBytes: 1 MiB, timeoutMs: 10 s, idleTimeoutMs: null,
maxRedirects: 0 }`) is what a save-time check uses: one small authenticated request whose answer
  nobody reads.
- **`STREAMING_LIMITS`** (`{ maxBytes: null, timeoutMs: null, idleTimeoutMs: 2 min,
maxRedirects: 0 }`) is what a model call uses: a model streams a long reply, so a size or time
  cap would cut a legitimate answer — what is bounded instead is an idle stream, which is a hung
  connection rather than a slow answer. The caller's own abort signal covers the rest.

Both presets set **`maxRedirects: 0`**, so a provider API call that answers a redirect is refused
(`too_many_redirects`) rather than sent somewhere else — the endpoint is a URL the user typed, and
neither the key nor the model request should follow a `Location` off it. Following redirects (up
to `DEFAULT_MAX_REDIRECTS`) is the default policy, which the tools' `web_fetch` will use.

## The remote-MCP client (epic #303, X10)

`openMcpClient(options)` opens one **Streamable HTTP** connection to a remote MCP server, over
the official `@modelcontextprotocol/sdk`. It initializes, and `listTools()` reads the server's
whole tool list (following pagination) as this protocol's `McpToolDefinition`s. The underlying
SDK `client` is exposed so the tool loop (#312) can call tools without this module inventing a
call API the connection check does not need.

It is deliberately thin and reaches nothing on its own: the **server** injects the URL, the
auth headers (a sealed header map, or an OAuth bearer token) and the `fetch` — a `safeFetch`
wrapper, so a user-supplied URL is guarded. stdio, the deprecated HTTP+SSE transport and the
SDK's own OAuth provider are all unused: the server is the OAuth client, and its tokens are
sealed in the deployment's vault, so the flow is the server's.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

## Testing

`src/**/*.test.ts` with Vitest (node environment).

- `ssrf.test.ts` is the address table: every refused range spelled out with why it is refused
  — the IPv4 blocks, the IPv6 blocks, the IPv4-mapped and tunnelled forms, the metadata
  hostnames — and the global unicast addresses that must stay accepted, mapped ones included.
- `safe-fetch.test.ts` has two halves. The **logic** — scheme, hostname, ranges, redirects and
  their re-checks, and which credential header a hop carries — runs on an injected resolver and
  transport, so a refusal is deterministic and no socket is opened. The **transport** — the
  address the socket is actually opened at, the three limits, and the connection's lifetime —
  runs against a real HTTP server on loopback reached through a resolver the test supplies; that
  is the only way to see the pin, because the host name resolves to an address only the test's
  resolver knows. Two servers on **one port**, one per loopback alias, name themselves in their
  bodies, so a response says which address was dialled: that is how the per-call pin is pinned
  down (a call after another call to the same origin, two calls released together, and one with
  `allowPrivate` under another without), and how a connection is shown to be closed after a body
  is read, errors or is cancelled — the server's own socket set goes empty. Those tests delete
  the proxy variables at module load (`safeFetch` honours the environment, and a sandbox's egress
  proxy would otherwise answer for `127.0.0.2`).
- `mcp-client.test.ts` runs `openMcpClient` against a real MCP server built from the same SDK
  on loopback: it initializes and lists tools as protocol definitions, follows pagination,
  carries the headers it was given, makes every request through the injected fetch, and closes.
  It uses the platform `fetch`, because `safeFetch` and the credential are the server's to
  inject.
- `index.test.ts` covers the barrel.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/hands/docs/`.
