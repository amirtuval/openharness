# @openharness/client

A typed SDK for the openharness API, used by both the web app and the TUI. It speaks the
`@openharness/protocol` contract over HTTP and SSE, authenticates the two ways the API accepts
(the web app's session cookie, the CLI's bearer token — plus the device-flow helpers behind
`oh login`), carries a transcript reducer that both frontends share, and ships a fake client
the frontends test against.

```ts
import { createClient, createTranscript } from '@openharness/client'
import { createFakeClient } from '@openharness/client/testing'
```

## Commands

Run from this folder (`packages/client`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`)                  |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | watch mode                                                              |
| `yarn typecheck`    | `tsc --noEmit` for `tsconfig.json` and for `tsconfig.tooling.json`      |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

## Environments

The client is loaded by browsers (the web app) and by Node 24 (the TUI, tests, scripts), so
`src/` is written against the APIs both have:

- No `node:*` imports, no `Buffer`, no `process`. `fetch`, `ReadableStream`, `TextDecoder`,
  `AbortController`, `DOMException` and the timers are the whole toolbox.
- `tsconfig.json` extends `@openharness/config/tsconfig/base.json` (`types: []`) with
  `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, so a `Buffer` or a `process.env` in a source
  file is a type error. The `*.config.ts` files are Node programs and are checked by
  `tsconfig.tooling.json` (the only program that sees `@types/node`).
- `src/browser.test.ts` is the runtime half of the same rule: it runs under `@vitest-environment
jsdom` with `Buffer` stubbed out, and streams a turn through the client and the transcript.
  (jsdom is a devDependency of this package.)
- The global `fetch` is called as `globalThis.fetch(...)`: a bare reference throws
  "Illegal invocation" in browsers.

## Layout

```
src/
  index.ts              the barrel: the client, the transcript, the errors, the device login
  client.ts             createClient, the Client interface, me/sendMessage/interrupt
  http.ts               request building, response parsing, error mapping, FetchLike
  errors.ts             ApiError, AuthenticationError, ResponseValidationError, status → type
  transcript.ts         TranscriptState, reduceTranscript, selectors, createTranscript
  providers.ts          PROVIDERS: the frontends' view of the shared provider list — the
                        protocol's id/name/key URL/credential type, plus free-tier and
                        key-format hints (#209, #245)
  resources/agents.ts   agents.create/get/list/update
  resources/auth.ts     auth.startDeviceLogin/pollDeviceLogin/signOut, DeviceLoginError
  resources/models.ts   models.list: the model catalog (epic #92)
  resources/preferences.ts  preferences.get/put: the caller's default model (#111)
  resources/provider-credentials.ts  providerCredentials.list/put/delete
  resources/sessions.ts sessions.create/get/list/delete + sessions.events.send/list/iterate/stream
  resources/usage.ts    usage.session/usage.me: what a session and the caller spent (#247)
  events/sse.ts         the SSE parser over a ReadableStream
  events/stream.ts      the reconnect/resume loop around it
  internal/async.ts     sleep and a small async queue (the fake's plumbing)
  internal/events.ts    isEventList: one user event or a list, shared by the client and the fake
  testing/index.ts      createFakeClient
  testing/fake-brain.ts the fake's turn loop: log, scripts, subscribers
  testing/titles.ts     the server's session-naming rule, restated for the fake
  testing/freeze.ts     deepFreeze: the fakes hand out frozen events (D9)
  test-support/         test-only helpers (mock fetch, response builders)
```

## Public API

### `@openharness/client`

| export                                                                                          | what it is                                                                                                           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `createClient(options)`                                                                         | build a client                                                                                                       |
| `Client`, `ClientOptions`, `RequestOptions`                                                     | the interface both the real and the fake client implement                                                            |
| `AgentsResource`, `SessionsResource`, `SessionEventsResource`                                   | the resource interfaces                                                                                              |
| `ProviderCredentialsResource`                                                                   | `providerCredentials.list/put/delete`                                                                                |
| `ModelsResource`                                                                                | `models.list`: the chat models the caller's keys can use (epic #92)                                                  |
| `PreferencesResource`                                                                           | `preferences.get/put`: the caller's stored default model (#111)                                                      |
| `UsageResource`                                                                                 | `usage.session(id)` and `usage.me(range)`: what was spent, priced on the server (#247)                               |
| `AuthResource`                                                                                  | `auth.startDeviceLogin/pollDeviceLogin/signOut`                                                                      |
| `OPENHARNESS_CLI_CLIENT_ID`                                                                     | the `client_id` the device flow presents: `'openharness-cli'`                                                        |
| `DeviceLoginError`, `DeviceLoginStart`, `PollDeviceLoginOptions`                                | the device flow's error, its start result and its poll options                                                       |
| `StreamOptions`                                                                                 | `{ deltas?, afterSeq?, signal? }` for `events.stream`                                                                |
| `SendMessageOptions`                                                                            | `sendMessage`'s options: cancellation, the `model` to switch to, the `reasoningEffort` (#252), and `rewindTo` (#238) |
| `FetchLike`, `DebugHook`, `RawResponse`                                                         | the `fetch` seam, the hook for what the client skips, the raw answer                                                 |
| `ApiError`, `AuthenticationError`, `ResponseValidationError`, `errorTypeForStatus()`            | the three errors and the status → `error.type` map                                                                   |
| `createTranscript()`, `reduceTranscript()`, `reduceTranscriptAll()`, `initialTranscriptState()` | the transcript store and the pure reducer                                                                            |
| `selectMessages()`, `selectIsRunning()`, `selectLastMessage()`, `selectStreamingMessage()`      | selectors                                                                                                            |
| `Transcript`, `TranscriptState`, `TranscriptMessage`, `TranscriptError`                         | the transcript's types                                                                                               |
| `MessagePart`, `TextPart`, `TranscriptMessageMeta`, `TranscriptUsage`, `PendingModelRequest`    | a message's typed parts, a reply's metadata, and its bookkeeping (#201)                                              |
| `SessionUsage`, `SessionModelUsage`, `SessionUsageTotals`, `ModelPriceLookup`                   | the session's totals as the transcript keeps them, and how a frontend prices them (#247)                             |
| `selectSessionUsage()`, `sessionUsageOf()`, `sessionCost()`, `replyCost()`                      | what a session and a reply cost, from the log's tokens and the catalog's rates (#247)                                |
| `PROVIDERS`, `providerInfo()`, `providerName()`, `ProviderInfo`                                 | the model providers a form or a tile needs (#209; built from the shared list, #245)                                  |
| `CREDENTIAL_TARGETS`, `CredentialTarget`                                                        | every provider _and_ named credential type a form or a tile offers (#245 A3a)                                        |
| `credentialDisplayName()`, `credentialTargetFor()`                                              | what to call a stored credential, and which tile its row reopens                                                     |
| `PACKAGE_NAME`                                                                                  | the package name; a dependent's cheap proof that the import resolved                                                 |

### `@openharness/client/testing`

| export                                                                      | what it is                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `createFakeClient(options?)`                                                | an in-memory `Client` with a scriptable brain and device flow                              |
| `FakeClient`, `FakeClientOptions`, `FakeReplyOptions`, `FakeFailureOptions` | the fake's interface and the options its scripting takes                                   |
| `FakeDeviceFlowOptions`                                                     | the script `scriptDeviceLogin` takes                                                       |
| `FakeReply`, `FakeFailure`, `FakeScript`                                    | one scripted reply, one scripted failure, and the queue entry they compose                 |
| `ModelListCall`                                                             | one `models.list` call the fake answered, and its `refresh` flag                           |
| `FAKE_MODEL_USAGE`, `FAKE_SESSION_TOKEN`                                    | the token usage every fake model request reports; the token the fake's device flow returns |

## The client

```ts
const client = createClient({
  baseUrl: 'https://api.example.com', // a trailing slash is ignored
  token: myToken, // the CLI's bearer token; omit it in a browser (the cookie authenticates)
  fetch: myFetch, // optional; defaults to the global fetch
  onDebug: (message, detail) => {}, // optional; see "Unknown events" below
})

// Model-first: chatting needs no agent — pick a model and go (epic #92).
const session = await client.sessions.create({ model: { id: 'anthropic/claude-sonnet-5' } })

// Or from an agent preset, optionally overriding its model or system prompt.
const agent = await client.agents.create({
  name: 'Summarizer',
  model: { id: 'anthropic/claude-sonnet-5' },
})
const preset = await client.sessions.create({ agent: agent.id, system: 'Be terse.' })

await client.sendMessage(session.id, 'Summarize the README.')
for await (const event of client.sessions.events.stream(session.id, { deltas: true })) {
  // ...
}
```

| method                                           | wire                                                                                                | returns                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `me(options?)`                                   | `GET /v1/me`                                                                                        | `User`                                                       |
| `agents.create(body, options?)`                  | `POST /v1/agents`                                                                                   | `Agent`                                                      |
| `agents.get(id, options?)`                       | `GET /v1/agents/{id}`                                                                               | `Agent`                                                      |
| `agents.list(params?, options?)`                 | `GET /v1/agents`                                                                                    | `{ data, next_page }`                                        |
| `agents.update(id, body, options?)`              | `POST /v1/agents/{id}`                                                                              | `Agent`                                                      |
| `sessions.create(body, options?)`                | `POST /v1/sessions`                                                                                 | `Session`                                                    |
| `sessions.get(id, options?)`                     | `GET /v1/sessions/{id}`                                                                             | `Session`                                                    |
| `sessions.list(params?, options?)`               | `GET /v1/sessions`                                                                                  | `{ data, next_page }`                                        |
| `sessions.delete(id, options?)`                  | `DELETE /v1/sessions/{id}`                                                                          | `void` (the wire answers `204`)                              |
| `sessions.events.send(id, events, options?)`     | `POST /v1/sessions/{id}/events`                                                                     | `{ data: user event[] }` (a rewind's event is the server's)  |
| `sessions.events.list(id, params?, options?)`    | `GET /v1/sessions/{id}/events`                                                                      | `{ data: stored event[], next_page }`                        |
| `sessions.events.iterate(id, params?, options?)` | the same, page after page                                                                           | `AsyncIterable<StoredEvent>`                                 |
| `sessions.events.stream(id, options?)`           | `GET /v1/sessions/{id}/events/stream`                                                               | `AsyncIterable<StreamEvent>`                                 |
| `providerCredentials.list(options?)`             | `GET /v1/provider-credentials`                                                                      | `{ data: credential metadata[] }`                            |
| `providerCredentials.put(provider, body, …)`     | `PUT /v1/provider-credentials/{provider}`                                                           | `ProviderCredential` (metadata only)                         |
| `providerCredentials.delete(provider, options?)` | `DELETE /v1/provider-credentials/{provider}`                                                        | `void` (the wire answers `204`)                              |
| `models.list(params?, options?)`                 | `GET /v1/models`                                                                                    | `{ data: ModelEntry[], providers: ProviderCatalogStatus[] }` |
| `preferences.get(options?)`                      | `GET /v1/me/preferences`                                                                            | `{ default_model }` (`null` when none is set)                |
| `usage.session(id, options?)`                    | `GET /v1/sessions/{id}/usage`                                                                       | `{ session_id, totals, cost, by_model }`                     |
| `usage.me(params?, options?)`                    | `GET /v1/me/usage` (`from`, `to`, `tz`)                                                             | `{ from, to, totals, cost, by_model, by_day }`               |
| `preferences.put(preferences, options?)`         | `PUT /v1/me/preferences`                                                                            | `{ default_model }` (the stored value)                       |
| `auth.startDeviceLogin(options?)`                | `POST /api/auth/device/code`                                                                        | `DeviceLoginStart`                                           |
| `auth.pollDeviceLogin(code, options?)`           | `POST /api/auth/device/token`, polled                                                               | the session token (`string`)                                 |
| `auth.signOut(options?)`                         | `POST /api/auth/sign-out`                                                                           | `void`                                                       |
| `sendMessage(id, text, options?)`                | `POST …/events` with one `user.message` — and a `session.rewind` first when `rewindTo` asks for one | the stored `UserMessageEvent`                                |
| `interrupt(id, options?)`                        | `POST …/events` with one `user.interrupt`                                                           | the stored `UserInterruptEvent`                              |

Notes worth knowing before reading the code:

- **Bodies and responses are parsed with the protocol's schemas.** Requests are sent as given;
  responses are validated, and a 2xx that does not match the protocol throws
  `ResponseValidationError` rather than returning a half-typed object. Unknown _fields_ are
  stripped by the schemas, so a real Anthropic response still parses.
- **Cursors are opaque.** `next_page` is handed back as `page` byte for byte; the client never
  decodes one. `iterate` walks pages until `next_page` is `null`, and stops if a server ever
  answers with a cursor it has already been given (which would otherwise page forever).
- **Query parameters** are spelled the way the protocol documents: array values repeat their
  key with a `[]` suffix (`types[]=user.message&types[]=agent.message`). Values are
  percent-encoded; the keys are constants and are written verbatim.
- **Auth** is the two ways the API accepts (epic #65, A2). Every request is sent with
  `credentials: 'include'`, so a browser carries the web app's session cookie, and a client
  built with a `token` sends `Authorization: Bearer <token>` — the CLI.
- **`options.signal`** cancels any request; the promise then rejects with the abort reason.
- **`sendMessage(id, text, { model })`** rides the `model` on its `user.message` (epic #116,
  U1): the log records the choice, and the turn the message starts runs it. A caller that
  builds the event itself passes the same `model` to `sessions.events.send`.
- **`sendMessage(id, text, { reasoningEffort })`** rides a `reasoning_effort` the same way
  (#252): `low`, `medium` or `high`, or `null` for the provider's default again. The brain maps
  the level onto whichever knob the model's provider has; a model that takes none runs the
  provider's default, and the request's `span.model_request_start` records what was asked for
  beside what was applied.
- **`sendMessage(id, text, { rewindTo })`** is "edit and resend" (#238): the rewind travels
  with the message in one request and one append — `[session.rewind, user.message]` — so the
  session is never rewound without the edit, and the rewrite is atomic in the log too. The
  `seq` is the edited message's own position, which {@link TranscriptMessage.position}
  carries. The server refuses one while a turn is running (409 `conflict_error`): the reply in
  flight belongs to the branch being taken back.
- A failed `fetch` (no network, DNS, TLS, an abort) rejects with the original error — only an
  answer from the server becomes an `ApiError`.

### Errors

`ApiError` has `status`, `type` (the protocol's `ApiErrorType`, e.g. `not_found_error`),
`message`, `requestId?` and a `retryable` getter (`429`, `500`, `502`, `503`, `504`, `529`). It
is built from the protocol's error envelope; a body that is not the envelope (HTML from a
proxy, an empty body) falls back to the type the status maps to.

A **401 is an `AuthenticationError`** — an `ApiError` subclass with everything fixed to
`status: 401`, `type: 'authentication_error'` — so a frontend can send the user to sign-in, or
the CLI to `oh login`, with one `instanceof`; the event stream stops on it instead of
reconnecting. It is an `ApiError`, so broader handlers keep working.

```ts
try {
  await client.sessions.get(id)
} catch (error) {
  if (error instanceof AuthenticationError) showSignIn()
  else if (error instanceof ApiError && error.type === 'not_found_error') showMissing()
  else if (error instanceof ApiError && error.retryable) retryLater()
}
```

### The signed-in user

`client.me()` is `GET /v1/me`, the identity every request is scoped to; the CLI prints
`Logged in as <email> on <server>` from it and uses it as `oh whoami`.

### Provider credentials

`client.providerCredentials` is the write-only credential API (epic #65, A5; named credentials:
#245 A3a): `put` sends the request body to `PUT /v1/provider-credentials/{name}` and returns the
stored **metadata** — the secret itself is never in a response, an error or a type here; `list`
reads the metadata array; `delete` answers `204`, so it resolves `void`. The name is the
credential's own: a provider id for an `api_key`, or one the reader chose (`azure`, `azure-eu`)
for a named type. `put` requires a fresh session server-side, and a credential the provider
rejects comes back as a 422 `invalid_provider_credential`.

### The model catalog

`client.models.list()` is `GET /v1/models` (epic #92): the chat models the caller's stored
provider keys can use, sorted by provider then name. `data` carries the entries — `<provider>/<model>`
`id`, display `name`, `context_window` and `max_output_tokens` (nullable), and `source`,
`'provider'` or `'registry'` — and `providers` one status per provider the caller has a key
for: `ok`, or `fallback` when the provider's own list failed or timed out and the registry's
chat models stood in.

The server caches the answer in memory per user and provider for an hour;
`list({ refresh: true })` is the one spelling that bypasses the cache (the parameter is left
off the wire otherwise). Refreshing is rate-limited to once a minute per user, so a
too-frequent one is answered `429 rate_limit_error` — an `ApiError` with `retryable: true`,
which a Refresh button should surface to the user rather than retry in a loop.

### Usage and cost (#247)

`client.usage` is the two reads that answer what was spent: `usage.session(id)` for one
session's totals and `usage.me({ from, to, tz })` for the caller's own, by model and by day.
Both are owner-scoped server-side (another user's session is a 404, and there is no id in the
per-user path), and both answer **cost** — computed by the server from the log's tokens and its
vendored prices, `null` for a model nobody prices.

The transcript carries the same numbers for a screen that is already following a session, which
is why a client rarely needs either route:

- `TranscriptState.usage` is the newest `session.usage` event the reducer has folded in — the
  session's **running** totals, per model, each entry with its token counters and its request
  count (the event carries them cumulatively).
- `selectSessionUsage(state)` answers that, or **derives** the same totals from the transcript's
  replies for a session stored before the event existed. The two agree by construction: the
  event is what a fold over the stored spans produces, and the derivation counts one request per
  reply that named a model.
- `sessionCost(usage, prices)` and `replyCost(meta, prices)` turn tokens into money with the
  catalog's rates (`ModelEntry.cost`), which is what a frontend passes in as a `ModelPriceLookup`
  — `modelPriceLookup(models)` in the web app. `replyCost` is one request's money, `null` for a
  reply whose model nobody prices — `—` on screen, never a zero. `sessionCost` is a **total**: a
  `TotalCost` of `cost` (the priced requests summed, or `null` when none could be priced) and
  `unpriced_requests` (how many were left out, counted per model from the event's request counts
  — #247, decided 2026-10-09), which a frontend renders as `$1.23 + 4 unpriced` and `—` only for
  the `null`.
- A `session.rewind` drops `state.usage`: the totals the rewind replaced counted a branch that is
  gone, and the derivation from the messages that survived is right until the next request writes
  a fresh snapshot.

### Preferences and deleting a session

`client.preferences` is the caller's own settings (#111): `get` reads
`GET /v1/me/preferences` and `put` writes the complete value to `PUT /v1/me/preferences` —
there is no partial update, and `default_model: null` clears the stored choice. `default_model`
is the `provider/model` a new chat starts with, validated for shape only (a free-text id the
catalog has not caught up with is allowed); it is `null`, never a 404, for an account that has
never saved one. Both routes are owner-only, like `GET /v1/me`.

`client.sessions.delete(id)` removes a session and its whole log (`DELETE /v1/sessions/{id}`,
answered `204`, so it resolves `void`). It is owner-scoped: another user's session is answered
as if it did not exist, which is also what an unknown or already-deleted id gets
(`not_found_error`). A stream following the session receives one final `session.deleted`
event — stream-only, with no `seq` — and the server closes the connection; the client ends the
iteration there instead of reconnecting, and the transcript folds the event into
`deleted: true`.

### Creating a session (model-first)

`client.sessions.create(body)` takes the protocol's `CreateSessionRequest`: an agent, a model,
or both — **at least one of `agent`/`model`**, which the request schema's refinement enforces
on the wire and the server answers as a 400.

- `{ model: { id: 'provider/model' }, system? }` creates a **model-first** session: no agent,
  the model it runs, and `system` (a string, or `null` for none).
- `{ agent: 'agent_…', model?, system? }` snapshots the agent preset and runs it; an explicit
  `model`/`system` overrides what the agent contributes, field by field.

Every session the API returns carries `model` and `system` — the configuration it actually
runs, always set — beside its `agent` snapshot, which is `null` for a model-first session
(issue #93). Read those two, not `agent.model`, in code that has to work for both shapes.

### The device flow (`oh login`)

`client.auth` drives Better Auth's device-authorization plugin under `/api/auth` — not the
`/v1` protocol, so its shapes are typed here. RFC 8628 as the plugin implements it:

```ts
const start = await client.auth.startDeviceLogin()
// { deviceCode, userCode, verificationUri, verificationUriComplete, interval, expiresIn }
// open a browser at verificationUriComplete ?? verificationUri and show userCode

const token = await client.auth.pollDeviceLogin(start.deviceCode, {
  interval: start.interval, // seconds
  signal, // optional: Ctrl+C
})
await client.auth.signOut() // revokes the session the client's token stands for
```

- The **`client_id`** is the exported `OPENHARNESS_CLI_CLIENT_ID` (`'openharness-cli'`); #61
  registers exactly that value server-side. The request also carries
  `scope: 'openid profile email'`, the plugin's documented example.
- **Polling** waits the interval before every request (RFC 8628; default five seconds),
  treats `authorization_pending` as "keep waiting", adds five seconds to the interval on
  `slow_down`, and throws a **`DeviceLoginError`** (with `code` and `description`) on
  `expired_token`, `access_denied` and the rest. A transport failure or a non-device status
  throws an `ApiError` — the caller decides whether to retry.
- The success body's `access_token` (a session token) is what `pollDeviceLogin` resolves
  with; `signOut` is `POST /api/auth/sign-out` with the bearer token and an empty JSON body
  (Better Auth's endpoints require a JSON content type, and a bodyless POST has none).

### Unknown events

Event types are a closed union, and the protocol grows. On the **stream**, an event a client
does not know is **skipped, not thrown**: it is dropped and reported through `onDebug`, so an
older client keeps working against a newer server. `events.list` (and `iterate`) does not
skip: the response is validated against the protocol's schema, and an event the schema
rejects fails the request with `ResponseValidationError`. The transcript reducer itself
tolerates an event it does not know when one is handed to it, and still advances `lastSeq`.

## Streaming and resume

`sessions.events.stream(sessionId, { deltas?, afterSeq?, signal? })` is an async iterable of
`StreamEvent`s, parsed from an SSE stream over `fetch` — not `EventSource`, which cannot send
the `Authorization` header the CLI authenticates with.

- **`deltas`** opts in per connection with `event_deltas[]=agent.message`, which is what makes
  the server send the `event_start` and `event_delta` chunks of a reply. The chunks are stored
  events (D9), so they take the stored-event path below and the connection needs nothing else:
  a reply in flight is replayed like any other range of the log.
- **`afterSeq`** is where to start. Omitted means _live only_: the stream delivers what happens
  next, not the history. Load history with `events.iterate`, fold it into the transcript, and
  pass `transcript.getState().lastSeq` to continue exactly where it stopped. `afterSeq: 0`
  replays the whole log.
- **Resume.** The client remembers the last stored event's `seq` — a chunk counts, so a
  disconnect mid-reply resumes mid-reply — and, when the connection drops or the server closes
  it, reconnects with `last-event-id: <seq>` **and** `after_seq=<seq>`, so the server resumes
  from the same position whichever one it honors. Anything at or below that `seq` is dropped
  before it reaches the caller, so a resume can neither duplicate nor skip a stored event.
  Reconnects back off from 500 ms to 15 s (with ±25% jitter).
- **Keepalive comments** (`: ping`) and any other comment line are ignored.
- **`session.deleted` ends the stream** (#111). It is the stream-only last event of a deleted
  session: the client yields it and then returns quietly, the way an abort ends the
  iteration — reconnecting could only ask for a session that is gone, so the loop would churn
  through 404s. The transcript folds it into `deleted: true`.
- **When it stops.** `signal.abort()` ends the iteration quietly — no throw — so a caller can
  `for await` without a try/catch. An `ApiError` that is not retryable (an unknown session) is
  thrown: retrying it forever would only hide the problem — and a **401 is an
  `AuthenticationError`** (never retryable), so a signed-out caller learns to sign in instead
  of watching a stream reconnect forever. A dropped connection, a retryable status and a
  non-SSE `200` are treated as transport failures; the first two reconnect, the third is a
  server bug and is thrown.

## The transcript reducer

`createTranscript()` folds events into the state a chat UI renders. It is pure and
serializable, and framework-free: the state is plain data, so React and Ink can both hold it
(React's `useSyncExternalStore(transcript.subscribe, transcript.getState)` takes exactly the
pair this store exposes).

```ts
const transcript = createTranscript()

// Rebuild from history, then follow live.
for await (const event of client.sessions.events.iterate(sessionId)) transcript.apply(event)
for await (const event of client.sessions.events.stream(sessionId, {
  deltas: true,
  afterSeq: transcript.getState().lastSeq,
}))
  transcript.apply(event)
```

```ts
interface TranscriptState {
  // { id, role, text, parts, meta?, pending, streaming, position, modelChangedTo? }
  messages: TranscriptMessage[]
  status: 'idle' | 'running' // from the session status events
  lastError: TranscriptError | null // { type, message, retryStatus }
  lastSeq: number // the `seq` to resume from
  deleted: boolean // a `session.deleted` arrived: the session is gone (#111)
  model: string | null // the model the log last said the session runs (#111)
  pendingRequests: PendingModelRequest[] // bookkeeping for `meta`; empty between turns (#201)
}
```

**A message is typed parts, not text** (epic #201, X1). `parts: readonly MessagePart[]` is a
discriminated union on `type`; only `{ type: 'text', text }` exists today, and `thinking`,
`tool_use`, `tool_result`, `question` and `approval` are the members the next phases add —
named in the type's TSDoc, deliberately not implemented, with no protocol event behind them
yet. `text` stays `parts.join('')` of the text parts, so a caller that only wants the words
does not change. Both frontends render `message.parts` through a `Record<MessagePart['type'],
Renderer>`, so the new members are a compile error until each frontend has drawn them.

The rules it implements, in one place:

- **Messages come from stored events, keyed by id.** `user.message` adds a `user` message;
  `agent.message` **replaces** whatever the transcript holds for the same id — the chunks
  accumulated so far, or nothing at all — and never merges.
- **A reply carries what it cost** (epic #201, U1). The turn's `span.model_request_start`
  names the model and opens a tracked request ({@link PendingModelRequest}), its
  `span.model_request_end` reports the tokens and closes it, and the reply takes them all as
  `meta: { model?, durationMs?, usage? }`. The span end arrives _after_ the reply, so the
  metadata is written twice: the model when the reply lands, the tokens and the time when the
  end arrives. A reply the brain retried takes the request that failed too, so its tokens sum
  and its duration runs from the first start to the last end — the time a reader waited. A
  turn that ends (`session.status_idle`) drops the requests no reply ever claimed. Anything
  the log does not say is absent, never `0`: a view that joined after a reply's span start
  cannot name its model, and one that never saw a span reports no `meta` at all.
- **Every message has a position, and `messages` stays sorted by it.** A reply in flight sits
  where its chunks started (its `event_start`'s `seq`, or its first delta's `seq` when the
  start was skipped); a finished reply sits where it started (`supersedes.from_seq`, the
  `{ from_seq, to_seq }` chunk range D9 adds); a user message sits at its `seq`. A reply
  interleaved with a steering message therefore renders identically for a client that followed
  its chunks and one that only ever saw the stored message, live or after a reload. Every
  event is a stored one, so every position is a real `seq`.
- **A reply's chunks are stored events.** Since D9 the chunks are `event_start` /
  `event_delta` with an `id` and a `seq`, so they flow through the `seq <= lastSeq` dedupe,
  advance `lastSeq`, and make `Last-Event-ID` resume work mid-reply. A chunk without the
  stored envelope does not parse and is skipped like any event this client does not know.
- **The chunks accumulate.** `event_start` opens an empty `agent` message with `streaming:
true`, keyed by the id of the event it previews; `event_delta`s extend it (per content-block
  `index`, so a multi-block message accumulates correctly). A delta for a message that is
  already stored is ignored: the stored event is the record.
- **Unreconciled previews are dropped** on `span.model_request_end` — including the previews of
  a chunk range the span end `supersedes` — and on `session.status_idle`, which is the same
  statement about a turn that has ended: a preview no stored event ever replaced belonged to a
  request that failed, was interrupted, or ended without a reply, and there is nothing to keep.
  The idle half is what makes the rule hold when the span end never arrives: a stored event
  this client cannot parse is skipped (`events/stream.ts`), and without it a preview would stay
  `streaming` for the life of the session — an empty reply bubble in a frontend that renders
  one (#40).
- **`pending` clears on the claim.** The event that answers a user message names it in its
  `consumes`: a `span.model_request_start` claims the messages its request folds in (P3), and a
  `span.model_request_end` or `session.status_idle` claims the interrupts it ends on (P4). A
  message queued _while_ a turn is running (a steering message) stays pending until the request
  that claims it, and it keeps its place in the conversation. A claim event with no list at all
  is a log stored before D9 and keeps the older reading for a span start — everything pending
  was picked up — while a span end or an idle without a list claims nothing.
- **An interrupt keeps the partial reply**: the text produced so far is stored as an
  `agent.message` (carrying `supersedes` over its chunks), the span closes with an `interrupted`
  error, and the turn goes idle.
- **`status`** is `running` from `session.status_running` and `session.status_rescheduled` (a
  session that is retrying is not idle), and `idle` from `session.status_idle`.
- **`lastError`** is the latest `session.error`, and is cleared by an `agent.message` (the turn
  recovered and produced a reply). An error that ends a turn stays visible.
- **`lastSeq`** advances to the highest `seq` seen, and an event at or below it is dropped
  before anything else happens — so history and a resumed stream can overlap, and loading the
  same history twice changes nothing.
- **`session.deleted` is a terminal end state** (#111). It has no `seq` — it is stream-only —
  so it is folded in _before_ the dedupe above, and the only thing it does is set
  `deleted: true`; seeing it again changes nothing. The stream ends after it, so a UI reacts
  to the state rather than to the end of an iteration.
- **A `session.rewind` drops the branch it replaced** (#238). Editing a message restarts the
  session from it, and the rewind carries the range it replaced — from the edited message
  through the last event before the rewind. Everything the transcript is showing from there on
  belongs to a branch the session is no longer on (a client that loads the session later never
  receives any of it, because replay skips the range), so the rewind drops those messages,
  the `lastError` it replaced, and the requests of the turn it replaced. The test is each
  message's `position`: everything the range covers — at or after its `from_seq`, and not past
  its `to_seq` — is inside it, and everything else stays exactly where it was. The `to_seq`
  bound is what keeps the edit itself: a client that sent it has already applied the stored
  message (whose `seq` is past the range), and the rewind the stream echoes behind it carries
  the lower `seq` of the range — the one event the `seq <= lastSeq` dedupe must not swallow.
  A rewind is applied wherever it arrives, and applying it twice changes nothing.
- **A `model` on a `user.message` may switch the session** (epic #116, U1). `state.model`
  becomes the new id, and the message carries `modelChangedTo` when that id differs from the
  one already in effect — the change a UI draws its marker for. The first model the log shows
  is not a change (`state.model` starts at `null`), so it sets the state silently, and a
  message naming the model already in effect changes nothing.

## Provider metadata (#209, #245)

`src/providers.ts` is the list both frontends offer: one `ProviderInfo` per provider — the
**provider id** (the `provider` half of a `provider/model` string), the display name, the
**credential type** that selects the form (epic #201, X6), the "get a key" URL, an optional
free-tier hint (X8) and an optional key-format hint for an input's placeholder.

It is presentation metadata, not a capability list: authorization is still the server's
(`PUT /v1/provider-credentials/{name}`). Since #245 it is **built from** the shared provider
list (`@openharness/protocol`'s `PROVIDERS`, epic #245, A0) rather than restated: the id, the
name, the credential type and the key URL come from that list, and `PRESENTATION` — a
`Record<ProviderId, …>` — adds the two hints only a form or a tile needs. That is what makes "it
describes providers the server will accept a key for" a compile-time property: there is one
list, so there is nothing left for `e2e`'s removed `provider-metadata.test.ts` to hold together.

`providerName(id)` answers the display name for a **provider id** and falls back to the id — the
credentials API takes any router provider, so a reader who typed an id this list does not carry
sees what they typed, never a blank.

**`CREDENTIAL_TARGETS` is what an Add-provider surface offers** (epic #245, A3a/A3b): the eleven
providers, then the named credential types. A `CredentialTarget` carries the _name_ a first save
uses (a provider id, or the type's default — `azure`, `custom`), the display name, the credential
type that selects the form (X6), the key URL, and `named` — whether the reader may keep more than
one, each under a name they choose. The key URL is **optional**: a custom OpenAI-compatible
endpoint (#249) has no console to link to, so its target omits `keyUrl` and the form offers no
link. `credentialTargetFor(credential)` answers the target a _stored_ credential's Replace
reopens, and `credentialDisplayName(credential)` is what a list row is called: the provider's
name, the type's display name where the name is its default, and the reader's own label
otherwise — so `azure-eu` is called `azure-eu` and two Azure rows are told apart.

The web app builds its first-run tiles, its Add-provider dialog and its Settings list from this
(#209); `oh` will offer the same providers in the terminal (#210, X7).

## The fake client

`@openharness/client/testing`'s `createFakeClient()` is an in-memory server behind the same
`Client` interface as the real one: same methods, same event order per turn, same `seq` rules,
same `after_seq` backlog, same error envelopes. Component tests written against the fake
therefore run unchanged against the real API, which is why the web app and the TUI test with it.

```ts
import { createFakeClient } from '@openharness/client/testing'

const fake = createFakeClient()
fake.respondWith('Hello from the fake!', { chunks: 3 }) // script the next reply

const stream = collectEvents(
  fake.sessions.events.stream(fake.session.id, {
    deltas: true,
    afterSeq: 0, // 0 replays the log so far, exactly like the server
  }),
)
await fake.sendMessage(fake.session.id, 'Hi') // starts a turn
await fake.waitForIdle() // the whole turn, retries included
```

`fake.session`, `fake.agent` and `fake.user` are the seeded trio. `fake.session` and
`fake.agent` are **live views through the fake's own store**, not the seed objects:
`fake.session.status` and `fake.session.model` read the current state, and an update through
`fake.agents.update(...)` is visible through `fake.agent` immediately (issue #106).
`fake.user` is what `me()` answers. `createFakeClient({ session, agent, user, preferences, authenticated, delayMs, now })`
seeds your own, sets how slowly the stream runs, and fixes the clock. The seeded session runs
the seeded agent's configuration, the way one created from that agent would.

`sessions.create` takes both shapes the real endpoint does (issue #93): `{ model }` for a
model-first session — `agent: null`, the model it runs, `system: null` unless given — and
`{ agent }` for one snapshotted from a preset, with `model`/`system` overriding what the
preset contributes. A body that matches neither is refused with the server's 400
`invalid_request_error`; an inline `model.id` that is not the router's `provider/model` shape
is refused the same way, exactly where the server checks it (issue #94, `sessions.create`
only — agent bodies are not shape-checked, because the server does not check them either);
and the created session runs the model it was created from, so a turn's
`span.model_request_start` carries that model.

**A session is named by its first message, in the fake too** (#29, #105). The request that
stores the first `user.message` — `sendMessage`, `events.send` and the `initial_events` of
`sessions.create` alike — derives the title from it with the server's rule (the first
non-empty line, whitespace collapsed, cut to `SESSION_TITLE_MAX_LENGTH` with an ellipsis;
`src/testing/titles.ts` restates `apps/server/src/titles.ts` for the fake), and never over a
title that exists. The naming _replaces_ the brain's session object rather than mutating it,
so a caller holding an earlier read keeps its stale `title: null` until it re-reads — the
one-re-read flow the frontends have (#35) — while `fake.session` and later reads carry the
title immediately.

`sessions.delete(id)` deletes a session the way the route does (#111): one final
`session.deleted` event is delivered to that session's subscribers — the streams close behind
it — the log is dropped, and from then on `sessions.get`, the events routes and `sendMessage`
answer the 404 `not_found_error` an unknown id gets, as does deleting it a second time. A
`user.message` sent with a `model` stores the choice on the event and switches the fake
session's live `model`, so the next turn's `span.model_request_start` carries it — while a
session created with a model still runs the model it was created with.

`sessions.events.send` (and `sendMessage`) takes a `session.rewind` too (#238), the way the
route does: the fake stores the rewind's own event — with the range the server would record,
`from_seq` through the end of its log — and the batch's other events beside it, in one
append. A refused rewind refuses the whole request, as one append does, with the two answers
the server gives: the 409 `conflict_error` while a turn is running (the reply in flight
belongs to the branch being taken back) and the 400 `invalid_request_error` for a `from_seq`
that names nothing a reader could edit — no event there, not a `user.message`, or a message an
earlier range already replaced. What a range covers is skipped by the fake's reads too, which
is what the server's replay does: a reloaded client sees the conversation as if the edited
message had been the one sent.

**The fake refuses what the server refuses, the way the server refuses it** (#121). Bodies go
through the same protocol schemas the routes parse them with — `agents.create` and
`agents.update` with their request schemas, `events.send` (and `sendMessage`) with
`SendEventsRequestSchema` / `UserMessageEventInputSchema`, `sessions.create` with
`CreateSessionRequestSchema` plus the model-id shape check — and what the schema parsed is
what is stored, so an unknown field is stripped rather than kept. Every refusal is the
server's 400: `invalid_request_error`, the message composed exactly as
`apps/server/src/http/errors.ts` composes it. And a `page` cursor is checked for kind:
`agents`/`sessions` lists take a `key` cursor and the events list takes a `seq` cursor, and
the other kind — or a string that is no cursor at all — is the same 400 the server answers,
never a silent page 1.

| scripting                  | what it does                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `respondWith(text, opts?)` | queue a reply for the next model request; `chunks` a count or the exact fragments, `delayMs` a pace          |
| `failWith(opts?)`          | queue a failure: `type`, `message`, `retryStatus` (`retrying` keeps the turn alive, the rest end it)         |
| `scriptDeviceLogin(opts?)` | script the device flow `oh login` runs: `pendingPolls`, `slowDownPolls`, `outcome`, and the codes it reports |
| `waitForIdle(sessionId?)`  | resolve when the session's turn — retries included — has finished                                            |
| `history(sessionId?)`      | the session's stored event log, in order                                                                     |

**Authentication is simulated too.** The fake is signed in unless `authenticated: false`, in
which case every `/v1` method — `me`, the credentials, the catalog, the streams — rejects with
`AuthenticationError`, the way a 401 answers. `fake.auth` implements the device flow with the
same contract as the real one (it sleeps between polls, so `interval` defaults to 0 in the
script to keep tests instant): `startDeviceLogin()` reports deterministic codes — the server's
URI shape, `<base>/#/device` with `?user_code=…` inside the fragment (A6), not a query before
the hash — `pollDeviceLogin` answers `authorization_pending` for `pendingPolls` polls and
`slow_down` for the next `slowDownPolls`, adding five seconds to its interval on each
`slow_down` exactly as the real client does (the constant is shared with `resources/auth.ts`,
not restated), and then resolves with `FAKE_SESSION_TOKEN` — signing the fake in — or throws a
`DeviceLoginError` for `denied` and `expired`. `signOut()` signs it out again.

```ts
const fake = createFakeClient({ authenticated: false })
fake.scriptDeviceLogin({ pendingPolls: 2, outcome: 'approved' })

const start = await fake.auth.startDeviceLogin() // deviceCode 'fake_device_code', userCode 'FAKE-CODE'
const token = await fake.auth.pollDeviceLogin(start.deviceCode) // FAKE_SESSION_TOKEN
const me = await fake.me() // fake.user
```

The credential routes are an in-memory store: `put` keeps the metadata (`last4` from the key)
and never the key, replacing keeps `id` and `created_at`, `delete` is idempotent, and an empty
key answers 422 `invalid_provider_credential` — the one provider rejection a test can spell
without a provider.

The preferences routes are an in-memory value too: `{ default_model: null }` unless
`createFakeClient({ preferences })` seeds it, `put` replaces it whole, and both answer 401
while signed out like every `/v1` route.

The credentials are configurable too: `createFakeClient({ credentials })` seeds the store with
metadata-only rows, which is what a screen that behaves differently for an account **with** a key
needs — the first-run check is the one that made this an option (#209) — because `put` cannot run
before a synchronous render. The store itself follows the server: `put` replaces one provider's
row, `delete` is idempotent, an empty key is answered 422 `invalid_provider_credential` — unless
the type is `openai_compatible`, whose key is optional (#249), so a keyless one is accepted with
an empty `last4` — and the **first** save with no default stored picks one the way U4 does — the
saved provider's first catalog model, else the catalog's first, and never over a default that is
already there. The public `details` it stores come from the protocol's `credentialDetails`, the
same helper the server's `credentialUpsert` calls, so a faked custom credential's metadata
matches the real route's (a base URL's host). The recommendation table the server keeps is the
one thing the fake does not restate.

The usage reads are answered from the fake's own logs (#247), the way the server answers them
from a real one: `fakeRequestsOf` pairs a session's spans (through the replay read, so a rewound
branch is not counted), `fakeUsage` prices them with the catalog the fake lists and assembles the
totals and the per-model split, and `usage.me` groups the caller's requests by the local day they
fell on in the zone it was given (`fakeUsageRange`/`fakeLocalDay`, `Intl` as the server uses it).
The fake's own `session.usage` events are written by its brain after every request that reported
usage, in the same spot the real brain writes them — so a component test that reads either the
transcript's totals or the route sees the same numbers. A zone the runtime does not know is the
400 `invalid_request_error` the server answers, and an unknown session is a 404.

The model catalog is configurable too: `createFakeClient({ models, providers })` seeds what
`models.list` answers — one `anthropic/claude-sonnet-5` entry with an `ok` status by default —
served sorted by provider then name, the way the server sorts it. Every call is recorded, so a
component test can assert what the picker asked for:

```ts
await fake.models.list({ refresh: true })
expect(fake.modelListCalls).toEqual([{ refresh: true }])
```

Calls queue up, so a retry is "fail once, then succeed":

```ts
const fake = createFakeClient()
fake.failWith({ retryStatus: 'retrying' })
fake.respondWith('Second time lucky.')

// → session.error, session.status_rescheduled, session.status_running, the reply, idle
```

An interrupt cuts a slow stream in the middle and keeps what it produced:

```ts
const fake = createFakeClient({ delayMs: 10 })
fake.respondWith('One two three four five', { chunks: 5 })
// ... start reading the stream with deltas, then:
await fake.interrupt(fake.session.id)
// → a user.interrupt, the partial agent.message, an interrupted span end, idle
```

Details that follow the server and can surprise a test:

- **A stream is live by default.** Without `afterSeq` it delivers only what happens next, so
  start reading _before_ sending the message that starts the turn (or pass `afterSeq: 0`).
- **A reply's bubble is placed where its chunks started** — and the fake talks the P4 server's
  dialect: the chunks are stored events, the request's span start claims its messages in
  `consumes`, the span end or the idle claims the interrupts it ends on, and the finished
  message carries `supersedes` over its chunk range. A steering message sent mid-reply lands
  after the reply's start, which is where it arrived in time.
- **The events it emits are frozen.** The fake's log is append-only in the same sense the real
  one is (D9): every event is deep-frozen before it is stored or delivered, and nothing
  rewrites one — including `processed_at`, which a read derives from a note the brain keeps
  beside the log, fed by the `consumes` lists of the events it emits, exactly as the real store
  derives it from `event_claims`. A test that tries to rewrite an emitted event fails at the
  attempt instead of corrupting what other readers see.

Deliberate differences, so a test does not read more into the fake than is there:

- **No network, and no pace-based limits.** A request never fails for transport reasons, and
  the server's guards that exist because of how fast a caller is going are not simulated:
  `models.list` never answers the 429 its once-a-minute refresh limit produces, and the device
  flow's `slow_down` is scripted by position (`slowDownPolls`) rather than decided from the
  pace of the polls. What the scripted answers _make the client do_ — the interval the poll
  loop grows to — is the real client's behaviour, because the constant is shared.
- **One user, one process.** There is no second account to prove isolation against and no
  cross-instance ordering to worry about, so the fake never answers the 404 an
  ownership-scoped route gives another user's resource.
- **A malformed path id is a 404, not the 400 the server's id schemas give it.** The fake
  looks an id up as given; only bodies and cursors go through the protocol's schemas.

## Testing

`src/**/*.test.ts` with Vitest: `node` everywhere except `src/browser.test.ts`, which declares
`@vitest-environment jsdom`. `src/providers.test.ts` holds what the metadata list must be on its
own — unique ids, https key URLs, and a credential type the protocol's request schema parses. The suite drives a mock `fetch` (`src/test-support/mock-fetch.ts`)
rather than a server: request building and response parsing (cookie and bearer, `me`, the
credential routes, the preferences routes — `null` and a refused value included — deleting a
session's 204, the model catalog, sending a message with a model — and with a reasoning effort — and creating a session from
a model, from an agent and with overrides — each body asserted against
`CreateSessionRequestSchema`), the 401 → `AuthenticationError` mapping, the transport-side
leak assertions (a rejected key and a bearer token appear in the request and in no error,
stack or debug line), the device flow's polling with fake timers (`src/auth.test.ts`), the
SSE parser's edge cases, reconnect/resume (including a resume mid-reply, from a stored chunk,
and the stream ending on `session.deleted` without a reconnect), the server's `event: error`
goodbye being skipped with the loop ending on the 401 its reconnect meets, every transcript
rule (the model-switch marker and the deleted flag
included), typed parts (one text part per content block, a streamed reply's parts equal to the
stored one's) and per-reply metadata (the model, the duration and the tokens off the spans; a
retried reply's summed tokens; `undefined` where the log says nothing), one scripted D9
session folded from five different client views that must all converge on the same
conversation — metadata included, except that the view which joined after the reply's span
start cannot know its model — frozen events through the reducer, the fake's own auth
(signed-out 401s, credentials, preferences, the scripted device flow — `slow_down` included),
the fake's naming of a session from its first message, its 400s and cursor kinds (each case
asserted against the protocol schema that refuses it), the default model a first credential save
picks and the default it leaves alone, a deleted fake session's final event
and the 404s that follow it, and the fake against the real client on the same scripted
scenario (the fake's events are replayed to the real client as an SSE body, and the two
transcripts must be equal — a retried reply's metadata included).

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol` (including its `@openharness/protocol/fixtures` subpath, which the
  fake uses to build schema-shaped resources)

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/client/docs/`.
