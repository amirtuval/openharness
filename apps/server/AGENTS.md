# @openharness/server

The runnable openharness server: the HTTP API the protocol describes, the SSE stream over a
session's event log, and the scheduler that runs brains against it. Hono app served by
`@hono/node-server`; the store is Postgres when there is a `DATABASE_URL` and in-memory when
there is not.

```bash
DATABASE_URL=postgres://localhost/openharness yarn dev   # http://localhost:3000
```

## Commands

Run from this folder (`apps/server`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds `src/` to `dist/` with tsdown (`.js` + `.d.ts`)                  |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | rebuilds on change and restarts the server (http://localhost:3000)      |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

## Routes

Everything under `API_VERSION_PREFIX` (`/v1`). Bodies and queries are validated by the
protocol's schemas, so the shapes are not repeated here — see
[`packages/protocol/AGENTS.md`](../../packages/protocol/AGENTS.md).

| method | path                                      | body / query                             | answers                                        |
| ------ | ----------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `GET`  | `/health`                                 | —                                        | `{ status: 'ok' }`; never needs a key          |
| `POST` | `/v1/agents`                              | `CreateAgentRequestSchema`               | 201, the `Agent`                               |
| `GET`  | `/v1/agents`                              | `ListAgentsQuerySchema`                  | `{ data, next_page }`                          |
| `GET`  | `/v1/agents/{agent_id}`                   | —                                        | the `Agent`, or 404                            |
| `POST` | `/v1/agents/{agent_id}`                   | `UpdateAgentRequestSchema`               | the updated `Agent`, or 404                    |
| `POST` | `/v1/sessions`                            | `CreateSessionRequestSchema`             | 201, the `Session`; 404 for an unknown agent   |
| `GET`  | `/v1/sessions`                            | `ListSessionsQuerySchema`                | `{ data, next_page }`                          |
| `GET`  | `/v1/sessions/{session_id}`               | —                                        | the `Session`, or 404                          |
| `POST` | `/v1/sessions/{session_id}/events`        | `SendEventsRequestSchema`                | `{ data: user event[] }`; then signals         |
| `GET`  | `/v1/sessions/{session_id}/events`        | `ListEventsQuerySchema`                  | `{ data, next_page }`                          |
| `GET`  | `/v1/sessions/{session_id}/events/stream` | `StreamEventsQuerySchema`                | the SSE stream; 404 for an unknown session     |
| `POST` | `/v1/sessions/{session_id}/ai-sdk/chat`   | the AI SDK `useChat` request (see below) | an AI SDK UI message stream — an **extension** |

There is no `GET /v1/models`: it is out of scope for v1 (the epic tracks it separately).
Anything else answers 404 in the protocol's error envelope.

`POST …/events` is the only way user input enters the system, and it does two things in a
fixed order: it **stores** the events (`processed_at: null`, which is what makes them queued)
and only then tells the scheduler. The store call is what makes the request durable; the
signal is a latency optimization the scheduler can afford to lose (see "Signals are hints" in
`packages/session`).

Creating a session with `initial_events` goes through the same rules: the protocol says those
events are stored "before it starts running", so a `user.message` among them signals `work` and
a `user.interrupt` signals `interrupt` — exactly what the same events would do posted to
`POST …/events` afterwards.

## Environment variables

| variable                              | default | what it does                                                  |
| ------------------------------------- | ------- | ------------------------------------------------------------- |
| `DATABASE_URL`                        | —       | run on Postgres, migrating on boot; unset means in-memory     |
| `OPENHARNESS_API_KEY`                 | —       | require `x-api-key` on `/v1/*`; unset leaves the API open     |
| `PORT`                                | `3000`  | the port to listen on                                         |
| `OPENHARNESS_TEST_MODEL`              | —       | `mock` swaps in the deterministic test model                  |
| `OPENHARNESS_WEB_DIR`                 | —       | a built web app to serve at `/`                               |
| `OPENHARNESS_CORS_ORIGINS`            | —       | comma-separated origins to allow; unset means no CORS headers |
| `OPENHARNESS_MAX_CONCURRENT_SESSIONS` | `4`     | how many sessions may be running at once                      |
| `OPENHARNESS_DRAIN_TIMEOUT_MS`        | `5000`  | how long shutdown waits for a turn in flight                  |

Provider credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are not read by this package:
the default model factory is the brain's `routerModelFactory`, and Mastra's router reads
whatever the provider it resolves needs from the environment itself.

A variable that is set but empty counts as unset. A value that cannot be what it claims — a
`PORT` that is not a port, an `OPENHARNESS_TEST_MODEL` that is not `mock` — fails the boot
with a message naming the variable, rather than coming up in a state nobody asked for.

**The store.** With `DATABASE_URL`, `main.ts` builds a pool, runs `migrate()` (idempotent, so
two instances starting together are safe) and hands the pool to `createPostgresSessionStore`.
Without it, the server runs on `InMemorySessionStore` and says so loudly at startup: that mode
is for local development and quick trials, and nothing survives a restart.

## Errors

Every failure is the protocol's envelope — `{ type: 'error', error: { type, message } }` with
the status `API_ERROR_STATUS_BY_TYPE` gives that type — and every response carries a
`request-id` header the body repeats as `request_id`.

| what happened                                          | type                    | status |
| ------------------------------------------------------ | ----------------------- | ------ |
| a body, query or path id that does not match a schema  | `invalid_request_error` | 400    |
| a store cursor that is valid but not for this endpoint | `invalid_request_error` | 400    |
| a missing or wrong `x-api-key`                         | `authentication_error`  | 401    |
| an id that names no agent or session                   | `not_found_error`       | 404    |
| a route that does not exist                            | `not_found_error`       | 404    |
| anything else                                          | `api_error`             | 500    |

A malformed path id is a 400 rather than a 404: it could not name a resource even if one
existed. Anything unrecognised is logged server-side and answered with a fixed message — a
stack trace is never part of a response.

## SSE

`GET …/events/stream` is the live half of the log, in the format `packages/client` reads:

- one message per event, `data: <the JSON StreamEvent>`;
- stored events also carry `id: <seq>` — the resume position — and stream-only previews
  (`event_start` / `event_delta`) carry none;
- `: ping` comments every 15 seconds when nothing else is happening.

The replay position comes from `after_seq` if the query carries it, otherwise from the
`last-event-id` header a reconnecting client sends back, otherwise from nowhere — and "nowhere"
means **live only**, which is the client's documented default. A header that is not a position
this server handed out (a `sevt_` id, say) is ignored rather than refused.

Replay and live delivery are stitched together so a client cannot tell where one ended:

1. **subscribe first** — the store starts buffering everything that happens from here;
2. **replay** the log after the resume position, page by page;
3. **flush the buffer**, dropping any stored event at or below the last `seq` the replay
   delivered, which is exactly the overlap.

`event_start` / `event_delta` are delivered only to a connection that asked for them with
`event_deltas[]=agent.message`. Disconnecting cancels the body stream, and that is what ends
the store subscription and the keepalive timer — there is nothing left running for a client
that has gone away.

## Scheduler

```ts
interface SessionScheduler {
  start(): Promise<void>
  stop(options?: { drainTimeoutMs?: number }): Promise<void>
  signal(sessionId: SessionId, kind: 'work' | 'interrupt'): void
}
```

Routes only ever call `signal`, and nothing else. Whether that reaches a brain in this process
or in another instance is the scheduler's business, which is what keeps the handlers unchanged
when ownership stops being trivial:

| implementation                   | how a signal reaches the owner                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `LocalScheduler` (this package)  | in-process: this server owns every partition                                                      |
| `PostgresPartitionScheduler` #11 | `store.signalPartition` onto the partition's channel, `store.onPartitionSignal` on the owner side |

`LocalScheduler` owns a queue and a `SessionRunner`. On `start()` it recovers: every session
`findSessionsNeedingWork` reports — queued user events, or a turn some dead process left open —
is queued. `work` enqueues the session, or wakes the pass already running for it; `interrupt`
aborts that pass's turn, and _starts a turn if none was running_, because a queued
`user.interrupt` still has to be claimed (the brain handles one and marks it processed). At
most `OPENHARNESS_MAX_CONCURRENT_SESSIONS` sessions run at once; the rest wait their turn.
`stop()` accepts nothing more, aborts the turns in flight and gives them the drain timeout to
write their last events.

```ts
class SessionRunner {
  run(
    sessionId: SessionId,
    options?: { fence?: PartitionFence; signal?: AbortSignal },
  ): Promise<TurnOutcome>
  isRunning(sessionId: SessionId): boolean
  wake(sessionId: SessionId): boolean
  abort(sessionId: SessionId): boolean
  runningSessions(): SessionId[]
  stop(options?: { drainTimeoutMs?: number }): Promise<void>
}
```

`SessionRunner` is the reusable half: **one turn per session at a time**, and after a `runTurn`
resolves it looks at the log again — `getPendingUserEvents` and `getTurnState` — to run another
one if there is work (a message queued behind an interrupt, an open turn). It stops on `noop`,
which is what keeps a session that cannot make progress from spinning — but a `wake` that
arrived during that `noop` turn is honored first, because the brain reads the log before it
decides and a signal for an event appended in that window would otherwise be lost. Calling
`run()` while a pass is in flight does not start a second one: it wakes the pass and answers
with its outcome.

**This is where #11 plugs in.** A `PostgresPartitionScheduler` acquires partition leases, listens
with `onPartitionSignal`, and calls the same `runner.run(sessionId, { fence })` with the lease it
holds — the `fence` goes straight to `runTurn`, so a brain whose lease has been taken over stops
at its first refused write. The scheduler above decides _which_ sessions are owned; the runner
decides _how_ they are run.

`run`'s optional `signal` is the other half of that: "this process should not be running this
session any more" — a shutdown, or a lease given up. A pass whose signal is already aborted
writes nothing and answers `noop`; one aborted mid-turn lets the turn end the way an interrupt
does and then stops instead of looking for more work. Nothing is lost either way: the work is in
the log, and the next owner finds it with `findSessionsNeedingWork`.

## The test model hook

`OPENHARNESS_TEST_MODEL=mock` swaps the brain's Mastra router for a deterministic model, so the
whole server — scheduler, brain, store, SSE, the AI SDK adapter — runs with no provider keys
and no network. It is an AI SDK `MockLanguageModelV4`, streamed through the same `streamText`
path a real provider goes through, and it lives in `mock-model.ts`; `resolveModelFactory` is
the only thing that constructs it, and it only does so when the variable says `mock`:

| last user message    | what happens                                                                |
| -------------------- | --------------------------------------------------------------------------- |
| anything else        | echoed back in 4 chunks, 25 ms apart                                        |
| `__slow__`           | 40 chunks, 250 ms apart — about 10 seconds, for interrupt and restart tests |
| `__fail_retryable__` | HTTP 503 (`model_overloaded_error`) on the **first** attempt, then the echo |
| `__fail_terminal__`  | HTTP 400 (`model_request_failed_error`) on every attempt                    |

A marker matches the _start_ of the message, so `__slow__ tell me something` still streams
slowly. Usage is fixed (`MOCK_MODEL_USAGE`: 42 input, 17 output, no cache) so a test can assert
the exact numbers a `span.model_request_end` carries. The retry marker counts attempts per
prompt, which is what lets it fail once and succeed on the retry inside one turn.

The startup log says which model the process is running with, and the in-memory store warns
just as loudly: a server quietly answering with fixed text would be a bad surprise.

## The AI SDK adapter

`POST /v1/sessions/{id}/ai-sdk/chat` is a **compatibility extension**, not part of the
protocol: nothing in `@openharness/protocol` mentions UI message chunks, and
`packages/client` does not use this endpoint. It exists so a React app built on `useChat` can
talk to a session without knowing about the event log.

It takes the last `user` message's text out of the AI SDK request (`parts`, or a `content`
string), appends it as a `user.message`, signals the scheduler, and answers with a UI message
stream built from the session's live events: previews become `text-start` / `text-delta` /
`text-end` under the `sevt_` id the brain announced, the stored `agent.message` closes the
block (streaming any tail the previews shed), a `session.error` becomes an `error` chunk, and
`session.status_idle` ends the response. The subscription is opened _before_ the message is
appended, so a turn that starts and finishes while the handler is still running is still seen —
and it is released in a `finally` however the response ended, because a subscription that
outlives its reader would keep buffering every later event of the session for nobody.

`session.status_idle` is also the only thing that ends the response. A turn that dies without
writing one (a store failure mid-turn, which the scheduler logs and drops) leaves the request
open until the client disconnects: the client's own abort signal is what closes it. The
protocol's SSE stream has the same stay-open-until-disconnected property.

`trigger: 'regenerate-message'` is treated as "send the last user message again": v1 has no
regenerate semantics, and answering the same prompt again is the closest honest reading.

## Static web assets

With `OPENHARNESS_WEB_DIR` set, the server serves that directory at `/`: a request that names a
file gets it, and any other GET outside `/v1` gets `index.html`, because the web app routes on
the URL hash. Paths that climb out of the directory are refused. Without the variable there is
no static serving at all, and `/` answers the API's 404.

## CORS

Off by default. `OPENHARNESS_CORS_ORIGINS` (comma-separated) enables it for exactly those
origins — nothing else, and no wildcard. A browser talking to this API needs it; the web app
served from the same origin does not.

## Shutdown

`SIGTERM` / `SIGINT` shut down in a fixed order: stop accepting requests, drain the scheduler
(abort the turns in flight, give them `OPENHARNESS_DRAIN_TIMEOUT_MS` to write their last
events), drop the connections still open — including SSE streams, which would otherwise never
end — and close the store. A second signal is ignored rather than allowed to interrupt the
drain.

## Public API

| `@openharness/server`                               | what it is                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `createApp(options)`                                | the Hono app: routes, auth, errors, static assets — against any store/scheduler |
| `startServer(options)`                              | store, migrations, model, scheduler, listener and a `shutdown()`                |
| `main(env, options)`                                | `startServer` from the environment, plus the signal handlers                    |
| `LocalScheduler`                                    | the single-process `SessionScheduler`                                           |
| `SessionRunner`                                     | the per-session turn loop, reusable (#11)                                       |
| `createMockModelFactory()`                          | the deterministic test model, for a host that wires its own                     |
| `readServerConfig(env)`, `ServerConfig`, `ENV_VARS` | the environment, parsed                                                         |
| `HttpError`, `PACKAGE_NAME`, `Logger`               | the error type, the package name and the logging seam                           |

`node dist/index.js` runs `main()`, which reads the environment and starts the server.

## Layout

```
src/
  index.ts              the barrel; `node dist/index.js` starts the server
  main.ts               env → store (migrations) → model → scheduler → listener → shutdown
  app.ts                createApp: middleware, routes, error mapping, static fallback
  config.ts             the environment, parsed and checked
  model.ts              which model factory the process runs (router, or the mock)
  mock-model.ts         the deterministic test model and its markers
  runner.ts             SessionRunner: one turn per session, re-run while there is work
  scheduler.ts          SessionScheduler, LocalScheduler, partition helpers
  sse.ts                the SSE body of a stream request
  static.ts             serving a built web app from OPENHARNESS_WEB_DIR
  types.ts              AppEnv (the Hono environment) and the Logger seam
  http/
    errors.ts           HttpError and the protocol's error envelope
    request.ts          body/query/path reading, through the protocol's schemas
  routes/               agents.ts, sessions.ts, events.ts, ai-sdk.ts
  test-support/         test-only: scripted model, SSE reader, the server harness
```

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/session`
- `@openharness/brain`
- `@openharness/hands`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Testing

`src/**/*.test.ts` with Vitest (node environment), against `InMemorySessionStore` and a
scripted model. Route tests call the Hono app in-process (`app.request()`); the SSE and AI SDK
tests start a real listener on an ephemeral port, because what they assert — frames on a
socket, the client transport's own request shape — only exists over one.

- `app.test.ts` — every route, the error envelopes, auth, CORS, static assets.
- `sse.test.ts` — replay and live with no gaps or duplicates, `last-event-id` resume, previews
  opt-in, keepalive, disconnect cleanup.
- `scheduler.test.ts` — one turn per session, steering, interrupts (running and idle), a
  message queued behind an interrupt, recovery on start, concurrency, stopping, and the fence
  reaching the store.
- `ai-sdk.test.ts` — the adapter through `DefaultChatTransport` and `readUIMessageStream`.
- `mock-model.test.ts` — the echo, `__slow__`, both failure markers, fixed usage, and that the
  hook cannot activate without the variable.
- `config.test.ts`, `main.test.ts` — the environment, startup, recovery and shutdown.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue. If a contract blocks you, work around it here and say so.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/server/docs/`.
