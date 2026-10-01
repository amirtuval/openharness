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
  pagination.ts         page cursors: `seq` (events) and keyset `key` (agents, sessions)
  errors.ts             the Anthropic error envelope, error types and status codes
  content.ts            message content blocks (text only in v1)
  readonly.ts           DeepReadonly, the helper the immutable event types are built with
  resources/
    agent.ts            the agent resource + its endpoints
    provider-credential.ts  provider credential metadata (write-only) + its endpoints
    session.ts          the session resource + its endpoints
    user.ts             the signed-in user: GET /v1/me, UserIdSchema (owner_id)
  events/
    common.ts           the event vocabulary, the fields every stored event carries, supersedes
    user.ts             user.message, user.interrupt (+ the shapes a client sends)
    agent.ts            agent.message
    session.ts          status events, session.error, stop_reason
    span.ts             span.model_request_start / _end, model_usage, claims (consumes/model)
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

| export                                                                                                    | what it is                                                      |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `AgentSchema` / `Agent`                                                                                   | the `agent` resource (carries a read-only `owner_id`)           |
| `CreateAgentRequestSchema`, `UpdateAgentRequestSchema`                                                    | bodies of `POST /v1/agents`, `POST /v1/agents/{agent_id}`       |
| `ListAgentsQuerySchema`, `ListAgentsResponseSchema`                                                       | `GET /v1/agents`                                                |
| `ModelConfigSchema` / `ModelConfig`                                                                       | `{ id }`, where `id` is a Mastra router string `provider/model` |
| `SessionSchema` / `Session`, `SessionAgentSchema` / `SessionAgent`                                        | the `session` resource (read-only `owner_id`) and its snapshot  |
| `SessionStatusSchema`, `StopReasonSchema`                                                                 | `idle`/`running`; `{ type: 'end_turn' }`                        |
| `CreateSessionRequestSchema`, `ListSessionsQuerySchema`, `ListSessionsResponseSchema`                     | the sessions endpoints                                          |
| `UserSchema` / `User`, `GetMeResponseSchema` / `GetMeResponse`                                            | the signed-in user; `GET /v1/me`                                |
| `UserIdSchema` / `UserId`                                                                                 | an opaque Better Auth user id; what `owner_id` holds            |
| `ProviderCredentialSchema` / `ProviderCredential`, `ProviderCredentialTypeSchema`                         | credential metadata (`api_key` only today); never the secret    |
| `ApiKeyProviderCredentialSchema`, `PutProviderCredentialRequestSchema` / `PutProviderCredentialRequest`   | body of `PUT /v1/provider-credentials/{provider}` (write-only)  |
| `ListProviderCredentialsResponseSchema` / `ListProviderCredentialsResponse`                               | `GET /v1/provider-credentials`                                  |
| `AGENT_NAME_MAX_LENGTH`, `AGENT_DESCRIPTION_MAX_LENGTH`, `SESSION_TITLE_MAX_LENGTH`, `MAX_INITIAL_EVENTS` | limits Anthropic documents                                      |

**Events**

