# @openharness/hands

Pluggable _hands_: the tools behind `execute(name, input)`, the registry that runs one, and
the one outbound-request guard the rest of openharness uses.

Since epic #303 ([#304](https://github.com/amirtuval/openharness/issues/304)) this package
holds the **tool registry**: a tool declares its name, the description a model reads, an input
schema (zod), a default permission and a timeout, and `ToolRegistry.execute` runs one call of
one and turns every outcome into a `ToolResult` the brain stores. There is **no sandbox**: a
tool runs in this process. The built-in tools arrive with
[#305](https://github.com/amirtuval/openharness/issues/305) — `web_fetch` and `todo_write`,
below — the loop's first client was a test tool behind the server's
`OPENHARNESS_TEST_MODEL=mock` hook, and the MCP client lives here too: **`openMcpClient`**
(#303, X10) is what the server's connection check and the tool loop
([#312](https://github.com/amirtuval/openharness/issues/312)) share. The one built-in of #305
that is **not** here is `web_search`, which is no longer a tool this package runs at all: since
[#335](https://github.com/amirtuval/openharness/issues/335) it is offered by attaching the chat
model's own provider's native search tool to the request, so the provider runs the search inside
that one model request and nothing of ours executes it (the loop's half is
`@openharness/brain`).

**`safeFetch`** (epic #245, A3a) is the SSRF guard for a URL a **user** supplied, and is what
`web_fetch` uses — and what the skill import's clone reads a repository through (epic #349, K3). Everything else the server fetches is a constant URL it wrote itself, so
there is no address to choose and nothing to guard; a provider credential's endpoint is
different — an Azure OpenAI endpoint is typed by the user, and a URL the user chose is exactly
what a guard is for. `web_fetch` reuses it (epic #245, decision M1), which is why it is built
here.

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

| export                                                                                                                                                                                             | what it is                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safeFetch(url, init?, options?)`                                                                                                                                                                  | fetch a user-supplied URL, refusing everything below                                                                                                                                                                                                                                                                                                                                                                                               |
| `safeFetchResult(url, init?, options?)`, `SafeFetchResult`                                                                                                                                         | the same call, answering `{ response, url }` — the address the response finally came from, after redirects                                                                                                                                                                                                                                                                                                                                         |
| `SafeFetchError`, `isSafeFetchError()`, `SafeFetchErrorCode`                                                                                                                                       | the refusal, with a stable `code`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `AddressResolver`, `SafeFetchTransport`, `SafeFetchRequest`                                                                                                                                        | the two seams: how a host resolves, and how the request is made                                                                                                                                                                                                                                                                                                                                                                                    |
| `SafeFetchOptions`                                                                                                                                                                                 | `allowPrivate`, `maxBytes`, `timeoutMs`, `idleTimeoutMs`, `maxRedirects`, the seams                                                                                                                                                                                                                                                                                                                                                                |
| `SAVE_TIME_LIMITS`, `STREAMING_LIMITS`, `STREAMING_IDLE_TIMEOUT_MS`                                                                                                                                | the two presets: a tight check, and a streaming-safe model call                                                                                                                                                                                                                                                                                                                                                                                    |
| `DEFAULT_MAX_BYTES`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_REDIRECTS`                                                                                                                                 | `1 MiB`, `30 s`, `5` — what a call with no options gets                                                                                                                                                                                                                                                                                                                                                                                            |
| `isBlockedAddress()`, `isPublicAddress()`, `isMetadataHostname()`, `parseIpAddress()`, `parseIPv4()`, `parseIPv6()`, `ParsedAddress`                                                               | the address rules, exported so a caller can reason about one on its own                                                                                                                                                                                                                                                                                                                                                                            |
| `openMcpClient(options)`                                                                                                                                                                           | open and initialize a Streamable HTTP connection to a remote MCP server                                                                                                                                                                                                                                                                                                                                                                            |
| `McpClientSession`, `McpClientOptions`, `McpFetch`                                                                                                                                                 | the session (`listTools()`, `client`, `close()`), its options and the injected fetch                                                                                                                                                                                                                                                                                                                                                               |
| `mcpToolDefinition(tool)`, `MCP_CLIENT_NAME`, `MCP_CLIENT_VERSION`                                                                                                                                 | one SDK tool as this protocol's definition, and the identity this client announces                                                                                                                                                                                                                                                                                                                                                                 |
| `createMcpTool(options)`, `McpToolOptions`                                                                                                                                                         | one remote tool as an ordinary `ToolDefinition` (#312): the offered name, the server's own JSON Schema, the `ask` default, and a `run` that opens a connection, calls, shapes and closes                                                                                                                                                                                                                                                           |
| `mcpResult(answer, options)`, `McpResultOptions`, `DEFAULT_MCP_TOOL_TIMEOUT_MS`                                                                                                                    | an MCP answer as this protocol's result — text, structured content as JSON, a marker for anything else, the provenance line — and the ceiling a remote call runs under (60 s)                                                                                                                                                                                                                                                                      |
| `PACKAGE_NAME`                                                                                                                                                                                     | `'@openharness/hands'`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PROTOCOL_DEPENDENCY`                                                                                                                                                                              | `@openharness/protocol`'s `PACKAGE_NAME`; proves the built-output edge                                                                                                                                                                                                                                                                                                                                                                             |
| `parseGitUrl(url)`, `repositoryName(url)`, `GitUrlError`, `isGitUrlError()`, `GitSourceLocation`, `GitUrlErrorCode`                                                                                | read a `https://` git URL — a clone URL or a GitHub/GitLab **browse** URL (`…/tree/<ref>/<path>`, `…/-/tree/<ref>/<path>`) — into the repository, the optional `ref` and the optional `path`; refuses another scheme, credentials in the URL and a URL naming no repository (epic #349, K3); and the repository's **name** — its URL path's last segment, minus a trailing `.git` — which is what a `SKILL.md` at a repository's root is named for |
| `cloneRepository(options)`, `ClonedRepository`, `ClonedFile`, `CloneRepositoryOptions`, `GitCloneError`, `isGitCloneError()`, `GitCloneErrorCode`                                                  | a **shallow, in-memory** `isomorphic-git` clone (`depth: 1`, one branch, no checkout) whose HTTP client is `safeFetch`: no `git` binary, no subprocess, no submodules, no LFS, nothing written to disk; a total download cap and one deadline; answers the resolved commit and every blob of its tree (epic #349, K3)                                                                                                                              |
| `DEFAULT_CLONE_MAX_BYTES`, `DEFAULT_CLONE_TIMEOUT_MS`, `DEFAULT_CLONE_MAX_REDIRECTS`                                                                                                               | the clone's own limits: 20 MB (the same number the protocol's `SKILL_CLONE_MAX_BYTES` names), 60 s, 5 hops — each re-checked by the guard                                                                                                                                                                                                                                                                                                          |
| `createMemoryFileSystem()`, `MemoryFileSystem`, `MemoryStats`                                                                                                                                      | the in-memory file system a clone is written into: the ten operations `isomorphic-git`'s file-system contract names (plus `rm`), with every path normalized so nothing can climb out of the tree                                                                                                                                                                                                                                                   |
| `createToolRegistry(tools)`                                                                                                                                                                        | a registry over a host's tools: look one up by name, or run one call                                                                                                                                                                                                                                                                                                                                                                               |
| `ToolRegistry`, `ToolRunContext`                                                                                                                                                                   | `{ tools, get(name), execute(name, input, ctx) }`, and what a caller tells `execute` about the turn (`signal`, `secrets`, a `timeoutMs` ceiling)                                                                                                                                                                                                                                                                                                   |
| `ToolDefinition`, `ToolExecutionContext`, `ToolResult`                                                                                                                                             | one tool — name, description, zod input schema, default permission, timeout, the result cap a request carries of its output (`maxResultTokens`, epic #303 X9; #306), `run` — and what `run` is handed (the turn's signal, its resolved limit, the per-user `secrets`)                                                                                                                                                                              |
| `textResult(text)`, `errorResult(text)`                                                                                                                                                            | the two results a tool normally answers with: one text block, the second with `isError: true`                                                                                                                                                                                                                                                                                                                                                      |
| `DEFAULT_TOOL_TIMEOUT_MS`                                                                                                                                                                          | `30000` — a call's limit when its definition names none                                                                                                                                                                                                                                                                                                                                                                                            |
| `DEFAULT_TOOL_RESULT_TOKENS`                                                                                                                                                                       | `4096` — the most of one call's result a model request keeps, when its definition names no `maxResultTokens` (epic #303, X9)                                                                                                                                                                                                                                                                                                                       |
| `scrubText(text, values)`, `REDACTED_PLACEHOLDER`                                                                                                                                                  | the redaction every result passes through: `[REDACTED]` where a resolved secret was                                                                                                                                                                                                                                                                                                                                                                |
| `createWebFetchTool(options?)`, `WebFetchOptions`, `PageFetch`, `safePageFetch`, `WEB_FETCH_TOOL_NAME`                                                                                             | `web_fetch`: a GET of a model-chosen URL through `safeFetch`, as Markdown                                                                                                                                                                                                                                                                                                                                                                          |
| `WebFetchInputSchema`, `WebFetchInput`, `DEFAULT_MAX_FETCH_CHARS`, `WEB_FETCH_MAX_BYTES`, `WEB_FETCH_MAX_REDIRECTS`, `WEB_FETCH_MAX_RESULT_TOKENS`, `WEB_FETCH_TIMEOUT_MS`, `WEB_FETCH_USER_AGENT` | its input, and the caps it declares: 50,000 characters of output, 2 MiB of response, 5 redirect hops, 16,384 tokens of a result a request keeps (its `maxResultTokens`), a 20 s call                                                                                                                                                                                                                                                               |
| `htmlToMarkdown(html, url)`                                                                                                                                                                        | the conversion `web_fetch` runs: main content first, chrome/consent and script and style dropped, a headline fallback for a page with no article, `charset` sniffed when the response names none, relative links resolved against `url`                                                                                                                                                                                                            |
| `todoWriteTool`                                                                                                                                                                                    | `todo_write`: the whole list, replacing the previous one                                                                                                                                                                                                                                                                                                                                                                                           |

### The built-in tools (epic #303; #305)

Two tools ship with this package. They are ordinary `ToolDefinition`s — nothing in the
registry knows they are special — and each one's _default permission_ is `allow` (the epic's
default policies), so an unfiltered registry offers them to the model. `web_search` is the
third built-in of #305 and it is deliberately **not** one of these (#335): it is offered by
attaching the chat model's own provider's native search tool to the request, so the provider
runs the search and no `ToolDefinition` of ours exists for it.

**`web_fetch`** (`src/web-fetch.ts`) is the one tool that reaches an address the **model**
chose, so every hop of it goes through `safeFetch`: the scheme, the metadata hostnames, every
address the name resolves to, the pin, and each redirect re-checked — up to
`WEB_FETCH_MAX_REDIRECTS` (5), the guard's own default. What the tool adds is what a model
should _see_:

- **HTML becomes Markdown** (`src/markdown.ts`): [Mozilla's
  `Readability`](https://github.com/mozilla/readability) extracts the main content from a DOM
  built by [`linkedom`](https://github.com/WebReflection/linkedom) — small, and with no
  dependency tree of its own, unlike `jsdom` — and
  [`turndown`](https://github.com/mixmark-io/turndown) converts it (ATX headings, fenced code,
  inlined links). Both are maintained libraries rather than hand-written rules, which is the
  point: HTML→Markdown is a solved problem with a well-known failure mode for every special
  case, and a tool is not where it should be re-solved. What is done here is what is specific
  to _this_ use:
  - **Chrome is dropped before anything reads the page**: `script`, `style`, `noscript`,
    `template`, `iframe`, `svg` and `canvas` (so an inline `<script type="application/ld+json">`
    goes with the rest), and the page's own structural chrome — `nav`, `header`, `footer`,
    `aside`, `dialog`, `form` and the ARIA landmark roles that name the same regions — by the
    page's markup rather than by guessing class names. A consent/cookie banner is dropped by a
    whole-word rule on its class or id (`cookie`/`consent`/`gdpr`), so a page that merely mentions
    cookies is left alone.
  - **A page whose "content" is a list of headlines still gets its content.** `Readability` is
    tuned for one article, so a news homepage can make it answer `null` or a small wrong node
    (a byline list). When its answer is missing, or is a small fraction (under a quarter) of the
    page's own text, a second pass keeps the headline shape — headings, the links that carry
    them, teasers, lists and captioned images, in document order — without the menus, and it
    drops the masthead above the first real content so the headline leads. It is a documented
    heuristic, not a per-site rule.
  - **Every link is resolved** against the address the page was fetched from, so a model can
    follow it, and the page's own `<title>` is put back as a heading when `Readability` read one.
  - **The shapes a converter renders as stray punctuation are fixed on the DOM, not the string.**
    A news card is often one `<a>` wrapping a whole headline and teaser; the inlined-link rule
    would render that as an orphan `[` at the start with its `](href)` hundreds of characters
    below, so the link is pushed down into each block instead (`# [Headline](href)`). An icon
    link (an empty `<a>`) or an undescribed image (no `alt`, Hacker News's spacer `s.gif`) would
    render as `[](...)`/`![](...)`, so both are dropped: an element with no readable content
    never reaches the converter.
- **Text and JSON pass through** as they are; **anything else** (an image, a PDF) is refused
  with an `is_error` result naming the content type, because bytes that are not text are not
  something to store as if they were. A response that names no content type is read as text.
- **The charset is decoded in the order a browser uses**: the `charset` the `content-type`
  header named, then the page's **own** statement — a `<meta charset>`/`<meta http-equiv>` in
  its first bytes, or a byte-order mark — then UTF-8. A `windows-1255` Hebrew page served as
  plain `text/html` would otherwise come back with every character replaced.
- **The result leads with the address — the _final_ one, after redirects — and says the
  content is untrusted data from the web, not instructions.** That sentence is the threat
  model's rule made visible to the model on the one path where a page's text could be mistaken
  for a command.
- **The output is capped** at `DEFAULT_MAX_FETCH_CHARS` (50,000 characters — a long article,
  about twelve thousand tokens), on top of `safeFetch`'s byte cap (2 MiB here, twice the
  guard's default, because HTML is mostly markup the Markdown conversion drops). A page over
  the cap is cut with a last-line marker saying how many of how many characters were shown,
  never silently. Above that sits the tool's `maxResultTokens`
  (`WEB_FETCH_MAX_RESULT_TOKENS`, 16,384 — epic #303, X9), the tool's own declaration of what a
  result may cost a **model request**: it is deliberately above what the character cap can
  produce, so for an ordinary page the character cap is the binding one, and the brain's own
  share of the model's budget can only lower it further. What a _result_ may cost the whole
  context is [#306](https://github.com/amirtuval/openharness/issues/306)'s.
- A non-2xx answer is refused rather than converted: a 404 page is not the page.

**`web_search` is not here** (#305; #335). It was the third tool of
[#305](https://github.com/amirtuval/openharness/issues/305), one search through a single
operator-paid search API with a per-user daily cap — the removed design. Since
[#335](https://github.com/amirtuval/openharness/issues/335) the search runs on the **user's own
model key**, with the chat model's own provider's index, inside the model request itself: the
provider attaches its native search tool to the request it is already running and executes the
search there, so there is no operator bill, no key to hand over and no call of ours to run. The
consequence for this package is that there is nothing to build — no `createWebSearchTool`, no
adapter, no transport, no per-call secret, no allowance — and `web_search` is a name this
package no longer exports. The loop's half (which model families have a native tool, how the
tool is attached and how a provider's refusal is answered) is `@openharness/brain`'s
`native-search.ts`, and the settings list it as a tool no registry holds
(`@openharness/protocol`'s `WEB_SEARCH_TOOL_NAME`).

**`todo_write`** (`src/todo.ts`) replaces the **whole list** every time, which is what makes
the list one value and the storage the log itself: the newest call's own input is the list, and
`@openharness/protocol`'s `readTodoList` is the reading (for the brain and the clients). The
tool does no I/O and reads no context; its result is a rendered checklist — a marker per state
(`[x]` done, `[~]` in progress, `[ ]` pending) and a count of each — so a model reads back
exactly what it wrote.

### The tool registry (epic #303; #304)

A tool is a name the model calls, a description it reads, an **input schema** (zod), a default
permission and a timeout; `run(input, ctx)` does the work. The registry holds a host's tools
and is the only way to call one:

```ts
const registry = createToolRegistry([echo]) // throws on two tools sharing a name
const result = await registry.execute('echo', call.input, { signal, secrets })
```

- **Every outcome is a `ToolResult`, and `execute` never throws.** A name no tool has, input the
  tool's schema refuses (naming the field), a call that throws, one that runs past its timeout,
  and one the turn aborted all come back as `isError` results the model reads and the brain
  stores. There is no second failure channel, so a tool cannot take a turn down with it.
- **The caller's `ctx` is the whole world a tool gets.** `signal` is the turn's (plus a deadline),
  `secrets` is what the host resolved for the session's owner, and `timeoutMs` is the resolved
  limit. `hands` reads no environment variable and no database: whatever a tool needs, the
  server puts in `secrets` (the same injected-resolver rule the brain's credential resolver
  follows).
- **The limit is the smaller of the tool's own and the host's.** `ToolRunContext.timeoutMs` is a
  ceiling, not an override — a host can shorten a call, never lengthen what a tool declared —
  and the tool is told the resolved number in `ctx.timeoutMs`.
- **A cut-short call is reported as cut short, whatever the tool did about it.** A timeout
  aborts the call's signal and answers `Tool <name> timed out after <n> ms.`; a turn abort
  answers `Interrupted by the user.`; a call whose signal was already aborted when it arrived
  is never started. A tool that cooperates (returns its own partial answer) does not get to
  rewrite that: the model is owed one story about the call.
- **The limit is a race, not a hint.** The call is run against its deadline and the turn's
  signal, and the first of the three to settle wins — so a tool that ignores the signal it was
  handed (a library that takes none, a hand-written loop) is cut short anyway, and one hung
  call cannot hold a turn open for as long as it likes. The abandoned call is left running
  against an aborted signal and its answer is discarded.
- **The turn's secrets are scrubbed out of every result and every thrown message.** Every
  outcome passes through one redaction, so "a secret never reaches the log" (X11) is a property
  of the registry rather than a rule each tool has to remember. Values are matched whole, so a
  result that merely resembles one is left alone.
- **How much of a result a request keeps is the tool's declaration, not the registry's doing.**
  `maxResultTokens` (epic #303, X9; #306) is the tool's own judgement about its output — a
  fetched page against a todo list — and the brain caps a result to the smaller of it and
  the share of the chat model's budget no single result may take, head and tail around an
  omission marker. Nothing here enforces it: the whole result is stored in the log and the tool
  still sees it, and the cap is what the _model request_ carries. `DEFAULT_TOOL_RESULT_TOKENS`
  is what a definition that names none gets.

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
to `DEFAULT_MAX_REDIRECTS`) is the default policy, which `web_fetch` uses.

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

### Calling a remote tool (epic #303, X10; #312)

`createMcpTool(options)` turns one tool of a listed server into an ordinary `ToolDefinition`, so
the registry runs a remote call exactly as it runs a local one — the permission, the timeout
race, the abort signal and the secret scrubbing are all the registry's, and nothing downstream
learns which tools are local.

- **The name is the model-facing one.** A remote tool is offered as `<server>__<tool>`
  (`@openharness/protocol`'s `mcpToolOfferedName`), never under the server's own spelling: two
  servers may each have a `search`, and a provider refuses a name outside `[a-zA-Z0-9_-]{1,64}`.
- **The model is shown the server's own JSON Schema.** `ToolDefinition.inputJson` carries it and
  a request offers it as received — translating an MCP tool's schema into zod would drop
  whatever the translator did not model — while `inputSchema` is a permissive `z.looseObject({})`
  so the registry validates that a call is an object and nothing more. The remote server is the
  authority on its own arguments.
- **The default policy is `ask`** (`DEFAULT_MCP_TOOL_PERMISSION`): a remote server is somebody
  else's code, so the user is asked the first time and may remember the answer (#309).
- **The answer is shaped, not passed through.** `mcpResult` renders text blocks as text, MCP's
  `structuredContent` as pretty-printed JSON, and anything this protocol cannot carry — an
  image, an audio clip, an embedded resource — as a marker naming what is not there; a
  `resource_link` becomes a marker carrying its address. The result leads with a line naming the
  server and the tool and saying the content is third-party data, never instructions (X11) — the
  same rule `web_fetch` states. MCP's `isError` becomes the result's `isError`.
- **Every header the call was made with is scrubbed out of its answer and its errors**, so a
  server that echoes the request back stores `[REDACTED]` rather than a token.
- **A call opens its own connection and closes it again**, and a failure — unreachable, refused,
  timed out — comes back as an `is_error` result rather than an exception, like every other way
  a call can end. `DEFAULT_MCP_TOOL_TIMEOUT_MS` (60 s) is the ceiling, which the host's own
  per-turn limit can lower. Nothing here caches a connection, an address or a token: MCP session
  state is the remote server's, and a client kept alive across a turn would have to be
  re-validated after every sleep, timeout and abort.

## Cloning a repository (epic #349, K3)

`cloneRepository` is the one other thing here that reaches a URL a user supplied: the **skill
import** reads a public git repository with it, once, at one commit, and stores what it found.
It is deliberately the narrowest thing that can do that.

- **`isomorphic-git`, in this process.** No `git` binary, no shell, no subprocess: a packfile is
  parsed by a JavaScript library, and "what a repository is" stays one answer rather than two
  programs'. A `depth: 1, singleBranch: true, noCheckout: true` clone means the commit's tree is
  all that is fetched — no history, no working directory.
- **Into memory, and nowhere else.** The repository lives in `createMemoryFileSystem()`, which is
  dropped when the clone ends; a path it is handed is normalized textually, so `..` cannot climb
  out of the tree. Nothing of a repository nobody has reviewed touches the host's disk.
- **Every request through `safeFetch`.** `https` **and `http`** (the guard's rule; the _route_
  is what insists a user's URL is `https`), a private, loopback, link-local or metadata address
  refused unless the deployment's self-host flag turns that off, every redirect re-checked, and
  each hop's socket pinned to the addresses that were checked. No auth callback is installed, so
  a repository that wants credentials ends the clone as `authentication_required` rather than
  opening a prompt.
- **Bounded.** A running total over every request of the clone — the cap K4 really names is the
  clone, not one response — and one deadline for the whole thing.
- **A failure a caller can act on.** `GitCloneError` carries one of the protocol's own codes
  (`unreachable`, `not_a_repository`, `authentication_required`, `ref_not_found`, `over_limit`,
  `refused_address`), so the sentence a user reads is the protocol's and this module's job is
  only to decide which of them happened. The classification is coarse where a forge is
  deliberately opaque: GitHub answers `401` for a repository that does not exist as readily as
  for a private one, so a `401` says "private, or requires credentials" and no more.
- **No submodules and no LFS.** A tree entry of type `commit` is a gitlink whose object is in
  another repository; the walk that lists the tree reports the type without reading it and skips
  it, so a repository that uses submodules still imports its own files. An LFS pointer is stored
  as the small text file it is, and the LFS server is never asked for anything.

`parseGitUrl` is the reading of the URL itself: a browse URL (`https://github.com/o/r/tree/main/skills`,
`https://gitlab.com/g/r/p/-/tree/v1.2/skills`) is split into the three fields, the **earliest**
separator wins (GitLab's `-` and GitHub's `tree` are two grammars, and a GitLab path also contains a
bare `tree` later), and the first segment after the separator is the ref. A ref or path a caller
states explicitly beats what a URL implied.

`repositoryName` is the one name a URL implies: the last segment of the repository's path, with a
trailing `.git` dropped (`https://github.com/acme/release-notes.git` → `release-notes`). A skill's
name is its folder's, and a repository's **root** is not a folder — so the import reads a `SKILL.md`
sitting at a repository's root as a candidate named for the repository itself. It is a function of
the `url` `parseGitUrl` **answered**, not of what a user typed, which is what keeps a browse URL's
`/tree/<ref>/<path>` half out of the name.

## The test fixtures (`@openharness/hands/testing`)

The package has a second entry point, `@openharness/hands/testing`, for the fixtures another
package's tests are meant to reuse — the server's import routes and the e2e QA specs of #355 want
the same repository, and a fixture only one suite can reach is one the next suite rewrites.

`createGitFixture(options)` builds a repository from a map of files and serves it over **smart
HTTP on loopback**, exactly as a forge does: `GET /<name>/info/refs?service=git-upload-pack` for
the advertisement, `POST /<name>/git-upload-pack` for the packfile, both answered by real
`git upload-pack --stateless-rpc` (which is what `git http-backend` runs). So a test drives the
**real** `cloneRepository` — real `isomorphic-git`, real `safeFetch`, a real packfile — with no
internet and no flake.

```ts
const repo = await createGitFixture({ files: { 'skills/pdf/SKILL.md': '…' } })
const clone = await cloneRepository({ url: repo.url, allowPrivate: true })
await repo.commit({ ...files, 'skills/pdf/reference/notes.md': '…' }) // move the branch
await repo.tag('v1.0')
await repo.branch('stable')
await repo.head()
await repo.close()
```

- `repo.url` is `http://127.0.0.1:<port>/skills.git`, so a test driving the clone passes
  `allowPrivate: true` (the self-host flag) and one testing the guard's refusal passes nothing.
- The served repository is a real directory, so `repo.directory` can be inspected — and a test
  that needs an exotic tree (a gitlink, a tag) can run `git` against it itself.
- Two routes exist for the guard: `…/skills.git/redirect/private/info/refs` answers a `302` to
  the link-local metadata service, and `…/skills.git/redirect/self/info/refs` a `302` back to the
  fixture. `…/skills.git/stall` accepts and never answers, for a deadline.
- `gitAvailable()` says whether a `git` executable is on the path; **a suite that needs the
  fixture asks first and skips with a note**, the rule the Postgres suites follow for a database.
  The served side is real `git` on purpose: a hand-written packfile would test the client against
  our idea of the format rather than against git's.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`

`@openharness/config` is additionally allowed as a **devDependency**.

The registry's input schemas are `zod`'s, so a tool's contract with the model is one schema both
sides read — the registry parses a call with it, and the brain hands it to the AI SDK as the
tool definition a request offers.

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
- `registry.test.ts` is the tool registry on its own: the tools it holds and the name it
  refuses twice, the parsed input and the turn a tool is handed, and every way a call can end —
  an unregistered name, input the schema refuses, a thrown error (and one with nothing to say),
  a timeout (a call that ignores the signal is still cut short), a turn that aborted (before the
  call and during it, and one whose tool answers after it), the host's ceiling lowering a tool's
  own timeout, and the turn's secrets scrubbed out of a result and out of a thrown message.
- `markdown.test.ts` is the conversion on its own: the main content kept and script, style and
  chrome dropped, relative links and images resolved against the page's address, a link in
  another scheme kept as written and a `javascript:` one dropped by the extractor, headings,
  fenced code, lists and emphasis, the fallback for a page with no article in it, and an empty
  document.
- `markdown-extraction.test.ts` is the conversion on **saved pages** under `src/fixtures/`,
  each trimmed under 120 KB and read relative to the test file: the ynet homepage keeps its
  main headline and leads with it (no top bar, navigation or ticker before it), the Hacker News
  front page yields its story titles as links with their addresses resolved, the Wikipedia
  article keeps its first paragraph, none of them keeps a `<script>`'s text or a `window.`
  string, and a consent banner's words are dropped while a page that merely mentions cookies is
  kept. Every one of the five fixtures — the four above and the `windows-1255` Hebrew page —
  is also checked for the **stray punctuation** a converter emits on the wrong shapes: the
  Markdown never begins with an unmatched `[`/`]`, and carries no empty link or image (`[](`,
  `[ ](`).
- `web-fetch.test.ts` runs the tool against **local HTTP servers**, reached through the real
  guard with a resolver the test supplies — so the address checks and every redirect's re-check
  are the real ones and no test needs the internet. It covers the conversion a model reads (and
  that the result leads with the final URL after a redirect and the untrusted-data notice), text
  and JSON passed through, a content type that is not text refused, a non-2xx refused, the
  charset honoured (including a `windows-1255` fixture decoded through an injected `PageFetch`
  when the response names no charset, and a header charset winning over the page's own), the byte
  cap, the output cap and its truncation marker (which states how many of how many characters were
  shown), the declared `maxResultTokens`, a call cut short by its deadline, a redirect that lands
  on a private address refused, the metadata host, another scheme and a loopback-resolving name
  refused, the redirect cap, and the input schema.
- `todo.test.ts` is `todo_write`: the markers and the counts, a cleared list, the states it
  refuses, and the offer the model reads.
- `mcp-client.test.ts` runs `openMcpClient` against a real MCP server built from the same SDK
  on loopback: it initializes and lists tools as protocol definitions, follows pagination,
  carries the headers it was given, makes every request through the injected fetch, and closes.
  It uses the platform `fetch`, because `safeFetch` and the credential are the server's to
  inject.
- `mcp-tool.test.ts` runs `createMcpTool` through the **real registry** against a stateless stub
  MCP server on loopback: the offered name and the default `ask`, the server's own JSON Schema
  offered and a permissive validation, a call answered with the provenance line and its
  structured content, an `isError` answer, an image and an embedded resource each replaced by a
  marker, a `resource_link` rendered with its address, an unknown content type named rather than
  dropped, the headers carried to the server and scrubbed out of an answer that quotes them, a
  server that cannot be reached answered `is_error` rather than thrown, and a call cut short by
  the turn's ceiling. The stub is stateless — a fresh server and transport per request — because
  that is what the tool's open-call-close shape meets.
- `git-url.test.ts` is the URL table: a clone URL read as a repository and nothing else, a
  GitHub browse URL split into repository, ref and path (and a ref with no path under it), a
  GitLab one around its own `-`, a nested group kept with the repository, a self-hosted host and
  port kept, query/fragment/trailing slash dropped, a percent-encoded ref and path decoded, a
  repository itself called `tree` left alone — and every refusal: another scheme, a URL with
  credentials in it (whose value never reaches the message), and a URL naming no repository. The
  `repositoryName` table is the name a URL implies: the last path segment with a trailing `.git`
  dropped, read off the repository URL a browse URL was split into (never the `/tree/…` half),
  percent-decoded, and a name that merely contains `.git` left alone.
- `git-clone.test.ts` runs the clone against the **fixture** through the **real guard**, with the
  self-host flag: the default branch and its whole tree read back (the commit checked against
  `git rev-parse`), a branch, a lightweight tag, an annotated tag (peeled to the commit it names)
  and a commit sha cloned by name, a commit's files and not another branch's, an empty root, a
  submodule entry skipped rather than failing the clone, a ref that is not there, a loopback
  address refused unless the flag allows it (the same option on and off), something that is not a
  repository, an unreachable host, a redirect that lands on a private address refused, the byte
  cap and the deadline — and that two clones of one repository share no buffer.
- `git-clone-network.test.ts` is the **opt-in** half (`OPENHARNESS_TEST_NETWORK=1`), because it
  needs the internet: it clones `https://github.com/anthropics/skills` through the guard and
  checks the ref that is not there is answered `ref_not_found`. It leaves the egress proxy alone —
  a deployment behind one is a documented deployment — and it never turns a network failure into
  a pass: without the variable the file skips.
- `memory-fs.test.ts` pins the file system a repository writes into: bytes and text reads,
  `mkdir`/`readdir`/`rm`/`rmdir` and the `ENOENT`/`ENOTDIR`/`EEXIST`/`ENOTEMPTY` codes
  `isomorphic-git` branches on, a symlink followed by `stat` and not by `lstat`, a loop caught,
  and — the one that matters for a hostile repository — every `..` resolved inside the tree.
- `index.test.ts` covers the barrel.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- The `./testing` subpath is part of the package's contract too: a change to a fixture another
  package's tests import is a breaking change, and `AGENTS.md` is where it is described.
- Larger docs go in `packages/hands/docs/`.
