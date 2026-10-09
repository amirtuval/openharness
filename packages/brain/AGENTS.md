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
strategy is handed (epic #92, #93/#94). The **reasoning effort** a request runs at is read from
the log at each request boundary — the newest `user.message` that carried one (#252) — and
recorded on the span beside it, since nothing stores an effort on a session. Since #111/#116 the model is not frozen for a turn: a
`user.message` carrying `model` switches it in the append transaction, and the loop re-reads
the session at **every request boundary**, so a switch applies from the next request on —
across providers, since each request is built from the current id and credential alone (U3).
The brain never reads `session.agent` — a session may have none, and even when it does the
session's `model`/`system` are the effective ones.

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
  azure-fetch.ts        the Azure endpoint's base URL, and the safeFetch guard a model call goes through
  reasoning.ts          the reasoning effort: per provider, gated by the injected resolver
  provider-fetch.ts     the one guarded `fetch` (safeFetch + a limits preset + allowPrivate) both types build from
  openai-compatible-fetch.ts  a custom endpoint's base URL, and the safeFetch guard its model call goes through (#249)
  bedrock.ts            Bedrock's two AWS hosts, and the SigV4 signing the server borrows for a
                        control-plane read
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

| export                                                                                                                                 | what it is                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runTurn(sessionId, options)`                                                                                                          | run one turn; resolves to a `TurnOutcome`                                                                                                                                                                                              |
| `RunTurnOptions`                                                                                                                       | `{ store, model, resolveCredential, signal?, fence?, contextStrategy?, reasoningSupportFor?, retry? }`                                                                                                                                 |
| `TurnOutcome`, `TurnOutcomeKind`                                                                                                       | `{ outcome: 'idle' \| 'noop' \| 'interrupted' \| 'error' }`                                                                                                                                                                            |
| `ContextStrategy`, `ContextStrategyOptions`                                                                                            | `(events, { model, system }) => ModelMessage[]`                                                                                                                                                                                        |
| `createContextStrategy(config?)`, `ContextStrategyConfig`                                                                              | the default strategy: the conversation, trimmed to a token budget resolved per model                                                                                                                                                   |
| `DEFAULT_CONTEXT_STRATEGY`, `DEFAULT_CONTEXT_TOKEN_BUDGET`, `CHARS_PER_TOKEN`                                                          | its defaults                                                                                                                                                                                                                           |
| `estimateTokens(text)`                                                                                                                 | the chars/4 estimate the budget is measured in                                                                                                                                                                                         |
| `ModelCredential`                                                                                                                      | `{ type: 'api_key', apiKey }`, `{ type: 'azure_openai', apiKey, endpoint }`, `{ type: 'openai_compatible', apiKey, baseUrl }` or `{ type: 'bedrock', accessKeyId, secretAccessKey, sessionToken?, region }` — one request's credential |
| `credentialSecrets(credential)`                                                                                                        | every secret a credential carries, for redaction — a Bedrock credential has three                                                                                                                                                      |
| `ResolveCredential`                                                                                                                    | `(name) => Promise<ModelCredential \| null>` — where it comes from                                                                                                                                                                     |
| `ModelFactory`                                                                                                                         | `(modelId, credential) => LanguageModel` — how a `provider/model` becomes a model                                                                                                                                                      |
| `providerModelFactory`, `createProviderModelFactory(options)`                                                                          | the `ModelFactory` hosts normally pass: the official AI SDK providers, the key passed explicitly                                                                                                                                       |
| `azureFetch`, `createAzureFetch(options)`, `azureBaseUrl(endpoint)`                                                                    | the Azure `fetch` (safeFetch under the streaming-safe limits) and the base URL it builds                                                                                                                                               |
| `redactSecrets(text, secrets)`                                                                                                         | `redactSecret` for a credential that carries more than one secret                                                                                                                                                                      |
| `BEDROCK_SERVICE`, `bedrockRuntimeBaseUrl(region)`, `bedrockControlPlaneUrl(region, path)`                                             | the SigV4 service both Bedrock hosts are signed for, and the two AWS hosts a region derives                                                                                                                                            |
| `signBedrockRequest(credential, url, input?)`, `SignedBedrockRequest`, `BedrockRequestInput`                                           | one SigV4-signed Bedrock request, returned rather than sent — what the server's save-time check and catalogue read use                                                                                                                 |
| `openAICompatibleFetch`, `createOpenAICompatibleFetch(options)`, `openAICompatibleBaseUrl(baseUrl)`                                    | the custom endpoint's `fetch` (safeFetch under the streaming-safe limits, with the self-host `allowPrivate` option, #249) and the base URL it normalizes                                                                               |
| `SafeFetch`, `ProviderFetch`, `SafeProviderFetchOptions`, `createSafeProviderFetch(options)`                                           | the one guarded `fetch` the two URL-typed types are built from                                                                                                                                                                         |
| `providerOf(modelId)`                                                                                                                  | the provider of a `provider/model` id: the part before the first slash                                                                                                                                                                 |
| `isUsableCredential(credential)`                                                                                                       | whether a resolved credential is a key at all (a blank one is not)                                                                                                                                                                     |
| `missingCredentialMessage(provider)`                                                                                                   | the `session.error` sentence for a provider with no key                                                                                                                                                                                |
| `redactSecret(text, secret)`, `REDACTED_PLACEHOLDER`                                                                                   | the credential scrubbed out of provider error text                                                                                                                                                                                     |
| `streamModelRequest(params)`, `ModelRequestParams`, `ModelRequestResult`                                                               | one model request, as text, usage, error and abort                                                                                                                                                                                     |
| `ProviderOptions`                                                                                                                      | the AI SDK's per-provider options for one call, read off `streamText`                                                                                                                                                                  |
| `PROVIDER_REASONING`, `CREDENTIAL_TYPE_REASONING`, `planReasoning`, `ReasoningPlan`, `ReasoningSupportFor`, `requestedReasoningEffort` | `low \| medium \| high` in each provider's — and named credential type's — own option, gated by the injected resolver, and what the log asks a request for (#252)                                                                      |
| `toModelUsage(usage)`, `ZERO_MODEL_USAGE`                                                                                              | what a request reported → the protocol's four counters, always integers                                                                                                                                                                |
| `classifyModelError(error)`, `ModelErrorClassification`                                                                                | retryable or not, and the `session.error` type that says so                                                                                                                                                                            |
| `isRetryableModelError(error)`                                                                                                         | the same answer, when only the boolean is wanted                                                                                                                                                                                       |
| `isClaimConflictError(error)`                                                                                                          | whether the store refused a claim another owner had taken                                                                                                                                                                              |
| `isOwnershipError(error)`                                                                                                              | a fenced write or a claim conflict: the log is somebody else's (D9)                                                                                                                                                                    |
| `RetryPolicy`, `ResolvedRetryPolicy`, `resolveRetryPolicy(policy?)`                                                                    | how failures are retried                                                                                                                                                                                                               |
| `backoffDelay(attempt, policy)`, `abortableSleep`, `Sleep`                                                                             | the delay, and the sleep that honors an abort                                                                                                                                                                                          |
| `DEFAULT_MAX_RETRIES`, `DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`                                                                 | `3`, `500`, `8000`                                                                                                                                                                                                                     |
| `PACKAGE_NAME`, `DEPENDENCIES`                                                                                                         | the package name, and the edges that must resolve through built output                                                                                                                                                                 |

`log.ts`, `events.ts` and `validate.ts` are internal: they are how the loop is written, not what
a host talks to.

**An edited message is not history.** A `session.rewind` (#238) restarts the session from the
`user.message` a reader edited, and everything it replaced is gone from the log the brain
reads — `readLog` is the store's replay read, which skips what a recorded range covers — so
the prompt a request is built from holds the conversation as the reader left it, and the model
is never told what the edit took back. The brain does nothing about it: the turn reads the log
and answers what is waiting in it, exactly as after any other append.

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
  3. re-read the session; its CURRENT model is this request's model (U3 — a user.message may
     have switched it, even mid-stream of the previous request), and it chooses the
     credential's provider. A session deleted meanwhile throws SessionNotFoundError and the
     turn stops, writing nothing (U5)
  4. no credential for the model's provider ............... MISSING CREDENTIAL (below)
  4b. the id names a provider with no client here .......... UNSUPPORTED PROVIDER (below)
  5. ... span.model_request_start { consumes: the queued user.message ids,
                                    model: the provider/model of the request,
                                    reasoning_effort: what the newest effort-carrying
                                    user.message asked for, and what was applied }
     (the append IS the claim: atomic, fenced, refused whole with ClaimConflictError)
  6. stream ............................................... stored event_start under a fresh
                                                             sevt_ id, then one stored
                                                             event_delta per text chunk
  7. text arrived ......................................... agent.message { same sevt_ id,
                                                             supersedes: the chunk range }
     no text .............................................. (no message: the span end below
                                                             carries the range)
  8. ...................................................... span.model_request_end
                                                             { model_usage, is_error: null }
     ...................................................... session.usage
                                                             { the session's running totals,
                                                               per model (#247) }
  9. another user.message arrived ......................... loop, from 1
 10. otherwise ............................................ session.status_idle, return idle

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

UNSUPPORTED PROVIDER — the model id names a provider `providerModelFactory` has no client for
  ........................................... session.error
                                               { type: model_request_failed_error,
                                                 retry_status: exhausted }
  ........................................... session.status_idle
                                               { consumes: the queued user.message ids }
  ........................................... return error

  The provider of a `provider/model` id is free text (C5), so an id naming a provider outside
  the 11 the server can store a key for is reachable — and a key for one could never exist.
  The factory is built before the span start, so this ends the turn like a missing credential:
  no span, no request, the message claimed by the idle event. `UnsupportedProviderError` is the
  only error the loop treats this way; anything else a factory throws is a bug and propagates.

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

NO SUCH SESSION — `runTurn` on an id no session has, or one hard-deleted while the turn ran
  (the session is re-read at every request boundary, U5)
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
- **The session's running totals follow every request that reported usage** (epic #245, A2;
  #247). `session.usage` carries the tokens and the request count of every request the session
  has made, summed per model — the loop folds them from the log it already read for the request
  (`usageByModel`) and adds the request that just finished. It rides in the **same append as the
  span end**, so the two land in one transaction and a reader never sees a finished request whose
  totals lag behind it; a request that failed or was interrupted closes its span with no usage to
  add (`ZERO_MODEL_USAGE`) and writes none. It carries no cost: cost is computed when it is read,
  from these tokens and the model catalog's prices, and is never stored. The per-model `requests`
  count is what lets a reader price those running totals the way the usage routes do — counting
  the requests a model nobody prices leaves unpriced (#247, decided 2026-10-09) — and it is a
  fact about the log, not about money. Models appear in the order their first request ran, and a
  request whose span start named no model — a log from before the field existed — contributes to
  no entry rather than to a guessed one.
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
| how `provider/model` becomes a model | `model` on `runTurn` (required): a `ModelFactory`; the server passes `providerModelFactory`      |
| where the key comes from             | `resolveCredential` on `runTurn`: the owner's credential per provider, resolved per request (A5) |
| which models take a reasoning effort | `reasoningSupportFor` on `runTurn`: the levels a model takes, asked per request (#252)           |
| how failures are retried             | `retry` on `runTurn`: attempts, base delay, ceiling, and the `sleep` itself                      |

`ContextStrategy` is called once per model request, with the log as that request sees it and the
session's `{ model, system }`; it must be pure — the loop owns the store, and a strategy that
wrote to it would put the transcript out of step with the request that produced it.

### The context budget (#246)

The default strategy trims the history to a token budget, and how big that budget is per
model is the host's to say. `ContextStrategyConfig` takes `tokenBudget` — one number for every
model, defaulting to `DEFAULT_CONTEXT_TOKEN_BUDGET` — and `tokenBudgetFor(modelId)`, a
**resolver the strategy asks once per call** with the id the request runs. It is a function
rather than a record because the model space is not a handful of ids: the server's registry
holds hundreds (the bundled models.dev snapshot), and a record would have to be built from all
of them to answer for the one model a request names. `undefined` means "budget it like every
other model", so the default stays in one place.

The budget is resolved **per request, not per session**: the loop re-reads the session at
every request boundary, so a mid-chat model switch trims to the new model from the next
request on. The server's resolver (`apps/server/src/catalog/context-budget.ts`) turns the
registry's limits into `contextWindow − min(maxOutput, 25% of contextWindow)`, and the
trimming itself is unchanged — oldest complete turns first, never the newest turn.

`ModelFactory` is what keeps the package testable without a key: tests return one of the AI SDK's
mock models, and nothing else in the loop knows the difference — a mock ignores the credential
it is handed, but the loop still asks for one, which is what the tests' `resolveTestCredential`
is for.

## The model seam

The loop streams with the **AI SDK's `streamText`**, and resolves a `provider/model` id with
**`providerModelFactory`**: one official AI SDK provider per provider id, each built with the
request's key passed explicitly. The package used to resolve it with Mastra's model router,
which was tried after Mastra's `Agent` and rejected — `Agent.stream()` swallowed everything
the loop needs, retried underneath it, and did not hand back a `LanguageModel`. The router
stood in for it until [#234](https://github.com/amirtuval/openharness/issues/234) removed the
dependency; this paragraph is the historical note the repository keeps.

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
loop asks `runTurn`'s `resolveCredential` for the provider of the session's **current** model
— read at that request's boundary, so a `user.message` that switched the model mid-turn
changes which provider is asked from the next request (U3) — the part before the first slash,
`providerOf`'s reading — and hands the answer to the
`ModelFactory`, which builds the model for that one request. Nothing is held between requests:
a retry resolves again, so a key the owner just added is picked up. `isUsableCredential` treats
`null` **and a blank key** as "no credential": a blank one is not merely useless, it is
dangerous (below), so both end the turn with `missing_provider_credential` before any span is
opened.

`providerModelFactory` passes the key to the provider package as a **constructor argument** —
`createAnthropic({ apiKey, baseURL })`, `createOpenAI({ apiKey, baseURL }).responses(id)`, and
so on — which is the whole of "no environment fallback". Every AI SDK provider reads its
`*_API_KEY` variable only when it was constructed without a key, so an explicit one cannot be
overridden; and a falsy one would silently become "no key given" and hand the request to
whatever the process has set, which is exactly why the loop never builds a model without one.
The base URL is pinned the same way, in that one table (`PROVIDER_CLIENTS`), because the
`*_BASE_URL` variables would otherwise move a request — and its key — to a host nobody chose.
The table is keyed by the shared provider id (`Readonly<Record<ProviderId, …>>`, epic #245), so
a provider a key can be stored for and a request cannot be made to is a compile error rather
than a test failure.

`model.test.ts` pins both halves of that contract, for **each of the 11 providers**: with every
`*_API_KEY` and `*_BASE_URL` decoy set, one request goes to the provider's own host with the
owner's key in the header that provider authenticates with, and with nothing from the
environment in it. `turn.test.ts` pins the second half at the loop's boundary: a turn with no
credential reaches no provider (`fetch` is stubbed and must not be called) even with the
variables set, and a turn whose id names a provider outside the table ends the same way —
`model_request_failed_error`, `retry_status: exhausted`, no span, no request — because a
credential for such a provider could never have been stored.

The credential is also scrubbed on the way into the log: a provider that rejects a key
sometimes quotes it in the error text, and `redactSecret` replaces the key — the whole value,
minus its first four characters, and minus its last four — with `[REDACTED]` (a secret shorter
than eight characters is left alone, as is a trimmed variant that falls below eight) before the
`span.model_request_end` error and the `session.error` are built. The message is otherwise kept
whole, so the log still says what the provider said. The brain itself never logs; the tests
capture the console anyway, because the libraries on this path could.

### Named credentials, Azure OpenAI, custom OpenAI-compatible endpoints and Amazon Bedrock (epic #245, A3a/A3b/A3c)

The first half of a `provider/model` id is not always one of the eleven provider ids. A
**named credential** — an Azure OpenAI credential stored under `azure` or `azure-eu`, or a
custom endpoint stored under `custom` — takes the model ids `<name>/<deployment>` (Azure) or
`<name>/<model>` (custom), and the credential's `type` is what decides which client builds it:

```
providerOf('azure/gpt-4o')  → 'azure'   → not one of the eleven → the credential's type decides
                                        → azure_openai → createAzure(...).chat('gpt-4o')
providerOf('custom/llama3') → 'custom'  → not one of the eleven → openai_compatible
                                        → createOpenAICompatible(...).chatModel('llama3')
providerOf('bedrock/…-v1:0') → 'bedrock' → not one of the eleven → bedrock
                                        → createAmazonBedrock(…)(modelId)
```

- **The type is the discriminant, and it is checked.** For a first half that _is_ one of the
  eleven, the request is built from an `api_key` credential (`credential.apiKey`); a credential
  of another type under a fixed provider id is an `UnsupportedProviderError`, because the server
  cannot store one — the name and the type have to agree. For any other first half the
  credential's own type decides which client is built; an `api_key` credential under a name no
  provider carries is still an `UnsupportedProviderError`, which ends a turn with no span and no
  request, exactly as before.
- **`createAzure` gets the key and a base URL, both explicit.** `azureBaseUrl(endpoint)` turns
  the resource endpoint a user saved (`https://my-resource.openai.azure.com`) into the base URL
  `@ai-sdk/azure` appends `/v1` to — deriving and normalizing the `/openai` segment, so the
  three spellings a user might paste land on the same API. `apiKey` is a constructor argument,
  so `AZURE_API_KEY` is never read.
- **`.chat(id)`, not the provider's default.** The default is the Responses API, which newer
  deployments support and older ones do not; the deployment name is a string the user typed, so
  the factory cannot know. Chat completions is the API every Azure deployment answers.
- **Every Azure request goes through `safeFetch`.** `azureFetch` is `safeFetch` under
  `STREAMING_LIMITS` — no total deadline and no size cap, because a model streams a long reply,
  and an idle timeout instead, because a stream that stops producing is hung rather than slow.
  Private addresses are **always** refused: the `allowPrivate` option safeFetch has is for the
  custom-URL credential type and is never passed here. The endpoint is a URL a user typed, so the
  guard runs on the model call exactly as it does on the save-time check (in the server).
- **The custom client is `@ai-sdk/openai-compatible` at the base URL the user saved.**
  `openAICompatibleBaseUrl(baseUrl)` normalizes the trailing slash (nothing else is derived —
  the family serves `<base>/models` and `<base>/chat/completions`, and the user pasted that
  root), `apiKey` is a constructor argument (an empty one sends no `Authorization` header —
  `createOpenAICompatible` has no environment fallback), and `.chatModel(id)` is used rather
  than the provider's default for the same reason Azure uses `.chat`. `isUsableCredential`
  checks this type's **base URL**, not its key: the key is optional (`apiKey` may be `''`), so a
  missing base URL is the only unusable shape.
- **The custom `fetch` honours the self-host setting, and only for this type.**
  `createOpenAICompatibleFetch({ allowPrivate })` — the server passes its
  `OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS` flag — spreads `allowPrivate: true` into safeFetch's
  options **only when the flag is on**; when it is off the option is absent, so the guard's own
  refusal applies. `azureFetch` never passes it. Both are built by the one
  `createSafeProviderFetch` (`provider-fetch.ts`), which is where the AI SDK's `Request`-or-URL
  shape and the `STREAMING_LIMITS` preset meet.

**Bedrock is the other named type, and it is signed rather than guarded.** A `bedrock` model id
is `<name>/<bedrock model id>`, and the client is `createAmazonBedrock(…)(modelId)`:

- **The address is derived from the region, so there is no URL to guard.** `bedrock.ts` builds
  `https://bedrock-runtime.<region>.amazonaws.com`, and the region came from the protocol's list
  — validated on save, because it is spliced into the host. That is why this type, alone among
  the three, needs no `safeFetch`: nothing here is a user-supplied address.
- **Every setting is passed explicitly, and one of them looks like a no-op.** `region`,
  `accessKeyId`, `secretAccessKey`, `sessionToken` and `baseURL` are all constructor arguments,
  so `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and
  `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` are never read. `apiKey: ''` is the subtle one: a
  non-blank `apiKey` — or the `AWS_BEARER_TOKEN_BEDROCK` variable — flips the provider to bearer
  auth and skips SigV4, so an explicit empty string _seals_ that variable and keeps the client on
  the user's stored keys. A deployment with the variable set would otherwise authenticate every
  request with a token nobody saved.
- **The control plane is signed here, not by the provider package.** `@ai-sdk/amazon-bedrock`
  has no control-plane surface, so the server's `ListFoundationModels` check and its catalogue
  read use `signBedrockRequest` — `aws4fetch`, the same signer the provider uses internally, so
  both paths sign identically. The two AWS hosts are signed for the one `bedrock` service, and a
  returned value rather than a `fetch` keeps the server's own egress-proxy-aware client in the
  path. Nothing in this module reads an `AWS_*` variable or a shared credentials file; the decoy
  test sets the lot and asserts none of them reaches a request.
- **A credential's secrets are plural, and redaction knows it.** `credentialSecrets` lists the
  access key ID, the secret and the session token, and `turn.ts` scrubs a provider's error text
  with all of them — a rejected request echoed back can quote any of the three. `last4` is drawn
  from the **access key ID**, the one half a reader recognises and the only one safe to show.

**Bedrock is the other named type, and it is signed rather than guarded.** A `bedrock` model id
is `<name>/<bedrock model id>`, and the client is `createAmazonBedrock(…)(modelId)`:

- **The address is derived from the region, so there is no URL to guard.** `bedrock.ts` builds
  `https://bedrock-runtime.<region>.amazonaws.com`, and the region came from the protocol's list
  — validated on save, because it is spliced into the host. That is why this type, alone among
  the three, needs no `safeFetch`: nothing here is a user-supplied address.
- **Every setting is passed explicitly, and one of them looks like a no-op.** `region`,
  `accessKeyId`, `secretAccessKey`, `sessionToken` and `baseURL` are all constructor arguments,
  so `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and
  `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` are never read. `apiKey: ''` is the subtle one: a
  non-blank `apiKey` — or the `AWS_BEARER_TOKEN_BEDROCK` variable — flips the provider to bearer
  auth and skips SigV4, so an explicit empty string _seals_ that variable and keeps the client on
  the user's stored keys. A deployment with the variable set would otherwise authenticate every
  request with a token nobody saved.
- **The control plane is signed here, not by the provider package.** `@ai-sdk/amazon-bedrock`
  has no control-plane surface, so the server's `ListFoundationModels` check and its catalogue
  read use `signBedrockRequest` — `aws4fetch`, the same signer the provider uses internally, so
  both paths sign identically. The two AWS hosts are signed for the one `bedrock` service, and a
  returned value rather than a `fetch` keeps the server's own egress-proxy-aware client in the
  path. Nothing in this module reads an `AWS_*` variable or a shared credentials file; the decoy
  test sets the lot and asserts none of them reaches a request.
- **A credential's secrets are plural, and redaction knows it.** `credentialSecrets` lists the
  access key ID, the secret and the session token, and `turn.ts` scrubs a provider's error text
  with all of them — a rejected request echoed back can quote any of the three. `last4` is drawn
  from the **access key ID**, the one half a reader recognises and the only one safe to show.

### Usage

`ai@7` reads a model's `specificationVersion` and reshapes what it reports to match. Every
provider in `PROVIDER_CLIENTS` declares the spec it implements (`v4`), which is the one `ai@7` reads,
so a report arrives as the numbers the protocol wants — `{ inputTokens: { total, noCache,
cacheRead, cacheWrite }, … }` — and `result.usage` is reliable.

The router this replaced did not: it declared the **v2** spec while streaming v3-shaped usage,
so `ai` ran its v2 compatibility layer over a report that was already the newer shape,
`streamText` accumulated the steps with `0 + { … }`, and the total became the _string_
`"0[object Object]"` (issue #39). That is gone with it, but the recovery stays, because it
costs a `typeof` check and because a future pairing could disagree in the same way:

- `streamModelRequest` reads each step's own report (`finish-step`) as it streams — the counts
  are most truthful there — and only falls back to the SDK's accumulated `result.usage` when no
  step reported one.
- `toModelUsage` accepts whatever shape arrives: the v4 usage object, that object wrapped once
  more by a compatibility layer, a numeric field (a number or a numeric string), or nothing
  readable at all. It always answers with the protocol's four counters, as non-negative
  integers, and `0` for a count that cannot be recovered rather than a value the log would
  reject. Cache counters come from the breakdown when the shape has one and from inside the
  usage object when it does not.

`model.test.ts` reads **real-shaped streams** for the two biggest providers — an OpenAI
Responses body and an Anthropic Messages body, streamed through the real clients with `fetch`
stubbed — and asserts the four counters the wire carried. That is the acceptance test for the
whole seam: not that a mock's object maps correctly, but that the numbers a provider really
sends reach the log. `testing/mock-model.ts`'s `wrongSpecModel` declares the wrong spec on
purpose and stays as `toModelUsage`'s regression test; no shipped provider is that model.

Sessions whose turns ran before the fix keep the unreadable rows they were stored with; v1 is
unreleased, so nothing migrates them — the fix is what stops new ones being written.

### The reasoning effort

How hard a request is asked to think is a property of the **request**, and `low | medium | high`
is the vocabulary the protocol fixes (`@openharness/protocol`); this package is where a level
becomes the thing a provider actually reads (`src/reasoning.ts`).

- **One table, keyed by the provider list, that keeps only the spelling.** `PROVIDER_REASONING`
  is a `Readonly<Record<ProviderId, …>>` — the same shared list #245 built — so a provider the
  server can store a key for and this table has no effort for is a compile error. Each row keeps
  only the `providerOptions` its AI SDK client reads: Anthropic's `effort`, OpenAI's and xAI's
  and Groq's and Cerebras' `reasoningEffort`, DeepSeek's, Mistral's, Fireworks' and Together's,
  Gemini's `thinkingConfig.thinkingLevel`, OpenRouter's — each checked against the installed
  `@ai-sdk/*` version — and the clamp its own knob needs (DeepSeek has no `medium` and runs it
  at `high`; Mistral has only `none` and `high`, and every level above the default runs at
  `high`; `applied`).
- **A second table, keyed by credential type, for the named credentials.** A named credential's
  model ids carry its _name_ as the first half (`azure-eu/gpt-4o`), and a name is the reader's,
  so the provider table has no row for it. `CREDENTIAL_TYPE_REASONING` is the
  `Readonly<Record<NamedCredentialType, …>>` that does: `azure_openai` asks Azure OpenAI for an
  effort through the **`openai`** options key, which is what `@ai-sdk/azure`'s chat model reads
  (it _is_ the OpenAI chat model under an Azure URL, `azure.chat`; `providerOptions.azure` would
  never be looked at). A type the protocol grows without a row here is a compile error.
- **Which models take an effort is the host's, through an injected resolver.** It used to be
  hand-written patterns per provider in this table, which rotted with every model release — a new
  reasoning model silently got no effort, a renamed one could be sent a level its API rejects
  with a 400. `RunTurnOptions.reasoningSupportFor` is a `(modelId, credentialType) => levels |
undefined` resolver, the same seam the context budget's `tokenBudgetFor` uses, built by the
  host from the registry it already holds (the server's models.dev snapshot); the rows above
  supply only the option and the clamp. The credential type travels with the id because the id's
  first half may be a credential's name rather than a provider id, and the _type_ is what says
  which registry entry a deployment reads (see the server's resolver). A host that injects none —
  and a model the resolver does not know (a custom URL, an Azure deployment models.dev has no
  entry for, a model a snapshot predates) — is the **safe default**: no model is known to take an
  effort, so nothing is sent and the request keeps the provider's default. `undefined` (unknown)
  and `[]` (known to take none) are kept apart for that reason.
- **A level the model does not take is clamped to one it does.** When the resolver names the
  levels a model takes and the level the provider's knob produced is outside them, the nearest
  is sent — a `medium` asked of a model that takes `low` and `high` runs at `high` — so a level
  the model's API would reject is never put on the wire.
- **The loop reads the effort out of the log, per request.** `requestedReasoningEffort` walks the
  replay read for the newest `user.message` carrying one — the same "from this message on"
  reading as the model switch of #111, and the same boundary, so a message that arrived while the
  previous request was streaming belongs to the next one. Nothing is stored on the session, so a
  log that never carried an effort answers `null` and its requests are built exactly as they were
  before #252.
- **Both facts land on the span.** `span.model_request_start.reasoning_effort` records
  `{ requested, applied }`: `applied` is `null` when the model took none, and the field is absent
  when nothing was asked for. That record is the only durable statement of what a request ran
  with — the session's own field is the message that asked.

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
  (#117), and the delays that ladder sleeps, pinned with a fixed jitter so a wrong attempt
  index or a missing policy ceiling fails a number — the six ways a turn can be recovered, a
  fenced write and a claim another owner took (both stop the turn where it stands), a turn
  against a model that declares the wrong provider spec, and the invalid-event ending (a store
  subclass that refuses the `agent.message` with the loop's own `EventValidationError`, the one
  branch no scripted model can reach); most scenarios also assert that a replay of the log
  holds no superseded chunk and that no span start exists without a model request behind it,
  and one asserts that the brain writes only through `appendEvents`.
- `per-request-model.test.ts` — the per-request model (U3): a queued message that switched
  the session's model is what the first request runs (and its provider is whose credential is
  resolved), a steering message carrying a switch — across providers — is the model of the
  **next** request while the first keeps its own, the session's projection follows the log,
  and the newest switch among several queued messages wins.
- `reasoning.test.ts` and `reasoning-effort.test.ts` — the effort: the option spelling for every
  one of the eleven providers (with a resolver granting the model the levels), the levels a
  provider's own knob cannot spell, the resolver's gate (`undefined` and `[]` both send nothing,
  an unknown provider sends nothing), the clamp to the nearest level a model takes, the newest
  effort winning the walk over the log, and the loop's own half — the option reaching the
  model call, the span recording what was asked for and applied (including `applied: null`
  for a model that takes none, the same when no resolver is injected), a switch that arrives
  mid-stream belonging to the next request, and a session that never asked for one writing no
  field at all.
- The credential paths live in `turn.test.ts` too: a turn that ends with
  `missing_provider_credential` (no span, the queued message claimed by the idle event, no
  model call), the same with `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` set to decoys and `fetch`
  stubbed (the environment is never a fallback), a resolver asked once per request, and a
  whole scenario — a normal turn, a 401, a retryable failure — whose provider errors quote a
  distinctive fake key, asserting neither the key nor a four-character-trimmed piece of it
  appears in the stored events or in captured console output.
- `context.test.ts` pins the per-model budget resolver of #246 too: the strategy trims to what
  `tokenBudgetFor` answers for the request's own model, falls back to the default when it
  answers nothing, and asks it once per call with the id the request runs.
- `errors.test.ts`, `retry.test.ts`, `log.test.ts`, `model.test.ts`,
  `redact.test.ts`, `validate.test.ts` and `index.test.ts` cover the pieces on their own,
  including the branches the loop cannot reach. `errors.test.ts` also covers the wrappers the
  classification follows (`AI_RetryError` and duck-typed ones), and `model.test.ts` pins the
  one-failure-one-call invariant with a failure the SDK's retry classifier would act on.
- `bedrock-model.test.ts` — the Bedrock path: both endpoint builders, the request the real
  factory sends (a stubbed global `fetch`, because the provider resolves `globalThis.fetch` at
  request time and the host comes from the region rather than from a user-typed URL), the URL
  shape `/model/<id>/converse-stream` with the model id's colon percent-encoded, the **decoy
  environment** — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_REGION`,
  `AWS_DEFAULT_REGION`, `AWS_PROFILE`, a shared credentials file through
  `AWS_SHARED_CREDENTIALS_FILE`, the two endpoint overrides and `AWS_BEARER_TOKEN_BEDROCK`, with
  the request asserted to carry none of them and to be SigV4-signed with the stored key for the
  stored region — the stored session token riding along when there is one and no
  `x-amz-security-token` invented when there is not, `signBedrockRequest`'s signature and the
  service it scopes to, `isUsableCredential`'s three blanks, `credentialSecrets`, and the
  unsupported-provider endings.
- `azure-model.test.ts` — the named-credential path: `azureBaseUrl`'s normalization, the URL a
  `azure/gpt-4o` request is sent to (the deployment from the id, the endpoint from the
  credential), the key in the `api-key` header with `AZURE_API_KEY` set to a decoy, and that
  the real `azureFetch` refuses a loopback, metadata or `http:` endpoint before any request.
- `openai-compatible-model.test.ts` — the custom-endpoint path (#249): `openAICompatibleBaseUrl`'s
  normalization, the URL a `custom/llama3.3` request is sent to, the key as `Authorization:
Bearer` with a decoy environment, **no** `Authorization` header for a keyless endpoint, a
  streamed SSE reply end to end, the self-host `allowPrivate` option reaching the guard only when
  it is on (and the streaming preset in every case), and that the real `openAICompatibleFetch`
  refuses a loopback, metadata or `ftp:` endpoint before any request.
- `src/testing/harness.ts` builds the session and reads the log back; `src/testing/mock-model.ts`
  scripts what each model request answers with, records the prompts, and can act mid-stream
  (abort, append a steering message) between two chunks. Its `apiCallError` is the failure
  shape a retry test needs — an `APICallError` the SDK's own retry classifier would act on, so
  a call-count assertion can actually fail (#117). Its `wrongSpecModel` is the one model
  no provider has to be asked for: a mock that declares the `v2` provider spec over v3-shaped
  usage, which is the shape the router this package used to carry produced — the tests that use
  it assert the counts still reach the log, as integers. `src/testing/provider-streams.ts` holds
  the real-shaped SSE bodies `model.test.ts` streams through the real provider clients.

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
