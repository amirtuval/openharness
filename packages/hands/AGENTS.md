# @openharness/hands

Pluggable _hands_: the tools behind `execute(name, input)`, the registry that runs one, and
the one outbound-request guard the rest of openharness uses.

Since epic #303 ([#304](https://github.com/amirtuval/openharness/issues/304)) this package
holds the **tool registry**: a tool declares its name, the description a model reads, an input
schema (zod), a default permission and a timeout, and `ToolRegistry.execute` runs one call of
one and turns every outcome into a `ToolResult` the brain stores. There is **no sandbox**: a
tool runs in this process. The built-in tools arrive with
[#305](https://github.com/amirtuval/openharness/issues/305) — `web_fetch`, `web_search` and
`todo_write`, below — the loop's first client was a test tool behind the server's
`OPENHARNESS_TEST_MODEL=mock` hook, and the MCP client will live here too
([#312](https://github.com/amirtuval/openharness/issues/312)).

**`safeFetch`** (epic #245, A3a) is the SSRF guard for a URL a **user** supplied, and is what
`web_fetch` uses. Everything else the server fetches is a constant URL it wrote itself, so
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

| export                                                                                                                                                                                                  | what it is                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safeFetch(url, init?, options?)`                                                                                                                                                                       | fetch a user-supplied URL, refusing everything below                                                                                                                                                                                                                  |
| `safeFetchResult(url, init?, options?)`, `SafeFetchResult`                                                                                                                                              | the same call, answering `{ response, url }` — the address the response finally came from, after redirects                                                                                                                                                            |
| `SafeFetchError`, `isSafeFetchError()`, `SafeFetchErrorCode`                                                                                                                                            | the refusal, with a stable `code`                                                                                                                                                                                                                                     |
| `AddressResolver`, `SafeFetchTransport`, `SafeFetchRequest`                                                                                                                                             | the two seams: how a host resolves, and how the request is made                                                                                                                                                                                                       |
| `SafeFetchOptions`                                                                                                                                                                                      | `allowPrivate`, `maxBytes`, `timeoutMs`, `idleTimeoutMs`, `maxRedirects`, the seams                                                                                                                                                                                   |
| `SAVE_TIME_LIMITS`, `STREAMING_LIMITS`, `STREAMING_IDLE_TIMEOUT_MS`                                                                                                                                     | the two presets: a tight check, and a streaming-safe model call                                                                                                                                                                                                       |
| `DEFAULT_MAX_BYTES`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_MAX_REDIRECTS`                                                                                                                                      | `1 MiB`, `30 s`, `5` — what a call with no options gets                                                                                                                                                                                                               |
| `isBlockedAddress()`, `isPublicAddress()`, `isMetadataHostname()`, `parseIpAddress()`, `parseIPv4()`, `parseIPv6()`, `ParsedAddress`                                                                    | the address rules, exported so a caller can reason about one on its own                                                                                                                                                                                               |
| `PACKAGE_NAME`                                                                                                                                                                                          | `'@openharness/hands'`                                                                                                                                                                                                                                                |
| `PROTOCOL_DEPENDENCY`                                                                                                                                                                                   | `@openharness/protocol`'s `PACKAGE_NAME`; proves the built-output edge                                                                                                                                                                                                |
| `createToolRegistry(tools)`                                                                                                                                                                             | a registry over a host's tools: look one up by name, or run one call                                                                                                                                                                                                  |
| `ToolRegistry`, `ToolRunContext`                                                                                                                                                                        | `{ tools, get(name), execute(name, input, ctx) }`, and what a caller tells `execute` about the turn (`signal`, `secrets`, a `timeoutMs` ceiling)                                                                                                                      |
| `ToolDefinition`, `ToolExecutionContext`, `ToolResult`                                                                                                                                                  | one tool — name, description, zod input schema, default permission, timeout, the result cap a request carries of its output (`maxResultTokens`, epic #303 X9; #306), `run` — and what `run` is handed (the turn's signal, its resolved limit, the per-user `secrets`) |
| `textResult(text)`, `errorResult(text)`                                                                                                                                                                 | the two results a tool normally answers with: one text block, the second with `isError: true`                                                                                                                                                                         |
| `DEFAULT_TOOL_TIMEOUT_MS`                                                                                                                                                                               | `30000` — a call's limit when its definition names none                                                                                                                                                                                                               |
| `DEFAULT_TOOL_RESULT_TOKENS`                                                                                                                                                                            | `4096` — the most of one call's result a model request keeps, when its definition names no `maxResultTokens` (epic #303, X9)                                                                                                                                          |
| `scrubText(text, values)`, `REDACTED_PLACEHOLDER`                                                                                                                                                       | the redaction every result passes through: `[REDACTED]` where a resolved secret was                                                                                                                                                                                   |
| `createWebFetchTool(options?)`, `WebFetchOptions`, `PageFetch`, `safePageFetch`, `WEB_FETCH_TOOL_NAME`                                                                                                  | `web_fetch`: a GET of a model-chosen URL through `safeFetch`, as Markdown                                                                                                                                                                                             |
| `WebFetchInputSchema`, `WebFetchInput`, `DEFAULT_MAX_FETCH_CHARS`, `WEB_FETCH_MAX_BYTES`, `WEB_FETCH_MAX_REDIRECTS`, `WEB_FETCH_TIMEOUT_MS`, `WEB_FETCH_USER_AGENT`                                     | its input, and the caps it enforces: 50,000 characters of output, 2 MiB of response, 5 redirect hops, a 20 s call                                                                                                                                                     |
| `htmlToMarkdown(html, url)`                                                                                                                                                                             | the conversion `web_fetch` runs: main content, script and style dropped, relative links resolved against `url`                                                                                                                                                        |
| `createWebSearchTool(options)`, `WebSearchToolOptions`, `WEB_SEARCH_TOOL_NAME`, `WEB_SEARCH_API_KEY`                                                                                                    | `web_search`: one search through the deployment's provider, bounded by a per-user daily allowance                                                                                                                                                                     |
| `WebSearchInputSchema`, `WebSearchInput`, `DEFAULT_SEARCH_COUNT`, `MAX_SEARCH_COUNT`, `WEB_SEARCH_TIMEOUT_MS`                                                                                           | its input, and its bounds: 5 results by default, at most 20, a 15 s call                                                                                                                                                                                              |
| `createBraveSearchProvider(options)`, `BraveSearchOptions`, `BRAVE_SEARCH_PROVIDER`, `BRAVE_SEARCH_ENDPOINT`, `BRAVE_TIMEOUT_MS`, `BRAVE_MAX_COUNT`, `SUPPORTED_SEARCH_PROVIDERS`, `SearchProviderName` | the Brave adapter, its fixed endpoint, and the provider names this build serves                                                                                                                                                                                       |
| `SearchProvider`, `SearchRequest`, `SearchResult`, `SearchResultSchema`, `SearchTransport`, `SearchRequestInit`, `SearchResponse`                                                                       | the adapter seam: what a provider is, what one query is, and how a request reaches the internet                                                                                                                                                                       |
| `todoWriteTool`                                                                                                                                                                                         | `todo_write`: the whole list, replacing the previous one                                                                                                                                                                                                              |

### The built-in tools (epic #303; #305)

Three tools ship with this package. They are ordinary `ToolDefinition`s — nothing in the
registry knows they are special — and each one's _default permission_ is `allow` (the epic's
default policies), so an unfiltered registry offers them to the model.

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
  to _this_ use: `script`, `style`, `noscript`, `template`, `iframe` and `svg` are dropped
  before anything reads the page (turndown would otherwise emit a `<style>`'s rules as text),
  and every link is resolved against the address the page was fetched from so a model can
  follow it. A page `Readability` finds no content in falls back to the stripped document, and
  the page's own `<title>` is put back as a heading.
- **Text and JSON pass through** as they are; **anything else** (an image, a PDF) is refused
  with an `is_error` result naming the content type, because bytes that are not text are not
  something to store as if they were. A response that names no content type is read as text.
- **The charset the response names is honoured** (a `windows-1252` page would otherwise come
  back with every accented character replaced), with UTF-8 when it names none.
- **The result leads with the address — the _final_ one, after redirects — and says the
  content is untrusted data from the web, not instructions.** That sentence is the threat
  model's rule made visible to the model on the one path where a page's text could be mistaken
  for a command.
- **The output is capped** at `DEFAULT_MAX_FETCH_CHARS` (50,000 characters — a long article,
  about twelve thousand tokens), on top of `safeFetch`'s byte cap (2 MiB here, twice the
  guard's default, because HTML is mostly markup the Markdown conversion drops). A page over
  the cap is cut with a marker saying so, never silently. What a _result_ may cost the whole
  context is [#306](https://github.com/amirtuval/openharness/issues/306)'s.
- A non-2xx answer is refused rather than converted: a 404 page is not the page.

**`web_search`** (`src/web-search.ts`) is served by **one operator key**, so the deployment
pays for what a user asks and the tool is bounded twice:

- **The provider is behind an adapter** (`src/search.ts`): `SearchProvider` is one method
  (`search({ query, count, apiKey, signal })`), `createBraveSearchProvider` is the first
  implementation — a plain JSON `GET` of Brave's endpoint with the key in
  `X-Subscription-Token`, no SDK, a free tier an operator can start on — and
  `SUPPORTED_SEARCH_PROVIDERS` is the list a deployment's configuration is validated against.
  Only `title`, `url` and `description` are read out of a result, and a payload that is not a
  page of results is an error rather than an empty list: "Brave refused this key" and "nothing
  on the web matched" are different answers.
- **The key travels per call, in the turn's per-user values** (`WEB_SEARCH_API_KEY`), not in
  the adapter: `@openharness/hands` reads no environment variable, and the host is what holds
  the operator's secret — which also means the registry's scrubbing applies to it, so a result
  that somehow quoted the key stores `[REDACTED]`.
- **The daily allowance is the host's, not the tool's**: the tool names the limit in the
  notice it answers with, and the server decides by handing the key over or withholding it
  (see `apps/server/AGENTS.md`). A tool that is handed no key answers
  `Search limit reached: this account has used all N of its web searches for today.`
- **A deployment with no provider configured does not register the tool at all** — the model
  is offered no search rather than a tool that always fails.

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
const registry = createToolRegistry([echo]); // throws on two tools sharing a name
const result = await registry.execute("echo", call.input, { signal, secrets });
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
  search's answer against a fetched page — and the brain caps a result to the smaller of it and
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
- `web-fetch.test.ts` runs the tool against **local HTTP servers**, reached through the real
  guard with a resolver the test supplies — so the address checks and every redirect's re-check
  are the real ones and no test needs the internet. It covers the conversion a model reads (and
  that the result leads with the final URL after a redirect and the untrusted-data notice), text
  and JSON passed through, a content type that is not text refused, a non-2xx refused, the
  charset honoured, the byte cap, the output cap and its truncation marker, a call cut short by
  its deadline, a redirect that lands on a private address refused, the metadata host, another
  scheme and a loopback-resolving name refused, the redirect cap, and the input schema.
- `search.test.ts` is the Brave adapter against a stub transport: the endpoint, the query and
  count it asks for, the operator's key in its header, the results it reads out (title, URL and
  a snippet with the provider's markup stripped, an entry with no URL skipped), the count capped
  at what Brave accepts, a refusal thrown with what the provider said, a payload that is not a
  page of results, and an endpoint a deployment names instead.
- `web-search.test.ts` is the tool on its own: the results it renders, the count it asks for,
  the key it hands the adapter, the allowance notice a call with no key gets (and that the
  adapter is never reached), a failing provider answered as an `is_error` result, no results,
  and the input schema.
- `todo.test.ts` is `todo_write`: the markers and the counts, a cleared list, the states it
  refuses, and the offer the model reads.
- `index.test.ts` covers the barrel.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/hands/docs/`.
