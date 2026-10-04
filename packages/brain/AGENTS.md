# @openharness/brain

The stateless brain: the harness loop that drives a session.

A turn is one call to `runTurn`. It reads the session log, streams a reply from the model, and
appends what happened — user events claimed, a span around every model request, the chunks of
the reply as they arrive, the reply itself, the status transitions and any error. It remembers nothing between turns and knows nothing about
scheduling, ownership, HTTP or Postgres: it is handed a `SessionStore`, a model factory, a
credential resolver and an abort signal. Every model request is made with a credential the
resolver answered — the session owner's own provider key, never one from the environment (epic
#65, A5) — and a request the owner has no key for ends the turn before it is attempted. The log
is the state, which is what lets a crashed turn be resumed by another process — and why a brain
that holds a partition lease writes under its fence.

What a turn streams is the **session's** configuration: `session.model` is the id every request
is built from and recorded on its span, and `session.system` is the system prompt the context
strategy is handed (epic #92, #93/#94). The brain never reads `session.agent` — a session may
have none, and even when it does the session's `model`/`system` are the effective ones.

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
  model.ts              ModelFactory, credentials, and streaming one request through the AI SDK
  redact.ts             redactSecret: scrubbing a provider key out of error text
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

| export                                                                        | what it is                                                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `runTurn(sessionId, options)`                                                 | run one turn; resolves to a `TurnOutcome`                                                     |
| `RunTurnOptions`                                                              | `{ store, model, resolveCredential, signal?, fence?, contextStrategy?, retry? }`              |
| `TurnOutcome`, `TurnOutcomeKind`                                              | `{ outcome: 'idle' \| 'noop' \| 'interrupted' \| 'error' }`                                   |
| `ContextStrategy`, `ContextStrategyOptions`                                   | `(events, { model, system }) => ModelMessage[]`                                               |
| `createContextStrategy(config?)`, `ContextStrategyConfig`                     | the default strategy: the conversation, trimmed to a token budget                             |
| `DEFAULT_CONTEXT_STRATEGY`, `DEFAULT_CONTEXT_TOKEN_BUDGET`, `CHARS_PER_TOKEN` | its defaults                                                                                  |
| `estimateTokens(text)`                                                        | the chars/4 estimate the budget is measured in                                                |
| `ModelCredential`                                                             | `{ apiKey }` — the credential one model request is made with                                  |
| `ResolveCredential`                                                           | `(provider) => Promise<ModelCredential \| null>` — where it comes from                        |
| `ModelFactory`                                                                | `(modelId, credential) => LanguageModel` — how a `provider/model` becomes a model             |
| `routerModelFactory`                                                          | the `ModelFactory` hosts normally pass: Mastra's model router, with the key passed explicitly |
| `providerOf(modelId)`                                                         | the provider of a `provider/model` id: the part before the first slash                        |
| `isUsableCredential(credential)`                                              | whether a resolved credential is a key at all (a blank one is not)                            |
| `missingCredentialMessage(provider)`                                          | the `session.error` sentence for a provider with no key                                       |
| `redactSecret(text, secret)`, `REDACTED_PLACEHOLDER`                          | the credential scrubbed out of provider error text                                            |
| `streamModelRequest(params)`, `ModelRequestParams`, `ModelRequestResult`      | one model request, as text, usage, error and abort                                            |
| `toModelUsage(usage)`, `ZERO_MODEL_USAGE`                                     | what a request reported → the protocol's four counters, always integers                       |
| `classifyModelError(error)`, `ModelErrorClassification`                       | retryable or not, and the `session.error` type that says so                                   |
| `isRetryableModelError(error)`                                                | the same answer, when only the boolean is wanted                                              |
| `isClaimConflictError(error)`                                                 | whether the store refused a claim another owner had taken                                     |
| `isOwnershipError(error)`                                                     | a fenced write or a claim conflict: the log is somebody else's (D9)                           |
| `RetryPolicy`, `ResolvedRetryPolicy`, `resolveRetryPolicy(policy?)`           | how failures are retried                                                                      |
| `backoffDelay(attempt, policy)`, `abortableSleep`, `Sleep`                    | the delay, and the sleep that honors an abort                                                 |
| `DEFAULT_MAX_RETRIES`, `DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`        | `3`, `500`, `8000`                                                                            |
| `PACKAGE_NAME`, `DEPENDENCIES`                                                | the package name, and the edges that must resolve through built output                        |

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
  3. no credential for the model's provider ............... MISSING CREDENTIAL (below)
  4. ... span.model_request_start { consumes: the queued user.message ids,
                                    model: the provider/model of the request }
     (the append IS the claim: atomic, fenced, refused whole with ClaimConflictError)
  5. stream ............................................... stored event_start under a fresh
                                                             sevt_ id, then one stored
                                                             event_delta per text chunk
  6. text arrived ......................................... agent.message { same sevt_ id,
                                                             supersedes: the chunk range }
     no text .............................................. (no message: the span end below
                                                             carries the range)
  7. ...................................................... span.model_request_end
                                                             { model_usage, is_error: null }
  8. another user.message arrived ......................... loop, from 1
  9. otherwise ............................................ session.status_idle, return idle

MISSING CREDENTIAL — the owner has no stored key for the model's provider (epic #65, A5)
  ........................................... session.error
                                               { type: missing_provider_credential,
                                                 retry_status: exhausted }
  ........................................... session.status_idle
                                               { consumes: the queued user.message ids }
  ........................................... return error

  The credential is resolved before the span start, so a request that has no key to make it
  opens no span — every span start is a real model request — and streams nothing, which is why
  there is no chunk range to supersede. The messages the request would have answered are
  claimed by the idle event that ends the turn, the way an interrupt's are (P4): left queued,
  the session's own scheduler would find them and run the same failing turn again. Nothing is
  retried: adding the key and sending the message again is what works.

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
  ......................... session.status_running, loop from 1 — a NEW sevt_ id and its own
                             event_start; the failed attempt's partial chunks are superseded,
                             never kept as a reply

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

NO SUCH SESSION — `runTurn` on an id no session has
  ........................................... throw SessionNotFoundError, write nothing
```

Notes on the corners:

- **Every span a turn finishes is closed.** `brain_lost` for one a dead brain left open,
  `interrupted` for an abort, `model_error` for a failure. The one exception is the fenced /
  claim-conflict stop below, which leaves the span it had started open by design; the next
  brain closes it as `brain_lost`.
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

| what                                 | how                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| how the log becomes messages         | `contextStrategy` on `runTurn`; the default trims to a token budget, per model                   |
| how `provider/model` becomes a model | `model` on `runTurn` (required): a `ModelFactory`; the server passes `routerModelFactory`        |
| where the key comes from             | `resolveCredential` on `runTurn`: the owner's credential per provider, resolved per request (A5) |
| how failures are retried             | `retry` on `runTurn`: attempts, base delay, ceiling, and the `sleep` itself                      |

`ContextStrategy` is called once per model request, with the log as that request sees it and the
session's `{ model, system }`; it must be pure — the loop owns the store, and a strategy that
wrote to it would put the transcript out of step with the request that produced it.

`ModelFactory` is what keeps the package testable without a key: tests return one of the AI SDK's
mock models, and nothing else in the loop knows the difference — a mock ignores the credential
it is handed, but the loop still asks for one, which is what the tests' `resolveTestCredential`
is for.

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
(including its status), an `abort` part, and a `usage` report. The SDK must not retry
underneath the loop, and in `ai@7` two options control retries — only the first is a call-level
retry (issue #117):

- `maxRetries: 0` disables the provider retries of one model call; the default is **2**. Left
  at the default, a retryable failure makes up to three provider calls the loop never sees,
  and what `onError` then reports is not the provider error but an `AI_RetryError` wrapper
  around it — `statusCode` and `isRetryable` gone from the wrapper itself. This is the option
  that keeps the turn loop the only retrier.
- `streamRetries: 0` disables retries of provider errors received _after_ streaming has
  started; its default is already 0 (disabled when omitted). It is kept explicit so a changed
  default cannot re-enable them. `onError` never returns `{ retry: true }`, the one way a
  stream error could still be retried with this set.

`classifyModelError` follows the wrapper's `lastError` (and `errors`/`cause` in other wrappers)
when the error itself says nothing, so a retryable failure that still arrives wrapped is
classified by the provider's verdict rather than downgraded to `unknown_error` — see
`errors.ts`. `model.test.ts` pins the call-count invariant (one failure, one `doStream` call)
with a failure the SDK's own classifier would retry.

### The credential of one request

Each model request is made with an explicit credential, and only with one (epic #65, A5). The
loop asks `runTurn`'s `resolveCredential` for the model's provider — the part of
`session.model.id` before the first slash, `providerOf`'s reading — and hands the answer to the
`ModelFactory`, which builds the model for that one request. Nothing is held between requests:
a retry resolves again, so a key the owner just added is picked up. `isUsableCredential` treats
`null` **and a blank key** as "no credential": a blank one is not merely useless, it is
dangerous (below), so both end the turn with `missing_provider_credential` before any span is
opened.

`routerModelFactory` passes the key into the router's config —
`new ModelRouterLanguageModel({ id: modelId, apiKey })` — which is the whole of "no environment
fallback". Mastra's `resolveAuth()` (`@mastra/core@1.71.0`, its `router.ts`) returns a
config-supplied `apiKey` verbatim, tagged `source: 'explicit'`, **without** asking the gateway
whose `getApiKey()` is what reads `OPENAI_API_KEY` and friends; it only consults that gateway
when `config.apiKey` is falsy. So an explicit key cannot be overridden, and the environment is
never read — and a falsy key would silently restore the fallback, which is exactly why the loop
never constructs the router without one. `model.test.ts` pins the first half of that contract —
the explicit key wins with `OPENAI_API_KEY` set to a decoy — and `turn.test.ts` the second: a
turn with no credential reaches no provider (`fetch` is stubbed and must not be called) even
with the variables set.

The credential is also scrubbed on the way into the log: a provider that rejects a key
sometimes quotes it in the error text, and `redactSecret` replaces the key — the whole value,
minus its first four characters, and minus its last four — with `[REDACTED]` (a secret shorter
than eight characters is left alone, as is a trimmed variant that falls below eight) before the
`span.model_request_end` error and the `session.error` are built. The message is otherwise kept
whole, so the log still says what the provider said. The brain itself never logs; the tests
capture the console anyway, because the libraries on this path could.

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
- `toModelUsage` accepts whatever shape arrives: the v3 usage object, that object wrapped once
  more by the compatibility layer, a numeric field (a number or a numeric string), or nothing
  readable at all. It
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
`@openharness/session` and scripted mock models from `ai/test` — no keys and no network:
retries run on an injected `sleep`, the clock is a `TestClock` from
`@openharness/session/testing`, and the only real timers are the sleep test's own.

- `turn.test.ts` is the acceptance suite: the exact event order of every path above — claims
  (`consumes` on all three claim sites), the model that served each request, the stored chunks,
  the `supersedes` ranges — steering in a second request, interrupts at each point (the span
  end claiming an interrupt that stopped a request, the idle claiming one that arrived with
  nothing running), the retry ladder — a 429 and a 503 (before and mid-stream), each asserting
  exactly one provider call per attempt, because the SDK must not retry underneath the loop
  (#117) — the six ways a turn can be recovered, a fenced write and
  a claim another owner took (both stop the turn where it stands), a turn against a model that
  declares the wrong provider spec; most scenarios also assert that a replay of the log holds
  no superseded chunk and that no span start exists without a model request behind it, and one
  asserts that the brain writes only through `appendEvents`.
- The credential paths live in `turn.test.ts` too: a turn that ends with
  `missing_provider_credential` (no span, the queued message claimed by the idle event, no
  model call), the same with `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` set to decoys and `fetch`
  stubbed (the environment is never a fallback), a resolver asked once per request, and a
  whole scenario — a normal turn, a 401, a retryable failure — whose provider errors quote a
  distinctive fake key, asserting neither the key nor a four-character-trimmed piece of it
  appears in the stored events or in captured console output.
- `context.test.ts`, `errors.test.ts`, `retry.test.ts`, `log.test.ts`, `model.test.ts`,
  `redact.test.ts`, `validate.test.ts` and `index.test.ts` cover the pieces on their own,
  including the branches the loop cannot reach. `errors.test.ts` also covers the wrappers the
  classification follows (`AI_RetryError` and duck-typed ones), and `model.test.ts` pins the
  one-failure-one-call invariant with a failure the SDK's retry classifier would act on.
- `src/testing/harness.ts` builds the session and reads the log back; `src/testing/mock-model.ts`
  scripts what each model request answers with, records the prompts, and can act mid-stream
  (abort, append a steering message) between two chunks. Its `apiCallError` is the failure
  shape a retry test needs — an `APICallError` the SDK's own retry classifier would act on, so
  a call-count assertion can actually fail (#117). Its `misdeclaredSpec` is the one model
  no provider has to be asked for: a mock that declares the `v2` provider spec over v3-shaped
  usage, which is how the real router fails — the tests that use it assert the counts still reach
  the log, as integers.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/session`
- `@openharness/hands`

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

`hands` is not used yet — a chat agent has no tools — but the edge stays declared, and
`DEPENDENCIES` in `src/index.ts` is what keeps the build order honest.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/brain/docs/`.