| export                                                                                                                                                                                                    | what it is                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `EVENT_TYPES`, `STORED_EVENT_TYPES`, `EventType`, `StoredEventType`                                                                                                                                       | the vocabulary as constants and types                              |
| `UserMessageEventSchema`, `UserInterruptEventSchema`, `UserEventSchema`                                                                                                                                   | stored user events                                                 |
| `UserMessageEventInputSchema`, `UserInterruptEventInputSchema`, `UserEventInputSchema`                                                                                                                    | the same shapes as a client sends them                             |
| `AgentMessageEventSchema`, `AgentEventSchema`                                                                                                                                                             | stored agent events                                                |
| `SessionStatusRunningEventSchema`, `SessionStatusIdleEventSchema`, `SessionStatusRescheduledEventSchema`, `SessionErrorEventSchema`, `SessionEventSchema`                                                 | stored session events                                              |
| `SessionErrorSchema`, `SessionErrorTypeSchema`, `RetryStatusSchema`, `RetryStatusTypeSchema`                                                                                                              | the typed `session.error` payload                                  |
| `ModelRequestStartEventSchema`, `ModelRequestEndEventSchema`, `ModelUsageSchema`, `SpanEventSchema`, `SpanErrorSchema`, `SpanErrorTypeSchema`                                                             | span events, usage, and the span error extension                   |
| `StoredEventStartSchema` / `StoredEventStart`, `StoredEventDeltaSchema` / `StoredEventDelta`, `ContentDeltaSchema`, `DeltaTypeSchema`                                                                     | the stored chunks of a reply (D9)                                  |
| `SupersedesSchema` / `Supersedes`                                                                                                                                                                         | the `{ from_seq, to_seq }` a stored event replaces (D9)            |
| `StoredEventSchema` / `StoredEvent`, `StreamEventSchema` / `StreamEvent`, `isStoredEvent()`                                                                                                               | the unions everything else codes against                           |
| one `Immutable<Member>` per type above, `ImmutableStoredEvent`, `ImmutableStreamEvent`                                                                                                                    | **deprecated** aliases; the plain names are deep-readonly now (P4) |
| `DeepReadonly<T>`                                                                                                                                                                                         | the mapped type every event type is built with (D9)                |
| `EventSeqSchema`, `AfterSeqSchema`, `ProcessedAtSchema`, `QueuedProcessedAtSchema`                                                                                                                        | the fields every stored event carries                              |
| `SendEventsRequestSchema`, `SendEventsResponseSchema`, `ListEventsQuerySchema`, `ListEventsResponseSchema`, `StreamEventsQuerySchema`, `StoredEventTypeSchema`, `DEFAULT_EVENT_ORDER`, `MAX_EVENT_DELTAS` | the events endpoints                                               |
| `TextBlockSchema`, `ContentBlockSchema`, `ContentBlocksSchema`                                                                                                                                            | message content                                                    |

P4 removed the stream-only half of the chunk vocabulary: `EventStartSchema`, `EventDeltaSchema`,
`StreamOnlyEventSchema`, `StreamOnlyEvent` and `STREAM_ONLY_EVENT_TYPES` are gone, and
`event_start` / `event_delta` exist only in the stored form (`StoredEventStartSchema` /
`StoredEventDeltaSchema`). The `z.infer`-shaped types stay inside the schemas; every exported
event **type** (`StoredEvent`, `StreamEvent`, the members, the domain sub-unions) is
`DeepReadonly<…>` now, so mutating a stored event is a compile error.

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

**Ids, pagination, constants**

| export                                                                                                                                                                              | what it is                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ID_PREFIXES`, `IdType`, `ULID_LENGTH`, `ulid()`, `isUlid()`                                                                                                                        | id building blocks: `agent_`, `sesn_`, `sevt_`, `pcred_` + ULID |
| `generateId()`, `newAgentId()`, `newSessionId()`, `newEventId()`, `newProviderCredentialId()`                                                                                       | generators                                                      |
| `parseId()` / `ParsedId`, `tryParseId()`, `isId()`, `isAgentId()`, `isSessionId()`, `isEventId()`, `isProviderCredentialId()`                                                       | parsing and validation                                          |
| `AgentIdSchema` / `AgentId`, `SessionIdSchema` / `SessionId`, `EventIdSchema` / `EventId`, `ProviderCredentialIdSchema` / `ProviderCredentialId`                                    | branded id schemas                                              |
| `PAGE_CURSOR_PREFIX`, `PageCursorSchema` / `PageCursor`, `SeqCursorSchema` / `SeqCursor`, `KeyCursorSchema` / `KeyCursor`, `PageCursorStringSchema`, `NextPageSchema`               | opaque pagination cursors: `seq` and keyset `key` positions     |
| `encodeSeqCursor()`, `encodeKeyCursor()`, `KeyCursorPosition`, `decodePageCursor()`, `tryDecodePageCursor()`, `isPageCursor()`                                                      | writing a cursor, and reading one back                          |
| `API_VERSION_PREFIX`, `ANTHROPIC_VERSION_HEADER`, `ANTHROPIC_BETA_HEADER`, `API_VERSION_DATE`, `LAST_EVENT_ID_HEADER`, `REQUEST_ID_HEADER`, `JSON_CONTENT_TYPE`, `SSE_CONTENT_TYPE` | the wire constants                                              |

| `DEFAULT_PARTITION_COUNT`, `partitionOf()` | session → partition ownership hash |
| `TimestampSchema`, `MetadataSchema`, `PageLimitSchema`, `ListOrderSchema`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`, `METADATA_MAX_PAIRS`, `METADATA_MAX_KEY_LENGTH`, `METADATA_MAX_VALUE_LENGTH` | shared scalars and limits |
| `PACKAGE_NAME` | the package name; lets a dependent prove the import resolved |

