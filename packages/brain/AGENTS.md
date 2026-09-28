# @openharness/brain

The stateless brain: the harness loop that drives a session.

A turn is one call to `runTurn`. It reads the session log, streams a reply from the model, and
appends what happened — user events claimed, a span around every model request, the reply, the
status transitions and any error. It remembers nothing between turns and knows nothing about
scheduling, ownership, HTTP or Postgres: it is handed a `SessionStore`, a model factory and an
abort signal. The log is the state, which is what lets a crashed turn be resumed by another
process — and why a brain that holds a partition lease writes under its fence.

## Commands

Run from this folder (`packages/brain`):

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

## Layout

```
src/
  index.ts              the barrel: the loop, the context strategy, the model seam, retries
  turn.ts               runTurn: the loop, and the lifecycle it writes
  log.ts                reading the log, and the questions the loop asks of it
  context.ts            ContextStrategy: the log as model messages, trimmed
  model.ts              ModelFactory, and streaming one request through the AI SDK
  errors.ts             classifyModelError: retryable or terminal, and which session.error
  retry.ts              RetryPolicy, backoff, and the injectable sleep
  events.ts             the events the loop appends, built in one place
  testing/
    harness.ts          a session on an in-memory store, and log helpers (tests only)
    mock-model.ts       scripted AI SDK mock models, and prompt assertions (tests only)
```

`src/testing/` is not part of the build: the entry point is `src/index.ts`, and tsdown only
emits what that reaches.

## Public API

### `@openharness/brain`

| export                                                                        | what it is                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `runTurn(sessionId, options)`                                                 | run one turn; resolves to a `TurnOutcome`                              |
| `RunTurnOptions`                                                              | `{ store, model, signal?, fence?, contextStrategy?, retry? }`          |
| `TurnOutcome`, `TurnOutcomeKind`                                              | `{ outcome: 'idle' \| 'noop' \| 'interrupted' \| 'error' }`            |
| `ContextStrategy`, `ContextStrategyOptions`                                   | `(events, { model, system }) => ModelMessage[]`                        |
| `createContextStrategy(config?)`, `ContextStrategyConfig`                     | the default strategy: the conversation, trimmed to a token budget      |
| `DEFAULT_CONTEXT_STRATEGY`, `DEFAULT_CONTEXT_TOKEN_BUDGET`, `CHARS_PER_TOKEN` | its defaults                                                           |
| `estimateTokens(text)`                                                        | the chars/4 estimate the budget is measured in                         |
| `ModelFactory`                                                                | `(modelId) => LanguageModel` — how a `provider/model` becomes a model  |
| `routerModelFactory`                                                          | the default factory: Mastra's model router                             |
| `streamModelRequest(params)`, `ModelRequestParams`, `ModelRequestResult`      | one model request, as text, usage, error and abort                     |
| `toModelUsage(usage)`, `ZERO_MODEL_USAGE`                                     | AI SDK usage → the protocol's four counters                            |
| `classifyModelError(error)`, `ModelErrorClassification`                       | retryable or not, and the `session.error` type that says so            |
| `isRetryableModelError(error)`                                                | the same answer, when only the boolean is wanted                       |
| `RetryPolicy`, `ResolvedRetryPolicy`, `resolveRetryPolicy(policy?)`           | how failures are retried                                               |
| `backoffDelay(attempt, policy)`, `abortableSleep`, `Sleep`                    | the delay, and the sleep that honors an abort                          |
| `DEFAULT_MAX_RETRIES`, `DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`        | `3`, `500`, `8000`                                                     |
| `PACKAGE_NAME`, `DEPENDENCIES`                                                | the package name, and the edges that must resolve through built output |

`log.ts` and `events.ts` are internal: they are how the loop is written, not what a host talks
to.

## The lifecycle

The order of the events is the contract — the session log is what a client replays — so it is
the first thing this package documents and the first thing its tests assert.

```
  no turn to run, nothing queued .......................... return noop, write nothing

START — an inherited turn (`getTurnState` is not idle; the brain that opened it is gone)
  an open span ............................................ span.model_request_end
                                                             { error: brain_lost, is_error: true }
  last status is session.status_rescheduled ............... session.status_running
  last status is session.status_running ................... (nothing: that turn is already open)
START — a fresh turn (idle, with something queued)
  ......................................................... session.status_running

LOOP — once per model request
  1. the signal aborted, or a queued user.interrupt ....... INTERRUPT
  2. claim the queued user.message events (markProcessed)
  3. nothing left to answer ............................... session.status_idle, return idle
  4. ...................................................... span.model_request_start
  5. stream ............................................... event_start, then one event_delta
                                                             per text chunk, all under one
                                                             pre-generated sevt_ id (ephemeral:
                                                             published, never stored)
  6. text arrived ......................................... agent.message (that same sevt_ id)
  7. ...................................................... span.model_request_end
                                                             { model_usage, is_error: null }
  8. another user.message arrived ......................... loop, from 1
  9. otherwise ............................................ session.status_idle, return idle

INTERRUPT — an aborted signal, or a queued user.interrupt, at any point above
  text was streamed ....................................... agent.message (that same id)
  a span is open .......................................... span.model_request_end
                                                             { error: interrupted, is_error: true }
  queued user.interrupt events ............................ markProcessed
  ......................................................... session.status_idle, return interrupted

  The user messages that are still queued stay queued: they start the next turn.

MODEL FAILURE — retryable, attempts left
  ......................................................... span.model_request_end
                                                             { error: model_error, is_error: true }
  ......................................................... session.error { retry_status: retrying }
  ......................................................... session.status_rescheduled
  backoff sleep (the signal is honored here too)
  ......................................................... session.status_running, loop from 1

MODEL FAILURE — not retryable, or out of attempts
  ......................................................... span.model_request_end
                                                             { error: model_error, is_error: true }
  ......................................................... session.error
                                                             { retry_status: terminal | exhausted }
  ......................................................... session.status_idle, return error

FENCED WRITE — any append or markProcessed the store refuses
  ......................................................... stop, write nothing more, rethrow
```

