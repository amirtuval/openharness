# @openharness/brain

The stateless brain: the harness loop that drives a session.

A turn is one call to `runTurn`. It reads the session log, streams a reply from the model, and
appends what happened — user events claimed, a span around every model request, the chunks of
the reply as they arrive, the reply itself, the tool calls the model made and the answers they
came back with, the status transitions and any error. It remembers nothing between turns and knows nothing about
scheduling, ownership, HTTP or Postgres: it is handed a `SessionStore`, a model factory, a
credential resolver and an abort signal. Every model request is made with a credential the
resolver answered — the session owner's own provider key, never one from the environment (epic
#65, A5) — and a request the owner has no key for ends the turn before it is attempted. The log
is the state, which is what lets a crashed turn be resumed by another process — and why a brain
that holds a partition lease writes under its fence.

What a turn streams is the **session's** configuration: `session.model` is the id a request is
built from and recorded on its span, and `session.system` is the system prompt the context
strategy is handed (epic #92, #93/#94) — unless the session follows a **mode** (#245, M6),
which the host resolves per request so the request runs the mode's model, effort and
system-prompt addition instead. The **reasoning effort** a request runs at is read from
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
  context.ts            ContextStrategy: the log as model messages — the latest summary, the
                        history it covers, the trimmed tail (K1), the capped newest item (K6) —
                        the cut rule and the items it reads, the caps on a tool result and the
                        clearing of old ones (X9, #306), and the real size of the next request (K2)
  summarize.ts          the compaction engine: the trigger, the cut rule, the chunked passes, the
                        summary event (epic #277, C2; #279) and the tool-work prompt (#306)
  manual.ts             the manual half: whether a `/compact [instructions]` request is still
                        waiting for an answer, read off the log (epic #277, K8; #283)
  pausing.ts            the pause: the calls the user has to answer, the one confirmation that
                        answers them, and what each answer means (#309)
  model.ts              ModelFactory, credentials, and streaming one request through the AI SDK
  azure-fetch.ts        the Azure endpoint's base URL, and the safeFetch guard a model call goes through
  reasoning.ts          the reasoning effort: per provider, gated by the injected resolver
  provider-fetch.ts     the one guarded `fetch` (safeFetch + a limits preset + allowPrivate) both types build from
  openai-compatible-fetch.ts  a custom endpoint's base URL, and the safeFetch guard its model call goes through (#249)
  bedrock.ts            Bedrock's two AWS hosts, and the SigV4 signing the server borrows for a
                        control-plane read
  vertex.ts             the Vertex model families: which client builds a `gemini-*` or `claude-*` id
  redact.ts             redactSecret: scrubbing a provider key out of error text
  errors.ts             classifyModelError: retryable or terminal, and which session.error
  retry.ts              RetryPolicy, backoff, and the injectable sleep
  tools.ts              the loop's tool half: what a request offers, what the settings say, how
                        one step's calls are stored, run and answered (epic #303, #304; the
                        per-user settings and the mode's override: #307; `ask` and the
                        approvals a chat remembers: #309)
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

| export                                                                                                                                                                                                                                            | what it is                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runTurn(sessionId, options)`                                                                                                                                                                                                                     | run one turn; resolves to a `TurnOutcome`                                                                                                                                                                                                                                                                                                                                                      |
| `RunTurnOptions`                                                                                                                                                                                                                                  | `{ store, model, resolveCredential, signal?, fence?, contextStrategy?, reasoningSupportFor?, resolveMode?, retry?, tools?, toolSettings?, toolSupportFor?, resolveToolSecrets?, maxToolSteps? }`                                                                                                                                                                                               |
| `runToolStep(options)`, `ToolStepOptions`                                                                                                                                                                                                         | one step's tool calls (epic #303, X2; #307): the permission read off the request's settings, the calls stored, run concurrently through the registry and answered in call order                                                                                                                                                                                                                |
| `repairLostExecutions(events, append)`, `lostExecutions(events)`, `pendingToolUse(events)`                                                                                                                                                        | the crash rule (X3): the calls the log holds with no answer **and no user waiting on them**, and the `execution lost` results a brain that inherited them writes — never running them again                                                                                                                                                                                                    |
| `awaitingUser(events)`, `answeredWaiting(events)`, `confirmationsByCall(events)`, `sessionApprovedTools(events)`, `waitsForUser(permission, registered, name)`, `malformedQuestion(call)`                                                         | the pause, read off the log (epic #303, X6; #309): the calls with no result that wait on the user, the ones the user has answered, the newest confirmation per call, the tools this chat has been told to allow, whether a call is one the user must answer, and what is wrong with an `ask_user` call's questions                                                                             |
| `answerConfirmations(options)`, `confirmationOutcome(call, confirmation, recovered)`, `resolveWaiting(options)`, `denied(message)`, `executionLost(name)`, `RESOLVED_BY_MESSAGE`                                                                  | what answers a paused call: the turn's one append for the calls the user answered (running an approved tool, writing the denial, or writing the answers), the resolution of a single confirmation, the results a message or an interrupt leaves, and the two sentences those are written with                                                                                                  |
| `asToolInput(value)`                                                                                                                                                                                                                              | a model's arguments as the JSON object the log stores: anything JSON cannot carry is dropped, and a value that is not an object becomes `{}`                                                                                                                                                                                                                                                   |
| `DEFAULT_MAX_TOOL_STEPS`                                                                                                                                                                                                                          | `50` — the model requests one turn may make before it ends with the step-limit notice (X2)                                                                                                                                                                                                                                                                                                     |
| `offeredTools(registry)`, `toolSet(registry)`, `toolsFor(registry, supportFor, settings, modelId, credentialType)`                                                                                                                                | what a request's span records, the definitions the model is offered (with **no** `execute`, so the AI SDK never loops), and the registry this request may call from — the settings' disabled tools left out, `undefined` when that leaves none                                                                                                                                                 |
| `ToolDecision`, `ToolSettings`, `ToolSettingsResolver`, `ToolSupportFor`, `ToolSecretResolver`                                                                                                                                                    | the injected seams around tools: the settings in force per request — an `enabled` and a `permission` per tool name, asked with the owner and the mode's override (#307) — whether a model can call tools at all (models.dev's `tool_call`), and where a turn's per-user values come from (#311)                                                                                                |
| `TurnOutcome`, `TurnOutcomeKind`                                                                                                                                                                                                                  | `{ outcome: 'idle' \                                                                                                                                                                                                                                                                                                                                                                           | 'noop' \                     | 'interrupted' \                                                                                                                                 | 'error' }` |
| `ResolvedMode`, `ModeResolver`                                                                                                                                                                                                                    | a mode as the host resolved it — id, name, model, effort, prompt addition, and the tool override it imposes (#245, M6; #307) — and where a request's mode comes from                                                                                                                                                                                                                           |
| `ContextStrategy`, `ContextStrategyOptions`, `ContextStrategyResult`                                                                                                                                                                              | `(events, { model, system, tools? }) => { messages, truncated?, cleared? }` — the messages, what the strategy had to cap to fit (epic #277, K6) and the tool results it capped and cleared (epic #303, X9; #306). `tools` is the registry whose declarations carry the per-result cap                                                                                                          |
| `createContextStrategy(config?)`, `ContextStrategyConfig`                                                                                                                                                                                         | the default strategy: the conversation, summarized where the log says so (#277 K1), trimmed to a token budget resolved per model, with an oversized newest item capped (K6), a tool result capped to its tool's declaration (X9) and an old one cleared (X9)                                                                                                                                   |
| `DEFAULT_CONTEXT_STRATEGY`, `DEFAULT_CONTEXT_TOKEN_BUDGET`, `CHARS_PER_TOKEN`                                                                                                                                                                     | its defaults                                                                                                                                                                                                                                                                                                                                                                                   |
| `estimateTokens(text)`                                                                                                                                                                                                                            | the chars/4 estimate the budget is measured in                                                                                                                                                                                                                                                                                                                                                 |
| `OMISSION_MARKER(tokens)`                                                                                                                                                                                                                         | the `[… N tokens omitted …]` a capped item carries where its middle was (K6)                                                                                                                                                                                                                                                                                                                   |
| `estimateNextRequestTokens(options)`, `NextRequestSizeOptions`, `ContextSizeBaseline`, `promptTokensOf(usage)`                                                                                                                                    | how big the next request will be (K2): the previous request's real prompt size plus an estimate for what is new, falling back to chars/4 when the previous request cannot be a baseline                                                                                                                                                                                                        |
| `estimateContextSize(events, options)`, `ContextSizeOptions`, `isUsableContextSizeBaseline`, `latestContextSummary(events)`, `capItemText(text, budget)`                                                                                          | the same measurement, taken off a whole log: the baseline request, the text new since it, and — when there is none — the visible history (epic #277, K2; C2) — with a tool result measured as the request will carry it, capped and cleared (X9; `options.tools` and `options.budget`). `latestContextSummary` is the summary in force (K1); `capItemText` is the head-and-tail cut K6 applies |
| `summarizeContext(options)`, `SummarizeContextOptions`, `SummarizeResult`                                                                                                                                                                         | the compaction engine (epic #277, C2; #279): the trigger, the cut, the passes and the `session.context_summary` it writes                                                                                                                                                                                                                                                                      |
| `pendingManualCompaction(events)`, `PendingCompaction`                                                                                                                                                                                            | the manual half (epic #277, K8; #283): the newest `session.compact` no `session.compaction` answers yet, read off the log — what makes `/compact` idempotent while one is pending and lets the turn loop pick one up                                                                                                                                                                           |
| `compactionOutcome(outcome, record)`, `CompactionOutcomeRecord`                                                                                                                                                                                   | the brain's `session.compaction` event: what came of a manual request, echoing the guidance used (#283)                                                                                                                                                                                                                                                                                        |
| `resolveContextCompaction(config)`, `ContextCompactionConfig`, `ResolvedContextCompaction`, `DEFAULT_COMPACTION_THRESHOLD`, `DEFAULT_MAX_SUMMARY_PASSES`                                                                                          | how the engine is configured and the defaults it fills in: the threshold (0.7), the summary model (`null` = the chat's), the pass limit (3), the per-model budgets and output ceilings, and the cut rule                                                                                                                                                                                       |
| `summarizeContext(options)`, `SummarizeContextOptions`, `SummarizeResult`                                                                                                                                                                         | the compaction engine (epic #277, C2; #279): the trigger, the cut, the passes and the `session.context_summary` it writes                                                                                                                                                                                                                                                                      |
| `resolveContextCompaction(config)`, `ContextCompactionConfig`, `ResolvedContextCompaction`, `ContextCompactionResolver`, `ContextCompactionOption`, `DEFAULT_COMPACTION_THRESHOLD`, `DEFAULT_MAX_SUMMARY_PASSES`                                  | how the engine is configured and the defaults it fills in: the threshold (0.7), the summary model (`null` = the chat's), the pass limit (3), the per-model budgets and output ceilings, and the cut rule — and the option a host passes: one config, or a resolver the loop asks per request with the session owner (#282)                                                                     |
| `cutAtUserBoundary(items, tailTokens)`, `ContextCutRule`, `ContextCutItem`                                                                                                                                                                        | K12's one replaceable function: where history may be cut — the default keeps a recent tail, never splits a turn and never splits a tool call from its answer, steering or not (#306)                                                                                                                                                                                                           |
| `conversationItems(events, afterSeq, cap)`, `toolResultCap(tools, budget)`, `ToolResultCap`                                                                                                                                                       | the visible conversation as cut items — messages, calls and results, a result naming the call it answers — measured as a request would carry it (X9); and the cap one result may cost, by tool (X9)                                                                                                                                                                                            |
| `SUMMARY_SIZE_RATIO`, `RECENT_TAIL_RATIO`, `OVERFLOW_RECENT_TAIL_RATIO`, `SUMMARY_ITEM_CAP_RATIO`, `SUMMARY_SLICE_RATIO`, `SUMMARY_SIZE_BUDGET_RATIO`, `SUMMARY_INPUT_MARGIN`, `MIN_SLICE_TOKENS`, `MIN_SUMMARY_TOKENS`, `SUMMARY_PROMPT_VERSION` | the engine's numbers and the version of the summary prompt it records (`context-summary-v2` since #306; K5/K6/K7)                                                                                                                                                                                                                                                                              |
| `TOOL_RESULT_BUDGET_RATIO`, `CLEARED_TOOL_RESULT(tokens)`                                                                                                                                                                                         | the share of the chat model's budget no single tool result may take (X9, #306), and what a cleared result's body is replaced by                                                                                                                                                                                                                                                                |
| `ModelCredential`                                                                                                                                                                                                                                 | `{ type: 'api_key', apiKey }`, `{ type: 'azure_openai', apiKey, endpoint }`, `{ type: 'openai_compatible', apiKey, baseUrl }`, `{ type: 'bedrock', accessKeyId, secretAccessKey, sessionToken?, region }` or `{ type: 'vertex', project, location, serviceAccount }` — one request's credential                                                                                                |
| `VertexModelCredential`                                                                                                                                                                                                                           | the Vertex shape on its own: the project, the location, and the service-account key document as text                                                                                                                                                                                                                                                                                           |
| `credentialSecrets(credential)`                                                                                                                                                                                                                   | every secret a credential carries, for redaction — a Bedrock credential has three, a Vertex one its private key PEM                                                                                                                                                                                                                                                                            |
| `ResolveCredential`                                                                                                                                                                                                                               | `(name) => Promise<ModelCredential \                                                                                                                                                                                                                                                                                                                                                           | null>` — where it comes from |
| `ModelFactory`                                                                                                                                                                                                                                    | `(modelId, credential) => LanguageModel` — how a `provider/model` becomes a model                                                                                                                                                                                                                                                                                                              |
| `providerModelFactory`, `createProviderModelFactory(options)`                                                                                                                                                                                     | the `ModelFactory` hosts normally pass: the official AI SDK providers, the key passed explicitly, and the egress `fetch` a host injects (#270)                                                                                                                                                                                                                                                 |
| `azureFetch`, `createAzureFetch(options)`, `azureBaseUrl(endpoint)`                                                                                                                                                                               | the Azure `fetch` (safeFetch under the streaming-safe limits) and the base URL it builds                                                                                                                                                                                                                                                                                                       |
| `redactSecrets(text, secrets)`                                                                                                                                                                                                                    | `redactSecret` for a credential that carries more than one secret                                                                                                                                                                                                                                                                                                                              |
| `BEDROCK_SERVICE`, `bedrockRuntimeBaseUrl(region)`, `bedrockControlPlaneUrl(region, path)`                                                                                                                                                        | the SigV4 service both Bedrock hosts are signed for, and the two AWS hosts a region derives                                                                                                                                                                                                                                                                                                    |
| `BEDROCK_FOUNDATION_MODELS_PATH`, `BEDROCK_INFERENCE_PROFILES_PATH`                                                                                                                                                                               | the two control-plane paths the server's save-time check and catalogue read (models, and inference profiles, #274)                                                                                                                                                                                                                                                                             |
| `signBedrockRequest(credential, url, input?)`, `SignedBedrockRequest`, `BedrockRequestInput`                                                                                                                                                      | one SigV4-signed Bedrock request, returned rather than sent — what the server's save-time check and catalogue read use                                                                                                                                                                                                                                                                         |
| `openAICompatibleFetch`, `createOpenAICompatibleFetch(options)`, `openAICompatibleBaseUrl(baseUrl)`                                                                                                                                               | the custom endpoint's `fetch` (safeFetch under the streaming-safe limits, with the self-host `allowPrivate` option, #249) and the base URL it normalizes                                                                                                                                                                                                                                       |
| `isVertexModelId(id)`, `isVertexAnthropicModel(id)`                                                                                                                                                                                               | which Vertex ids this build can serve, and which of them the Anthropic client builds — the same rule the server's catalogue filters with (#251)                                                                                                                                                                                                                                                |
| `SafeFetch`, `ProviderFetch`, `SafeProviderFetchOptions`, `createSafeProviderFetch(options)`                                                                                                                                                      | the one guarded `fetch` the two URL-typed types are built from                                                                                                                                                                                                                                                                                                                                 |
| `providerOf(modelId)`                                                                                                                                                                                                                             | the provider of a `provider/model` id: the part before the first slash                                                                                                                                                                                                                                                                                                                         |
| `isUsableCredential(credential)`                                                                                                                                                                                                                  | whether a resolved credential is a key at all (a blank one is not)                                                                                                                                                                                                                                                                                                                             |
| `missingCredentialMessage(provider)`                                                                                                                                                                                                              | the `session.error` sentence for a provider with no key                                                                                                                                                                                                                                                                                                                                        |
| `redactSecret(text, secret)`, `REDACTED_PLACEHOLDER`                                                                                                                                                                                              | the credential scrubbed out of provider error text                                                                                                                                                                                                                                                                                                                                             |
| `streamModelRequest(params)`, `ModelRequestParams`, `ModelRequestResult`                                                                                                                                                                          | one model request, as text, usage, error and abort                                                                                                                                                                                                                                                                                                                                             |
| `ProviderOptions`                                                                                                                                                                                                                                 | the AI SDK's per-provider options for one call, read off `streamText`                                                                                                                                                                                                                                                                                                                          |
| `PROVIDER_REASONING`, `CREDENTIAL_TYPE_REASONING`, `planReasoning`, `ReasoningPlan`, `ReasoningSupportFor`, `requestedReasoningEffort`                                                                                                            | `low \                                                                                                                                                                                                                                                                                                                                                                                         | medium \                     | high` in each provider's — and named credential type's — own option, gated by the injected resolver, and what the log asks a request for (#252) |
| `toModelUsage(usage)`, `ZERO_MODEL_USAGE`                                                                                                                                                                                                         | what a request reported → the protocol's four counters, always integers                                                                                                                                                                                                                                                                                                                        |
| `classifyModelError(error)`, `ModelErrorClassification`                                                                                                                                                                                           | retryable or not, and the `session.error` type that says so                                                                                                                                                                                                                                                                                                                                    |
| `isRetryableModelError(error)`                                                                                                                                                                                                                    | the same answer, when only the boolean is wanted                                                                                                                                                                                                                                                                                                                                               |
| `isClaimConflictError(error)`                                                                                                                                                                                                                     | whether the store refused a claim another owner had taken                                                                                                                                                                                                                                                                                                                                      |
| `isOwnershipError(error)`                                                                                                                                                                                                                         | a fenced write or a claim conflict: the log is somebody else's (D9)                                                                                                                                                                                                                                                                                                                            |
| `RetryPolicy`, `ResolvedRetryPolicy`, `resolveRetryPolicy(policy?)`                                                                                                                                                                               | how failures are retried                                                                                                                                                                                                                                                                                                                                                                       |
| `backoffDelay(attempt, policy)`, `abortableSleep`, `Sleep`                                                                                                                                                                                        | the delay, and the sleep that honors an abort                                                                                                                                                                                                                                                                                                                                                  |
| `DEFAULT_MAX_RETRIES`, `DEFAULT_BASE_DELAY_MS`, `DEFAULT_MAX_DELAY_MS`                                                                                                                                                                            | `3`, `500`, `8000`                                                                                                                                                                                                                                                                                                                                                                             |
| `PACKAGE_NAME`, `DEPENDENCIES`                                                                                                                                                                                                                    | the package name, and the edges that must resolve through built output                                                                                                                                                                                                                                                                                                                         |
| `log.ts`, `events.ts` and `validate.ts` are internal: they are how the loop is written, not what                                                                                                                                                  |
| a host talks to.                                                                                                                                                                                                                                  |
| **An edited message is not history.** A `session.rewind` (#238) restarts the session from the                                                                                                                                                     |
| `user.message` a reader edited, and everything it replaced is gone from the log the brain                                                                                                                                                         |
| reads — `readLog` is the store's replay read, which skips what a recorded range covers — so                                                                                                                                                       |
| the prompt a request is built from holds the conversation as the reader left it, and the model                                                                                                                                                    |
| is never told what the edit took back. The brain does nothing about it: the turn reads the log                                                                                                                                                    |
| and answers what is waiting in it, exactly as after any other append.                                                                                                                                                                             |

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
  1b. a call the user has answered (#309) ................. answer it — run it, deny it, or write
     the answers as its result — and carry on with what that owes
  2. nothing left to answer ............................... session.status_idle, return idle
  2b. a call still waiting on the user (#309), and no message beside it .... PAUSE (below)
  3. re-read the session; its CURRENT model is this request's model (U3 — a user.message may
     have switched it, even mid-stream of the previous request), UNLESS the session follows a
     mode (#245, M6): the host resolves it as it is now and the resolved model is this
     request's. Either way it chooses the credential's provider. A session deleted meanwhile
     throws SessionNotFoundError and the turn stops, writing nothing (U5)
  4. no credential for the model's provider ............... MISSING CREDENTIAL (below)
  4b. the id names a provider with no client here .......... UNSUPPORTED PROVIDER (below)
  4c. a manual compaction is pending, and `compaction` is wired (#283)
     ...................................................... summarize the older history with
                                                             `reason: 'manual'` and the request's
                                                             guidance, at any size (K8), then write
                                                             the `session.compaction` outcome; the
                                                             log is re-read. On an idle session this
                                                             is the whole turn — no model reply of
                                                             its own, and nothing left to answer goes
                                                             idle below
  4d. the context is over the compaction threshold, and `compaction` is wired
     ...................................................... summarize the older history
                                                             (C2, #279): the summary's spans
                                                             and progress events, then the
                                                             `session.context_summary`, and
                                                             the log is re-read; a summarizer
                                                             that failed is recorded on its
                                                             span and changes nothing else
  4b. the turn has made OPENHARNESS_MAX_TOOL_STEPS requests .... STEPS EXHAUSTED (below)
  4c. a call the log holds with no answer .................. EXECUTION LOST (below)
  5. ... span.model_request_start { consumes: the queued user.message ids,
                                    model: the provider/model of the request,
                                    reasoning_effort: what the newest effort-carrying
                                    user.message asked for — else the mode's — and what was
                                    applied,
                                    mode: the mode the request ran under and its name then,
                                    tools: the { name, source } of every tool this request
                                    offered (#303 X1) — absent when it offered none,
                                    truncated: what the newest item had to be capped to, when it
                                    was over the model's budget (#277 K6), and the tool results
                                    it capped (epic #303, X9),
                                    cleared: the old tool results whose bodies were replaced by a
                                    placeholder so no summary was needed (X9) }
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
  9. the step called tools ................................ TOOL STEP (below), loop from 1
 10. another user.message arrived ......................... loop, from 1
 11. otherwise ............................................ session.status_idle, return idle

TOOL STEP — one model request's calls, run and answered (epic #303, X2; #307)
  each call's permission read off the request's settings ... else the tool's own declaration
  ...................................................... agent.tool_use × N { name, input,
                                                             evaluated_permission }
                                                             (one append, before anything runs)
  the calls run CONCURRENTLY through the registry .......... what the permission allowed; a
                                                             refused call is answered without
                                                             running, and one that waits on the
                                                             user is not answered at all
  ...................................................... agent.tool_result × N { tool_use_id,
                                                             content, is_error }
                                                             (one append, in CALL ORDER)
  then loop from 1: the answers are what owes the next request

  A result is `is_error: true` for everything that is not what the tool produced: a refusal
  (`Permission to use <name> has been denied.`), a timeout, an interrupt
  (`Interrupted by the user.`), the tool's own failure, or `execution lost`.

STEPS EXHAUSTED — the turn has made OPENHARNESS_MAX_TOOL_STEPS model requests (X2)
  ........................................... session.error
                                               { type: tool_steps_exhausted_error,
                                                 retry_status: terminal }
  ........................................... session.status_idle, return error

EXECUTION LOST — a call the log holds with no result, and no user waiting on it (X3)
  ........................................... agent.tool_result
                                               { is_error: true, "execution lost" }

  Never re-run: the call may already have had an effect nobody recorded. It runs at the request
  boundary, before any request is built, because an assistant turn whose calls have no answers
  is a request providers refuse. A call the user has **not** answered yet is not one of these:
  nothing is lost while the question is open, and a resumed brain keeps waiting (PAUSE).

PAUSE — a call whose decision is "the user has to answer this" (epic #303, X6; #309)
  the user has answered it (a `user.tool_confirmation` in the log)
    ..................................... the approved tool runs, a denial is written, or the
                                           answers become the `agent.tool_result` — one append,
                                           in call order — and the loop carries on
    the turn inherited an open turn, and the user *allowed* it
    ..................................... agent.tool_result { is_error: true, "execution lost" }
                                           — the approval is in the log and nobody knows
                                           whether it ran, so it never runs again
  nothing has answered it, and no message arrived
    ..................................... session.status_idle
                                           { stop_reason: { type: requires_action,
                                                            event_ids: the calls } }
    ..................................... return paused
  a user.message arrived while it waited ... agent.tool_result × N { is_error: true,
                                              "The user sent a message instead." }, then the
                                              turn carries on with the message
  an interrupt arrived while it waited ..... the same results, then INTERRUPT

  A pause is a turn end, not a wait in the process: the calls are in the log, the session is
  idle, and nothing is held open — no timer, no lease, no open request. That is what makes it
  survive a restart (a resumed brain reads the same log and keeps waiting) and what makes the
  `requires_action` stop reason the whole of what a client needs to draw the question.

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

CONTEXT TOO LONG — the provider refused the request as over its window, once per turn (K2, #279)
  ........................................... span.model_request_end
                                               { error: model_error, is_error: true,
                                                 supersedes: this attempt's chunks }
  ........................................... session.error { retry_status: retrying }
  ........................................... session.status_rescheduled
  compact with tighter caps (the overflow tail, half the usual one)
  a summary written .......................... session.status_running, back to step 4c
  a summary not written ...................... session.error
                                               { message: the provider's, plus why there was
                                                 no compaction ("no older history to
                                                 summarize", or "summarizing the history
                                                 failed"), retry_status: exhausted }
  ........................................... session.status_idle, return error
  a second refusal after the retry ............ the same clear error, no second compaction

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

## Tools (epic #303; #304)

The model can act: a request may offer tools, and a step that calls one has its calls stored,
run and answered before the next request is made. This package owns _when_; the tools
themselves — their names, descriptions, input schemas, permissions and timeouts — and the
running of one call are `@openharness/hands` (`createToolRegistry`, `execute`). Nothing else
about the loop changes: every step is an ordinary model request with its own span, so replay,
the transcript, usage and compaction see tools as one more thing the log holds.

- **The AI SDK is given no `execute`.** `toolSet` hands `streamText` the definitions without
  one, so the SDK stops after the step and reports the calls; a tool it could run is a tool it
  runs itself, looping underneath the loop that owns the log — the second loop X2 forbids. The
  brain then stores the call, runs it through the registry and makes the next request as its
  own step. `streamModelRequest` returns the step's `toolCalls` beside its text.
- **The call's identity is its event's.** `agent.tool_use`'s `id` is the call's id, the result
  names it in `tool_use_id`, and that id is what the rebuilt request uses as the AI SDK's
  `toolCallId` — so a call and its answer are one identity end to end, and a turn that finds a
  call with no answer knows exactly which execution was lost. The provider's own id is
  discarded.
- **The settings are resolved once per request, before the offer is built** (#307). The host's
  resolver is asked with the session's owner **and the tool override the request's mode
  imposes**, and what comes back is a decision per tool name: `enabled` — whether the tool is in
  the offer at all — and `permission` — what a call to it is evaluated under. Asking per request
  rather than per call is what makes a disabled tool **absent from the request**: the model
  cannot see it, so it cannot call it, and `span.model_request_start.tools` records only what
  was really offered. It is also why a settings change, or a mode edit, applies from the next
  request on — exactly like a model switch. The mode's override travels with the question rather
  than being merged here, because the host holds both the mode row and the user's settings; a
  mode decides on/off and never a permission.
- **`evaluated_permission` is the decision the call was made under.** It is read off the
  request's settings before the call is stored, so a setting changed later does not rewrite what
  a call ran under. `deny` refuses the call without running it (`Permission to use <name> has
been denied.`) — unless the name is one no tool carries, which is not a permission question at
  all and gets the registry's own `No tool named <name> is registered.`; `ask` is the pause of
  [#309](https://github.com/amirtuval/openharness/issues/309): the call is stored, nothing runs
  it, and the turn ends `requires_action` until one `user.tool_confirmation` answers it — so a
  setting nobody can honour never quietly becomes "run it" — and never reads as a denial the user
  did not make. A host that injects no settings gets each tool's own `permission`, which for
  every built-in is `allow` (#305) — the epic's "allow every registered tool" — while an MCP
  tool's `ask` (#312) pauses through the same path rather than being silently allowed. A tool a
  name nothing declares reads as `deny`.
- **Several calls of one step run concurrently and are stored in call order.** The calls are
  one append before anything runs (what the model asked for is in the log whatever happens
  next), the executions are concurrent, and the results are one append in the order the model
  made them — so three fetches cost one fetch's time and the log still reads as the model's
  questions rather than as the order a network happened to answer.
- **The limit is the turn's model requests, and it ends the turn with a notice.** `maxToolSteps`
  (the server's `OPENHARNESS_MAX_TOOL_STEPS`, `DEFAULT_MAX_TOOL_STEPS` = 50 here) counts the
  requests a turn makes; over it the turn writes `session.error
{ type: tool_steps_exhausted_error, retry_status: terminal }` and goes idle. `session.error`
  is the one event in the protocol that carries a sentence for the user, and `StopReason` has no
  member for this (it stays `end_turn`, X1) — so the notice is what says "this ended because the
  model looped" rather than a retry that would loop again.
- **A tool is never re-run automatically (X3).** A brain that inherits a `agent.tool_use` with
  no result answers it `execution lost` and lets the model decide; `repairLostExecutions` runs
  at the request boundary. The one call it must not answer is one waiting on the user (#309) —
  the seam its TSDoc names — because a question waiting for an answer has lost nothing.
- **A tool's timeout is per call, and it is a race.** `hands` runs the call against its own
  deadline and the turn's signal and reports whichever came first, so a tool that ignores the
  signal cannot hold the turn open. An interrupt during a tool step answers the running calls
  `Interrupted by the user.` and then ends the turn the way an interrupt always does.
- **`ctx` is the whole world a tool gets.** The turn's signal, the resolved timeout, and the
  per-user values the host resolved (`resolveToolSecrets`, asked once per step with the
  session's owner) — the same injected-resolver seam as `resolveMode`. Nothing in `hands` reads
  an environment variable or a database, and every value it is handed is scrubbed out of
  whatever a tool returns before it is stored.
- **Whether a model can call tools at all is the host's answer.** `toolSupportFor(modelId,
credentialType)` — the server builds it from models.dev's `tool_call`; `false` means no tools
  are offered and the request is built exactly as it was before tools existed, which is what
  keeps a model that cannot call them working rather than failing on a rejected parameter.
  `undefined` (a model the registry does not know) offers them, and so does no resolver at all:
  a host that wired a registry meant it.
- **The steering message that arrives during a tool step is the next request's.** The loop
  continues into the following request with the calls' answers, and a queued `user.message` is
  claimed by that request exactly as any steering message is.

### Tools in the context strategy

`conversationAfter` is where the log becomes messages, and tools are two shapes there: the
assistant's `agent.message` and its `agent.tool_use` events become **one** assistant message
(text parts first, then the calls), and the `agent.tool_result` events become one `tool`
message whose parts name the calls they answer by id.

- **An answer goes directly behind the turn that made the call**, even when the log put
  something between them. It can: a steering message arrives while a tool runs, so the log
  holds the call, then the user's message, then the answer — and a provider refuses an
  assistant turn whose calls are not answered by the very next message. The strategy moves the
  answer up rather than dropping it; a log that never interleaves is unaffected.
- **The trimming unit is a turn** — a `user` message and everything that answers it, tool calls
  and results included — so no cut can land between a call and its answer. Anything before the
  first user message (a summary cut, a rewind that took the question back) is an orphan and goes
  first. The item cap (K6) still shortens one block of text; a **tool result** is capped and
  cleared by the rules below (X9) instead, so no single result can be what pushes a request over
  its budget. A step of many capped results still can — the message that answers them is not one
  block of text, and the safety net does not split it — and a provider that refuses such a request
  ends the turn through the overflow path rather than with a request nobody can read.
- **A log that never held a tool builds exactly the request it always did** — no parts, no tool
  messages, the same strings — which is what keeps every session stored before #304 replaying
  unchanged, and a log whose results are all inside their caps and inside the verbatim tail
  builds exactly the request #304 built too.
- **The compaction engine covers tool work and cannot split a pair either.** Its item list is
  user messages, agent messages and both halves of every tool step (see below), and its cut —
  at a user-message boundary, widened back over a call whose answer would otherwise be kept
  without it — always leaves a tail that answers every call it carries.

### What a tool result may cost a request (epic #303, X9; #306)

A result is the one part of a request that can be arbitrarily large without anyone having
written it, so it is sized twice, and **both are the request's alone**: the stored
`agent.tool_result` keeps its body, and replay, the transcript and the summarizer still read it.

- **A result inside the verbatim tail is capped (X9).** The cap is the smaller of what its tool
  declares (`ToolDefinition.maxResultTokens`, `DEFAULT_TOOL_RESULT_TOKENS` = 4096 when it
  declares none) and `TOOL_RESULT_BUDGET_RATIO` — a fifth of the chat model's history budget, so
  a generous declaration cannot overrun a small model's window, and a result at the cap still
  leaves the quarter the engine keeps verbatim its room. The text becomes a head and a tail with
  `OMISSION_MARKER` between them, and every result the request capped is recorded in
  `span.model_request_start.truncated.results` — `{ seq, tool, tokens_before, tokens_after }` per
  result — so a client can show a notice. `truncated`'s `seq`/`tokens_before`/`tokens_after`
  still describe the newest item the request shortened: the newest message when it had to be
  capped (K6), and otherwise the newest result that was (X9).
- **A result older than the verbatim tail is cleared, before anything is summarized (X9).** Its
  body is replaced by `CLEARED_TOOL_RESULT(n)` — "result cleared, N tokens" — and the count and
  the tokens are recorded on the span as `cleared: { results, tokens }`. Old tool output is what
  a request can most afford to give up, and giving it up costs no model call: **clearing is the
  first answer to a filling context**, which is why `estimateContextSize` measures the request
  with the placeholder in it and a context it brings back under the threshold is never
  summarized at all.
- **"Old" is the K4 tail** — the recent quarter of the chat model's budget, cut at a
  `user.message` boundary by the same rule the engine cuts with — so a context small enough to be
  all tail clears nothing, and a result is cleared exactly when it is history the engine's cut
  would have covered.
- **The rules are derived, not recorded.** Both are computed from the log, the budget and the
  registry's declarations, by one function (`resultPolicy`), which is what lets the measurement
  the trigger takes build the same request the strategy is about to. A host that gives the
  strategy a different budget from the engine's measures a slightly different request — the
  server hands both the same `tokenBudgetFor` resolver (#246), which is what keeps the two one
  answer.
- **The cut items are measured the same way.** `conversationItems` counts a result at its cap
  rather than at what the store holds, because a stored result that is unbounded would stretch
  the tail walk over the whole history — and a history nobody can cut is a history nobody can
  clear. The _text_ the summarizer is handed is still the stored one: a summary stands in for
  what the tools said, so it has to be able to read it.

### Pausing for the user (epic #303, X6; #309)

A turn can end because it is waiting for the user, and `./pausing` is the whole of it: the
question ("which calls wait?"), the one event that answers them, and what each answer means.
It is deliberately not built-in-specific — an MCP tool that asks (`ask`, #312) pauses through
exactly the same path — because a pause is a property of the log, not of a tool.

- **Two things make a call wait.** The permission the loop evaluated it under (`ask`, which the
  settings resolver answered or the tool's own declaration did), and a call to `ask_user` — the
  built-in a model asks a question with, whose calls are answered by the user whatever the
  policy says, because the user's answers **are** its result and its `run` never produces one.
  Both are recorded the same way: the call's `evaluated_permission` is `ask`, so
  `awaitingUser` — unanswered `agent.tool_use` with `evaluated_permission: ask` — is the whole
  of "what is this session waiting for", and nothing is stored beside it. A name this
  deployment's registry does not hold waits for nothing: no such tool can be called.
- **A malformed question is not a pause.** An `ask_user` call whose input the protocol's schema
  refuses is answered with an `is_error` result naming what was wrong (`Invalid input for
ask_user: …`), so the model fixes it and asks again, rather than the turn pausing on questions
  no client could render. The check is the protocol's own (`askUserInputProblems`), so the shape
  the model is held to is the shape a client renders and an answer is validated against.
- **The pause is a turn end.** The call is stored, nothing runs, and the turn writes
  `session.status_idle { stop_reason: { type: 'requires_action', event_ids } }` where the ids
  are the waiting calls' — the calls' own event ids. The turn resolves to `paused`, the session
  is idle, and nothing is held open: no timer, no lease, no open request. That is what makes a
  pause survive a restart (a resumed brain reads the same log, and `repairLostExecutions` leaves
  a call the user has not answered alone) and what makes `requires_action` the whole of what a
  client needs to draw the question or the approval prompt.
- **One event answers it, and the server is the one that writes it** (epic #303, X1's rule that
  a client never writes a tool result). `user.tool_confirmation` names the call, and
  `./pausing`'s `answerConfirmations` turns it into the `agent.tool_result` the call is owed, in
  one append and call order like any step: the approved tool runs through the **deployment's**
  registry (the user has answered for that tool; an offer decides what a model may ask for, not
  whether an answer is honoured), a denial is written with the user's own words (`The user denied
this: …`), and an `ask_user` call has its answers written as its result — validated against
  the questions the call asked, because the tool never runs.
- **`remember` is the approval's memory, and the event is the record.** `once` (or absent)
  answers that call. `session` allows every later call to the same tool in this chat: the turn
  reads it back off the log every request (`sessionApprovedTools`, handed to the step as
  `approved`), so a compaction cannot drop it, a replay rebuilds it exactly, and a
  `session.rewind` past the confirmation takes it back with the branch it was on. `always` does
  the same for this chat and leaves the user's stored policy set to `allow` — a write the server
  makes on the append (#307). A remembered approval never waives `ask_user`: a question is still
  a question.
- **A call approved but never finished is `execution lost`** (X3). The log cannot say whether
  the turn that took the confirmation got as far as running the tool, so a brain that
  **inherits** an open turn answers it `execution lost` rather than running it again. The
  distinguishing fact is the turn state at the moment the turn began: a turn that opened on an
  idle session is the one the confirmation started and runs it, and one that took over somebody
  else's does not. A denial, or answers, are written in either case — nothing runs for them, so
  writing them again is not repeating anything.
- **A message or an interrupt ends the waiting.** A `user.message` that arrives while calls wait
  resolves every one of them — `resolveWaiting` writes one `is_error` result each, with
  `RESOLVED_BY_MESSAGE` ("The user sent a message instead.") — and the turn carries on with the
  message; an interrupt resolves them the same way and then ends the turn as an interrupt
  always does.
- **A session sitting on an answer looks idle.** A confirmation is not a queued user event, so
  `getPendingUserEvents` does not list it and the turn state is `idle`; the loop's no-op guard
  asks one targeted read for the newest tool event instead (a `user.tool_confirmation` there is
  work, and `answeredWaiting` is the same question asked of a whole log). The route signals the
  scheduler to start that turn, and a signal is a hint — so the store's work scan
  (`@openharness/session`'s `findSessionsNeedingWork`) treats the answer as work too: a session
  whose last turn ended `requires_action` and which holds a `user.tool_confirmation` naming one
  of the calls it waits on is found by recovery, so a confirmation appended by an instance that
  died before its turn started is picked up instead of stranding the chat.

### The seams the rest of the epic plugs into

| what                                                 | how                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a tool that runs                                     | `ToolDefinition` + `ToolRegistry.execute` in `@openharness/hands` (#305's `web_fetch`, `web_search`, `todo_write` live there)                                                                                                |
| whether a model can call tools                       | `toolSupportFor` on `runTurn`; the server answers from models.dev's `tool_call`                                                                                                                                              |
| which tools a request offers, and what a call may do | `toolSettings` on `runTurn`: the per-request decisions #307 stores per user and a mode overrides; a disabled tool is left out of the offer, and an `ask` is the pause of #309                                                |
| a call waiting on the user                           | `./pausing`: `awaitingUser` is the question ("which calls wait?"), `confirmationOutcome`/`answerConfirmations` are what a `user.tool_confirmation` does, and `resolveWaiting` is what a message or an interrupt does instead |
| a tool that always asks (rather than a policy)       | `ASK_USER_TOOL_NAME` in `./pausing`'s `waitsForUser`: a call to `ask_user` waits whatever the policy says, because the user's answers are its result. An MCP tool (#312) asks through its `ask` policy on the same path      |
| per-user values a tool needs                         | `resolveToolSecrets` on `runTurn` (asked per step with the owner); the operator's search key arrives here (#305), and #311's MCP tokens will                                                                                 |
| MCP tools                                            | `agent.mcp_tool_use` / `agent.mcp_tool_result` and a second source in the offered-tools record (#312); nothing in this loop is built-in-specific today besides `offeredTools`' `source`                                      |
| tool results in the context                          | the two rules above (X9, #306): a result's cap comes from `ToolDefinition.maxResultTokens` and the tool name in the log, and old results are cleared rather than summarized. #312's MCP results join them by being results   |

## Extension points

| what                                 | how                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| how the log becomes messages         | `contextStrategy` on `runTurn`; the default reads the latest summary (#277 K1), trims to a token budget per model, and caps an oversized newest item (K6)                                                                                                                                        |
| when history is summarized           | `compaction` on `runTurn`: one config, or a per-owner `ContextCompactionResolver` the loop asks at each request boundary — the threshold, the summary model, the pass limit, the per-model budgets and output ceilings, and the cut rule (#279; per-user controls: #282)                         |
| which tools a turn may call          | `tools` on `runTurn`: a `ToolRegistry` from `@openharness/hands`, or none at all (epic #303, X4); it is also the registry an approved call runs through once the user answers (#309)                                                                                                             |
| what the settings say about a tool   | `toolSettings` on `runTurn`: the resolver #307's per-user settings and a mode's override live behind, asked per request with the owner and the override; each tool's own declaration when absent (X4). `ask` pauses the turn, and a `remember: session` approval is read back off the log (#309) |
| which models may call tools          | `toolSupportFor` on `runTurn`: models.dev's `tool_call`, `false` meaning no tools are offered to that model (X2)                                                                                                                                                                                 |
| what a tool is handed besides input  | `resolveToolSecrets` on `runTurn`: the per-user values the host resolved for the step (X4; #305's search key, #311's MCP tokens)                                                                                                                                                                 |
| how many requests a turn may make    | `maxToolSteps` on `runTurn`: the deployment's `OPENHARNESS_MAX_TOOL_STEPS`, ending the turn with a notice past it (X2)                                                                                                                                                                           |
| how `provider/model` becomes a model | `model` on `runTurn` (required): a `ModelFactory`; the server passes `providerModelFactory`                                                                                                                                                                                                      |
| where the key comes from             | `resolveCredential` on `runTurn`: the owner's credential per provider, resolved per request (A5)                                                                                                                                                                                                 |
| which models take a reasoning effort | which models take a reasoning effort                                                                                                                                                                                                                                                             | `reasoningSupportFor` on `runTurn`: the levels a model takes, asked per request (#252) |
| what a mode resolves to              | `resolveMode` on `runTurn`: the mode a chat follows, resolved per request (#245, M6)                                                                                                                                                                                                             |
| how failures are retried             | `retry` on `runTurn`: attempts, base delay, ceiling, and the `sleep` itself                                                                                                                                                                                                                      |

`ContextStrategy` is called once per model request, with the log as that request sees it and the
session's `{ model, system }`; it must be pure — the loop owns the store, and a strategy that
wrote to it would put the transcript out of step with the request that produced it. It answers
the messages **and** what it had to cap to fit (K6), because the store is the loop's: the loop
records the truncation on the request's `span.model_request_start` rather than the strategy
writing it. That is also why the loop builds the prompt _before_ it appends the span start that
claims the pending messages — the span start carries the record, so the prompt has to exist
first — admitting the messages it is about to claim into the log view (`contextView`'s second
argument) rather than relying on the claim having landed.

### The context budget and the summary (#246; epic #277 K1/K6)

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

Since epic #277 the strategy also builds the request around the log's latest **summary** (K1).
When a `session.context_summary` is in the events, what the model is sent is: the session's
system prompt, then the summary as a second **system** message, then every event after the
summary's `covers.to_seq`. The role is deliberate. A `user`-role summary would read as a fresh
instruction from the reader and an `assistant` one as something the model itself had said; and
`trimToBudget` keeps every system message while dropping the oldest turns, so a system-role
summary is the one message the safety net can never throw away — which is the point of it. The
wording marks it plainly as context (`Earlier messages in this conversation were summarized…`),
and the AI SDK groups leading system messages ahead of the conversation, exactly where K1 puts
the summary. A summary a later `session.rewind` covers is ignored: the edit took the branch it
summarized back, so it must not reach the model (the replay read would normally have removed it
already; the strategy applies the rule itself so it holds for a caller that hands it a whole
log).

An item too big to send at all is **capped, not dropped** (K6). If the newest message alone is
over the budget, summarizing cannot help — it has to stay verbatim — so it is cut to a head and
a tail with `OMISSION_MARKER` between them, and the strategy returns the
`{ seq, tokens_before, tokens_after }` record the loop puts on the span. The newest user message
is therefore never dropped, and a client can tell the user their message was shortened.

### The real size of a context (epic #277 K2)

`estimateNextRequestTokens` is the function the compaction trigger uses to decide whether the
context is full: it takes the model the next request will run, the previous
request's `span.model_request_end.model_usage`, and the text of what is new since, and answers
the previous request's real prompt size plus a chars/4 estimate for the new text.
`promptTokensOf(usage)` is the first half: the three input-side counters of `ModelUsage` summed,
which is the real prompt size because those counters are disjoint — see `toModelUsage` for how
each provider family is normalized into them. The baseline is only used when it can say
something about the next request: the previous request must not have been a summary request
(`purpose: 'summary'`, C2), must have run on the same model, and must not have been superseded by
a rewind. Otherwise — and when there is no previous request at all, the session's first — the
whole estimate is the chars/4 one over `since`, which the caller passes as the entire visible
history in that case.

`estimateContextSize(events, { model, system })` is the log-walking companion the loop calls: it
finds the baseline request itself (`lastModelRequest` in `./log`) and builds the two inputs, and
`isUsableContextSizeBaseline` is the rule exported so the caller can pick the matching `since`
(what is new since the baseline, or the whole visible history when there is no usable one).

### The compaction engine (epic #277, C2; #279)

`./summarize` is the half of epic #277 that the context strategy cannot be: a summary needs model
calls, and model calls need the store, so this is the piece that runs **in the turn loop at a
request boundary** — where it can call a model and append events — while `ContextStrategy` stays
pure, synchronous and read-only.

It is deliberately not `apps/server`'s `compaction.ts`: that one is the stream's
`DeltaCompactor`, which deletes the chunks a finished reply superseded (D9, #46). Context
compaction is this one, its event is a `session.context_summary`, and nothing is deleted.

- **The trigger is a share of the chat model's budget** (K2). `runTurn` measures the request it
  is about to make (`estimateContextSize`), compares it against
  `ContextCompactionConfig.threshold` (default `DEFAULT_COMPACTION_THRESHOLD`, 0.7; the server's
  `OPENHARNESS_COMPACTION_THRESHOLD`), and calls the engine when it is over. Under the threshold
  nothing is written at all: a chat that never comes near it behaves exactly as it did before
  #279. The budgets come from the same `tokenBudgetFor` resolver the strategy is given (#246), so
  the trigger and the trimming agree about how big a model's history may be.
- **The controls are resolved per request, per owner** (C3, #282). `compaction` is either one
  configuration for every user or a `ContextCompactionResolver`, which the loop asks at each
  request boundary with the `owner_id` it just read — the same seam `resolveMode` uses (#245,
  M6). So the threshold, the summary model and the pass limit can be the session owner's stored
  preferences (which is what the server passes), an edit applies from the next request on, and
  one user's choices never reach another's chat. What the resolver answers goes through
  `resolveContextCompaction` like any config, so it may leave a field out and take the default.
- **A manual run is the second trigger** (K8; #283). `./manual`'s `pendingManualCompaction` reads
  the log for the newest `session.compact` no `session.compaction` answers, and `runTurn` runs the
  engine with `reason: 'manual'` **regardless of the threshold** — the user asked, so a short chat
  is attempted too and answers `'skipped'` only when there is genuinely nowhere to cut. The
  request's `instructions` become `SummarizeContextOptions.guidance`, folded into the
  summarizer's instructions as the user's own; the base prompt is unchanged, so
  `SUMMARY_PROMPT_VERSION` — `context-summary-v2` since #306 added the tool-work section — is
  unchanged by guidance. `runTurn` writes the `session.compaction`
  outcome after the run — `summarized` (with `summary_seq`), `nothing_to_summarize` or `failed` —
  which is both the clear outcome a client shows and what makes the request no longer pending. An
  idle session is woken by the route's `signal`, runs a turn that answers the request and makes no
  model reply, and goes idle.
- **Where to cut is one replaceable function** (K4, K12). `ContextCutRule` answers "where may
  history be cut?", given the visible conversation and how many tokens the tail should keep;
  `cutAtUserBoundary` is the default — the smallest recent tail that reaches a quarter of the
  chat model's budget (K4), widened to start at a `user.message` so no turn is split. Everything
  before the cut is what the summary covers. #276 replaces this function to keep tool
  call/result pairs together, without the engine changing.
- **The summary model is an input** (K3), `null` meaning the chat's own. A chosen model with no
  usable credential, or one this build has no client for, hands the work to the chat model, and
  the event's `fallback_reason` says which. So does a chosen model that would need more passes
  than `maxPasses` (default `DEFAULT_MAX_SUMMARY_PASSES`, 3): the _plan_ decides that before any
  request is made (K5). The chat model is never refused for needing many passes — refusing would
  leave a chat with no way to fit at all.
- **The history is folded in passes** (K5). Each pass sends the instructions, the running summary
  and the next slice, sized so that a pass's input fits the summary model's budget with room for
  its answer (`SUMMARY_SLICE_RATIO` is the half of the budget the answer may take). The running
  summary is capped by the smallest of 12% of the chat model's budget (`SUMMARY_SIZE_RATIO`,
  exactly the epic's figure), the summary model's output ceiling, and a quarter of the summary
  model's own budget (`SUMMARY_SIZE_BUDGET_RATIO`, K5's "leaves room for a slice next round"). A
  running summary over that cap is summarized **alone** first — one extra pass, added to the plan
  — and the slices continue against the smaller summary. Worked example (the epic's, K5): a 1M
  chat model with a 64k ceiling has a 936,000-token budget and a 200k summary model with an 8,192
  ceiling 191,808; the summary cap is `min(112,320, 8,192, 47,952)` = 8,192 and a slice ~95,904,
  so ~390,000 tokens of older history needs `⌈390,000 / 95,904⌉ = 5` passes — over the limit of
  3 — and the chat model takes over, folding the same history in one.
- **One model call per pass, recorded** (K3; #247). Every pass opens a
  `span.model_request_start` with `purpose: 'summary'`, claiming nothing, and closes it with the
  usage and a fresh `session.usage` — so the tokens and cost of summarizing are in the session's
  usage like any other request's, while the size accounting refuses the span as the baseline for
  the chat's own context (K2). `needsModelRequest` skips such a span too: it answers nothing, so
  it must not take over the answer set the chat's request recorded.
- **Progress is a stored event** (#279). `session.context_summary_progress { pass, passes }` is
  appended before every pass: everything a client is shown lives in the log (D9), so a client
  that reconnects mid-compaction sees the same progress the live stream carried. Nothing in the
  brain reads it back.
- **A summary never deletes or supersedes** (K1): the log, the transcript and replay stay whole,
  and the only reader is the context strategy. A later `session.rewind` past a summary supersedes
  it along with the rest of the tail it took back.
- **Failure never blocks the chat** (K11). A summarizer that fails, times out, is interrupted or
  returns nothing closes its span with the error and the engine answers `'failed'`; the request
  goes out with the strategy's trimming as the safety net. Nothing is retried there — the chat
  still works without a summary, and a second attempt would cost another model call for the same
  answer. A **refused write is not a summarizer failure**: the engine's appends go through the
  turn's own `append`, so a `FencedError` or a `ClaimConflictError` stops the turn where it stands
  and propagates, exactly as any other write does.
- **Overflow is compacted and retried once** (K2). A provider that refuses a request as too long
  is recognised per provider by `classifyModelError`'s `contextOverflow` — the real payload of
  each family: OpenAI's and Azure's `context_length_exceeded`, Anthropic's "prompt is too long",
  Bedrock's `ValidationException: Input is too long`, Gemini's "exceeds the maximum number of
  tokens allowed", and the OpenAI-compatible family's own prose (see `./errors`). The loop then
  compacts with tighter caps (`OVERFLOW_RECENT_TAIL_RATIO`, half the usual tail) and makes the
  request once more; a second refusal ends the turn with `session.error { retry_status:
'exhausted' }` and a message saying the context was compacted and still did not fit. When the
  tighter compaction cannot be made, the turn ends the same way but the message says why rather
  than claiming a compaction that never happened — "there was no older history to summarize" for
  the trigger's `'skipped'`, "summarizing the history failed" for `'failed'`. It is once per
  **turn**, not per request, so however many requests a turn makes, it cannot loop.
- **A summary request does not move the session's model.** The session projects the `model` a
  `span.model_request_start` names onto itself ("the model this chat last ran", #245 M6), so the
  span of a summary request is the one exception — see `@openharness/session` — or the chat would
  continue on the summarizer.

Compaction is **off unless a host asks for it**: `runTurn`'s `compaction` option absent means no
trigger and no overflow handling, which is what the brain's own tests run with. The server always
passes the per-owner resolver (`main.ts`), which is where the epic's 70% default applies to a
user who has not chosen a share (C3, #282).

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

**One message is rewritten, and only one** (#273). Vertex answers a request for a partner model
the project has not enabled in Model Garden with Google's own `404 … Publisher model
\`publishers/anthropic/models/…\` was not found or your project does not have access to it`(or a
Model Garden terms`403`), which reads like a typo in the model id. `vertexModelGardenMessage`turns exactly that — an`anthropic`publisher resource **and** Model Garden wording — into
*"Claude models must be enabled for this Google Cloud project in Vertex AI Model Garden
(&lt;model&gt;) …"*, and`classifyModelError` applies it to the message it reports; the type and
the retry decision are unchanged. The server's catalogue lists only enabled models now, so this
is the residual path — an id a chat already runs, a model disabled after the catalogue's hour was
taken — and no other provider's, or publisher's, error text is touched.

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

The `fetch` a fixed provider's client is built with comes from
`createProviderModelFactory`'s `fetch` option, the way Azure's, a custom endpoint's and
Vertex's come from theirs (#270). The host injects it — the server passes its
egress-proxy-aware client, so the eleven providers reach the internet through
`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` exactly as the catalogue and the save-time checks do,
with no `NODE_USE_ENV_PROXY`; a host that injects none gets the platform's `fetch`, which is
what a direct egress path and every test that stubs the global `fetch` want. It carries **no
deadline**: a model streams a long reply, so a request-level timeout would cut it off.

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
  has no control-plane surface, so the server's `ListFoundationModels` check and its two
  catalogue reads — `ListFoundationModels` and `ListInferenceProfiles`, #274 — use
  `signBedrockRequest` — `aws4fetch`, the same signer the provider uses internally, so
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
  has no control-plane surface, so the server's `ListFoundationModels` check and its two
  catalogue reads — `ListFoundationModels` and `ListInferenceProfiles`, #274 — use
  `signBedrockRequest` — `aws4fetch`, the same signer the provider uses internally, so
  both paths sign identically. The two AWS hosts are signed for the one `bedrock` service, and a
  returned value rather than a `fetch` keeps the server's own egress-proxy-aware client in the
  path. Nothing in this module reads an `AWS_*` variable or a shared credentials file; the decoy
  test sets the lot and asserts none of them reaches a request.
- **A credential's secrets are plural, and redaction knows it.** `credentialSecrets` lists the
  access key ID, the secret and the session token, and `turn.ts` scrubs a provider's error text
  with all of them — a rejected request echoed back can quote any of the three. `last4` is drawn
  from the **access key ID**, the one half a reader recognises and the only one safe to show.

### Google Vertex (epic #245, A3d)

A `vertex` credential is a named one like Azure's, and its models are `<name>/<model>` —
`vertex/gemini-2.5-pro`, `vertex/claude-sonnet-4-5@20250929`. Two things about it are
load-bearing:

- **The family decides the client, and the rule lives in `vertex.ts`.** `@ai-sdk/google-vertex`
  builds Google's own models and `@ai-sdk/google-vertex/anthropic` the Anthropic models Vertex
  serves; `isVertexAnthropicModel` is the `claude-*` prefix (Google's own naming for them) and
  everything else goes to the Gemini client, so an id this build does not know is answered by
  Google rather than refused here. `isVertexModelId` is the same rule the server's catalogue
  filters the registry with — the two halves of one answer: what a request can run.
- **No Application Default Credentials, ever.** This is the decision the whole type exists for.
  The server itself runs on GCP, so a request that fell back to ADC would quietly run a user's
  chat on openharness's own service account. The factory passes `googleAuthOptions.credentials`
  (the parsed document), `project` and `location`, and `apiKey: ''` — deliberately **empty
  rather than absent**, because a truthy one (or one left undefined, which lets the provider
  read `GOOGLE_VERTEX_API_KEY`) switches the client into Vertex "express mode" and
  authenticates the request with a key from the environment. `vertex-model.test.ts` holds all
  of it with every decoy set: a decoy credentials file, `GOOGLE_CLOUD_PROJECT`, a decoy
  `CLOUDSDK_CONFIG`, a `GCE_METADATA_HOST` stub that would hand out a working token, and the
  express-mode variable — the request is still signed by the stored key, and a bad one fails
  rather than becoming somebody else's.
- **The endpoint is Google's, derived from the location** — `<location>-aiplatform.googleapis.com`
  — which the protocol validates against Google's published list. There is no URL a user typed,
  so unlike Azure's there is no `safeFetch` on this path. `createProviderModelFactory` takes an
  optional `vertexFetch` seam for a test that wants to watch the request.

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
- `toModelUsage` is also where the provider families are **normalized apart** (epic #277, K2).
  The protocol's `input_tokens` is the _uncached_ input — the four counters are disjoint, which
  is what `usageCost` prices — while the SDK's `inputTokens` is the cache-inclusive total. So
  the counter is the SDK's `noCacheTokens`, whose per-family value the provider packages compute
  correctly for their own APIs: Anthropic's (and Bedrock's, and Vertex's Anthropic models')
  raw `input_tokens` already leaves cached tokens out, so their uncached half is that number,
  while OpenAI's and the OpenAI-compatible family's `prompt_tokens` already includes them, so
  their uncached half is it minus the cached ones. Summing the three input-side counters of the
  result is the real prompt size for every family, which is the measure the compaction trigger
  reads.

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
  log that never carried an effort answers `undefined` and its requests are built exactly as they
  were before #252. `undefined` (no message spoke) is kept apart from `null` (a message asked for
  the provider's default) because a mode supplies its own effort when the reader said nothing
  (#245, M6): an explicit message effort wins, and otherwise the mode's applies.

- **Both facts land on the span.** `span.model_request_start.reasoning_effort` records
  `{ requested, applied }`: `applied` is `null` when the model took none, and the field is absent
  when nothing was asked for. That record is the only durable statement of what a request ran
  with — the session's own field is the message that asked.

### Modes (#245, M6)

A session may follow a **mode**: a per-user named preset of a model, a reasoning effort and a
system-prompt addition. The mode lives in the host's database, not the log, and a chat follows
it **live** — so the loop is handed a resolver, the same seam as `reasoningSupportFor`, and
asks it once per request with the mode the session's projection names.

- **The host resolves, the loop applies.** `RunTurnOptions.resolveMode` is a
  `ModeResolver` — `(ownerId, modeId) => Promise<ResolvedMode | null>` — where the server owns
  the modes, the user's preferences (a mode may be "my default model") and the credentials
  that decide availability. The loop asks it at every request boundary, so an edit — the model,
  the effort, the prompt addition — applies from the next request on, exactly as a model switch
  does.
- **What a resolved mode changes.** The request's model is the mode's resolved model rather
  than the session's, so the credential is resolved for _that_ provider and the span records
  _that_ model; the effort is the mode's unless a `user.message` asked for one explicitly
  (#252); and the system prompt is the session's with the mode's addition appended after it —
  never in place of it.
- **The span says which mode.** `span.model_request_start.mode` is `{ id, name }`, recorded
  per request beside the resolved `model` and `reasoning_effort`, so the log says what the
  request ran under and what it resolved to, even after the mode is renamed or edited.
- **A mode that is gone is not a failure here.** The resolver answers `null` for a mode it no
  longer knows (a chat whose mode was deleted), and the request continues on the session's own
  model — the model the chat last ran, which the delete left in place — with no `mode` on the
  span. A host that injects no resolver behaves the same: a session on a mode runs its own
  model. Refusing an _unavailable_ mode is the server's rule, checked where a chat starts or
  continues, not the loop's.

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
- `modes.test.ts` — modes at the loop's boundary (#245, M6): the mode's resolved model, effort
  and prompt addition applied and recorded (`mode: { id, name }`, the resolved model and
  effort), a mode edited between two requests followed live, an explicit message effort winning
  over the mode's, an addition appended after the session's system prompt (and standing alone
  when the session has none), a mode the resolver no longer knows falling back to the session's
  own model with no mode on the span, no resolver injected behaving the same, and a chat without
  a mode never asking.
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
- `context.test.ts` pins the per-model budget resolver of #246: the strategy trims to what
  `tokenBudgetFor` answers for the request's own model, falls back to the default when it
  answers nothing, and asks it once per call with the id the request runs. It also pins epic
  #277's half: a log with no summary, one summary, several (the latest wins) and a summary a
  rewind has superseded (ignored, including a summary before the rewind but not after it); the
  summary kept through trimming; the newest item capped to a head and a tail with the marker and
  the record of what was cut (a reply as well as a message, and nothing cut when it fits); and
  the size accounting — `promptTokensOf`'s three counters, and
  `estimateNextRequestTokens` with a usable baseline, with none, and with each refusal (a
  summary request, another model, a superseded context), and `estimateContextSize` off a whole
  log (the baseline it finds, and the whole visible history when a summary has intervened).
  `turn.test.ts` holds the loop's half: the capped newest message reaching the request, and the
  record landing on the request's `span.model_request_start`.
- `summarize.test.ts` — the compaction engine (#279) and, since #306, the tool pairs and the
  clearing around it, in two layers. The engine on its own
  (`summarizeContext` against a hand-built log, with exactly-sized messages so the arithmetic is
  the assertion): the cut lands where K4 says and the summary covers exactly the older messages
  (`covers.to_seq`, and the prompt the summarizer was sent); nothing to cut is `'skipped'` with
  nothing written; under the threshold nothing is written either; an incremental update is handed
  the summary in force plus only the newly covered history; a long history is folded in three
  slices with `(1/3) (2/3) (3/3)` progress events and the last answer as the summary; a running
  summary over its cap is summarized alone first and then extended; an oversized item is capped
  with the omission marker; a summary model that would need too many passes, and one with no
  credential, both fall back to the chat model with `fallback_reason` and `summary_model`
  recorded; every pass is a span with `purpose: 'summary'` and its usage reaches `session.usage`;
  a failing summarizer closes its span with the error and writes no summary; a summarizer that
  returns nothing does the same. The loop's half is driven through `runTurn`: the trigger fires
  over the threshold share of a small model's budget and not for a large one (where the request
  is the one #278 built, byte for byte), the retried request is built from the summary, a
  summarizer failure leaves the chat running with trimming, an overflow compacts and retries
  exactly once, a second overflow ends with the clear `exhausted` error and no third call, and an
  overflow with nowhere to cut fails without a second request. Its #306 cases are the tool pairs
  and the clearing: `cutAtUserBoundary` widening past a steering message that sits between a call
  and its answer, and answering 0 when the only boundary would split one; a result in a log item
  measured at its cap rather than at what the store holds, and the tail walk that does not
  stretch for one; a summary whose tail answers every call it carries, with the pair in the
  request it bought; a call and its answer folded in the same pass even when a slice boundary
  falls between them; and, at the loop, clearing the old results _instead of_ summarizing when
  that is enough (no summary, the placeholder in the request, `cleared` on the span, the stored
  answer whole) and summarizing when it is not (with the tool-work section in the prompt and
  `context-summary-v2` on the event).
- `manual.test.ts` — manual compaction (#283): `pendingManualCompaction` as a rule (nothing,
  a request pending, an outcome answering it, the newest of two that raced, a new request after
  an outcome), and the loop's half through `runTurn` — a `/compact [instructions]` answered below
  the threshold with the guidance in the summarizer's prompt and a `session.compaction
{ outcome: 'summarized', summary_seq }` stored, a chat too short to cut answered with
  `nothing_to_summarize` and no model call, and neither run making a chat reply of its own.
- `errors.test.ts`, `retry.test.ts`, `log.test.ts`, `model.test.ts`,
  `redact.test.ts`, `validate.test.ts` and `index.test.ts` cover the pieces on their own,
  including the branches the loop cannot reach. `errors.test.ts` also covers the wrappers the
  classification follows (`AI_RetryError` and duck-typed ones) and the context-overflow flag per
  provider, each case built from the payload that provider really sends (OpenAI's and Azure's
  `context_length_exceeded`, Anthropic's "prompt is too long", Bedrock's `ValidationException`,
  Gemini's token-count refusal, an OpenAI-compatible endpoint's code or prose, one wrapped error,
  and an ordinary 400 that must not be mistaken for an overflow); `model.test.ts` pins the
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
- `vertex-model.test.ts` and `vertex-factory.test.ts` — the Vertex path (#251). The second
  replaces the provider package to pin the **options** the factory passes — the project, the
  location, the whole key document, the deliberately empty `apiKey`, and no `baseURL` — because
  that is where the no-ADC guarantee is written. The first is the behavioural half, against the
  real provider: the family rule, `isUsableCredential` and `credentialSecrets` for a Vertex
  credential (its one secret being the document's private key PEM, and its public facts the
  email, project and location), and the decoy suite (`GOOGLE_APPLICATION_CREDENTIALS` at a decoy
  file, `GOOGLE_CLOUD_PROJECT`, `CLOUDSDK_CONFIG`, a `GCE_METADATA_HOST` stub that serves a
  working token, `GOOGLE_VERTEX_API_KEY`/`_PROJECT`/`_LOCATION`) — a request signed with a
  throwaway key reaches Google's token endpoint and is refused there
  (`Invalid grant: account not found`), the metadata stub is never asked, no model request
  leaves the process, and a key Google cannot verify fails locally rather than falling back to
  anything.
- `pausing.test.ts` — the pause (epic #303, X6; #309), in two layers. The pure half, on
  hand-built logs: which calls wait (`awaitingUser`), the newest confirmation per call, the tools
  a `remember: session` approval allows, which unanswered calls are lost rather than open, and
  the predicate that makes a call wait (`waitsForUser`). The loop's half, driven through
  `runTurn` against a real store: an `ask` policy pausing the turn and running the call once the
  user allows it, a denial answered with the user's own words, `remember: once` remembered for
  nothing beyond that call while `session` runs every later one (and is forgotten once an edit
  rewinds past the confirmation), a step that runs what it may and pauses on what it may not, two
  waiting calls answered one at a time and the ones nobody has answered left waiting, the same
  pause read back from a replay of the log, `ask_user` pausing whatever the policy says with the
  answers written as its result (and a denial, and answers that do not fit the questions, and a
  malformed call answered instead of paused), a message and an interrupt resolving the waiting
  calls, a resumed brain keeping waiting, and an approval nobody finished answered `execution
lost`.
- `tool-loop.test.ts` — the tool loop (epic #303, X2/X3/X4), driven through `runTurn` with a
  real store, a scripted model that calls tools and local tools that record what ran: one call
  in one step (the exact event order, the tools the span records, the request the answer buys
  and the assistant/tool messages it is built from), two calls in one step (started together —
  the scenario's own gate deadlocks if they are not — and stored in call order), a loop across
  three steps, the step limit ending the turn with `tool_steps_exhausted_error` and every call
  answered, a timeout, an interrupt during a call, a `deny` answered without running anything
  and an `ask` pausing the turn (the pause itself, in every path, is `pausing.test.ts`),
  the settings asked **once per request** with the owner and the mode's override, a disabled
  tool left out of the offer (and every tool disabled meaning no offer at all, exactly as a
  tools-less deployment builds it), the turn's resolved secrets scrubbed out of a tool's
  answer, a model the support resolver rejects getting no tools at all, an unknown model
  getting them, and a turn with no registry calling nothing. Two more
  are the crash rule: a call with no result is answered `execution lost` and **not** run, with
  the dead brain's span closed first when one was left open; and one is steering — a message
  that arrives while a tool runs is claimed by the request after the step.
- `context.test.ts` also holds the tool half of the strategy: a call and its answer as one
  assistant turn and one `tool` message, an error result and an empty one, an answer moved
  behind the turn that made the call when the log interleaved a steering message, a cut that
  never lands between the two, and a log that never held a tool building exactly the request it
  always did. Its #306 half is what a result may cost a request: a result capped to its tool's
  declaration (head, tail and marker, with the record), to the fifth of the budget a generous
  declaration may not exceed, and to the default for a tool — or a registry — that declares
  nothing; an old result cleared to `result cleared, N tokens` with its pair still answered, an
  error result the same, nothing cleared when the whole history is the tail; and the measure —
  a call and its answer counted as part of the context (K2), and a cleared result counted as the
  placeholder it became.
- `tool-loop.test.ts`'s #306 case is the loop's own: an answer far over its tool's cap
  (`maxResultTokens`) reaches the _second_ request as a head and a tail with the marker, the
  stored `agent.tool_result` keeps every character, the call is still in front of it, and the
  request's `span.model_request_start.truncated.results` names the result and what it cost.
- `src/testing/harness.ts` builds the session and reads the log back; `src/testing/mock-model.ts`
  scripts what each model request answers with — text **and tool calls**, whose arguments travel
  as JSON text the way a provider sends them — records the prompts, and can act mid-stream
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