There is **no static-key header** any more: `API_KEY_HEADER` (`x-api-key`) was deleted in
#61, once its last importers were gone (epic #65, A8). Sign-in is Better Auth's, and the
headers that carry a session (a cookie for the web app, a bearer token for the CLI) are the
server's business, not this package's.

### `@openharness/protocol/fixtures`

Builders for every resource and event, and one realistic sample session.

| export                                                                                     | what it is                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `makeAgent()`, `makeSessionAgent()`, `makeSession()`                                       | resource builders; each takes `Partial<T>` overrides                                                                            |
| `makeUser()`, `makeProviderCredential()`                                                   | the signed-in user (a fixed opaque id) and credential metadata; never a secret                                                  |
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
- **Provider credentials:** write-only. `PUT /v1/provider-credentials/{provider}` takes
  `PutProviderCredentialRequestSchema` — a discriminated union on `type` with the single
  member `api_key` today, so `aws`, `gcp_service_account` and `azure` land later as new
  members — and answers `ProviderCredentialSchema`: metadata only, never the secret.
  `GET /v1/provider-credentials` lists that metadata for the caller's own credentials, and
  `DELETE /v1/provider-credentials/{provider}` answers 204. A credential that fails its
  validation call on save is a 422 `invalid_provider_credential`. A model request for a
  provider the owner has no credential for ends the turn with the non-retryable
  `missing_provider_credential` session error, whose message names the provider.
- **Ids:** a credential's `pcred_` id is this package's, so it is a ULID like the rest
  (`newProviderCredentialId()`); a user's id is Better Auth's — opaque, with no prefix of
  ours — and that is exactly what `owner_id` holds.

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
makes the types say so. D9 ran in four phases and this package finished in P4: what is
described here is the contract the packages code against today, not a transition. The rules,
and where each one lives:

- **Claims are events.** Three event types carry `consumes` — a `span.model_request_start`
  claims the `user.message`s its request folds in (and `model`, the `provider/model` that
  served it); a `span.model_request_end` claims the `user.interrupt`s that cut its request
  short; a `session.status_idle` claims the `user.interrupt`s a turn that had nothing running
  ended on. All three lists are optional in the schema only so logs stored before D9 keep
  parsing; `processed_at` on a user event is a value the store derives on read, never a column
  an update rewrites.
- **Streamed chunks are stored events.** `event_start` and `event_delta` keep their names and
  shapes (D2) and carry the stored envelope (`id`, `seq`, `processed_at`), so a reply in flight
  is resumable by `seq` like anything else. There is no stream-only form: the schemas and the
  `StreamOnlyEvent` union went with P4.
- **The event that finishes a reply supersedes its chunks.** The stored `agent.message` — and,
  for a request that ends without one (an interrupt, a `brain_lost` recovery, a reply that
  streamed no text), the `span.model_request_end` — carries `supersedes: { from_seq, to_seq }`,
  inclusive, `from_seq <= to_seq` enforced by the schema. Replay skips the range; the store
  deletes it after the retention window. Also optional, for the same pre-D9 reason: a reader
  without a range falls back to where the reply's preview opened.
- **Stored events are deep-readonly.** Every exported event type — `StoredEvent`,
  `StreamEvent`, each member, and the domain sub-unions (`UserEvent`, `AgentEvent`,
  `SessionEvent`, `SpanEvent`) — is `DeepReadonly<z.infer<…>>` of its schema, so `event.seq =
…` is a compile error everywhere. The `Immutable*` names remain as deprecated aliases of the
  readonly ones; `DeepReadonly` is exported too. The two response types that carry event
  arrays (`ListEventsResponse.data`, `SendEventsResponse.data`) are hand-written for this
  reason — a schema's inferred type cannot be readonly, and the read a client replays from has
  to be.
- **`isStoredEvent()` still checks `seq`.** Every event a P4 server delivers is stored, so the
  predicate is `true` for anything that parses; the runtime check stays because it is the
  honest test against a value that did not come from the schemas (a pre-D9 payload, say), and
  because it is what told the two chunk forms apart before P4. The `StreamEvent` union is the
  stored one.

## Deviations and extensions

Everything below is a deliberate difference from Anthropic's Managed Agents API. The `where`
column points at the definition in code; the same list appears in the TSDoc there.

### Extensions — things Anthropic does not have

