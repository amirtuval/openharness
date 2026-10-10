# @openharness/protocol

The shared protocol between brain, session, hands and the frontends: the wire types and
schemas every package agrees on. It defines the HTTP API, the session event log, users and
provider credentials, the error envelope, ids and pagination — and nothing else. No I/O, no
state, `zod` as the only runtime dependency.

The contract follows Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview)
API — the same event names, field names, id prefixes and error envelope — for the subset v1
supports. Everything beyond that subset, and every place openharness differs, is marked in
code with `// extension:` and listed under [Deviations and extensions](#deviations-and-extensions).

## Commands

Run from this folder (`packages/protocol`):

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

`@openharness/protocol` is loaded by browsers (the web app's client imports it) as well as by
Node, so everything in `src/` is written against the APIs both have:

- No `node:*` imports, no `Buffer`, no `process`. `crypto.getRandomValues` is the Web Crypto
  global, and is what `ids.ts` draws ULID randomness from.
- `tsconfig.json` extends `@openharness/config/tsconfig/base.json` (`types: []`) with
  `"lib": ["ES2023", "DOM"]`, which keeps `@types/node` out of `src/`: `Buffer.from('x')` in a
  source file is a type error (`yarn typecheck`). `TextEncoder`, `btoa`, `atob` and `crypto`
  typecheck because `DOM` declares them, and all of them exist in Node 24.
- The two `*.config.ts` files are Node programs — they configure tsdown and Vitest — and are
  checked by `tsconfig.tooling.json`, which extends `node.json`. That is the only program that
  sees `@types/node`, which is why it stays a devDependency; pulling it into `src/` through the
  tooling configs (Vitest's own types reach Node's through `vite`) is exactly what the split
  prevents.

## Layout

```
src/
  index.ts              the barrel: everything below, exported
  common.ts             timestamps, metadata, page limits
  constants.ts          route prefix, header names, partition count, partitionOf()
  ids.ts                id prefixes, ULID, generators, parsers, branded id schemas
  cost.ts               what a pile of tokens costs: usageCost / totalCost (#245, #247)
  pagination.ts         page cursors: `seq` (events) and keyset `key` (agents, sessions)
  errors.ts             the Anthropic error envelope, error types and status codes
  content.ts            message content blocks (text only in v1)
  readonly.ts           DeepReadonly, the helper the immutable event types are built with
  providers.ts          the model providers openharness knows: the one list every side uses
  reasoning.ts          how much thinking a request asks for, and what it ran with (#252)
  resources/
    agent.ts            the agent resource + its endpoints
    mode.ts             the per-user mode resource + its endpoints (#245, M6)
    model.ts            the model catalog (GET /v1/models) and its entries
    provider-credential.ts  provider credential metadata (write-only) + its endpoints
    session.ts          the session resource + its endpoints (incl. /compact, #283)
    usage.ts            the usage surface: totals, cost, per-model and per-day (#247)
    user.ts             the signed-in user: GET /v1/me, /v1/me/preferences, UserIdSchema
  events/
    common.ts           the event vocabulary, the fields every stored event carries, supersedes
    user.ts             user.message (with the #111 model switch and the mode, #245), user.interrupt, inputs
    agent.ts            agent.message
    session.ts          status events, session.error, session.rewind, session.usage, session.deleted,
                        session.context_summary (#278) and its progress event (#279), and the
                        manual-compaction pair session.compact / session.compaction (#283)
    span.ts             span.model_request_start / _end, model_usage, claims (consumes/model), the mode
    stream.ts           event_start / event_delta: the stored chunks of a reply
    union.ts            StoredEvent, StreamEvent and isStoredEvent()
    api.ts              the three events endpoints
  fixtures/index.ts     subpath `@openharness/protocol/fixtures`
```

## Public API

Two entry points, named in `package.json`'s `exports`. Both resolve to built output
(`dist/`), never to `src/`.

### `@openharness/protocol`

**Resources**

| export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | what it is                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AgentSchema` / `Agent`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the `agent` resource (carries a read-only `owner_id`)                                                                                                                                                  |
| `CreateAgentRequestSchema`, `UpdateAgentRequestSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | bodies of `POST /v1/agents`, `POST /v1/agents/{agent_id}`                                                                                                                                              |
| `ListAgentsQuerySchema`, `ListAgentsResponseSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `GET /v1/agents`                                                                                                                                                                                       |
| `ModelConfigSchema` / `ModelConfig`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `{ id }`, where `id` is a model id `provider/model`                                                                                                                                                    |
| `ModeSchema` / `Mode`, `ModeIdSchema` / `ModeId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the per-user `mode` resource (#245, M6): a named preset of model, effort and prompt addition                                                                                                           |
| `CreateModeRequestSchema`, `UpdateModeRequestSchema`, `ListModesResponseSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | bodies of `POST`/`POST {mode_id}`/`GET /v1/me/modes` and the list response                                                                                                                             |
| `ModeModelSchema` / `ModeModel`, `MODE_DEFAULT_MODEL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | a mode's model — a `provider/model` id, or `my-default-model` to follow the user's default                                                                                                             |
| `ModeReferenceSchema` / `ModeReference`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `{ id, name }`, what `span.model_request_start.mode` records (#245, M6)                                                                                                                                |
| `ModelEntrySchema` / `ModelEntry`, `ProviderCatalogStatusSchema` / `ProviderCatalogStatus`                                                                                                                                                                                                                                                                                                                                                                                                                                      | one `GET /v1/models` entry — with its list price (`ModelCost`) — and one provider's catalog status (epic #92; #247)                                                                                    |
| `ModelCostSchema` / `ModelCost`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | a model's price: USD per million tokens, input/output required and the two cache rates nullable (#247)                                                                                                 |
| `ListModelsResponseSchema` / `ListModelsResponse`, `ListModelsQuerySchema` / `ListModelsQuery`                                                                                                                                                                                                                                                                                                                                                                                                                                  | `GET /v1/models`; `refresh` bypasses the cache (C4)                                                                                                                                                    |
| `SessionSchema` / `Session`, `SessionAgentSchema` / `SessionAgent`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | the `session` resource (read-only `owner_id`), its effective config and its optional snapshot                                                                                                          |
| `SessionStatusSchema`, `StopReasonSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `idle`/`running`; `{ type: 'end_turn' }`                                                                                                                                                               |
| `CreateSessionRequestSchema`, `ListSessionsQuerySchema`, `ListSessionsResponseSchema`                                                                                                                                                                                                                                                                                                                                                                                                                                           | the sessions endpoints                                                                                                                                                                                 |
| `CompactSessionRequestSchema` / `CompactSessionRequest`, `CompactSessionResponseSchema` / `CompactSessionResponse`                                                                                                                                                                                                                                                                                                                                                                                                              | body and response of `POST /v1/sessions/{id}/compact` (epic #277, K8; #283): optional `instructions`, answered with the stored (or already pending) `session.compact`                                  |
| `UserSchema` / `User`, `GetMeResponseSchema` / `GetMeResponse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the signed-in user; `GET /v1/me`                                                                                                                                                                       |
| `UserIdSchema` / `UserId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | an opaque Better Auth user id; what `owner_id` holds                                                                                                                                                   |
| `UserPreferencesSchema` / `UserPreferences`, `GetPreferencesResponseSchema` / `GetPreferencesResponse`, `PutPreferencesRequestSchema`                                                                                                                                                                                                                                                                                                                                                                                           | the per-user default model, theme and compaction controls; `GET`/`PUT /v1/me/preferences` (#111, #201, #282)                                                                                           |
| `PreferencesDefaultsSchema` / `PreferencesDefaults`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | what a `null` compaction control follows — the deployment's trigger share and the engine's pass limit — carried by the preferences response (#282)                                                     |
| `DEFAULT_MODEL_PATTERN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the `provider/model` shape a `default_model` (and a `summary_model`) must have                                                                                                                         |
| `SummaryModelSchema` / `SummaryModel`, `SUMMARY_MODEL_SAME_AS_CHAT`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | a summary-model preference: the `same-as-chat` sentinel (the default), or a `provider/model` id (#282)                                                                                                 |
| `COMPACTION_THRESHOLD_MIN`, `COMPACTION_THRESHOLD_MAX`, `SUMMARY_MAX_PASSES_MIN`, `SUMMARY_MAX_PASSES_MAX`                                                                                                                                                                                                                                                                                                                                                                                                                      | the bounds of the two numeric compaction controls, 0.3–0.95 and 1–10 (#282)                                                                                                                            |
| `ProviderCredentialSchema` / `ProviderCredential`, `ProviderCredentialTypeSchema`, `PROVIDER_CREDENTIAL_TYPES`                                                                                                                                                                                                                                                                                                                                                                                                                  | credential metadata (`api_key`, `azure_openai`, `openai_compatible`, `bedrock`, `vertex`); never the secret                                                                                            |
| `ApiKeyProviderCredentialMetadataSchema`, `AzureOpenAIProviderCredentialMetadataSchema`, `OpenAICompatibleProviderCredentialMetadataSchema`, `BedrockProviderCredentialMetadataSchema`, `VertexProviderCredentialMetadataSchema`, `OpenAICompatibleCredentialDetailsSchema` / `OpenAICompatibleCredentialDetails`, `BedrockCredentialDetailsSchema` / `BedrockCredentialDetails`, `VertexCredentialDetailsSchema` / `VertexCredentialDetails`, `ProviderCredentialDetails`, `ProviderCredentialMetadata`, `credentialDetails()` | the per-type credential metadata, each type's own public `details` (a custom base URL's host #249, a Bedrock region #250, a Vertex credential's email, project and location #251) and their derivation |
| `ApiKeyProviderCredentialSchema`, `AzureOpenAICredentialSchema`, `OpenAICompatibleCredentialSchema`, `BedrockCredentialSchema`, `VertexCredentialSchema`, `MAX_AZURE_DEPLOYMENTS`, `PutProviderCredentialRequestSchema` / `PutProviderCredentialRequest`                                                                                                                                                                                                                                                                        | body of `PUT /v1/provider-credentials/{name}` (write-only), including Bedrock's region and IAM keys (#250) and Vertex's service-account key, project and location (#251)                               |
| `BEDROCK_REGIONS`, `BedrockRegion`, `DEFAULT_BEDROCK_REGION`, `BEDROCK_REGION_PATTERN`, `isBedrockRegion()`, `bedrockCredentialDetails()`, `bedrockRegionOf()`                                                                                                                                                                                                                                                                                                                                                                  | the AWS regions that serve Bedrock, the check a `bedrock` credential's region passes, and the region its metadata reports (#250)                                                                       |
| `VERTEX_LOCATIONS` / `VertexLocation`, `ServiceAccountKey`, `parseServiceAccountKey()`, `isServiceAccountKey()`                                                                                                                                                                                                                                                                                                                                                                                                                 | the Google Cloud regions a Vertex credential may name — the location is the host — and the one parser both sides check a service-account key with (#251)                                               |
| `ListProviderCredentialsResponseSchema` / `ListProviderCredentialsResponse`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `GET /v1/provider-credentials`                                                                                                                                                                         |
| `AGENT_NAME_MAX_LENGTH`, `AGENT_DESCRIPTION_MAX_LENGTH`, `SESSION_TITLE_MAX_LENGTH`, `MAX_INITIAL_EVENTS`                                                                                                                                                                                                                                                                                                                                                                                                                       | limits Anthropic documents                                                                                                                                                                             |
| **Events**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

| export                                                                                                                                                                                                                                                                          | what it is                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENT_TYPES`, `STORED_EVENT_TYPES`, `EventType`, `StoredEventType`                                                                                                                                                                                                             | the vocabulary as constants and types                                                                                                                                     |
| `UserMessageEventSchema`, `UserInterruptEventSchema`, `UserEventSchema`                                                                                                                                                                                                         | stored user events (the message carries the optional `model` switch, #111, and `mode`, #245)                                                                              |
| `UserMessageEventInputSchema`, `UserInterruptEventInputSchema`, `UserEventInputSchema`                                                                                                                                                                                          | the same shapes as a client sends them                                                                                                                                    |
| `SessionDeletedEventSchema` / `SessionDeletedEvent`                                                                                                                                                                                                                             | the stream-only `session.deleted` event (#111): sent last, before a stream closes                                                                                         |
| `AgentMessageEventSchema`, `AgentEventSchema`                                                                                                                                                                                                                                   | stored agent events                                                                                                                                                       |
| `SessionStatusRunningEventSchema`, `SessionStatusIdleEventSchema`, `SessionStatusRescheduledEventSchema`, `SessionErrorEventSchema`, `SessionEventSchema`                                                                                                                       | stored session events                                                                                                                                                     |
| `SessionRewindEventSchema` / `SessionRewindEvent`, `SessionRewindEventInputSchema` / `SessionRewindEventInput`                                                                                                                                                                  | the `session.rewind` event (#238): restart the conversation from an edited `user.message`                                                                                 |
| `ContextSummaryEventSchema` / `ContextSummaryEvent`, `ContextSummaryReasonSchema` / `ContextSummaryReason`, `ContextSummaryCoversSchema` / `ContextSummaryCovers`                                                                                                               | the `session.context_summary` event (epic #277, K1; #278): older history replaced for the model by a summary                                                              |
| `ContextSummaryProgressEventSchema` / `ContextSummaryProgressEvent`                                                                                                                                                                                                             | the `session.context_summary_progress` event (epic #277, C2; #279): which pass of a chunked summary is starting                                                           |
| `SessionCompactEventSchema` / `SessionCompactEvent`, `SessionCompactEventInputSchema` / `SessionCompactEventInput`, `SessionCompactionEventSchema` / `SessionCompactionEvent`, `SessionCompactionOutcomeSchema` / `SessionCompactionOutcome`, `COMPACT_INSTRUCTIONS_MAX_LENGTH` | the manual-compaction pair (epic #277, K8; #283): the `session.compact` request `/compact [instructions]` makes, and the `session.compaction` outcome it is answered with |
| `SessionErrorSchema`, `SessionErrorTypeSchema`, `RetryStatusSchema`, `RetryStatusTypeSchema`                                                                                                                                                                                    | the typed `session.error` payload                                                                                                                                         |
| `ModelRequestStartEventSchema`, `ModelRequestEndEventSchema`, `ModelUsageSchema`, `SpanEventSchema`, `SpanErrorSchema`, `SpanErrorTypeSchema`, `TruncationSchema` / `Truncation`, `ModelRequestPurposeSchema` / `ModelRequestPurpose`                                           | span events, usage, the span error, the mode a request ran under (#245, M6), what a request had to cap (K6) and whether it was a summary request (C2)                     |
| `StoredEventStartSchema` / `StoredEventStart`, `StoredEventDeltaSchema` / `StoredEventDelta`, `ContentDeltaSchema`, `DeltaTypeSchema`                                                                                                                                           | the stored chunks of a reply (D9)                                                                                                                                         |
| `SupersedesSchema` / `Supersedes`                                                                                                                                                                                                                                               | the `{ from_seq, to_seq }` a stored event replaces: a reply's chunks, or a rewind (#238)                                                                                  |
| `StoredEventSchema` / `StoredEvent`, `StreamEventSchema` / `StreamEvent`, `EventInputSchema` / `EventInput`, `isStoredEvent()`                                                                                                                                                  | the unions everything else codes against; `EventInputSchema` is what a client may append                                                                                  |
| one `Immutable<EventName>` per event type, plus `ImmutableStoredEvent` and `ImmutableStreamEvent`                                                                                                                                                                               | **deprecated** aliases of the readonly event types; the plain names are deep-readonly now                                                                                 |
| `DeepReadonly<T>`                                                                                                                                                                                                                                                               | the mapped type every event type is built with (D9)                                                                                                                       |
| `EventSeqSchema`, `AfterSeqSchema`, `ProcessedAtSchema`, `QueuedProcessedAtSchema`                                                                                                                                                                                              | the fields every stored event carries                                                                                                                                     |
| `SendEventsRequestSchema`, `SendEventsResponseSchema`, `ListEventsQuerySchema`, `ListEventsResponseSchema`, `StreamEventsQuerySchema`, `StoredEventTypeSchema`, `DEFAULT_EVENT_ORDER`, `MAX_EVENT_DELTAS`                                                                       | the events endpoints                                                                                                                                                      |
| `TextBlockSchema`, `ContentBlockSchema`, `ContentBlocksSchema`                                                                                                                                                                                                                  | message content                                                                                                                                                           |

The `z.infer`-shaped types stay inside the schemas; every exported event **type**
(`StoredEvent`, `StreamEvent`, the members, the domain sub-unions) is `DeepReadonly<…>`, so
mutating a stored event is a compile error.

**Errors**

| export                                                                                        | what it is                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `ApiErrorBodySchema` / `ApiErrorBody`, `ApiErrorSchema` / `ApiError`, `ApiErrorTypeSchema`    | the `{ type: 'error', error: { type, message } }` envelope    |
| `API_ERROR_TYPES`, `API_ERROR_STATUS_BY_TYPE`, `httpStatusForErrorType()`, `isApiErrorType()` | error types and their HTTP statuses (auth: 401/404/422 below) |
| `apiErrorBody()`                                                                              | build a body for the wire                                     |

The auth epic (#65) uses three of those types: `authentication_error` (401) for a caller who
is not signed in, or whose session or bearer token is invalid or expired; `not_found_error`
(404) for a resource that is another user's — answered as missing, never 403 (A4); and the
extension type `invalid_provider_credential` (422) for a credential that failed validation on
save. It is the one API error type that does not end in `_error`.

The modes work (#245, M6) adds one more extension type: `mode_unavailable_error` (422), for a
chat that starts or continues on a mode whose model cannot be used — no credential for its
provider, or "my default model" with no default set. It ends in `_error`, unlike
`invalid_provider_credential`.

**Ids, pagination, constants**

| export                                                                                                                                                                              | what it is                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ID_PREFIXES`, `IdType`, `ULID_LENGTH`, `ulid()`, `isUlid()`                                                                                                                        | id building blocks: `agent_`, `sesn_`, `sevt_`, `pcred_`, `mode_` + ULID |
| `generateId()`, `newAgentId()`, `newSessionId()`, `newEventId()`, `newProviderCredentialId()`, `newModeId()`                                                                        | generators                                                               |
| `parseId()` / `ParsedId`, `tryParseId()`, `isId()`, `isAgentId()`, `isSessionId()`, `isEventId()`, `isProviderCredentialId()`, `isModeId()`                                         | parsing and validation                                                   |
| `AgentIdSchema` / `AgentId`, `SessionIdSchema` / `SessionId`, `EventIdSchema` / `EventId`, `ProviderCredentialIdSchema` / `ProviderCredentialId`, `ModeIdSchema` / `ModeId`         | branded id schemas                                                       |
| `PAGE_CURSOR_PREFIX`, `PageCursorSchema` / `PageCursor`, `SeqCursorSchema` / `SeqCursor`, `KeyCursorSchema` / `KeyCursor`, `PageCursorStringSchema`, `NextPageSchema`               | opaque pagination cursors: `seq` and keyset `key` positions              |
| `encodeSeqCursor()`, `encodeKeyCursor()`, `KeyCursorPosition`, `decodePageCursor()`, `tryDecodePageCursor()`, `isPageCursor()`                                                      | writing a cursor, and reading one back                                   |
| `API_VERSION_PREFIX`, `ANTHROPIC_VERSION_HEADER`, `ANTHROPIC_BETA_HEADER`, `API_VERSION_DATE`, `LAST_EVENT_ID_HEADER`, `REQUEST_ID_HEADER`, `JSON_CONTENT_TYPE`, `SSE_CONTENT_TYPE` | the wire constants                                                       |

| `DEFAULT_PARTITION_COUNT`, `partitionOf()` | session → partition ownership hash |
| `PROVIDERS` / `ProviderDefinition`, `PROVIDER_IDS`, `ProviderId` | the model providers openharness knows: the provider ids and the facts every side shares (#245) |
| `CREDENTIAL_TYPES` / `CredentialTypeDefinition`, `NamedCredentialType` | the credential types that are not one of those ids (#245 A3a/A3b): `azure_openai` and `openai_compatible` |
| `credentialTypeInfo()`, `credentialTypeName()`, `defaultCredentialName()`, `isValidCredentialName()`, `isReservedCredentialName()`, `CREDENTIAL_NAME_PATTERN`, `CREDENTIAL_NAME_MAX_LENGTH` | naming a named credential: its facts, and the rules a name must satisfy |
| `ReasoningEffortSchema` / `ReasoningEffort`, `REASONING_EFFORTS`, `ReasoningEffortRunSchema` / `ReasoningEffortRun` | `low \| medium \| high`, and what a request was asked for and ran with (#252) |
| `TimestampSchema`, `MetadataSchema`, `PageLimitSchema`, `ListOrderSchema`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`, `METADATA_MAX_PAIRS`, `METADATA_MAX_KEY_LENGTH`, `METADATA_MAX_VALUE_LENGTH` | shared scalars and limits |
| `PACKAGE_NAME` | the package name; lets a dependent prove the import resolved |

There is **no static-key header**: sign-in is Better Auth's (epic #65, A8), and the headers
that carry a session — a cookie for the web app, a bearer token for the CLI — are the
server's business, not this package's.

### `@openharness/protocol/fixtures`

Builders for every resource and event, and one realistic sample session.

| export                                                                                     | what it is                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `makeAgent()`, `makeSessionAgent()`, `makeSession()`                                       | resource builders; each takes `Partial<T>` overrides                                                                            |
| `makeUser()`, `makeUserPreferences()`, `makeProviderCredential()`                          | the signed-in user (a fixed opaque id), their preferences, and credential metadata; never a secret                              |
| `makeMode()`                                                                               | a mode (#245, M6): a `deep` preset on `anthropic/claude-sonnet-5` at a `high` effort                                            |
| `makeSessionRewind()`                                                                      | a `session.rewind` event (#238) — the session restarts from an earlier `user.message`                                           |
| `makeSessionDeleted()`                                                                     | a `session.deleted` stream event (#111) — the last event a stream for a deleted session delivers                                |
| `makeModelEntry()`, `makeListModelsResponse()`                                             | the model catalog: one entry, and a response of entries plus per-provider statuses (epic #92)                                   |
| `makeUserMessage()`, `makeUserInterrupt()`, `makeAgentMessage()`                           | message and interrupt builders                                                                                                  |
| `makeStatusRunning()`, `makeStatusIdle()`, `makeStatusRescheduled()`, `makeSessionError()` | session status builders                                                                                                         |
| `makeModelRequestStart()`, `makeModelRequestEnd()`                                         | span builders; the end builder takes the start it closes                                                                        |
| `makeContentDelta()`, `makeStoredEventStart()`, `makeStoredEventDelta()`                   | chunk builders: a delta payload, and the two stored chunk events (D9)                                                           |
| `fixtureTimestamp()`, `FIXTURE_MODEL_USAGE`                                                | a fixed epoch offset by seconds; default token counts                                                                           |
| `sampleAgent`, `sampleSession`                                                             | one of each resource                                                                                                            |
| `sampleSessionHistory`                                                                     | a full turn (claims included), a steering message, an interrupt, a retried error, and a queued message — 32 events, `seq` 1..32 |

The event builders allocate a running `seq` and a fresh `sevt_` id; pass `seq` or `id` in the
overrides for a specific one. They construct plain typed values rather than calling `.parse()`,
so a test can assert that what a builder produces really does parse against the schemas.

## Authentication and ownership (epic #65, wave 1)

This package carries the **wire types** of v2 authentication — users, provider credentials,
the error types and ownership — and nothing of the mechanism. Sign-in itself, the
device-code flow and the `/api/auth/*` endpoints are Better Auth's own surface, mounted by
the server (`apps/server`); the client wraps the few of them `oh login` needs. They are not
part of this protocol, and no schema here names a cookie, a token or an auth header.

- **The caller:** `GET /v1/me` answers `User` — `{ id, email, name?, image?, created_at }`
  — unwrapped. The web app authenticates with a Better Auth session cookie, the CLI with
  `Authorization: Bearer`; both resolve to this same user (A2). A request that is not signed
  in, or whose session or token is invalid or expired, is a 401 `authentication_error`.
- **Ownership:** `AgentSchema` and `SessionSchema` carry a **required** `owner_id` — read-only,
  set by the server from the caller; no request carries it, and an unknown `owner_id` in a body
  is stripped like any unknown field. Another user's resource is answered **404**, never 403,
  so its existence does not leak (A4). Required since #61: the server sets it on every agent
  and session it creates, so a response without one fails these schemas rather than passing as
  unowned.
- **Provider credentials:** write-only. `PUT /v1/provider-credentials/{name}` takes
  `PutProviderCredentialRequestSchema` — a discriminated union on `type` with `api_key`,
  `azure_openai`, `openai_compatible`, `bedrock` and `vertex` today, so a further way to
  authenticate lands as a new member — and answers `ProviderCredentialSchema`: metadata only,
  never the secret. Since #251 that response's variant for a type that has them carries an
  optional, typed `details`: the non-secret facts the credential's _type_ knows (a Vertex
  credential's service-account email, project and location), never the secret.
  `GET /v1/provider-credentials` lists that metadata for the caller's own credentials, and
  `DELETE /v1/provider-credentials/{name}` answers 204. A credential that fails its
  validation call on save is a 422 `invalid_provider_credential`. A model request for a
  provider the owner has no credential for ends the turn with the non-retryable
  `missing_provider_credential` session error, whose message names the provider.

  The path parameter is the credential's **name** (§ below): a provider id for an `api_key`,
  a name the user chose for a named type — which is why the route is spelled `{name}` and its
  shape did not change when named credentials arrived.

- **Ids:** a credential's `pcred_` id is this package's, so it is a ULID like the rest
  (`newProviderCredentialId()`); a user's id is Better Auth's — opaque, with no prefix of
  ours — and that is exactly what `owner_id` holds.

## The model catalog (epic #92, wave 1)

This package carries the **wire shapes** of the model catalog — `GET /v1/models` — and nothing
of how the server fills them (that is #90, in `apps/server`). The catalog is the chat models
the caller's own provider keys can use; the route and its server-side semantics (caching,
fallback, the refresh rate limit) are documented in
[docs/api.md](../../docs/api.md#the-model-catalog).

- **`ModelEntry`** is one chat model: `id` (the model id an agent's `model.id`
  takes, `provider/model`), `provider` (its prefix), a display `name`, `context_window` and
  `max_output_tokens` (`null` when neither the provider nor the registry knows them), and
  `source` — `provider` when the provider's own list carried it, `registry` when it came from
  the registry alone (C3).
- **`ProviderCatalogStatus`** is one provider's outcome, one per provider the caller has a
  credential for (C5): `ok`, or `fallback` when the provider's list failed or timed out (5 s)
  and the registry's chat models stood in; `fetched_at` is the provider call's time (`null` on
  a fallback), and `message` says why it fell back — never any part of a key.
- **`ListModelsResponse`** is `{ data, providers }`: the entries sorted by provider then name,
  and the statuses. There is no pagination envelope — the response is bounded by the caller's
  own keys, and the agent form shows every provider at once.
- **`ListModelsQuery.refresh`** bypasses the server's per-user, per-provider one-hour cache
  (C4) and is rate-limited to once a minute per user. The schema reads the wire spelling
  `'true'` / `'false'` as well as a real boolean, because a query string arrives as text.

## The provider list (epic #245, A0)

`src/providers.ts` is the **one** list of model providers in the repo. A provider id is the
`provider` half of a `provider/model` model id, and `PROVIDERS` carries the facts every side of
that id shares: the display name, the credential type, the models.dev key its models are filed
under, and the URL a reader gets a key from.

The list used to be restated five times — the server's `VALIDATABLE_PROVIDERS` and its
model-list adapters, the brain's client table, `@openharness/client`'s metadata, the
models.dev refresh script — with a test in `e2e` holding them together, because the server may
not depend on `client`. Now each of those tables is keyed by `ProviderId`
(`Readonly<Record<ProviderId, …>>` or `satisfies Record<ProviderId, …>`), so a provider missing
from one is a **compile error**, not a test failure, and the agreement tests are gone.

- **What stays in the packages.** Only the shared facts live here. A side's own table adds
  what only it needs: the server's validating request and its model-list adapter, the brain's
  AI SDK client, the frontends' free-tier and key-format hints.
- **A provider id and a credential type are different things.** The id is the fixed name of one
  of the eleven providers; the type says how a credential authenticates (`api_key`,
  `azure_openai`, `openai_compatible`, `bedrock` and `vertex` today, `gcp_service_account`
  later). A _named_ credential —
  `azure` and `azure-eu`, both of type `azure_openai` — takes the name as the provider half of a
  model id without being a new id here, which is why the two are kept apart.
- **The order is the contract.** A frontend draws its tiles in `PROVIDERS` order and the
  vendored models.dev snapshot is keyed in it, so reordering the list reorders the snapshot.

## Named credentials and the credential types (epic #245, A3a/A3d)

`src/credential-types.ts` is the list of credential types that are **not** one of the eleven
fixed provider ids, and the rules for naming one.

- **A credential's name is the `provider` half of its model ids.** For the eleven fixed
  providers the name is the provider id, one each; a _named_ type takes as many credentials as
  a user wants, each under a short name they choose. `azure/gpt-4o` and `azure-eu/gpt-4o` are
  model ids of two different Azure OpenAI credentials. The distinction the whole design rests
  on is that a **provider id/name** is what a model id's first half is, while a **credential
  type** says how a credential authenticates — A0 keeps them apart, and a named credential is
  where that pays off: `azure_openai` is a type, `azure` is a name, and neither is the other.
- **`CREDENTIAL_TYPES`** carries the facts every side shares about a named type: its `type`
  discriminant, its display name (`Azure OpenAI`, `Amazon Bedrock`, `Google Vertex`), the
  `defaultName` a first credential takes (`azure`, `bedrock`, `vertex`) and the `keyUrl` a
  reader creates the secret at — plus the `modelsDevKey` (`azure`, `amazon-bedrock`,
  `google-vertex`) the registry snapshot files its models under, which is _not_ the credential
  name: an `azure-eu` credential still reads models.dev's single `azure` entry, and a
  `bedrock-us` one reads `amazon-bedrock`. The name and the key URL are
  **optional**: a custom OpenAI-compatible endpoint (#249, A3b) names no single models.dev
  provider and has no console to link to, so its entry omits both, and a frontend that finds no
  `keyUrl` offers no link. The list is widened to `CredentialTypeDefinition` on export so a
  caller reads an optional fact without the literal union refusing the member that omits it.
- **A name must be short and lowercase**: `CREDENTIAL_NAME_PATTERN` is
  `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`, capped at `CREDENTIAL_NAME_MAX_LENGTH` (32, because the
  name prefixes every model id). `isValidCredentialName()` checks the shape;
  `isReservedCredentialName()` checks the other half — a named credential may not take one of
  the eleven fixed ids, which would make `openai/gpt-5` ambiguous between the provider and a
  credential that called itself `openai`. The server enforces both on save; the frontends
  enforce them inline so a reader sees it next to the field.
- **`PutProviderCredentialRequestSchema` is the union the named types live in.** `azure_openai`
  carries `endpoint` (an absolute `https:` URL — the resource endpoint, e.g.
  `https://my-resource.openai.azure.com`), `api_key` (write-only, exactly like the `api_key`
  form's) and `deployments` (at least one, at most `MAX_AZURE_DEPLOYMENTS` = 64). Azure offers
  no endpoint that lists deployments, so the user types them and each becomes a model.
  `openai_compatible` carries `base_url` (an absolute `http:` **or** `https:` URL — a
  self-hosted endpoint is the case this type exists for, and the SSRF guard, not the scheme, is
  what refuses a forbidden address) and an **optional** `api_key` (a local server may take
  none). `credential-types.test.ts` holds `CREDENTIAL_TYPES` against this union's non-`api_key`
  members, so a type in one list and not the other fails a named test.
- **`vertex` carries a service-account key document, a project and a location.** `service_account`
  is the JSON key file Google Cloud issues for a service account, **as text**: it is sealed whole
  and handed to the client library whole, so nothing in between reformats it.
  `parseServiceAccountKey()` is the one parser — it accepts only a document that parses, says
  `type: service_account` and carries the fields a request needs — and both this schema's
  refinement and the server's metadata derivation use it, so "is this a service-account key" has
  one answer. `project` is a Google Cloud project id, and `location` one of `VERTEX_LOCATIONS`:
  the location is not a label but the **host** every request goes to
  (`<location>-aiplatform.googleapis.com`), so a value outside the list could name no host.
  Workload identity federation and an ADC-only setup are deliberately out (epic #245, decision
  M4): the server runs on GCP, so an ADC fallback would run a user's chat on openharness's own
  service account.
- **`bedrock` carries a region, not an endpoint.** Static IAM access keys (`access_key_id`,
  `secret_access_key`), an optional `session_token` for temporary credentials, and a `region`
  validated against `BEDROCK_REGIONS` rather than accepted as free text — the region is spliced
  into an AWS hostname (`bedrock.<region>.amazonaws.com` for the control plane,
  `bedrock-runtime.<region>.amazonaws.com` for a model call), so a string that is not a real
  region could not name one, and a hostile one would point a stored credential somewhere nobody
  chose. AWS's own hosts are why this type has **no `safeFetch` and no user-supplied URL to
  guard**: what a user types is a region, and the list is what makes it a region. There is no
  assume-role in v1 (epic #245, decision M4) — a role ARN is a different shape and a different
  signing path, and a save-time check cannot complete an `sts:AssumeRole` for a user. Its
  metadata reports the region as its own typed `details` variant, `{ region }` (#250).
- **`details` is keyed by the credential's type.** `ProviderCredentialSchema` is a
  discriminated union on `type`, and each variant carries exactly the public, non-secret facts
  its type publishes — `openai_compatible`'s `{ base_url_host }`, `bedrock`'s `{ region }` and
  `vertex`'s `{ email, project, location }` today — while a type with none (`api_key`,
  `azure_openai`) has no `details` key at all, so their metadata is unchanged by the field. A
  type's `details` is a closed shape, so a stray key on one is stripped like any unknown field.
  `credentialDetails(body)` derives it from the PUT body; the server stores it in the row (so a
  metadata read shows it without opening the seal) and the frontends' fakes call the same
  helper, so both give the same answer. `ProviderCredentialMetadata` is the wide spelling — the
  base fields plus an optional `type`/`details` — that a store builds from a row or an argument
  before the credential's type narrows it. For a `vertex` credential `last4` is the **private
  key id**'s last four characters — an identifier Google prints in the console, and never any
  part of the private key.

Model ids for a named credential are `<name>/<deployment>` for Azure, `<name>/<model>` for a
custom endpoint, `<name>/<bedrock model id>` for Bedrock and `<name>/<model>` (`vertex/gemini-2.5-pro`,
`vertex/claude-sonnet-4-5@20250929`) for Vertex; nothing else in this package knows that — the
catalog and the brain resolve the name to a credential and the type decides what to build.

## The reasoning effort (epic #245, A4a)

`low | medium | high`, and nothing else: the levels the providers' own knobs have in common, so
one value means the same thing across the eleven of them. It is a capability of the **request**,
not of the provider or the model — a session asks for an effort, the brain maps it onto whichever
knob the model's provider has, and the request's span records what happened.

- **It rides the message** (`src/reasoning.ts`, `events/user.ts`). A `user.message` carrying a
  `reasoning_effort` asks for it from that message on, exactly as the `model` field of #111
  switches the model; `null` asks for the provider's default again, and a message without the
  field leaves whatever is in effect alone. Nothing is stored on the session, so a log no message
  of which ever carried an effort replays exactly as it did before this existed.
- **The span records both facts** (`events/span.ts`). `span.model_request_start.reasoning_effort`
  is `{ requested, applied }`: what the log asked for, and what the request ran with. Two fields
  because they differ — a model that takes no effort runs the provider's default, and `applied:
null` is how the log says "asked for, not applied" rather than leaving a reader to guess
  whether anything was asked at all. The field is absent when nothing was asked for, so a session
  that never set an effort keeps the span shape it always had.

Which providers and models take an effort — and what each one calls it — is the brain's
(`packages/brain/src/reasoning.ts`); this package carries the vocabulary and the wire shape only.

## Modes (epic #245, A4b; decision M6)

A **mode** is a per-user named preset that bundles a model, a reasoning effort and a
system-prompt addition behind a stable name (`smart`, `fast`, `deep`). A user picks it instead
of a raw `provider/model`, and a chat that started from one **follows it live**: every request
resolves the mode as it is now, so editing it changes every chat that runs it. `src/resources/mode.ts`
carries the resource and its endpoints; the semantics below are what the server, the brain and
the stores implement.

- **Per user, in the database, optional.** `ModeSchema` carries a read-only `owner_id`; the
  routes live under `/v1/me/modes`, a name is unique among its owner's modes (at most `MAX_MODES_PER_USER` of them), and another user's mode is a 404 like every other
  resource (A4). The pick-a-model flow is unchanged, and `default_model` stays a model
  preference, not a mode.
- **The model is a `provider/model` id or "my default model".** `ModeModelSchema` accepts a real
  id or the `MODE_DEFAULT_MODEL` sentinel `my-default-model`; the latter resolves to the user's
  `default_model` at request time, so it follows a changed default — and is unavailable when no
  default is set.
- **The session references the mode, and a message switches it** (`resources/session.ts`,
  `events/user.ts`). `Session.mode` is the mode a chat follows, or `null`. A `user.message`
  carrying a `mode` sets it for that message on; a `model` with no `mode` detaches (a chat
  follows a mode or a plain model, never both); `null` detaches. The server resolves and
  validates the mode on the append path.
- **The request records what the mode resolved to** (`events/span.ts`).
  `span.model_request_start.mode` is `{ id, name }`, recorded per request beside the resolved
  `model` and `reasoning_effort`, so the log stays accurate after a rename or an edit.
- **An unavailable mode is refused, never silently replaced.** A chat that starts or continues
  on a mode whose model cannot be used — no credential for its provider, or "my default model"
  with no default set — answers `mode_unavailable_error` (422).

## Model-first sessions (epic #92, issue #93)

Chatting does not require an agent. A session can be created from a model alone, and an agent
— when one is given — is the preset the session snapshotted: it stays in the API, hidden from
the UI for now.

- **`Session.model` and `Session.system` are the configuration the session runs**, always
  set. They are the agent's `model`/`system`, the request's override of either, or the inline
  model of an agent-less session (`system: null` when nothing named one). Since #111 the
  model is not frozen: a `user.message` carrying `model` switches it from that message on
  (epic #116, U3), which is the one way a session's configuration changes after creation.
- **`Session.agent` is that preset's snapshot — or `null`.** It is where the session came
  from, not what it runs: an edit to the agent still changes nothing, and a session created
  from a model has no snapshot at all.
- **`CreateSessionRequest` takes `agent?`, `model?` and `system?`, with at least one of
  `agent`/`model`** — a schema refinement with the message "a session needs an agent or a
  model". `system` may be `null` (no system prompt). An explicit `model`/`system` overrides
  what the agent contributes; without an agent, `model` is required and `system` defaults to
  `null`.
- **The wire is a strict superset of the old one** for agent-based clients: `{ agent }` still
  means "snapshot that agent and run it", and the response simply carries the two new fields
  besides the snapshot.

## Page cursors

`next_page` in a list response, and the `page` query parameter that carries it back, are one
opaque string per resume position: `page_` plus the URL-safe base64 of a small JSON payload,
tagged with the kind of position it holds.

| kind  | endpoints                            | payload                           | the next page starts             |
| ----- | ------------------------------------ | --------------------------------- | -------------------------------- |
| `seq` | the events list                      | `{ kind: 'seq', seq }`            | after that event `seq`           |
| `key` | `GET /v1/agents`, `GET /v1/sessions` | `{ kind: 'key', created_at, id }` | strictly before that keyset item |

Both resource lists are ordered by `(created_at, id)` and use the keyset cursor for a reason:
sessions are listed newest first, so an item offset would shift under a client that fetches
two pages while a session is being created, duplicating or skipping items. `created_at` alone
is not a position either — two items can share a millisecond — and `id` breaks the tie, being
a ULID that sorts by creation time too. The store seeks into that total order with one
comparison; the events list keeps using `seq`, which is already the log's ordering key.

`encodeSeqCursor(seq)` / `encodeKeyCursor({ created_at, id })` write a position (the second
takes anything carrying those two fields, so a whole `Agent` or `Session` can be passed).
`tryDecodePageCursor()` returns a `PageCursor` — the `{ kind: 'seq', … } | { kind: 'key', … }`
union — or `null`; `decodePageCursor()` throws `RangeError` instead. Only the canonical
spelling round-trips: the string must be exactly what the encoder emits for the position it
carries, so two spellings can never mean the same page.

Clients never parse a cursor, and `PageCursorStringSchema` — what `page` is validated with —
accepts either kind. Which kind an endpoint expects is the server's business.

## The immutable log (D9, #46)

The log is append-only, and [D9](https://github.com/amirtuval/openharness/issues/46) is what
makes the types say so. The rules, and where each one lives:

- **Claims are events.** Three event types carry `consumes` — a `span.model_request_start`
  claims the `user.message`s its request folds in (and `model`, the `provider/model` that
  served it); a `span.model_request_end` claims the `user.interrupt`s that cut its request
  short; a `session.status_idle` claims the `user.interrupt`s a turn that had nothing running
  ended on. All three lists are optional in the schema only so logs stored before D9 keep
  parsing; `processed_at` on a user event is a value the store derives on read, never a column
  an update rewrites.
- **Streamed chunks are stored events.** `event_start` and `event_delta` keep their names and
  shapes (D2) and carry the stored envelope (`id`, `seq`, `processed_at`), so a reply in flight
  is resumable by `seq` like anything else. The stored form is the only one.
- **The event that finishes a reply supersedes its chunks.** The stored `agent.message` — and,
  for a request that ends without one (an interrupt, a `brain_lost` recovery, a reply that
  streamed no text), the `span.model_request_end` — carries `supersedes: { from_seq, to_seq }`,
  inclusive, `from_seq <= to_seq` enforced by the schema. Replay skips the range; the store
  deletes it after the retention window. Also optional, for the same pre-D9 reason: a reader
  without a range falls back to where the reply's preview opened.
- **A rewind supersedes the tail of the log (#238).** `session.rewind` carries the same
  `supersedes: { from_seq, to_seq }` shape as a finished reply, but its range is the whole tail
  of the log from the edited `user.message` to the event before it — every event in between,
  of any type. Replay skips it, the client's transcript drops the messages it covers, and
  compaction deletes it after the retention window, so a reader that loads the session later
  sees the conversation as if the edited message had been the one sent. Required, not
  optional: unlike a reply's range there is no pre-#238 log with a rewind in it.
- **A batch carries at most one rewind, and it comes first (#238).** `SendEventsRequestSchema`
  is where the rule is written on the wire: the batch is appended in order and a rewind
  supersedes everything from the message it names to the end of the log as it stands, so a
  message ahead of it — or anything behind a second rewind — would be stored and then swallowed
  by the range the rewind records, accepted by the response and answered by no turn. Breaking
  the rule is a 400 `invalid_request_error` and stores nothing; the store enforces the same
  rule on its append path (`assertRewinds` in `@openharness/session`).
- **Stored events are deep-readonly.** Every exported event type — `StoredEvent`,
  `StreamEvent`, each member, and the domain sub-unions (`UserEvent`, `AgentEvent`,
  `SessionEvent`, `SpanEvent`) — is `DeepReadonly<z.infer<…>>` of its schema, so `event.seq =
…` is a compile error everywhere. The `Immutable*` names remain as deprecated aliases of the
  readonly ones; `DeepReadonly` is exported too. The two response types that carry event
  arrays (`ListEventsResponse.data`, `SendEventsResponse.data`) are hand-written for this
  reason — a schema's inferred type cannot be readonly, and the read a client replays from has
  to be.
- **`isStoredEvent()` checks `seq`.** Every event a server delivers is stored, with one
  exception: `session.deleted` (#111), which names a session whose log no longer exists and
  carries no envelope, so the predicate is `false` for exactly it. The runtime check stays
  because it is the honest test against a value that did not come from the schemas (a pre-D9
  payload, say). The `StreamEvent` union is the stored one plus that event.

## Deviations and extensions

Everything below is a deliberate difference from Anthropic's Managed Agents API. The `where`
column points at the definition in code; the same list appears in the TSDoc there.

### Extensions — things Anthropic does not have

| extension                                                                     | where                                                           | why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seq` on every stored event                                                   | `events/common.ts`, `EventSeqSchema`                            | Anthropic orders the log by `processed_at`, which is not monotonic across a crash and collides at millisecond resolution. `seq` is the ordering key, the pagination cursor and the SSE resume position. Starts at 1, +1 per event, per session.                                                                                                                                                                                                                                                                                                                                                                                |
| `after_seq` on the events list and stream queries                             | `events/api.ts`                                                 | Exact resume: `after_seq=0` reads from the start, `after_seq=<last seen seq>` re-reads nothing. Complements `page` and the `last-event-id` header.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `span.model_request_end.error`                                                | `events/span.ts`                                                | Anthropic only has `is_error`. The reason is needed to tell an interrupt (`interrupted`) from a lost brain (`brain_lost`) from a failed model request (`model_error`) — all three close a span without a normal reply.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `consumes` and `model` on `span.model_request_start`                          | `events/span.ts`                                                | Anthropic marks a user event processed out of band; openharness records the claim in the log: `consumes` lists the `user.message`/`user.interrupt` ids the request answers, `model` is the `provider/model` that served it (per request, so a mid-session model change stays visible). Optional only so a pre-D9 log keeps validating.                                                                                                                                                                                                                                                                                         |
| `consumes` on `span.model_request_end` and `session.status_idle`              | `events/span.ts`, `events/session.ts`                           | P4: an interrupt is answered by the event that ends the work it stopped — the open request's span end, or the turn's idle event when nothing was running — so the claim rides on that event instead of on a request opened for the interrupt. Optional, likewise, for pre-P4 logs.                                                                                                                                                                                                                                                                                                                                             |
| `supersedes` on `agent.message` and `span.model_request_end`                  | `events/common.ts`, `events/agent.ts`, `events/span.ts`         | The `{ from_seq, to_seq }` chunk range the event replaces (D9): replay skips the range and a compaction job deletes it later. No Anthropic equivalent — Anthropic never stores the chunks.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| stored `event_start` / `event_delta`                                          | `events/stream.ts`                                              | Anthropic only streams the previews. openharness stores each chunk as a normal event (same `type` strings, plus `id`/`seq`/`processed_at`), which is what makes a reply in flight resumable by `seq`; `supersedes` compacts them away. The stored form is the only form.                                                                                                                                                                                                                                                                                                                                                       |
| `user` resource and `GET /v1/me`                                              | `resources/user.ts`                                             | Anthropic has no user resource: its API is account-scoped by the key that calls it. openharness has real users (epic #65), and everything a caller does is scoped to the one `/v1/me` names.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `owner_id` on `agent` and `session`                                           | `resources/agent.ts`, `resources/session.ts`                    | Every agent and session belongs to exactly one user (A4): nothing is shared, another user's resource is a 404, and no request carries the field. **Required** since #61: the server sets it on everything it creates.                                                                                                                                                                                                                                                                                                                                                                                                          |
| provider credentials (`pcred_`, the `/v1/provider-credentials` routes)        | `resources/provider-credential.ts`, `ids.ts`                    | Anthropic holds the model-provider keys; openharness users bring their own (A5). The API is write-only: the secret goes up, metadata comes back, and the credential store's other forms (`aws`, …) become new members of the request union.                                                                                                                                                                                                                                                                                                                                                                                    |
| `invalid_provider_credential` (422)                                           | `errors.ts`                                                     | The one API error type without the `_error` suffix: a credential that failed validation on save (A5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `model` and `system` on `session`; a nullable `agent` (§93)                   | `resources/session.ts`                                          | The configuration a session actually runs, always set, and the optional preset it snapshotted. Anthropic has no equivalent: there a session always has an agent, and the agent carries the model.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `missing_provider_credential` session error                                   | `events/session.ts`                                             | The owner has no stored credential for the model's provider, so the turn cannot make a model request. Non-retryable — the schema pins `retry_status` to `exhausted` — and the message names the provider.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `model` on `user.message` and its input (#111)                                | `events/user.ts`                                                | Mid-chat model switching (epic #116, U3): a message that carries a `model` also sets the session's current `model` in the same transaction, and the brain uses that for each request. Anthropic's model is the agent's, fixed at session creation.                                                                                                                                                                                                                                                                                                                                                                             |
| `reasoning_effort` on `user.message` and on `span.model_request_start` (#252) | `reasoning.ts`, `events/user.ts`, `events/span.ts`              | How hard a request is asked to think (epic #245 decision M5, A4a). The effort rides the message — the same "from this message on" reading as the `model` switch — and the span records what the request was asked for beside what it applied, because a model that takes no effort runs the provider's default. Anthropic carries an `effort` on the agent's model config instead, fixed at session creation.                                                                                                                                                                                                                  |
| the `mode` resource and its routes (#245, M6)                                 | `resources/mode.ts`                                             | A per-user named preset: a model, a reasoning effort and a system-prompt addition behind a stable name such as `smart`. Users and agents pick a mode instead of a raw `provider/model`, and a chat follows the mode live, so retuning it changes every chat that runs it. Anthropic's API is account-scoped with a fixed agent per session and has no user-defined presets.                                                                                                                                                                                                                                                    |
| `mode` on `session` and on `user.message` (#245, M6)                          | `resources/session.ts`, `events/user.ts`                        | Which mode a chat follows, and the switch that changes it. Rides the message exactly as the `model` switch does (#111): a message carrying a `mode` sets it from that message on, `null` or a plain `model` detaches, and a message carrying neither leaves it alone. Stored on the session so a chat keeps its mode across requests, and cleared when the mode is deleted — the chat then continues on the model it last ran.                                                                                                                                                                                                 |
| `mode` on `span.model_request_start` (#245, M6)                               | `events/span.ts`                                                | The mode a request ran under and its name then, recorded per request beside the resolved `model` and `reasoning_effort`. Per request like `model`, so a rename or an edit later does not rewrite what the request ran with: the log stays accurate after the mode's mapping changes. Anthropic has no modes and so nothing to record.                                                                                                                                                                                                                                                                                          |
| `mode_unavailable_error` (422)                                                | `errors.ts`                                                     | A chat that starts or continues on a mode whose model cannot be used — no credential for its provider, or "my default model" with no default set. Refused rather than silently fallen back to the user's default; the message tells the user to edit the mode or pick a model (epic #245, M6).                                                                                                                                                                                                                                                                                                                                 |
| `session.deleted` — a stream-only event (#111)                                | `events/session.ts`, `events/common.ts`                         | A `DELETE /v1/sessions/{session_id}` removes the session and its log, so the stream that was following it gets one final `session.deleted` (`{ type, session_id }`) before the server closes it — an end state, not an event of the log. The only event type not in `STORED_EVENT_TYPES`.                                                                                                                                                                                                                                                                                                                                      |
| `session.rewind` (#238)                                                       | `events/session.ts`, `events/common.ts`                         | Editing a sent message restarts the conversation from it: the event carries `supersedes: { from_seq, to_seq }` over the tail of the log from the edited `user.message`, replay and the client's transcript skip it, and compaction deletes it after the retention window. The edited text is an ordinary `user.message` appended right behind it, in the same append — and `SendEventsRequestSchema` accepts at most one rewind per batch and only as its first event. Anthropic has no edit: there is no way to take a message back.                                                                                          |
| `session.usage` (#247)                                                        | `events/session.ts`                                             | The session's running token totals, per model, written after every model request that reported usage. Anthropic has the event — a snapshot of cumulative usage and its tracked list cost — but writes it once per idle, stamps the cost onto it and keeps it flat; here it is per request, carries no cost (cost is computed on read, epic #245) and is broken down by model — each entry with the request count that lets a reader count unpriced requests — because an openharness session may switch models mid-conversation.                                                                                               |
| `cost` on a model entry, and the usage endpoints (#247)                       | `resources/model.ts`, `resources/usage.ts`                      | The price of a model, and what a session or a user spent. Anthropic has no per-user usage endpoint and no price on its catalog: its cost figures are platform-computed and stored. openharness computes cost from the tokens the log holds and the vendored rates, on the read that asked for it.                                                                                                                                                                                                                                                                                                                              |
| `session.context_summary` (epic #277, K1; #278)                               | `events/session.ts`, `events/common.ts`                         | A summary of the older history, written by the brain when a chat's context fills. It supersedes **nothing**: the log, the transcript and replay stay whole, and the only reader is the context strategy — what the model sees is the system prompt, then the latest non-superseded summary, then every event after `covers.to_seq`. Anthropic has no server-side brain and no compaction event that leaves the transcript intact.                                                                                                                                                                                              |
| `session.context_summary_progress` (epic #277, C2; #279)                      | `events/session.ts`, `events/common.ts`                         | One pass of a chunked summary is starting: `{ pass, passes }`. Stored, because everything a client is shown lives in the log (D9) — a client that reconnects mid-compaction, or loads the session later, sees the same progress the live stream carried. Read by no part of the brain; deleting the stale ones is follow-up work (#285). Anthropic has no server-side brain and so nothing to report progress about.                                                                                                                                                                                                           |
| `truncated` and `purpose` on `span.model_request_start` (epic #277; #278, C2) | `events/span.ts`                                                | `truncated: { seq, tokens_before, tokens_after }` records that the newest message alone was over the chat model's budget and was capped to a head and a tail with an omission marker (K6), so a client can tell the user rather than let the message silently disappear. `purpose: 'summary'` marks a request the compaction engine made to write a summary, so the size accounting can refuse it as a baseline for the next request's context size (K2). Anthropic records neither.                                                                                                                                           |
| `session.compact` and `session.compaction` (epic #277, K8; #283)              | `events/session.ts`, `events/common.ts`, `resources/session.ts` | The manual-compaction pair behind `POST /v1/sessions/{id}/compact` — `/compact [instructions]`. `session.compact` is the client-requested event (an optional bounded `instructions` string), written by the server like a rewind; `session.compaction` is the brain's stored answer (`summarized` \| `nothing_to_summarize` \| `failed`, echoing the guidance and pointing at the summary it wrote). Together they are a clear outcome a client shows, never a silent no-op, and "the newest of the pair is a request" is what makes `/compact` idempotent while one is pending. Anthropic has no user-triggered compaction.   |
| `GET`/`PUT /v1/me/preferences` (#111)                                         | `resources/user.ts`                                             | A per-user default model (epic #116, U1), stored server-side and shared by the web app and `oh`. `default_model` is `provider/model`-shaped or `null`; the id does not have to be in the catalog. Anthropic has no per-user settings: its API is account-scoped by the caller's key.                                                                                                                                                                                                                                                                                                                                           |
| `GET`/`PUT /v1/me/preferences` (#111, #282)                                   | `resources/user.ts`                                             | A per-user default model (epic #116, U1), the web theme (#201) and the three compaction controls (epic #277, C3; #282): the trigger share (`0.3`–`0.95`, `null` for the deployment's own), the summary model (`same-as-chat` or a `provider/model` id) and the pass limit (1–10, `null` for the engine's own). `default_model` is `provider/model`-shaped or `null`; the ids do not have to be in the catalog. The response carries `defaults` — what the `null`s follow — because the share is a deployment's and a client cannot know it. Anthropic has no per-user settings: its API is account-scoped by the caller's key. |
| the provider list (#245)                                                      | `providers.ts`                                                  | Anthropic holds the model-provider keys and has no registry of them; openharness users bring their own (A5), so the providers it knows are openharness's own list. Every side — the server's validation and model-list tables, the brain's clients, the frontends' metadata, the models.dev refresh script — is keyed by its `ProviderId`.                                                                                                                                                                                                                                                                                     |
| `DELETE /v1/sessions/{session_id}` → 204 (#111)                               | `resources/session.ts`                                          | Hard delete of a chat (epic #116, U5): owner-scoped (another user's session is a 404) and irreversible — it removes the session and its whole log. The explicit exception to the immutable log besides compaction; open streams receive `session.deleted` and close. Anthropic has no session-delete route.                                                                                                                                                                                                                                                                                                                    |

### Deviations — subsets and changed shapes

| deviation                                                                                                             | where                         | Anthropic                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content blocks are text only: no `image`, `document`, `file` or `redacted` blocks                                     | `content.ts`                  | user messages accept image/document/file blocks; agent messages may carry `redacted`                                                                                                                       |
| `model` is `{ id }` only: no `effort`, `inference_geo`, `speed`                                                       | `resources/agent.ts`          | `BetaManagedAgentsModelConfig`                                                                                                                                                                             |
| `model.id` is a **model id** (`provider/model`), not a bare Anthropic model id                                        | `resources/agent.ts`          | `"claude-sonnet-5"`                                                                                                                                                                                        |
| `stop_reason` is only `{ type: 'end_turn' }`                                                                          | `events/session.ts`           | also `requires_action`, `retries_exhausted`, `budget_reached`                                                                                                                                              |
| `SessionStatus` is only `idle`/`running`                                                                              | `resources/session.ts`        | also `rescheduling` and `terminated`; openharness models retries as `session.status_rescheduled` events                                                                                                    |
| An agent has no `archived_at`, `mcp_servers`, `metadata`, `multiagent`, `skills`, `tools` or `version`                | `resources/agent.ts`          | all present                                                                                                                                                                                                |
| A session agent snapshot is `{ id, name, model, system }` — or `null` (§93)                                           | `resources/session.ts`        | `BetaManagedAgentsSessionAgent` also carries `description`, `mcp_servers`, `skills`, `tools`, `version`, and a session always has one                                                                      |
| `initial_events` accepts user events (`user.message`, `user.interrupt`); at most 50                                   | `resources/session.ts`        | only `user.message` and `user.define_outcome`                                                                                                                                                              |
| `POST /v1/sessions` takes an `agent` **id string** and/or an inline `model`/`system` (§93); no agent reference object | `resources/session.ts`        | `string`, `{ type: 'agent', id, version? }` or `{ type: 'agent_with_overrides', ... }`; the agent is required                                                                                              |
| `event_deltas[]` accepts `agent.message` only                                                                         | `events/stream.ts`            | also `agent.thinking` (start-only)                                                                                                                                                                         |
| No system events (`system.message`), tools, MCP, outcomes, multiagent threads, budgets or webhooks                    | everything                    | all present in the beta                                                                                                                                                                                    |
| `GET /v1/models` answers the caller's own usable chat models, not Anthropic's model list                              | `resources/model.ts`          | `GET /v1/models` lists Anthropic's models — `{ data: [{ type: 'model', id, display_name, created_at }], has_more, first_id, last_id }`: no provider grouping, no per-provider status, no registry fallback |
| `GET /v1/sessions` takes only `limit`, `page` and `agent_id`; `GET /v1/agents` only `limit` and `page`                | `resources/`                  | sessions also take `agent_version`, `created_at[gt]`-style bounds, `deployment_id`, `include_archived`, `memory_store_id` and `statuses`; agents also take `created_at[...]` and `include_archived`        |
| `processed_at` is written as an explicit `null` on a queued user event rather than omitted                            | `events/common.ts`            | `optional string or null`                                                                                                                                                                                  |
| `content_delta.index` may be omitted, and parses as `0`                                                               | `events/stream.ts`            | `index: optional number`; Anthropic's own accumulator reads a missing index as 0                                                                                                                           |
| `request_id` in the error envelope is optional here                                                                   | `errors.ts`                   | Anthropic always includes it; a proxy or a pre-app error may not have one to report                                                                                                                        |
| `data` and `next_page` are required in every list response                                                            | `events/api.ts`, `resources/` | Anthropic's generated spec marks both `optional`; openharness always writes them, and `next_page: null` is how "no more pages" is spelled                                                                  |
| Unknown **fields** are stripped, not rejected, by every object schema                                                 | everywhere                    | —                                                                                                                                                                                                          |

Stripping unknown fields is what lets a real Anthropic response (which carries `effort`,
`archived_at`, `skills`, ...) parse cleanly against the v1 subset. Two things are still
rejected: unknown **event types** — the unions are closed — and a response missing a field
the envelope is required to carry.

## How to add a new event type

Event types are the part of this package that grows most often. Adding one touches five
places, in this order:

1. **Name it** in `EVENT_TYPES` (`src/events/common.ts`). `{domain}.{action}`, matching
   Anthropic's spelling exactly. Add it to `STORED_EVENT_TYPES` — every event a server emits
   is stored, except the stream-only `session.deleted` (#111), which names a log that is
   already gone; a stream-only event is deliberately left out of that list.
2. **Define the schema** in the file for its domain (`user.ts`, `agent.ts`, `session.ts`,
   `span.ts`). Build it from `EventIdSchema`, `EventSeqSchema` and the `processed_at` schema
   that matches who writes it — `QueuedProcessedAtSchema` for user events, `ProcessedAtSchema`
   for anything the server produces. A stream-only event carries no envelope at all (see
   `SessionDeletedEventSchema`). Add `// extension:` to any field Anthropic does not have.
3. **Add it to the domain union** at the bottom of the same file — a stored type goes to the
   domain's stored union, a stream-only one deliberately does not — then to
   `StoredEventSchema` (stored) and/or `StreamEventSchema` in `union.ts`. A stored type that
   reuses a `type` string an existing member already has cannot go _inside_ the discriminated
   union — zod throws on a duplicate discriminator value when it parses — so it is added to
   the surrounding `z.union` instead, the way the stored chunks are.
4. **Add a builder** in `src/fixtures/index.ts` and a valid sample to `storedSamples` in
   `src/events/events.test.ts` — that table is asserted against `STORED_EVENT_TYPES`, so a
   stored type without a sample fails the suite (a stream-only type gets its own test).
5. **Document it**: the `EVENT_TYPES` entry is the documentation for the wire; put the
   semantics in the schema's TSDoc, and extend the sample history in the fixtures if the new
   type belongs in a realistic turn.

Then run the package commands above. If the new type is a `types[]` filter value it is picked
up automatically through `StoredEventTypeSchema`.

## Allowed `@openharness/*` dependencies

None. This package must stay free of `@openharness/*` dependencies.

Packages consume each other through built output only (`exports` → `dist/`); ESLint's
`import-x/no-relative-packages` (in the shared config) rejects a relative import that leaves
the package, and `yarn check:deps` at the repo root enforces the allowed `@openharness/*`
dependency table.

## Usage and cost (#247)

The other half of the protocol that is not a wire shape: **what a pile of tokens costs**. Cost
is never stored — the log holds tokens, and the money is derived on the read that asked for it —
so the arithmetic has to live somewhere both the server and the frontends can reach, and
`src/cost.ts` is that place. It is pure (no I/O, no state), which is what lets it sit in this
package beside the schemas it prices:

- **`usageCost(usage, cost)`** — the four counters times the model's rates, per million tokens.
  A model with no price at all answers `null`; so does one whose cache rate nobody published
  when the request spent cache tokens, because charging nothing for tokens that were really
  spent would understate the bill. A counter of zero costs zero whatever the rate is.
- **`totalCost(costs)`** — a `TotalCost`: `cost`, the sum of the parts that could be priced (or
  `null` when none could), and `unpriced_requests`, how many were left out (#247, decided
  2026-10-09). One request nobody prices no longer makes a whole total unknown; the known part
  is the money and the unknown part is named, and neither is guessed. An empty set is `null`
  with nothing counted, not `0`.

`resources/usage.ts` is the wire half: the totals, the per-model breakdown, the per-day cut and
the query the per-user route takes. Every total carries the two fields of `TotalCostSchema` —
`cost`, a `MoneySchema` (a non-negative number of dollars, or `null` for "unknown", the only way
this package says so), and `unpriced_requests` — as siblings, so a client renders `$1.23 + 4
unpriced` and reserves `—` for a total with nothing priced. `ModelCost` itself lives on
`resources/model.ts`, because a price is a property of a model entry (the catalog is where a
client gets its rates); `SessionModelUsage` (`events/session.ts`) carries the per-model `requests`
count beside its tokens, which is what lets a reader of the running `session.usage` totals count
unpriced requests the way the routes do without storing any money.

**The four `ModelUsage` counters are disjoint** — no token is counted twice — which is what makes
`usageCost`'s arithmetic (each counter at its own rate) correct. `input_tokens` is the **uncached**
input, the way Anthropic's own `input_tokens` reads, and the two cache counters are the cached
halves. A provider whose API reports a cache-inclusive input — OpenAI's `prompt_tokens`, a Gemini
`promptTokenCount` — is normalised before its numbers reach the log: the brain's `toModelUsage`
reads the AI SDK's _uncached_ half for exactly this reason (epic #277, K2). Summing the three
input-side counters therefore answers what the real prompt size of a request was, which is the
measure the compaction trigger uses; storing the SDK's cache-inclusive total instead would have
counted cached tokens twice in the same arithmetic.

## Context summaries and request sizes (epic #277, K1/K2/K6; #278)

`session.context_summary` (`events/session.ts`) is the brain's own event for a chat whose context
filled: `summary` is the text, `covers.to_seq` the last event it replaces **for the model**, and
`reason` why it happened (`threshold | overflow | manual`). It records the model, prompt version
and pass count that wrote it, and an optional `fallback_reason` for when the chat's own model did
the work instead of the chosen summary model. It is the brain's bookkeeping like `session.usage`:
not queued, never claimed, and it supersedes **nothing** — replay and the transcript still show
the full history, and only the context strategy reads it. A later `session.rewind` that reaches
back past a summary supersedes it along with the rest of the tail it covered, so it disappears
from the strategy's reading naturally.

`span.model_request_start` carries two fields that go with it. `truncated` is
`{ seq, tokens_before, tokens_after }`: the newest message alone was over the chat model's budget,
so the request carries it capped to a head and a tail around an omission marker (K6) and the span
says which event was cut and what it cost — a client shows the user a notice rather than letting
the message silently disappear. `purpose: 'summary'` marks a request the compaction engine made to
summarize history (C2), which is how the size accounting refuses such a request as a baseline for
the next request's size (K2). Both are optional: a session that never overflowed and never
summarized writes neither.

While a summary is being written, `session.context_summary_progress` (`{ pass, passes }`) is
stored before every pass, so a client watches a long compaction the same way it watches a turn —
everything it is shown is in the log (D9). It is the brain's bookkeeping like the summary itself:
never claimed, never read back by the strategy, and never a position a request is built from.

A user can also ask for a compaction on demand (`/compact [instructions]`, epic #277 K8; #283):
`session.compact` is the request — written by the server on the caller's behalf, with the
reader's optional bounded guidance — and `session.compaction` is the brain's stored answer
(`summarized` \| `nothing_to_summarize` \| `failed`), written after every request whatever came
of it. The pair is the client's whole view of a manual compaction: the newest of the two being a
request is what "one is pending" means, which is what makes `/compact` idempotent while a request
waits, and the outcome event is why it is never a silent no-op.

The semantics — local days, ownership, what a rewind does to a bill — are in
[`docs/api.md`](../../docs/api.md#usage-and-cost) and the server's `AGENTS.md`.

## Testing

`src/**/*.test.ts` with Vitest (node environment). One file per module, plus
`events/events.test.ts` for the unions — it drives a table of one valid wire sample per stored
event type, so a schema change that breaks the wire format fails a named test rather than a
type.

Tests are in `src/`, so they are typechecked against the browser-safe program too, and they
must not need `@types/node`. `pagination.test.ts` also runs a cursor round trip with
`globalThis.Buffer` stubbed out — the runtime half of the environment rule above.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `packages/protocol/docs/`.
