# @openharness/brain

The stateless brain: the harness loop that drives a session.

A turn is one call to `runTurn`. It reads the session log, streams a reply from the model, and
appends what happened — user events claimed, a span around every model request, the chunks of
the reply as they arrive, the reply itself, the status transitions and any error. It remembers nothing between turns and knows nothing about
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
  validate.ts           the protocol check every appended event passes
  testing/
    harness.ts          a session on an in-memory store, and log helpers (tests only)
    mock-model.ts       scripted AI SDK mock models, and prompt assertions (tests only)
```

`src/testing/` is not part of the build: the entry point is `src/index.ts`, and tsdown only
emits what that reaches.

## Public API

### `@openharness/brain`

| export                                                                        | what it is                                                              |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `runTurn(sessionId, options)`                                                 | run one turn; resolves to a `TurnOutcome`                               |
| `RunTurnOptions`                                                              | `{ store, model, signal?, fence?, contextStrategy?, retry? }`           |
| `TurnOutcome`, `TurnOutcomeKind`                                              | `{ outcome: 'idle' \| 'noop' \| 'interrupted' \| 'error' }`             |
| `ContextStrategy`, `ContextStrategyOptions`                                   | `(events, { model, system }) => ModelMessage[]`                         |
| `createContextStrategy(config?)`, `ContextStrategyConfig`                     | the default strategy: the conversation, trimmed to a token budget       |
| `DEFAULT_CONTEXT_STRATEGY`, `DEFAULT_CONTEXT_TOKEN_BUDGET`, `CHARS_PER_TOKEN` | its defaults                                                            |
| `estimateTokens(text)`                                                        | the chars/4 estimate the budget is measured in                          |
| `ModelFactory`                                                                | `(modelId) => LanguageModel` — how a `provider/model` becomes a model   |
| `routerModelFactory`                                                          | the default factory: Mastra's model router                              |
| `streamModelRequest(params)`, `ModelRequestParams`, `ModelRequestResult`      | one model request, as text, usage, error and abort                      |
| `toModelUsage(usage)`, `ZERO_MODEL_USAGE`                                     | what a request reported → the protocol's four counters, always integers |
| `classifyModelError(error)`, `ModelErrorClassification`                       | retryable or not, and the `session.error` type that says so             |
| `isRetryableModelError(error)`                                                | the same answer, when only the boolean is wanted                        |
| `isClaimConflictError(error)`                                                 | whether the store refused a claim another owner had taken               |
| `isOwnershipError(error)`                                                     | a fenced write or a claim conflict: the log is somebody else's (D9)     |
| `RetryPolicy`, `ResolvedRetryPolicy`, `resolveRetryPolicy(policy?)`           | how failures are retried                                                |
| `backoffDelay(attempt, policy)`, `abortableSleep`, `Sleep`                    | the delay, and the sleep that honors an abort                           |
| `DEFAULT_MAX_RETRIES`, `DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`        | `3`, `500`, `8000`                                                      |
| `PACKAGE_NAME`, `DEPENDENCIES`                                                | the package name, and the edges that must resolve through built output  |

`log.ts`, `events.ts` and `validate.ts` are internal: they are how the loop is written, not what
a host talks to.

## The lifecycle

The order of the events is the contract — the session log is what a client replays — so it is
the first thing this package documents and the first thing its tests assert.

```
  no turn to run, nothing queued .......................... return noop, write nothing