| extension                                                              | where                                                   | why                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq` on every stored event                                            | `events/common.ts`, `EventSeqSchema`                    | Anthropic orders the log by `processed_at`, which is not monotonic across a crash and collides at millisecond resolution. `seq` is the ordering key, the pagination cursor and the SSE resume position. Starts at 1, +1 per event, per session.                                                                                        |
| `after_seq` on the events list and stream queries                      | `events/api.ts`                                         | Exact resume: `after_seq=0` reads from the start, `after_seq=<last seen seq>` re-reads nothing. Complements `page` and the `last-event-id` header.                                                                                                                                                                                     |
| `span.model_request_end.error`                                         | `events/span.ts`                                        | Anthropic only has `is_error`. The reason is needed to tell an interrupt (`interrupted`) from a lost brain (`brain_lost`) from a failed model request (`model_error`) — all three close a span without a normal reply.                                                                                                                 |
| `consumes` and `model` on `span.model_request_start`                   | `events/span.ts`                                        | Anthropic marks a user event processed out of band; openharness records the claim in the log: `consumes` lists the `user.message`/`user.interrupt` ids the request answers, `model` is the `provider/model` that served it (per request, so a mid-session model change stays visible). Optional only so a pre-D9 log keeps validating. |
| `consumes` on `span.model_request_end` and `session.status_idle`       | `events/span.ts`, `events/session.ts`                   | P4: an interrupt is answered by the event that ends the work it stopped — the open request's span end, or the turn's idle event when nothing was running — so the claim rides on that event instead of on a request opened for the interrupt. Optional, likewise, for pre-P4 logs.                                                     |
| `supersedes` on `agent.message` and `span.model_request_end`           | `events/common.ts`, `events/agent.ts`, `events/span.ts` | The `{ from_seq, to_seq }` chunk range the event replaces (D9): replay skips the range and a compaction job deletes it later. No Anthropic equivalent — Anthropic never stores the chunks.                                                                                                                                             |
| stored `event_start` / `event_delta`                                   | `events/stream.ts`                                      | Anthropic only streams the previews. openharness stores each chunk as a normal event (same `type` strings, plus `id`/`seq`/`processed_at`), which is what makes a reply in flight resumable by `seq`; `supersedes` compacts them away. Since P4 this is the only form.                                                                 |
| `user` resource and `GET /v1/me`                                       | `resources/user.ts`                                     | Anthropic has no user resource: its API is account-scoped by the key that calls it. openharness has real users (epic #65), and everything a caller does is scoped to the one `/v1/me` names.                                                                                                                                           |
| `owner_id` on `agent` and `session`                                    | `resources/agent.ts`, `resources/session.ts`            | Every agent and session belongs to exactly one user (A4): nothing is shared, another user's resource is a 404, and no request carries the field. **Required** since #61: the server sets it on everything it creates.                                                                                                                  |
| provider credentials (`pcred_`, the `/v1/provider-credentials` routes) | `resources/provider-credential.ts`, `ids.ts`            | Anthropic holds the model-provider keys; openharness users bring their own (A5). The API is write-only: the secret goes up, metadata comes back, and the credential store's other forms (`aws`, …) become new members of the request union.                                                                                            |
| `invalid_provider_credential` (422)                                    | `errors.ts`                                             | The one API error type without the `_error` suffix: a credential that failed validation on save (A5).                                                                                                                                                                                                                                  |
| `missing_provider_credential` session error                            | `events/session.ts`                                     | The owner has no stored credential for the model's provider, so the turn cannot make a model request. Non-retryable — the schema pins `retry_status` to `exhausted` — and the message names the provider.                                                                                                                              |

### Deviations — subsets and changed shapes

| deviation                                                                                              | where                         | Anthropic                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content blocks are text only: no `image`, `document`, `file` or `redacted` blocks                      | `content.ts`                  | user messages accept image/document/file blocks; agent messages may carry `redacted`                                                                                                                |
| `model` is `{ id }` only: no `effort`, `inference_geo`, `speed`                                        | `resources/agent.ts`          | `BetaManagedAgentsModelConfig`                                                                                                                                                                      |
| `model.id` is a **Mastra router string** (`provider/model`), not a bare Anthropic model id             | `resources/agent.ts`          | `"claude-sonnet-5"`                                                                                                                                                                                 |
| `stop_reason` is only `{ type: 'end_turn' }`                                                           | `events/session.ts`           | also `requires_action`, `retries_exhausted`, `budget_reached`                                                                                                                                       |
| `SessionStatus` is only `idle`/`running`                                                               | `resources/session.ts`        | also `rescheduling` and `terminated`; openharness models retries as `session.status_rescheduled` events                                                                                             |
| An agent has no `archived_at`, `mcp_servers`, `metadata`, `multiagent`, `skills`, `tools` or `version` | `resources/agent.ts`          | all present                                                                                                                                                                                         |
| A session agent snapshot is `{ id, name, model, system }`                                              | `resources/session.ts`        | `BetaManagedAgentsSessionAgent` also carries `description`, `mcp_servers`, `skills`, `tools`, `version`                                                                                             |
| `initial_events` accepts user events (`user.message`, `user.interrupt`); at most 50                    | `resources/session.ts`        | only `user.message` and `user.define_outcome`                                                                                                                                                       |
| `POST /v1/sessions` takes an `agent` **id string**; no inline agent reference or per-session overrides | `resources/session.ts`        | `string`, `{ type: 'agent', id, version? }` or `{ type: 'agent_with_overrides', ... }`                                                                                                              |
| `event_deltas[]` accepts `agent.message` only                                                          | `events/stream.ts`            | also `agent.thinking` (start-only)                                                                                                                                                                  |
| No system events (`system.message`), tools, MCP, outcomes, multiagent threads, budgets or webhooks     | everything                    | all present in the beta                                                                                                                                                                             |
| `GET /v1/sessions` takes only `limit`, `page` and `agent_id`; `GET /v1/agents` only `limit` and `page` | `resources/`                  | sessions also take `agent_version`, `created_at[gt]`-style bounds, `deployment_id`, `include_archived`, `memory_store_id` and `statuses`; agents also take `created_at[...]` and `include_archived` |
| `processed_at` is written as an explicit `null` on a queued user event rather than omitted             | `events/common.ts`            | `optional string or null`                                                                                                                                                                           |
| `content_delta.index` may be omitted, and parses as `0`                                                | `events/stream.ts`            | `index: optional number`; Anthropic's own accumulator reads a missing index as 0                                                                                                                    |
| `request_id` in the error envelope is optional here                                                    | `errors.ts`                   | Anthropic always includes it; a proxy or a pre-app error may not have one to report                                                                                                                 |
| `data` and `next_page` are required in every list response                                             | `events/api.ts`, `resources/` | Anthropic's generated spec marks both `optional`; openharness always writes them, and `next_page: null` is how "no more pages" is spelled                                                           |
| Unknown **fields** are stripped, not rejected, by every object schema                                  | everywhere                    | —                                                                                                                                                                                                   |

Stripping unknown fields is what lets a real Anthropic response (which carries `effort`,
`archived_at`, `skills`, ...) parse cleanly against the v1 subset. Two things are still
rejected: unknown **event types** — the unions are closed — and a response missing a field
the envelope is required to carry.

## How to add a new event type

Event types are the part of this package that grows most often. Adding one touches five
places, in this order:

1. **Name it** in `EVENT_TYPES` (`src/events/common.ts`). `{domain}.{action}`, matching
   Anthropic's spelling exactly. Add it to `STORED_EVENT_TYPES` — every event a server emits
   is stored; the stream-only list was removed in P4.
2. **Define the schema** in the file for its domain (`user.ts`, `agent.ts`, `session.ts`,
   `span.ts`). Build it from `EventIdSchema`, `EventSeqSchema` and the `processed_at` schema
   that matches who writes it — `QueuedProcessedAtSchema` for user events, `ProcessedAtSchema`
   for anything the server produces. Add `// extension:` to any field Anthropic does not have.
3. **Add it to the domain union** at the bottom of the same file, then to `StoredEventSchema`
   and `StreamEventSchema` in `union.ts`. A stored type that reuses a `type` string an
   existing member already has cannot go _inside_ the discriminated union — zod throws on a
   duplicate discriminator value when it parses — so it is added to the surrounding
   `z.union` instead, the way the stored chunks are.
4. **Add a builder** in `src/fixtures/index.ts` and a valid sample to `storedSamples` in
   `src/events/events.test.ts` — that table is asserted against `STORED_EVENT_TYPES`, so a
   type without a sample fails the suite.
5. **Document it**: the `EVENT_TYPES` entry is the documentation for the wire; put the
   semantics in the schema's TSDoc, and extend the sample history in the fixtures if the new
   type belongs in a realistic turn.

Then run the package commands above. If the new type is a `types[]` filter value it is picked
up automatically through `StoredEventTypeSchema`.

## Allowed `@openharness/*` dependencies

None. This package must stay free of `@openharness/*` dependencies.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

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
