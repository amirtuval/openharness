# @openharness/client

A typed SDK for the openharness API, used by both the web app and the TUI. It speaks the
`@openharness/protocol` contract over HTTP and SSE, carries a transcript reducer that both
frontends share, and ships a fake client the frontends test against.

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
  index.ts              the barrel: the client, the transcript, the errors
  client.ts             createClient, the Client interface, sendMessage/interrupt
  http.ts               request building, response parsing, error mapping, FetchLike
  errors.ts             ApiError, ResponseValidationError, status → error type
  transcript.ts         TranscriptState, reduceTranscript, selectors, createTranscript
  resources/agents.ts   agents.create/get/list/update
  resources/sessions.ts sessions.create/get/list + sessions.events.send/list/iterate/stream
  events/sse.ts         the SSE parser over a ReadableStream
  events/stream.ts      the reconnect/resume loop around it
  internal/async.ts     sleep and a small async queue (the fake's plumbing)
  testing/index.ts      createFakeClient
  testing/fake-brain.ts the fake's turn loop: log, scripts, subscribers
  testing/freeze.ts     deepFreeze: the fakes hand out frozen events (D9)
  test-support/         test-only helpers (mock fetch, response builders)
```

## Public API

### `@openharness/client`

| export                                                                                          | what it is                                                           |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `createClient(options)`                                                                         | build a client                                                       |
| `Client`, `ClientOptions`, `RequestOptions`                                                     | the interface both the real and the fake client implement            |
| `AgentsResource`, `SessionsResource`, `SessionEventsResource`                                   | the resource interfaces                                              |
| `StreamOptions`                                                                                 | `{ deltas?, afterSeq?, signal? }` for `events.stream`                |
| `FetchLike`, `DebugHook`                                                                        | the `fetch` seam, and the hook for what the client skips             |
| `ApiError`, `ResponseValidationError`, `errorTypeForStatus()`                                   | the two errors and the status → `error.type` map                     |
| `createTranscript()`, `reduceTranscript()`, `reduceTranscriptAll()`, `initialTranscriptState()` | the transcript store and the pure reducer                            |
| `selectMessages()`, `selectIsRunning()`, `selectLastMessage()`, `selectStreamingMessage()`      | selectors                                                            |
| `Transcript`, `TranscriptState`, `TranscriptMessage`, `TranscriptError`                         | the transcript's types                                               |
| `PACKAGE_NAME`                                                                                  | the package name; a dependent's cheap proof that the import resolved |

### `@openharness/client/testing`

| export                                                                      | what it is                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `createFakeClient(options?)`                                                | an in-memory `Client` with a scriptable brain            |
| `FakeClient`, `FakeClientOptions`, `FakeReplyOptions`, `FakeFailureOptions` | the fake's interface and the options its scripting takes |
| `FAKE_MODEL_USAGE`                                                          | the token usage every fake model request reports         |

## The client

```ts
const client = createClient({
  baseUrl: 'https://api.example.com', // a trailing slash is ignored
  apiKey: 'oh_...', // sent as `x-api-key`
  fetch: myFetch, // optional; defaults to the global fetch
  onDebug: (message, detail) => {}, // optional; see "Unknown events" below
})

const agent = await client.agents.create({
  name: 'Summarizer',
  model: { id: 'anthropic/claude-sonnet-5' },
})
const session = await client.sessions.create({ agent: agent.id })
await client.sendMessage(session.id, 'Summarize the README.')
for await (const event of client.sessions.events.stream(session.id, { deltas: true })) {
  // ...
}
```

| method                                           | wire                                      | returns                               |
| ------------------------------------------------ | ----------------------------------------- | ------------------------------------- |
| `agents.create(body, options?)`                  | `POST /v1/agents`                         | `Agent`                               |
| `agents.get(id, options?)`                       | `GET /v1/agents/{id}`                     | `Agent`                               |
| `agents.list(params?, options?)`                 | `GET /v1/agents`                          | `{ data, next_page }`                 |
| `agents.update(id, body, options?)`              | `POST /v1/agents/{id}`                    | `Agent`                               |
| `sessions.create(body, options?)`                | `POST /v1/sessions`                       | `Session`                             |
| `sessions.get(id, options?)`                     | `GET /v1/sessions/{id}`                   | `Session`                             |
| `sessions.list(params?, options?)`               | `GET /v1/sessions`                        | `{ data, next_page }`                 |
| `sessions.events.send(id, events, options?)`     | `POST /v1/sessions/{id}/events`           | `{ data: user event[] }`              |
| `sessions.events.list(id, params?, options?)`    | `GET /v1/sessions/{id}/events`            | `{ data: stored event[], next_page }` |
| `sessions.events.iterate(id, params?, options?)` | the same, page after page                 | `AsyncIterable<StoredEvent>`          |
| `sessions.events.stream(id, options?)`           | `GET /v1/sessions/{id}/events/stream`     | `AsyncIterable<StreamEvent>`          |
| `sendMessage(id, text, options?)`                | `POST …/events` with one `user.message`   | the stored `UserMessageEvent`         |
| `interrupt(id, options?)`                        | `POST …/events` with one `user.interrupt` | the stored `UserInterruptEvent`       |

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
- **Auth** is `x-api-key` (and nothing else: no `anthropic-version` is sent, since the brief
  for this issue names `x-api-key` as the whole auth story).
- **`options.signal`** cancels any request; the promise then rejects with the abort reason.
- A failed `fetch` (no network, DNS, TLS, an abort) rejects with the original error — only an
  answer from the server becomes an `ApiError`.

### Errors

`ApiError` has `status`, `type` (the protocol's `ApiErrorType`, e.g. `not_found_error`),
`message`, `requestId?` and a `retryable` getter (`429`, `500`, `502`, `503`, `504`, `529`). It
is built from the protocol's error envelope; a body that is not the envelope (HTML from a
proxy, an empty body) falls back to the type the status maps to.

```ts
try {
  await client.sessions.get(id)
} catch (error) {
  if (error instanceof ApiError && error.type === 'not_found_error') showMissing()
  else if (error instanceof ApiError && error.retryable) retryLater()
}
```

### Unknown events

Event types are a closed union, and the protocol grows. An event a client does not know is
**skipped, not thrown**: the stream drops it and calls `onDebug`, so an older client keeps
working against a newer server. `events.list` does the same thing, so the same unknown event in
history cannot break a transcript rebuild.

## Streaming and resume

`sessions.events.stream(sessionId, { deltas?, afterSeq?, signal? })` is an async iterable of
`StreamEvent`s, parsed from an SSE stream over `fetch` — not `EventSource`, which cannot send
the `x-api-key` header.

- **`deltas`** opts in per connection with `event_deltas[]=agent.message`, which is what makes
  the server send the `event_start` and `event_delta` chunks of a reply. The chunks are stored
  events (D9), so they take the stored-event path below and the connection needs nothing else:
  a reply in flight is replayed like any other range of the log, and a pre-P4 server's
  envelope-less preview does not parse and is skipped like any event this client does not
  know.
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
- **When it stops.** `signal.abort()` ends the iteration quietly — no throw — so a caller can
  `for await` without a try/catch. An `ApiError` that is not retryable (a bad key, an unknown
  session) is thrown: retrying it forever would only hide the problem. A dropped connection, a
  retryable status and a non-SSE `200` are treated as transport failures; the first two
  reconnect, the third is a server bug and is thrown.

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
  messages: TranscriptMessage[] // { id, role: 'user' | 'agent', text, blocks, pending, streaming, position }
  status: 'idle' | 'running' // from the session status events
  lastError: TranscriptError | null // { type, message, retryStatus }
  lastSeq: number // the `seq` to resume from
}
```

The rules it implements, in one place:

- **Messages come from stored events, keyed by id.** `user.message` adds a `user` message;
  `agent.message` **replaces** whatever the transcript holds for the same id — the chunks
  accumulated so far, or nothing at all — and never merges.
- **Every message has a position, and `messages` stays sorted by it.** A reply in flight sits
  where its chunks started (its `event_start`'s `seq`, or its first delta's `seq` when the
  start was skipped); a finished reply sits where it started (`supersedes.from_seq`, the
  `{ from_seq, to_seq }` chunk range D9 adds); a user message sits at its `seq`. A reply
  interleaved with a steering message therefore renders identically for a client that followed
  its chunks and one that only ever saw the stored message, live or after a reload. Every
  event is a stored one since P4, so every position is a real `seq` — the `lastSeq + 0.5`
  placement of stream-only previews went with them.
- **A reply's chunks are stored events.** Since D9 (phase P3 on the server) the chunks are
  `event_start` / `event_delta` with an `id` and a `seq`, so they flow through the
  `seq <= lastSeq` dedupe, advance `lastSeq`, and make `Last-Event-ID` resume work mid-reply.
  P4 removed the envelope-less form: a seq-less chunk from a pre-P4 server does not parse and
  is skipped like any event this client does not know.
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

`fake.session` and `fake.agent` are the seeded pair; both are the fake's live objects, so
`fake.session.status` reads the current state and an update through `fake.agents` shows up in
`fake.agent` at once. `createFakeClient({ session, agent, delayMs, now })` seeds your own, sets
how slowly the stream runs, and fixes the clock.

| scripting                  | what it does                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `respondWith(text, opts?)` | queue a reply for the next model request; `chunks` a count or the exact fragments, `delayMs` a pace  |
| `failWith(opts?)`          | queue a failure: `type`, `message`, `retryStatus` (`retrying` keeps the turn alive, the rest end it) |
| `waitForIdle(sessionId?)`  | resolve when the session's turn — retries included — has finished                                    |
| `history(sessionId?)`      | the session's stored event log, in order                                                             |

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

## Testing

`src/**/*.test.ts` with Vitest: `node` everywhere except `src/browser.test.ts`, which declares
`@vitest-environment jsdom`. The suite drives a mock `fetch` (`src/test-support/mock-fetch.ts`)
rather than a server: request building and response parsing, the SSE parser's edge cases,
reconnect/resume (including a resume mid-reply, from a stored chunk), every transcript rule,
one scripted D9 session folded from five different client views that must all converge on the
same conversation, frozen events through the reducer, and the fake against the real client on
the same scripted scenario (the fake's events are replayed to the real client as an SSE body,
and the two transcripts must be equal).

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol` (including its `@openharness/protocol/fixtures` subpath, which the
  fake uses to build schema-shaped resources)

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/client/docs/`.