START — an inherited turn (`getTurnState` is not idle; the brain that opened it is gone)
  an open span ............................................ span.model_request_end
                                                             { error: brain_lost, is_error: true,
                                                               supersedes: that span's chunks }
  last status is session.status_rescheduled ............... session.status_running
  last status is session.status_running ................... (nothing: that turn is already open)
START — a fresh turn (idle, with something queued)
  ......................................................... session.status_running

LOOP — once per model request
  1. the signal aborted, or a queued user.interrupt ....... INTERRUPT
  2. nothing left to answer ............................... session.status_idle, return idle
  3. ................ span.model_request_start { consumes: the queued user.message ids,
                                                  model: the provider/model of the request }
     (the append IS the claim: atomic, fenced, refused whole with ClaimConflictError)
  4. stream ............................................... stored event_start under a fresh
                                                             sevt_ id, then one stored
                                                             event_delta per text chunk
  5. text arrived ......................................... agent.message { same sevt_ id,
                                                             supersedes: the chunk range }
     no text .............................................. (no message: the span end below
                                                             carries the range)
  6. ...................................................... span.model_request_end
                                                             { model_usage, is_error: null }
  7. another user.message arrived ......................... loop, from 1
  8. otherwise ............................................ session.status_idle, return idle

INTERRUPT — an aborted signal, or a queued user.interrupt, at any point above
  text was streamed ......................... agent.message { supersedes: the chunk range }
  a span is open ............................ span.model_request_end
                                               { error: interrupted, is_error: true,
                                                 consumes: the queued user.interrupt ids }
                                               (with the chunk range when no text was stored)
  nothing was in flight ..................... session.status_idle { consumes: the ids }
  ........................................... session.status_idle, return interrupted

  An interrupt is claimed by the event that ends the work it stopped (P4) — the open
  request's span end, or the turn's idle event when nothing was running. No span is opened
  for an interrupt: every span start is a real model request. The user messages that are
  still queued stay queued; they start the next turn.

MODEL FAILURE — retryable, attempts left
  ........................................... span.model_request_end
                                               { error: model_error, is_error: true,
                                                 supersedes: this attempt's chunks }
  ........................................... session.error { retry_status: retrying }
  ........................................... session.status_rescheduled
  backoff sleep (the signal is honored here too)
  ......................... session.status_running, loop from 3 — a NEW sevt_ id and its own
                             event_start; the failed attempt's partial output is never stored

MODEL FAILURE — not retryable, or out of attempts
  ........................................... span.model_request_end
                                               { error: model_error, is_error: true,
                                                 supersedes: this attempt's chunks }
  ........................................... session.error
                                               { retry_status: terminal | exhausted }
  ........................................... session.status_idle, return error

AN EVENT THE PROTOCOL DOES NOT ACCEPT — a write the schema refuses, before it is stored
  the open span ............................. span.model_request_end
                                               { error: model_error, model_usage: 0,
                                                 supersedes: the chunks }
  ........................................... session.error
                                               { type: unknown_error, retry_status: terminal }
  ........................................... session.status_idle, return error

FENCED WRITE — any append the store refuses with FencedError, or with ClaimConflictError
  (another owner claimed the user events this request was about to answer)
  ........................................... stop, write nothing more, rethrow
```

Notes on the corners:

- **Every span is closed.** `brain_lost` for one a dead brain left open, `interrupted` for an
  abort, `model_error` for a failure. A turn never ends with an open span.
- **A claim is an append, not a write.** The user events a request answers are listed in its
  span start's `consumes`, and the store takes them in the same transaction — so two brains can
  never own one message, and a claim that cannot be taken (another owner got there first)
  refuses the whole append with `ClaimConflictError`. That is the fencing loss of D9: the turn
  stops where it stands, like a `FencedError`, and nothing more is written.
- **A request that produced no text stores no message.** An empty `agent.message` would be a
  reply the model did not make; the span still records that the request ran, and its
  `supersedes` covers the `event_start` the request announced. An interrupted request stores its
  partial text for the same reason, and only when there is one — with the range on the message,
  or on the span end when there is no message to carry it.
- **Partial output is never stored as a reply.** A failure mid-stream supersedes the chunks the
  attempt streamed and the retry mints a **new** message id with its own `event_start`; a reply
  that is not the model's final answer never becomes one.
- **An interrupt ends the turn the same way at every point** — before the first request, during
  a stream, during a backoff — and always writes `session.status_idle`. Only the partial text
  and the span close depend on whether anything was streaming; the queued `user.interrupt`
  events are claimed either way, by the span end that stopped their request or by the idle
  event that ended a turn with nothing in flight (P4).
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
- **Nothing is stored that the protocol would not accept.** Every append is checked against the
  protocol's schema first (`validate.ts`), and an event that fails ends the turn there: the span
  closes with no usage, `session.error { type: unknown_error, retry_status: terminal }` says what
  the schema refused, and the session goes idle. The write path fails loudly rather than storing
  a row every reader rejects — see the model seam below for why that matters.

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

### Usage, and the provider spec Mastra gets wrong

`ai@7` reads a model's `specificationVersion` and reshapes what it reports to match. Mastra's
router declares the **v2** spec (`@mastra/core@1.71.0`, `dist/llm/model/router.d.ts`) while the
model it resolves — its own bundled `OpenAIResponsesLanguageModel` — declares **v3** and reports
v3-shaped usage, `{ inputTokens: { total, noCache, cacheRead, cacheWrite }, … }`. `ai` believes
the declaration, so `convertV2UsageToV3` reads that object as if it were the v2 number and wraps
it again; `streamText` then accumulates the steps with `0 + { … }` and the total becomes the
_string_ `"0[object Object]"` (issue #39). No released or alpha version of either package agrees
with itself, so the brain recovers the numbers itself:

- `streamModelRequest` reads each step's own report (`finish-step`) as it streams — the totals
  are still numbers there — and only falls back to the SDK's accumulated `result.usage` when no
  step reported one.
- `toModelUsage` accepts whatever shape arrives: a number, the v3 usage object, that object
  wrapped once more by the compatibility layer, a numeric string, or nothing readable at all. It
  always answers with the protocol's four counters, as non-negative integers, and `0` for a
  count that cannot be recovered rather than a value the log would reject. Cache counters come
  from the breakdown when the shape has one and from inside the usage object when it does not.

Sessions whose turns ran before the fix keep the unreadable rows they were stored with; v1 is
unreleased, so nothing migrates them — the fix is what stops new ones being written.

## Chunks, ids and supersession (D9)

A streamed reply is stored as it streams (issue #46). The brain mints the `sevt_` id the
`agent.message` will have before it talks to the model, appends a stored `event_start` under it,
and appends one stored `event_delta` per chunk as the chunk arrives — each append awaited, so a
store refusal ends the request the way a failed write always did rather than being swallowed.
`appendEvents` stores a caller-supplied id exactly as given (see `@openharness/session`), which
is what makes the chunks and the message one identity throughout.

The event that finishes the reply supersedes the chunks it replaced:
`supersedes: { from_seq, to_seq }` from the `event_start` to the last `event_delta`. Replay skips
the range, so a client resuming from inside it sees the reply once, whole, and the server's
compaction job deletes it later — none of which the brain has to think about beyond writing the
range. The tests assert the message's id, its range and that a replay of the log holds no
superseded chunk.

## Testing

`src/**/*.test.ts` with Vitest (node environment), against a real `InMemorySessionStore` from
`@openharness/session/testing` and scripted mock models from `ai/test` — no keys, no network, no
timers: retries run on an injected `sleep`, and the clock is a `TestClock`.

- `turn.test.ts` is the acceptance suite: the exact event order of every path above — claims
  (`consumes` on all three claim sites), the model that served each request, the stored chunks,
  the `supersedes` ranges — steering in a second request, interrupts at each point (the span
  end claiming an interrupt that stopped a request, the idle claiming one that arrived with
  nothing running), the retry ladder, the six ways a turn can be recovered, a fenced write and
  a claim another owner took (both stop the turn where it stands), a turn against a model that
  declares the wrong provider spec, and, on every scenario, that a replay of the log holds no
  superseded chunk, that no span start exists without a model request behind it, and that the
  brain writes only through `appendEvents`.
- `context.test.ts`, `errors.test.ts`, `retry.test.ts`, `log.test.ts`, `model.test.ts` and
  `validate.test.ts` cover the pieces on their own, including the branches the loop cannot
  reach.
- `src/testing/harness.ts` builds the session and reads the log back; `src/testing/mock-model.ts`
  scripts what each model request answers with, records the prompts, and can act mid-stream
  (abort, append a steering message) between two chunks. Its `misdeclaredSpec` is the one model
  no provider has to be asked for: a mock that declares the `v2` provider spec over v3-shaped
  usage, which is how the real router fails — the tests that use it assert the counts still reach
  the log, as integers.

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