Notes on the corners:

- **Every span is closed.** `brain_lost` for one a dead brain left open, `interrupted` for an
  abort, `model_error` for a failure. A turn never ends with an open span.
- **A request that produced no text stores no message.** An empty `agent.message` would be a
  reply the model did not make; the span and the status still record that the request ran. An
  interrupted request stores its partial text for the same reason, and only when there is one.
- **An interrupt ends the turn the same way at every point** — before the first request, during
  a stream, during a backoff — and always writes `session.status_idle`. Only the partial text
  and the span close depend on whether anything was streaming.
- **Retried failures close the span and open a new one**: `session.error` and
  `session.status_rescheduled` precede the backoff, `session.status_running` follows it, and the
  next attempt is a fresh `span.model_request_start`.
- **A recovering brain does not ask twice.** It closes the inherited span, then runs a request
  only if some claimed `user.message` has no reply of its own (`needsModelRequest`). A brain that
  died after storing a reply closes the turn instead of storing a second one.
- **The reply to a steering message is not the reply in flight.** A message that arrives while a
  request streams is not part of that request's context (`contextView`), so the loop answers it
  in a second request rather than letting the first answer it early — and the log keeps the
  order it really happened in, which puts the steering message before the reply to the message
  before it.

## Extension points

| what                         | how                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| how the log becomes messages | `contextStrategy` on `runTurn`; the default trims to a token budget, per model               |
| which model a session runs   | `model` on `runTurn`: a `ModelFactory`, defaulting to `routerModelFactory` (Mastra's router) |
| how failures are retried     | `retry` on `runTurn`: attempts, base delay, ceiling, and the `sleep` itself                  |

`ContextStrategy` is called once per model request, with the log as that request sees it and the
session's `{ model, system }`; it must be pure — the loop owns the store, and a strategy that
wrote to it would put the transcript out of step with the request that produced it.

`ModelFactory` is what keeps the package testable without a key: tests return one of the AI SDK's
mock models, and nothing else in the loop knows the difference.

## The model seam

The loop streams with the **AI SDK's `streamText`**, and resolves `provider/model` with
**Mastra's model router** (`ModelRouterLanguageModel`) — the fallback the issue allows, chosen
after trying Mastra's `Agent` first. `Agent.stream()` swallows what this loop needs most:

- a provider failure never reaches the caller: the stream ends, `textStream` yields nothing
  further, the error is logged to the console, and the turn would look like an empty success;
- an abort is not reported either, and `agent.stream` retries internally through `p-retry`, on
  top of the retries the loop has to write `session.error` events for;
- the model object it wants is not the AI SDK's, so the factory could not be a `LanguageModel`.

`streamText` gives all three cleanly: an `error` part plus `onError` with the original error
(including its status), an `abort` part, and a `usage` report. `streamRetries: 0` keeps the SDK
from retrying underneath the loop.

## Contract gaps

**The `sevt_` id of a stored `agent.message`.** `@openharness/protocol` says the stored reply
carries the id its `event_start` announced, so a client can replace what it accumulated with
what was stored. `@openharness/session` says `appendEvents` assigns `id` — `AppendableEvent` has
no `id` field at all — so `InMemorySessionStore` overwrites the id the brain passes. Both
packages are read-only contracts for this issue, so the brain does what it can: it publishes the
preview under one pre-generated id, passes that id to `appendEvents` (see `events.ts`), and
everything a client can observe about the _preview_ is correct. On a store that honors a
caller-supplied id for an agent event the two line up; on `InMemorySessionStore` they do not,
and the loop cannot fix that from inside `brain`.

## Testing

`src/**/*.test.ts` with Vitest (node environment), against a real `InMemorySessionStore` from
`@openharness/session/testing` and scripted mock models from `ai/test` — no keys, no network, no
timers: retries run on an injected `sleep`, and the clock is a `TestClock`.

- `turn.test.ts` is the acceptance suite: the exact event order of every path above, the preview
  ids, steering in a second request, interrupts at each point, the retry ladder, the six ways a
  turn can be recovered, and a fenced write that stops the turn where it stands.
- `context.test.ts`, `errors.test.ts`, `retry.test.ts`, `log.test.ts` and `model.test.ts` cover
  the pieces on their own, including the branches the loop cannot reach.
- `src/testing/harness.ts` builds the session and reads the log back; `src/testing/mock-model.ts`
  scripts what each model request answers with, records the prompts, and can act mid-stream
  (abort, append a steering message) between two chunks.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/session`
- `@openharness/hands`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

`hands` is not used yet — a chat agent has no tools — but the edge stays declared, and
`DEPENDENCIES` in `src/index.ts` is what keeps the build order honest.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/brain/docs/`.
