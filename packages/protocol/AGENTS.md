# @openharness/protocol

The shared protocol between brain, session, hands and the frontends: the wire types and
schemas every package agrees on. It defines the HTTP API, the session event log, the error
envelope, ids and pagination — and nothing else. No I/O, no state, `zod` as the only runtime
dependency.

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
  pagination.ts         page cursors (encode / decode)
  errors.ts             the Anthropic error envelope, error types and status codes
  content.ts            message content blocks (text only in v1)
  resources/
    agent.ts            the agent resource + its endpoints
    session.ts          the session resource + its endpoints
  events/
    common.ts           the event vocabulary and the fields every stored event carries
    user.ts             user.message, user.interrupt (+ the shapes a client sends)
    agent.ts            agent.message
    session.ts          status events, session.error, stop_reason
    span.ts             span.model_request_start / _end, model_usage
    stream.ts           stream-only event_start / event_delta
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
| `AgentSchema` / `Agent`                                                                                   | the `agent` resource                                            |
| `CreateAgentRequestSchema`, `UpdateAgentRequestSchema`                                                    | bodies of `POST /v1/agents`, `POST /v1/agents/{agent_id}`       |
| `ListAgentsQuerySchema`, `ListAgentsResponseSchema`                                                       | `GET /v1/agents`                                                |
| `ModelConfigSchema` / `ModelConfig`                                                                       | `{ id }`, where `id` is a Mastra router string `provider/model` |
| `SessionSchema` / `Session`, `SessionAgentSchema` / `SessionAgent`                                        | the `session` resource and its agent snapshot                   |
| `SessionStatusSchema`, `StopReasonSchema`                                                                 | `idle`/`running`; `{ type: 'end_turn' }`                        |
| `CreateSessionRequestSchema`, `ListSessionsQuerySchema`, `ListSessionsResponseSchema`                     | the sessions endpoints                                          |
| `AGENT_NAME_MAX_LENGTH`, `AGENT_DESCRIPTION_MAX_LENGTH`, `SESSION_TITLE_MAX_LENGTH`, `MAX_INITIAL_EVENTS` | limits Anthropic documents                                      |

**Events**

| export                                                                                                                                                                                                    | what it is                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `EVENT_TYPES`, `STORED_EVENT_TYPES`, `STREAM_ONLY_EVENT_TYPES`, `EventType`, `StoredEventType`                                                                                                            | the vocabulary as constants and types            |
| `UserMessageEventSchema`, `UserInterruptEventSchema`, `UserEventSchema`                                                                                                                                   | stored user events                               |
| `UserMessageEventInputSchema`, `UserInterruptEventInputSchema`, `UserEventInputSchema`                                                                                                                    | the same shapes as a client sends them           |
| `AgentMessageEventSchema`, `AgentEventSchema`                                                                                                                                                             | stored agent events                              |
| `SessionStatusRunningEventSchema`, `SessionStatusIdleEventSchema`, `SessionStatusRescheduledEventSchema`, `SessionErrorEventSchema`, `SessionEventSchema`                                                 | stored session events                            |
| `SessionErrorSchema`, `SessionErrorTypeSchema`, `RetryStatusSchema`, `RetryStatusTypeSchema`                                                                                                              | the typed `session.error` payload                |
| `ModelRequestStartEventSchema`, `ModelRequestEndEventSchema`, `ModelUsageSchema`, `SpanEventSchema`, `SpanErrorSchema`, `SpanErrorTypeSchema`                                                             | span events, usage, and the span error extension |
| `EventStartSchema`, `EventDeltaSchema`, `ContentDeltaSchema`, `DeltaTypeSchema`, `StreamOnlyEventSchema`                                                                                                  | stream-only previews                             |
| `StoredEventSchema` / `StoredEvent`, `StreamEventSchema` / `StreamEvent`, `isStoredEvent()`                                                                                                               | the unions everything else codes against         |
| `EventSeqSchema`, `AfterSeqSchema`, `ProcessedAtSchema`, `QueuedProcessedAtSchema`                                                                                                                        | the fields every stored event carries            |
| `SendEventsRequestSchema`, `SendEventsResponseSchema`, `ListEventsQuerySchema`, `ListEventsResponseSchema`, `StreamEventsQuerySchema`, `StoredEventTypeSchema`, `DEFAULT_EVENT_ORDER`, `MAX_EVENT_DELTAS` | the events endpoints                             |
| `TextBlockSchema`, `ContentBlockSchema`, `ContentBlocksSchema`                                                                                                                                            | message content                                  |

**Errors**

| export                                                                                        | what it is                                                 |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `ApiErrorBodySchema` / `ApiErrorBody`, `ApiErrorSchema` / `ApiError`, `ApiErrorTypeSchema`    | the `{ type: 'error', error: { type, message } }` envelope |
| `API_ERROR_TYPES`, `API_ERROR_STATUS_BY_TYPE`, `httpStatusForErrorType()`, `isApiErrorType()` | error types and their HTTP statuses                        |
| `apiErrorBody()`                                                                              | build a body for the wire                                  |

**Ids, pagination, constants**

| export                                                                                                                                                                                                | what it is                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ID_PREFIXES`, `IdType`, `ULID_LENGTH`, `ulid()`, `isUlid()`                                                                                                                                          | id building blocks: `agent_`, `sesn_`, `sevt_` + ULID        |
| `generateId()`, `newAgentId()`, `newSessionId()`, `newEventId()`                                                                                                                                      | generators                                                   |
| `parseId()` / `ParsedId`, `tryParseId()`, `isId()`, `isAgentId()`, `isSessionId()`, `isEventId()`                                                                                                     | parsing and validation                                       |
| `AgentIdSchema` / `AgentId`, `SessionIdSchema` / `SessionId`, `EventIdSchema` / `EventId`                                                                                                             | branded id schemas                                           |
| `PAGE_CURSOR_PREFIX`, `PageCursorSchema`, `PageCursorStringSchema`, `NextPageSchema`, `encodePageCursor()`, `decodePageCursor()`, `tryDecodePageCursor()`, `isPageCursor()`                           | opaque pagination cursors                                    |
| `API_VERSION_PREFIX`, `API_KEY_HEADER`, `ANTHROPIC_VERSION_HEADER`, `ANTHROPIC_BETA_HEADER`, `API_VERSION_DATE`, `LAST_EVENT_ID_HEADER`, `REQUEST_ID_HEADER`, `JSON_CONTENT_TYPE`, `SSE_CONTENT_TYPE` | the wire constants                                           |
| `DEFAULT_PARTITION_COUNT`, `partitionOf()`                                                                                                                                                            | session → partition ownership hash                           |
| `TimestampSchema`, `MetadataSchema`, `PageLimitSchema`, `ListOrderSchema`, `DEFAULT_PAGE_LIMIT`, `MAX_PAGE_LIMIT`, `METADATA_MAX_PAIRS`, `METADATA_MAX_KEY_LENGTH`, `METADATA_MAX_VALUE_LENGTH`       | shared scalars and limits                                    |
| `PACKAGE_NAME`                                                                                                                                                                                        | the package name; lets a dependent prove the import resolved |

### `@openharness/protocol/fixtures`

Builders for every resource and event, and one realistic sample session.

| export                                                                                     | what it is                                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `makeAgent()`, `makeSessionAgent()`, `makeSession()`                                       | resource builders; each takes `Partial<T>` overrides                                                                                  |
| `makeUserMessage()`, `makeUserInterrupt()`, `makeAgentMessage()`                           | message and interrupt builders                                                                                                        |
| `makeStatusRunning()`, `makeStatusIdle()`, `makeStatusRescheduled()`, `makeSessionError()` | session status builders                                                                                                               |
| `makeModelRequestStart()`, `makeModelRequestEnd()`                                         | span builders; the end builder takes the start it closes                                                                              |
| `makeEventStart()`, `makeEventDelta()`, `makeContentDelta()`                               | stream-preview builders                                                                                                               |
| `fixtureTimestamp()`, `FIXTURE_MODEL_USAGE`                                                | a fixed epoch offset by seconds; default token counts                                                                                 |
| `sampleAgent`, `sampleSession`                                                             | one of each resource                                                                                                                  |
| `sampleSessionHistory`                                                                     | a full turn, a steering message, an interrupt, a retried error, and a queued message — 32 events, `seq` 1..32                         |
| `sampleStreamPreview`                                                                      | the live view of that history's first `agent.message`: `event_start`, its deltas, then the stored event — same `sevt_` id, same `seq` |

The event builders allocate a running `seq` and a fresh `sevt_` id; pass `seq` or `id` in the
overrides for a specific one. They construct plain typed values rather than calling `.parse()`,
so a test can assert that what a builder produces really does parse against the schemas.

## Deviations and extensions

Everything below is a deliberate difference from Anthropic's Managed Agents API. The `where`
column points at the definition in code; the same list appears in the TSDoc there.

### Extensions — things Anthropic does not have

| extension                                         | where                                | why                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq` on every stored event                       | `events/common.ts`, `EventSeqSchema` | Anthropic orders the log by `processed_at`, which is not monotonic across a crash and collides at millisecond resolution. `seq` is the ordering key, the pagination cursor and the SSE resume position. Starts at 1, +1 per event, per session. |
| `after_seq` on the events list and stream queries | `events/api.ts`                      | Exact resume: `after_seq=0` reads from the start, `after_seq=<last seen seq>` re-reads nothing. Complements `page` and the `last-event-id` header.                                                                                              |
| `span.model_request_end.error`                    | `events/span.ts`                     | Anthropic only has `is_error`. The reason is needed to tell an interrupt (`interrupted`) from a lost brain (`brain_lost`) from a failed model request (`model_error`) — all three close a span without a normal reply.                          |

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
   Anthropic's spelling exactly. Add it to `STORED_EVENT_TYPES` (or
   `STREAM_ONLY_EVENT_TYPES` if it must never be persisted).
2. **Define the schema** in the file for its domain (`user.ts`, `agent.ts`, `session.ts`,
   `span.ts`). Build it from `EventIdSchema`, `EventSeqSchema` and the `processed_at` schema
   that matches who writes it — `QueuedProcessedAtSchema` for user events, `ProcessedAtSchema`
   for anything the server produces. Add `// extension:` to any field Anthropic does not have.
3. **Add it to the domain union** at the bottom of the same file, then to `StoredEventSchema`
   and `StreamEventSchema` in `union.ts`.
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
