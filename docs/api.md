# The API, at a glance

openharness speaks an Anthropic-shaped API: a session is the durable log a conversation
happens in, it is created from a **model**, and everything that happens is an event in that
log. An **agent** is an optional preset — a name, a model and a system prompt — that a
session can be created from instead. This
page is the map. The shapes themselves live in
[`packages/protocol`](../packages/protocol/AGENTS.md) — every request and response below is
validated by a schema from there — and the server's behaviour is in
[`apps/server/AGENTS.md`](../apps/server/AGENTS.md).

Base URL: `/v1`. Errors are the Anthropic envelope everywhere:

```json
{
  "type": "error",
  "error": { "type": "not_found_error", "message": "no session with id sesn_…" },
  "request_id": "req_01H…"
}
```

## Life

```bash
curl -X POST localhost:3000/v1/agents \
  -H 'content-type: application/json' \
  -d '{"name":"Summarizer","model":{"id":"anthropic/claude-sonnet-5"},"system":"Be brief."}'

# A session from a model: chatting does not need an agent.
curl -X POST localhost:3000/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"model":{"id":"anthropic/claude-sonnet-5"}}'

# Or from an agent preset, optionally overriding its model or system prompt.
curl -X POST localhost:3000/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"agent":"agent_01H…"}'

curl -X POST localhost:3000/v1/sessions/sesn_01H…/events \
  -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Hi"}]}]}'

curl -N localhost:3000/v1/sessions/sesn_01H…/events/stream?event_deltas[]=agent.message
```

The POST stores the message and answers immediately; the brain runs in the background and the
stream carries what it does. `user.interrupt` is the same call with
`{"type":"user.interrupt"}`, and it aborts the turn in flight. The same array may carry one
instruction that is not the user's own event — `{"type":"session.rewind","from_seq":1}`
(#238), "edit and resend" — which restarts the session from that message and is refused with
`409 conflict_error` while a turn is running. Such a batch takes **at most one rewind, and
only as its first event**; anything else is a 400 `invalid_request_error` (see
[Claims, chunks and superseding](#claims-chunks-and-superseding-d9)).

**Creating a session.** `POST /v1/sessions` takes a `model`, an `agent`, or both, and at least
one of the two: a request that names neither is refused with a 400 `invalid_request_error`. An
inline `model.id` must have the router's `provider/model` shape — two or more non-empty
slash-separated parts — or the request is a 400 too; it is a shape check, not a catalogue
lookup, because the router accepts models the catalog does not know yet. What the session
_runs_ is one model and one system prompt — with an agent, its configuration is copied, and an
explicit `model` or `system` in the request overrides it (per field); without one, `model` is
required and `system` defaults to `null`. The session the API answers with carries that
effective configuration as `model` and `system` (always set), and `agent` — the preset it was
created from, `{ id, name, model, system }` — or `null` for a model-first session. The snapshot
is never rewritten: editing an agent changes no session that already exists. Creating a session
never calls a provider and never needs a stored credential: a key the owner lacks is reported
when a turn runs, as the brain's `missing_provider_credential` `session.error`.

The first `user.message` a session is sent also names it: the session's `title` — `null` until
then — becomes the message's first non-empty line, whitespace collapsed and cut to
`SESSION_TITLE_MAX_LENGTH`, so a list of chats shows what each one is about rather than the
agent's name. That happens once. A title passed to `POST /v1/sessions`, and one an earlier
message produced, is never overwritten; a session created with `initial_events` is named the
same way, in the same request.

**Deleting a session.** `DELETE /v1/sessions/{session_id}` answers `204` and takes the session
and its whole log with it — events, claims, supersessions, everything keyed by it. It is
irreversible and owner-scoped: another user's session answers `404`, exactly as it does
everywhere else. A running turn is stopped first, so nothing keeps writing to a log that is
gone, and every open stream for the session receives one final `session.deleted` frame and
closes. This is the one deliberate exception to the append-only log besides compaction — and
the only way an event is ever removed together with its session.

## Routes

| method   | path                                      | what it does                                                                                    |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                                 | liveness — always `{ status: 'ok' }` while the process lives; open                              |
| `GET`    | `/ready`                                  | readiness — `{ status: 'ok' }`, or `503` while draining or when the store does not answer; open |
| `GET`    | `/v1/auth-config`                         | unauthenticated: which providers are on, and whether dev login is                               |
| `GET`    | `/v1/me`                                  | the signed-in user                                                                              |
| `GET`    | `/v1/me/preferences`                      | the caller's preferences — the default model, the web theme and the context settings            |
| `PUT`    | `/v1/me/preferences`                      | merge fields in; model ids, four theme names, the compaction share and pass limit               |
| `POST`   | `/v1/me/modes`                            | create a mode; `409` for a duplicate name or the twenty-first mode                              |
| `GET`    | `/v1/me/modes`                            | list the caller's modes, oldest first (no cursor: at most 20)                                   |
| `GET`    | `/v1/me/modes/{mode_id}`                  | read one mode                                                                                   |
| `POST`   | `/v1/me/modes/{mode_id}`                  | update a mode; omitted fields keep their value, `null` clears one                               |
| `DELETE` | `/v1/me/modes/{mode_id}`                  | delete one; answers `204`, and the chats that followed it keep their last model                 |
| `POST`   | `/v1/agents`                              | create an agent                                                                                 |
| `GET`    | `/v1/agents`                              | list agents, oldest first                                                                       |
| `GET`    | `/v1/agents/{agent_id}`                   | read one agent                                                                                  |
| `POST`   | `/v1/agents/{agent_id}`                   | update an agent; sessions already created keep their snapshot                                   |
| `POST`   | `/v1/sessions`                            | create a session from a model and/or an agent (at least one)                                    |
| `GET`    | `/v1/sessions`                            | list sessions, newest first (`agent_id` filters)                                                |
| `GET`    | `/v1/sessions/{session_id}`               | read one session                                                                                |
| `DELETE` | `/v1/sessions/{session_id}`               | delete it and its whole log; answers `204` with no body                                         |
| `POST`   | `/v1/sessions/{session_id}/events`        | append user events; the server owns every other event type                                      |
| `GET`    | `/v1/sessions/{session_id}/events`        | read the log, with `types[]`, `after_seq`, `limit` and `page`                                   |
| `GET`    | `/v1/sessions/{session_id}/events/stream` | follow it live over SSE; `event_deltas[]` opts into a reply's chunks                            |
| `POST`   | `/v1/sessions/{session_id}/compact`       | ask for a manual compaction; optional `instructions` (epic #277, K8; #283)                      |
| `POST`   | `/v1/sessions/{session_id}/ai-sdk/chat`   | AI SDK `useChat` compatibility — an extension, not the protocol                                 |
| `PUT`    | `/v1/provider-credentials/{name}`         | add or replace one of the caller's credentials, under that name (write-only)                    |
| `GET`    | `/v1/provider-credentials`                | list the caller's credential metadata; never the secrets                                        |
| `DELETE` | `/v1/provider-credentials/{name}`         | delete one; answers `204` with no body                                                          |
| `GET`    | `/v1/models`                              | the chat models the caller's own keys can use, with per-provider status                         |
| `GET`    | `/v1/sessions/{session_id}/usage`         | what one session spent: totals, cost, and the per-model breakdown                               |
| `GET`    | `/v1/me/usage`                            | what the caller spent between two local days (`from`, `to`, `tz`): by model and by day          |

Every `/v1` resource belongs to the caller and is scoped to them.

Paginated lists answer `{ data, next_page }` — `next_page` is an opaque cursor handed back as
`page`, and `null` means there is nothing more. The credential list and the model catalog have
no cursor: `/v1/provider-credentials` answers `{ data }` and `/v1/models` `{ data, providers }`,
both bounded by the caller's own keys.

## Events

The log is the source of truth, and `seq` is the order it happened in: `1`, `2`, `3`, per
session. It is also the SSE `id` and the resume position, so a client that reconnects with
`last-event-id: 7` gets `8` next — never `7` twice, never a gap.

| event                              | who writes it | what it means                                                                           |
| ---------------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| `user.message`                     | the client    | a message, until the brain claims it                                                    |
| `user.interrupt`                   | the client    | stop the turn in flight                                                                 |
| `agent.message`                    | the brain     | a reply, under the `sevt_` id its chunks announced                                      |
| `agent.tool_use`                   | the brain     | the model asked for a tool — its own id is the call's id (#304)                         |
| `agent.tool_result`                | the brain     | what the call produced, or why it did not — always written by the brain (#304)          |
| `session.status_running`           | the brain     | a turn started (also after a retry)                                                     |
| `session.status_idle`              | the brain     | the turn ended; the session is waiting for input                                        |
| `session.status_rescheduled`       | the brain     | a transient failure; it is retrying                                                     |
| `session.error`                    | the brain     | what went wrong, and whether it is retrying — `missing_provider_credential` never is    |
| `span.model_request_start`         | the brain     | a model request began, the messages it claims, and the effort it ran at                 |
| `span.model_request_end`           | the brain     | it finished — usage, any error, the interrupts it ends                                  |
| `event_start`                      | the brain     | a reply started streaming — a stored chunk since D9                                     |
| `event_delta`                      | the brain     | a streamed fragment of it — a stored chunk since D9                                     |
| `session.usage`                    | the brain     | the session's running token totals, per model, after a request that reported usage      |
| `session.context_summary`          | the brain     | // extension: older history replaced for the model by a summary (epic #277, #278)       |
| `session.context_summary_progress` | the brain     | // extension: a summary is being written — which pass is running (#279)                 |
| `session.compact`                  | the server    | // extension: the user asked for a manual compaction, `/compact [instructions]` (#283)  |
| `session.compaction`               | the brain     | // extension: what came of it — `summarized`, `nothing_to_summarize` or `failed` (#283) |
| `session.rewind`                   | the server    | // extension: the session restarts from an earlier `user.message` (#238)                |
| `session.deleted`                  | the server    | stream-only: the session was deleted; sent last, then the stream closes (#111)          |

A `user.message` may also carry a `model` (`{ "id": "provider/model" }`): it switches the
model the session runs from that message on, and the session keeps running it until another
message changes it (epic #116, U3). The switch is stored on the message — the log stays the
source of truth — and each `span.model_request_start` still records the model its request
actually used.

It may carry a `reasoning_effort` (`"low"`, `"medium"` or `"high"`) the same way: the effort
the session runs at from that message on, until another message changes it or clears it with
`null` — which is the provider's default, and what a message that leaves the field out keeps
(#252). The brain maps the effort onto each provider's own knob, and a model that takes no
effort — or one the server's model catalogue does not know takes one — runs the provider's
default instead; a level a model does not take is sent as the nearest one it does. Either way
the request's `span.model_request_start` records what it was asked for and what it ran with:

```json
{
  "type": "span.model_request_start",
  "id": "sevt_…",
  "seq": 3,
  "processed_at": "…",
  "consumes": ["sevt_…"],
  "model": "openai/o4-mini",
  "reasoning_effort": { "requested": "high", "applied": "high" }
}
```

`applied` is `null` when the model took none — an effort asked for and not applied — and the
field is absent entirely for a session that never set one, which is every session stored
before #252.

### Tools (epic #303)

A model request may be given tools. When it asks for one, the model's call is an event of its
own and so is the loop's answer, so a replay shows exactly what was asked for, what ran, and
what came back:

```json
{ "type": "agent.tool_use",    "id": "sevt_…", "seq": 4, "processed_at": "…",
  "name": "web_fetch", "input": { "url": "https://example.com" },
  "evaluated_permission": "allow" }
{ "type": "agent.tool_result", "id": "sevt_…", "seq": 5, "processed_at": "…",
  "tool_use_id": "sevt_…", "content": [{ "type": "text", "text": "…" }], "is_error": false }
```

- **The call's id is the event's id.** `agent.tool_result.tool_use_id` names the
  `agent.tool_use` it answers, and a turn that finds a call with no result knows exactly which
  execution was lost.
- **Only the brain writes a result.** A client never does — a call the model made is answered
  once, by the loop that ran it: with what the tool produced, or with an `is_error` result
  saying why it did not run or did not finish (`Permission to use … has been denied.`,
  `Tool … timed out`, `Interrupted by the user.`, or `execution lost` for a call a crashed turn
  never ran).
- **`evaluated_permission` is what the policy said about that call** — `allow`, `ask` or
  `deny`, the same vocabulary Anthropic uses. `deny` refuses the call without running it;
  `ask` is the pausing half, which arrives with #309, so nothing produces it yet.
- **The tools a request offered are recorded on its span.** `span.model_request_start.tools`
  is a `{ name, source }` per offered tool — `builtin` today, `mcp` with #312 — so the log says
  what the model could have called, not only what it did. A request with no tools writes none.
- **Input is not streamed and a result's content is text.** The call is stored when it is
  complete, and a result carries text blocks. The loop itself is bounded: at most
  `OPENHARNESS_MAX_TOOL_STEPS` model requests per turn (50 by default), after which the turn
  ends with a `session.error` of type `tool_steps_exhausted_error` rather than retrying.
- **A tool is never re-run.** A brain that inherits a call with no result writes an `is_error`
  result for it and lets the model decide what to do next.
- **A model that cannot call tools is offered none.** `GET /v1/models` reports each model's
  `tool_call`, and a model whose registry entry says `false` chats exactly as it did before
  tools existed.

The tools this build offers (epic #303, [#305](https://github.com/amirtuval/openharness/issues/305))
are `builtin` ones — a call's `input` is the JSON object below, and the result is text:

| tool         | input                                                    | what it does                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web_fetch`  | `{ "url": "https://…" }`                                 | GETs one `http`/`https` URL through the SSRF guard (every redirect hop re-checked) and answers its main content as Markdown. Text and JSON pass through; anything else is an error.                                                   |
| `web_search` | `{ "query": "…", "count": 5 }`                           | One search of the deployment's search API, as titles, URLs and snippets. **Offered only where an operator configured a provider**; each user has a daily allowance of searches, and a call over it is an `is_error` result saying so. |
| `todo_write` | `{ "todos": [{ "content": "…", "status": "pending" }] }` | Replaces the model's whole task list. The list is the newest successful call's own input — nothing is stored beside it — and `readTodoList` in `@openharness/protocol` reads it back out of a log.                                    |

A `web_fetch` result **leads with the address it finally came from** and says the content is
untrusted data from the web, not instructions: it is the one tool whose text arrives from a
place nobody in this deployment chose, and the log records that the model was told so.

`session.usage` is the session's **running** totals, written by the brain in the same append as
the `span.model_request_end` that closes a request which reported usage — so a client watching
a turn reads the session's cost off the stream instead of adding the spans up itself:

```json
{
  "type": "session.usage",
  "id": "sevt_…",
  "seq": 10,
  "processed_at": "…",
  "input_tokens": 1076,
  "output_tokens": 64,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "models": [
    {
      "model": "anthropic/claude-sonnet-5",
      "usage": {
        "input_tokens": 1076,
        "output_tokens": 64,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0
      },
      "requests": 2
    }
  ]
}
```

The four counters beside `models` are that breakdown's sum, and the schema refuses an event
where they disagree. Each entry also carries `requests` — how many model requests ran on that
model so far — which is a fact about the log rather than about money. **It carries no cost**:
money is computed when it is read, from these tokens and the model catalog's prices, and is
never stored (see [Usage and cost](#usage-and-cost)). A session stored before the event existed
has none, and its totals are derived on read from the `span.model_request_end` events it does
have — the same numbers, from the events underneath.

### Context summaries and oversized messages (epic #277)

When a chat's context fills, the brain summarizes the older history and continues from the
summary plus the recent messages verbatim, instead of dropping the oldest messages. The summary
is an **event** — `session.context_summary`, written by the brain — and it **supersedes
nothing**: the log, the transcript and replay stay whole, and the only reader is the context
strategy, which builds each model request as the system prompt, then the latest summary no
rewind has superseded, then every event after `covers.to_seq`.

```json
{
  "type": "session.context_summary",
  "id": "sevt_…",
  "seq": 42,
  "processed_at": "…",
  "summary": "The user asked for the README summary; the license is MIT.",
  "covers": { "to_seq": 40 },
  "reason": "threshold",
  "tokens_before": 51200,
  "summary_model": "anthropic/claude-sonnet-5",
  "prompt_version": "compact-v1",
  "passes": 1
}
```

`reason` is `threshold` (the context reached the share of the model's budget that triggers a
summary), `overflow` (the provider refused a request as too long) or `manual` (the user asked
for it). `tokens_before` is how full the context was, and `summary_model`, `prompt_version` and
`passes` record what wrote the summary and how — with an optional `fallback_reason` when the
chat's own model summarized instead of the summary model the user chose (no credential for it,
or it would have needed more passes than the limit allows). A `session.rewind` that reaches back
before a summary supersedes it along with the rest of the tail it covered, so it disappears from
what the model sees the same way the messages it replaced do — while the transcript, which never
read the summary in the first place, is unchanged.

**Where the trigger is, and how big the tail is.** The engine runs in the brain at each request
boundary, before the request: it measures the context the request is about to make from the
previous request's real prompt size plus an estimate of what is new, and compares it against
`OPENHARNESS_COMPACTION_THRESHOLD` (default `0.7`) of the **chat** model's context budget. Over
it, the older history is summarized with the recent quarter of the budget kept verbatim, cut at a
`user.message` boundary so no turn is split. A provider that still refuses a request as too long
gets one more attempt after a tighter compaction; if that fails too the turn ends with
`session.error { retry_status: "exhausted" }` rather than looping — and the message says which
of the three things happened, so an error never claims a compaction that the engine, finding
nowhere to cut or failing, did not make. A summarizer that fails ends
nothing: the failure is recorded on its own span and the request goes out with the usual trimming
as the safety net.

**The share, the model and the pass limit are the session owner's**
([`/v1/me/preferences`](#preferences), issue #282): the server resolves them per request from
the owner's stored preferences, over the deployment's `OPENHARNESS_COMPACTION_THRESHOLD` and
the engine's own defaults, so a change in Settings applies from the next request on and one
user's choices never reach another's chat. A chosen summary model many times smaller than the
chat model's needs more passes than the limit allows and the chat model summarizes instead —
the settings surfaces say so in advance, from the same arithmetic the engine plans with.

**The summary is written in passes, and each one is a model request.** A long history is folded
in slices sized to the summary model's budget, each pass updating the one before, and every pass
is recorded as a `span.model_request_start`/`span.model_request_end` pair with
`purpose: "summary"` — so the tokens and cost of summarizing appear in the session's
`session.usage` like any other request, while the size accounting refuses such a span as the
baseline for the chat's own context. Because everything a client is shown lives in the log, each
pass starts with a stored progress event:

```json
{
  "type": "session.context_summary_progress",
  "id": "sevt_…",
  "seq": 43,
  "processed_at": "…",
  "pass": 2,
  "passes": 3
}
```

`pass` is the pass starting (from 1) and `passes` how many the plan holds, so a client can show
"summarizing (2/3)". The event is the brain's bookkeeping like the summary itself: it is never
claimed, the transcript and replay do not show it, and the context strategy ignores it.

**A user can ask for it on demand — `/compact [instructions]`.** `POST /v1/sessions/{id}/compact`
takes an optional `instructions` string (at most `COMPACT_INSTRUCTIONS_MAX_LENGTH`, 2000
characters) and stores a `session.compact` request — a client-requested event like
`session.rewind`, written by the server, not queued and never claimed:

```json
// POST /v1/sessions/{id}/compact  { "instructions": "keep the API decisions in detail" }
// → 200 { "data": { "type": "session.compact", "id": "sevt_…", "seq": 44,
//                   "processed_at": "…", "instructions": "keep the API decisions in detail" } }
```

The brain answers it with a `session.compaction` — always, whatever came of the run — and folds
the guidance into the summarizer's prompt as the user's own instruction:

```json
{
  "type": "session.compaction",
  "id": "sevt_…",
  "seq": 46,
  "processed_at": "…",
  "outcome": "summarized",
  "instructions": "keep the API decisions in detail",
  "summary_seq": 45
}
```

`outcome` is `summarized` (a `session.context_summary` with `reason: "manual"` was written, and
`summary_seq` points at it), `nothing_to_summarize` (there was no older history to fold — a short
chat, or nothing before the newest turn) or `failed` (the summarizer failed; the chat carries on
with the usual trimming). `instructions` echoes the request's guidance when it had any. It is the
clear, stored outcome a client shows — a manual compaction is never a silent no-op.

The request is answered **at a request boundary**: a turn already running folds it in at its next
request, and a session that is idle gets a turn of its own that answers the request and makes no
model reply. Repeating the call while a request is still waiting is the same request, not a
second — the route reads the log to decide, and returns the pending event. The instructions
bound the guidance a reader can give; a longer string is the protocol's `400` and nothing is
stored.

**A message too big to send is shortened, never dropped.** If the newest message alone is over
the chat model's budget, summarizing cannot help — that message has to stay verbatim — so the
request carries it capped to a head and a tail with an `[… N tokens omitted …]` marker, and the
request's `span.model_request_start` records it:

```json
{
  "type": "span.model_request_start",
  "id": "sevt_…",
  "seq": 43,
  "processed_at": "…",
  "consumes": ["sevt_…"],
  "model": "anthropic/claude-sonnet-5",
  "truncated": { "seq": 41, "tokens_before": 40000, "tokens_after": 30000 }
}
```

`seq` names the event whose text was cut, and the two counts bracket what it cost before and
after — so a client can tell the user their message was shortened rather than let it silently
disappear. The field is absent for every request whose newest message fits.

**The token counters are disjoint, and that is what `usage` prices.** `ModelUsage.input_tokens`
is the **uncached** input (the way Anthropic's own `input_tokens` reads) and the two cache
counters are the cached halves, so summing the three input-side counters answers the real prompt
size a request was made with. A provider whose API reports a cache-inclusive input — OpenAI's
`prompt_tokens`, a Gemini `promptTokenCount` — is normalized on the way into the log, so the
same arithmetic is right for every provider; a provider whose `input_tokens` leaves cached tokens
out is not double-counted either. This is the measure the compaction trigger compares against the
model's budget, and a request the compaction engine made to summarize carries
`purpose: "summary"` on its span so it is never used as the baseline for the chat's own size.

### Claims, chunks and superseding (D9)

The log is immutable: once an event is appended no field of it changes. There are exactly two
deletions — compaction, and deleting a whole session ([issue #46](https://github.com/amirtuval/openharness/issues/46),
[#111](https://github.com/amirtuval/openharness/issues/111)) — and everything else is
append-only. The rules that carry it:

- Three event types list `consumes`, the ids of the user events they claim: a
  `span.model_request_start` claims the `user.message`s its request folds in (and `model`, the
  `provider/model` that served it); a `span.model_request_end` claims the `user.interrupt`s that
  cut its request short; a `session.status_idle` claims the `user.interrupt`s a turn that had
  nothing running ended on. The claim _is_ that append: an event already consumed by one event
  cannot be consumed again. `processed_at` stays in the payload and is derived on read from the
  claim that took the event.
- `event_start` and `event_delta` are **stored events**, with `id`, `seq` and `processed_at`
  like any other — a reply in flight is part of the log, so reconnecting mid-reply is
  `after_seq` / `last-event-id` alone. Their names and shapes are Anthropic's
  `event_deltas[]` previews; a connection that asked for `event_deltas[]=agent.message` gets
  them live, and there is no second, envelope-less form.
- The event that finishes a reply — the `agent.message`, or the `span.model_request_end` that
  closes a request that stored none (an interrupt, a brain that died, a reply that streamed no
  text) — carries `supersedes: { from_seq, to_seq }`, the chunk range it replaces, inclusive
  and with `from_seq <= to_seq`. **Replay skips superseded chunks**, so a resumed client sees
  the reply once, whole. The chunks stay for a retention window and are then deleted by
  compaction; whether compaction has run is invisible to a reader.
- **Edit and resend is the same machinery over a different range** (`session.rewind`, #238).
  Editing never changes an old event: the client sends the rewind and the edited text in one
  `POST …/events`, the server writes the rewind with `supersedes: { from_seq, to_seq }` over
  the **tail of the log** — from the edited `user.message` through the last event before the
  rewind — and the message follows it as an ordinary `user.message`. So `from_seq` is the
  message the reader edited, `to_seq` is where the log ended, and everything in between (the
  message, its reply, the spans and status events around them) is superseded: a reader that
  loads the session afterwards never sees any of it, a client that was showing it drops it
  when the rewind arrives, and the model is never told about it. A rewind covers events of
  **any** type, where a reply's range covers the chunks it was streamed as and nothing else —
  the recorded range says which kind it is. It is accepted only while the session is idle
  (409 `conflict_error` otherwise), because the turn in flight owns the branch being replaced.
  A batch carries **at most one rewind, and only as its first event**: the batch is appended in
  order and the rewind supersedes everything after the message it names, so a message ahead of
  it — or anything behind a second rewind — would be stored and then swallowed by the range,
  accepted by the response and answered by no turn. Either mistake is a 400
  `invalid_request_error`, and nothing in the batch is stored.

```json
{"type":"span.model_request_start","id":"sevt_…","seq":3,"processed_at":"…",
 "consumes":["sevt_…","sevt_…"],"model":"anthropic/claude-sonnet-5"}
{"type":"event_start","id":"sevt_…","seq":4,"processed_at":"…",
 "event":{"type":"agent.message","id":"sevt_…"}}
{"type":"event_delta","id":"sevt_…","seq":5,"processed_at":"…","event_id":"sevt_…",
 "delta":{"type":"content_delta","index":0,"content":{"type":"text","text":"Hello"}}}
{"type":"agent.message","id":"sevt_…","seq":6,"processed_at":"…",
 "content":[{"type":"text","text":"Hello there"}],"supersedes":{"from_seq":4,"to_seq":5}}
```

The reader edits the message at `seq` 1, "write a haiku about rain", and sends "…about snow".
The request carries both events — the instruction, and the message that replaces the one it
takes back — and they are stored in one append:

```jsonc
// POST /v1/sessions/sesn_…/events
{
  "events": [
    { "type": "session.rewind", "from_seq": 1 },
    { "type": "user.message", "content": [{ "type": "text", "text": "write a haiku about snow" }] },
  ],
}
// → {"data":[{"type":"user.message","id":"sevt_…","seq":9,"processed_at":null,…}]}
//   the answer carries the stored *user* event; the rewind is the server's
```

The rewind must be the batch's **first** event, and there may be only one: `[user.message,
session.rewind]` and `[session.rewind, session.rewind]` are both a 400 `invalid_request_error`
that stores nothing, because the message the range would swallow would otherwise come back in
the response as if a turn were going to answer it.

An interrupt that arrives with nothing running is claimed by the `session.status_idle` that
ends the turn — no span is opened for it, because no model request runs:

```json
{"type":"user.interrupt","id":"sevt_…","seq":7,"processed_at":null}
{"type":"session.status_running","id":"sevt_…","seq":8,"processed_at":"…"}
{"type":"session.status_idle","id":"sevt_…","seq":9,"processed_at":"…",
 "stop_reason":{"type":"end_turn"},"consumes":["sevt_…"]}
```

`consumes`, `model` and `supersedes` are optional in the schema so that a log written before
D9 keeps validating; the server writes them on every event that takes them. A
`session.rewind`'s `supersedes` is **required** — the event exists only to carry the range —
and the client's input names `from_seq` alone: how far the restart reaches is the log's end,
which only the store knows.

## Reading the stream

```
id: 12
data: {"type":"agent.message","id":"sevt_01H…","seq":12,"processed_at":"…","content":[…]}

: ping
```

- A reconnecting client sends back the last `seq` it saw as `last-event-id` **and** as
  `after_seq`, so the server resumes from exactly there whichever one it honors.
- Without either, the stream is **live only**: it delivers what happens next. Read the log
  first with `GET …/events` (or `after_seq=0`) and pass the last `seq` to continue.
- Comments (`: ping`, every 15 seconds) are keepalives and can be ignored.
- When the session is **deleted**, the stream ends with one `session.deleted` frame
  (`{"type":"session.deleted","session_id":"sesn_…"}`) and closes. It is stream-only — the log
  it would belong to is gone — and carries no `seq`; a client treats it as terminal and stops
  reconnecting. `@openharness/client`'s transcript records it as `deleted`.

### When the session is revoked mid-stream

A stream is one long request, so the server watches the session behind it (epic #65, A2): a
sign-out, `oh logout`, "revoke other sessions" or an operator deleting the session row ends an
open stream — on whichever instance holds it — within about a second, and an **expired**
session ends it within at most half a minute (the periodic re-check; 15 seconds by default).

What the client sees is one final frame before the connection closes:

```
event: error
data: {"type":"error","error":{"type":"authentication_error","message":"the session behind this stream was revoked or has expired"}}
```

A client should treat it as it treats a 401 — stop reconnecting and route to sign-in.
`@openharness/client` does exactly that in effect: it does not decode this frame (it is not a
`StreamEvent`, so its parser skips it like any unknown message), it reconnects once as it
would after any dropped connection, and the `401 authentication_error` that answers the
reconnect is an `AuthenticationError` — never retryable — which stops the stream loop and
tells the caller to sign in again. The AI SDK adapter's response says the same thing as an
`error` chunk with the message above.

### Reloading mid-reply

A client that connects while a reply is streaming — a reloaded page, a second tab — must not
start rendering it mid-word. Since D9 there is nothing special to do about it: the chunks are
stored events (see above), so what a client loads carries the reply in flight.

The documented flow is two calls, and it is what `@openharness/client` and both frontends do:

```bash
# 1. what the log holds: the reply in flight, chunk by chunk, plus everything settled
curl localhost:3000/v1/sessions/sesn_01H…/events

# 2. follow from where that read ended — from `seq`, never repeating one
curl -N "localhost:3000/v1/sessions/sesn_01H…/events/stream?after_seq=17&event_deltas[]=agent.message"
```

`GET …/events` skips superseded chunks and **returns the chunks of a reply still in flight** —
the message that will supersede them is not in the log yet. A client that resumes from inside
that range gets the rest of the chunks and then the stored `agent.message`; once compaction has
deleted them it gets the message alone. Both are the same conversation: the message sorts where
its range started, so a reply interleaved with a steering message renders the same live and
after a reload.

A connection that asked for `event_deltas[]=agent.message` gets the chunks — live and replayed
alike; one that did not is never sent an `event_start` or an `event_delta`, and sees the
`agent.message` when the turn ends.

## Authentication

Every `/v1/*` request must come from a signed-in user. The caller proves it with a
server-side session, and there are two ways to carry one:

| caller                  | proof                    | sent as                                      |
| ----------------------- | ------------------------ | -------------------------------------------- |
| the web app             | a Better Auth session    | an httpOnly, `Secure`, `SameSite=Lax` cookie |
| the CLI (`oh`), scripts | the same kind of session | `Authorization: Bearer <token>`              |

```bash
curl localhost:3000/v1/me -H "Authorization: Bearer $TOKEN"
```

- **Sign-in is not part of this API.** Better Auth serves it under `/api/auth/*`: the social
  callbacks, `sign-in/email` (dev login only), `sign-out`, and the device-authorization
  endpoints the CLI uses (`/api/auth/device/code`, `/device/token`, with approval on the web
  app's `#/device` page — the `verification_uri_complete` the code endpoint answers carries
  the `user_code` inside that fragment, where the app's hash router reads it). `oh login`
  drives that in the browser and stores the session token with `0600` permissions. Only the
  session that comes out of it is visible here.
- **A cookie-authenticated write must come from a trusted origin.** A browser sends its cookie
  on any request any page makes, so `POST`, `PUT` and `DELETE` calls that authenticate by
  cookie need an `Origin` header of the deployment's own URL (`BETTER_AUTH_URL`); a request
  from anywhere else is refused with `403 permission_error`. Bearer tokens (the CLI) do not
  need it — a page cannot attach that header cross-origin.
- **A non-browser client signing in by email/password must send an `Origin` of the server's
  public URL** (the dev login; the same `BETTER_AUTH_URL` the cookie rule above names).
  Sign-in is Better Auth's Fetch-Metadata CSRF check: a cookieless sign-in POST that carries
  `Sec-Fetch-*` headers — Node's own `fetch` sends `sec-fetch-mode: cors` — but no `Origin`
  is refused (`403`, `MISSING_OR_NULL_ORIGIN`), as is one from another origin
  (`INVALID_ORIGIN`). A `curl` that sends neither is left alone. The CLI is unaffected:
  `oh login` uses the device flow, whose endpoints carry no such check.
- **What sign-in is available** is `GET /v1/auth-config`, the one `/v1` route that needs no
  session (the web app reads it before showing the sign-in screen):

  ```bash
  curl localhost:3000/v1/auth-config
  # → {"providers":["google","github"],"dev_login":false}
  ```

  `providers` lists only the providers whose client id and secret are configured, in the order
  `google`, `github`, `microsoft`; `dev_login` says whether the local email/password login is
  on (it is off unless `OPENHARNESS_DEV_LOGIN=1`, and only ever on a localhost URL).

- Sessions live in the database with a 7-day sliding expiry: every request looks the token
  up, and a revoked one stops working immediately — **including the requests that are already
  open**: an SSE stream (see [When the session is revoked mid-stream](#when-the-session-is-revoked-mid-stream))
  and the AI SDK adapter's response end when the session behind them is revoked, or when it
  expires. There are no JWTs and no refresh tokens.
- **Sensitive actions require a fresh session**: `PUT` and `DELETE` on
  `/v1/provider-credentials` refuse a session older than the freshness window (one day after
  it was created) — with the same `401 authentication_error` as no session at all, which is
  what tells a client to sign the user in again. Reads are not sensitive.
- Anything not signed in — or carrying an invalid or expired session or token — gets an
  `authentication_error` with status `401`. `/health`, `/ready` and `/v1/auth-config` are the
  only routes that never ask.
- **Everything belongs to the user who created it.** Agents and sessions carry a read-only
  `owner_id`; a resource that belongs to another user answers **`404`**, not `403`, so its
  existence never leaks. Nothing is shared and no request ever carries an owner.

### The signed-in user

`GET /v1/me` answers the user the request authenticated as — the identity every request is
scoped to:

```json
{
  "id": "Qm3xT7bR9kL2nV5wZ8yA4cD6fG1hJ0pS",
  "email": "ada@example.com",
  "name": "Ada Lovelace",
  "image": "https://example.com/ada.png",
  "created_at": "2026-03-15T10:00:00Z"
}
```

`name` and `image` are absent when the identity provider gave none. A user is a
provider-verified email: signing in with Google, GitHub or Microsoft proves the same address,
and it is the same user.

#### Preferences

`GET /v1/me/preferences` answers the caller's stored preferences, unwrapped, plus the defaults
their `null`s mean:

```json
{
  "default_model": "anthropic/claude-sonnet-5",
  "theme": "system",
  "compaction_threshold": null,
  "summary_model": "same-as-chat",
  "summary_max_passes": null,
  "defaults": { "compaction_threshold": 0.7, "summary_max_passes": 3 }
}
```

A caller who has never saved any gets every choice at its default (the absence of a choice, not
a 404). `PUT` answers the same shape, so a client that has just written one preference reads the
effective defaults back in one round trip.

`default_model` is a router id of `provider/model` shape, checked for shape only — it does not
have to be in the caller's catalog — and it is what a new chat starts with (epic #116, U1).
`theme` is the web app's colour scheme: `system` (follow the operating system; the default),
`light`, `dim` or `dark` (epic #201, X3). It is a _choice_, not a resolved value — a `system`
user is not rewritten to `light` or `dark` when their OS changes, because the following
happens in the browser.

The three compaction controls (epic #277 decisions K2/K3/K5; issue #282) are what a long chat
does when it fills the model's context window: older history is summarized so the conversation
can continue.

- **`compaction_threshold`** is the share of the chat model's budget at which that happens, a
  number from `0.3` to `0.95`, or `null` to follow the **server's** own
  (`OPENHARNESS_COMPACTION_THRESHOLD`, default `0.7`). Lower means smaller requests and more
  summarization; higher means more of the chat stays verbatim.
- **`summary_model`** is the model that writes the summary: the sentinel `same-as-chat` (the
  default — the model the chat runs summarizes) or a `provider/model` id, shape-checked like
  `default_model`. A chosen model with no usable credential, or one that would need more passes
  than the limit allows, hands the work back to the chat model and the summary event records
  why.
- **`summary_max_passes`** is how many passes that model may take before the chat model takes
  over, a whole number from `1` to `10`, or `null` for the engine's own default (`3`).

`defaults` says what the two nullable controls mean here — the deployment's trigger share and
the engine's pass limit — because neither is a value a client could know, and a settings screen
shows `0.7 (server default)` from it.

`PUT` **merges**: each field the body carries is stored, a field it leaves out keeps its stored
value, and `null` clears a nullable one (`default_model`, `compaction_threshold`,
`summary_max_passes`) back to the absence of a choice. An empty body is a no-op that answers
what is stored. So the settings cannot clear each other — `{"theme": "dim"}` from Settings
leaves the default model alone, `{"default_model": "openai/gpt-5-mini"}` from
`oh default-model` leaves the theme alone, and one compaction control never disturbs another.
Both routes are owner-only like the rest of `/v1/me`, and a value outside a range above is the
`400 invalid_request_error` any bad body is.

**The automatic default** (epic #116, U4). Saving a provider key when `default_model` is
`null` sets one, so the first key makes "New chat" usable with no dialog: the server picks the
first entry of a curated per-provider recommendation list (its everyday tier — mini/flash/fast)
that the caller's live catalog actually lists, or, when none of them is listed, the newest
chat model the bundled registry knows for the caller's providers that is neither expensive
nor reasoning-only. Saving another key never moves a default that exists; deleting the key
whose provider a default depends on re-picks it from the providers that remain (or clears it
when none does) — an automatic pick is maintained this way, while a default the user chose
themselves is only cleared, because silently substituting another model for their choice is
not a decision the server makes for them.

#### Modes

A **mode** (epic #245, decision M6) is a per-user named preset: a model, a reasoning effort
(`low`/`medium`/`high`/`null`) and an optional system-prompt addition behind a stable name such
as `smart`. A chat can follow one instead of a raw model, and it follows it **live** — every
request resolves the mode as it is now — so retuning a mode changes every chat that runs it.

The routes are `/v1/me/modes`, owner-scoped like the rest of `/v1/me` (another user's mode is
a 404, never a 403, and it leaks nothing). A `name` is unique among the caller's modes and a
caller holds at most `MAX_MODES_PER_USER` (20) of them; both refusals are the protocol's `409`
`conflict_error` with a message saying which. `model` is a `provider/model` id or the sentinel
`my-default-model`, which resolves to the caller's stored `default_model` at request time — so
a mode on it follows a changed default, and one with no default set is unavailable. `PUT`-style
merging is a `POST /v1/me/modes/{mode_id}` update: omitted fields keep their stored value and
`null` clears a nullable one (`reasoning_effort`, `system_prompt_addition`).

**A chat follows a mode or a plain model.** `Session.mode` is the mode a chat follows, or
`null`; `POST /v1/sessions` takes a `mode` (the server stores the model it resolves to on the
session's header), and a `user.message` carrying a `mode` switches the session to it from that
message on. A `user.message` carrying a plain `model` with no `mode` **detaches** the chat, and
so does `"mode": null`. Deleting a mode lands the chats that followed it on the model each last
ran, as ordinary chats with no mode.

**An unavailable mode is refused, never silently replaced.** If a mode's model cannot be used —
no credential for its provider, or `my-default-model` with no default set — starting a chat on
it (`POST /v1/sessions`) or continuing one (`POST …/events`) is the `422`
`mode_unavailable_error`, with a message naming the mode and what to do about it, and nothing is
stored. A mode is stored even when its model is not usable yet: the key may come later.

**Every request records what it ran under.** `span.model_request_start.mode` is `{ id, name }`
— the mode the request ran under and the name it had then — beside the `model` and
`reasoning_effort` it resolved to, so a rename or an edit later does not rewrite history. The
effort is the mode's unless a `user.message` asked for one explicitly, and the mode's
`system_prompt_addition` is appended after the session's own system prompt (never in place of
it).

### Provider credentials

The server has no model-provider keys of its own — each user stores their own, and the API is
**write-only**. A credential goes up once, is stored encrypted, and only metadata ever comes
back:

```bash
curl -X PUT localhost:3000/v1/provider-credentials/anthropic \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"api_key","api_key":"sk-ant-…"}'
# → 200 {"id":"pcred_01J…","type":"api_key","name":"anthropic","last4":"…xYz9",
#        "created_at":"…","updated_at":"…","validated_at":"…"}

curl -X PUT localhost:3000/v1/provider-credentials/azure-eu \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"azure_openai","endpoint":"https://my-resource.openai.azure.com",
       "api_key":"…","deployments":["gpt-4o","gpt-4o-mini"]}'
# → 200 {"id":"pcred_01J…","type":"azure_openai","name":"azure-eu","last4":"…4242", …}

# Any server that speaks the OpenAI chat-completions API, at a URL the user chooses. The key
# is optional (a local endpoint may take none); only the base URL's host comes back.
curl -X PUT localhost:3000/v1/provider-credentials/custom \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"openai_compatible","base_url":"http://127.0.0.1:11434/v1","api_key":"…"}'
# → 200 {"id":"pcred_01J…","type":"openai_compatible","name":"custom","last4":"…4242",
#        "details":{"base_url_host":"127.0.0.1:11434"}, …}

# A Bedrock credential is an IAM principal's keys plus a region; the region rides back as the
# public fact. The secret access key is never any part of a response.
curl -X PUT localhost:3000/v1/provider-credentials/bedrock \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"bedrock","access_key_id":"AKIA…","secret_access_key":"…","region":"eu-west-1"}'
# → 200 {"id":"pcred_01J…","type":"bedrock","name":"bedrock","last4":"…MPLE",
#        "details":{"region":"eu-west-1"}, …}

curl localhost:3000/v1/provider-credentials -H "Authorization: Bearer $TOKEN"
# → {"data":[ …the metadata of all three… ]}

curl -X DELETE localhost:3000/v1/provider-credentials/azure-eu \
  -H "Authorization: Bearer $TOKEN"
# → 204
```

- **Write-only.** The secret is accepted on the `PUT` and never returned, logged, put in an
  event or repeated in an error. `last4` exists so a settings screen can tell two apart, and
  an empty `last4` is a credential that carries **no key at all** (a custom endpoint that takes
  none).
- **Non-secret per-type facts ride in `details`.** `last4` tells two credentials of one type
  apart but not which service one is: a Bedrock credential is one account's keys in one region,
  and a user may keep `bedrock` and `bedrock-us`; a Vertex credential is one service account in
  one project and one location, and a user may keep `vertex` and `vertex-eu`. Each type's
  `details` is its own typed object — `{"base_url_host":"127.0.0.1:11434"}` for a custom
  endpoint (#249), `{"region":"eu-west-1"}` for a Bedrock credential (#250) and
  `{"email":"…","project":"…","location":"us-central1"}` for a Vertex one (#251) — and it never
  carries a secret or anything a secret could be recovered from. It is **absent** for a
  credential whose type has nothing to report, which is every `api_key` and `azure_openai` one.
- **Validated on save** with one cheap call. An `api_key` is checked against the provider's own
  model list; an `azure_openai` credential is checked with one chat request to its **first
  deployment**; an `openai_compatible` credential is checked with `GET {base_url}/models` — the
  same call the catalogue makes. Each of the last two is sent through the SSRF guard, so an
  endpoint that resolves inside the network (loopback, private, link-local, the cloud metadata
  service) is refused before it can be stored; a `bedrock` credential is checked with one
  `ListFoundationModels` read in its region, SigV4-signed with the user's keys (the host comes
  from the region, so there is no user-supplied address to guard); a `vertex` credential is
  checked by signing an OAuth token with its service-account key — never Application Default
  Credentials — and listing one page of the project's **endpoints** in its location
  (`projects.locations.endpoints.list`; Google's own endpoint, derived from the validated
  location, so there is nothing to guard). A
  credential the provider rejects is an `invalid_provider_credential` with status `422` — for
  Bedrock and Vertex, the provider's own reason for the refusal, scrubbed — and nothing is
  stored.- **A credential is keyed by its `name`**, which is the `provider` half of the model ids it
  serves — and that is also the path parameter, which is why the route's shape did not change
  when names arrived. `PUT` replaces the credential with that name; deletion is immediate.
- **The eleven fixed providers keep their ids as names**, one each: an `api_key` credential may
  only be stored under `anthropic`, `openai`, … A **named credential type** — `azure_openai`
  `openai_compatible`, `bedrock` and `vertex` today — may be stored under any short, lowercase
  name (`[a-z0-9-]`, at most 32 characters) that is not one of those ids, which is how a user
  keeps `azure` _and_ `azure-eu`, `custom` _and_ `my-local`, two Bedrock credentials in two
  regions, or `vertex` _and_ `vertex-eu`. Only the first credential of a type defaults to the
  type's name (`azure`, `custom`, `bedrock`, `vertex`); the frontends ask for a name for a
  second one. Anything else is a `400 invalid_request_error`.
- `type` is a discriminated union: `api_key` (`api_key`); `azure_openai` (`endpoint`, an
  `https` URL; `api_key`; `deployments`, at least one); `openai_compatible` (`base_url`, an
  absolute `http`/`https` URL; an **optional** `api_key`); `bedrock` (`access_key_id`,
  `secret_access_key`, an optional `session_token`, and `region` — validated against the list
  of AWS regions that serve Bedrock, because the value goes into an AWS hostname; no
  assume-role in v1); and `vertex` (`service_account`, the JSON key file Google Cloud issued
  for a service account — it must parse, say `type: service_account` and carry the fields a
  request needs, or it is a `400` before it reaches the vault; `project`, a Google Cloud project
  id; and `location`, one of Google's Vertex regions, because the location is the host every
  request goes to). The whole Vertex document is sealed as text, exactly as it was pasted, and
  its models are `<name>/<model>`.
- **The public facts a list shows.** Metadata is the same fields for every type, plus the
  `details` object its own type publishes — the base URL's **host** for an
  `openai_compatible` credential, the **region** for a `bedrock` one and the service-account
  **email**, **project** and **location** for a `vertex` one, never the whole URL and never any
  part of a key. A type with no such facts (an `api_key`, an `azure_openai`) carries no
  `details` at all.- A turn whose model's provider half names no stored credential fails with a `session.error`
  whose type is `missing_provider_credential` — non-retryable, the message names the provider.
  The server never falls back to provider keys from the environment.

## The model catalog

`GET /v1/models` answers **the chat models the caller's own provider keys can use** — the list
the agent form picks from, and the prices a client computes a reply's cost with. Authentication
is the usual one; the optional `refresh=true` query parameter bypasses the server's cache
(below). The response is `ListModelsResponse`:

```json
{
  "data": [
    {
      "id": "google/gemini-2.5-flash",
      "provider": "google",
      "name": "Gemini 2.5 Flash",
      "context_window": 1048576,
      "max_output_tokens": 65536,
      "cost": { "input": 0.3, "output": 2.5, "cache_read": 0.075, "cache_write": null },
      "context_budget": 983040,
      "tool_call": true,
      "source": "provider"
    },
    {
      "id": "openai/gpt-4.1-mini",
      "provider": "openai",
      "name": "openai/gpt-4.1-mini",
      "context_window": null,
      "max_output_tokens": null,
      "cost": null,
      "context_budget": 32768,
      "tool_call": true,
      "source": "provider"
    },
    {
      "id": "anthropic/claude-sonnet-5",
      "provider": "anthropic",
      "name": "Claude Sonnet 5",
      "context_window": null,
      "max_output_tokens": null,
      "context_budget": 32768,
      "tool_call": true,
      "source": "registry"
    }
  ],
  "providers": [
    {
      "provider": "anthropic",
      "status": "fallback",
      "fetched_at": null,
      "message": "the anthropic model list did not answer within 5 seconds"
    },
    { "provider": "openai", "status": "ok", "fetched_at": "2026-03-15T10:00:00Z", "message": null }
  ]
}
```

- **Only credentials the caller has are listed.** No environment key is ever used, and
  neither a key nor any part of one appears in a response, an error or a log. `data` is sorted
  by provider, then name; the form stays free text regardless — the router accepts
  `provider/model` ids the catalog does not know yet.
- **`tool_call` says whether the model can call tools** (epic #303, X2): models.dev's own flag,
  read off the server's bundled snapshot, and `true` for a model the registry does not know. A
  model marked `false` is offered no tools at all and chats exactly as it did before tools
  existed; a client uses the field to say so before a chat starts (#308).
- **`context_budget` is the budget the brain will trim a request to** (epic #277, K10; #246).
  Every entry carries it, resolved by the server with the very resolver the scheduler is handed
  — the model's `context_window` less room for the reply (`min(max_output_tokens, 25% of the
window)`), or **32,768** when the resolver knows the model not at all. That last case is the
  point of the field: a custom OpenAI-compatible endpoint or an Azure deployment under a named
  credential can carry a `context_window` the registry supplied while the resolver — keyed by
  the model id's provider half, which is the credential's name — derives nothing, so a meter
  computing a budget from the window would measure against a number no request is trimmed to.
  Clients should read `context_budget` and fall back to the window rule only for a server that
  predates the field.
- **A named credential contributes its own models.** Azure OpenAI offers no endpoint that
  lists deployments, so an `azure_openai` credential contributes one model per name the user
  typed — `azure/gpt-4o`, `azure-eu/gpt-4o-mini` — with `source: "provider"` (the credential's
  own list is the deployment names), and its per-provider status is `ok` with the time the
  credential was read. A deployment whose name is one models.dev's `azure` entry knows carries
  that model's context window; one it does not know gets `null` for both limits rather than a
  guessed number.
- **A Bedrock credential contributes the region's on-demand text models and its inference
  profiles.** Two signed reads are made in the credential's region, both listed with
  `source: "provider"` and both joined against models.dev's Amazon Bedrock entry:
  - `ListFoundationModels`, filtered to text output and `ON_DEMAND` inference, lists each
    on-demand model as `<name>/<bedrock model id>` — `bedrock/anthropic.claude-…-v1:0`.
  - `ListInferenceProfiles` lists each ACTIVE inference profile as
    `<name>/<inferenceProfileId>` — `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
    `…/global.…` — which is the id a Bedrock request names, so models whose only access is a
    cross-region profile (a large share of the newest Claude and Nova models) are now offered
    too. A profile's name, window, max output and price come from the **foundation model it
    wraps** (`models[].modelArn`); its display name is that model's name plus the profile's
    geography scope — `Claude Sonnet 4.5 (US)`, `… (Global)` — so a reader can tell the profile
    from the on-demand entry beside it. A model offered both ways is listed both ways.

  A model that cannot be mapped to a foundation model, is not text-capable, or is not ACTIVE is
  not listed. A region whose **foundation-model** list cannot be read is the usual visible
  `fallback` (the registry's Bedrock models, acknowledged to their model ids); a region whose
  **inference-profile** list cannot be read (for example a key without
  `bedrock:ListInferenceProfiles`) keeps the on-demand models, still `ok`, and logs a warning.

- An `openai_compatible` credential contributes the models its endpoint's `/models` answers —
  `custom/llama3.3` — filtered to chat models the way a provider's list is; a model id that
  matches exactly one models.dev entry borrows its metadata, and an id that matches none or more
  than one (`gpt-4o` is filed under both `openai` and `azure`) gets `null` for both limits, no
  name and no price rather than a guess.
- **A Vertex credential contributes the publisher models the project can actually call**
  (#273). Model Garden's catalogue is per **publisher**, so both are listed live with the
  credential's own service-account token:
  `GET https://{location}-aiplatform.googleapis.com/v1beta1/publishers/{publisher}/models` for
  `publishers/google` and `publishers/anthropic` (there is no `v1` list, and no
  project- or location-scoped one — the location picks the host). Entries are
  `vertex/gemini-2.5-pro`, `vertex/claude-sonnet-4-5@20250929`, with `source: "provider"`; the
  bundled models.dev `google-vertex` entry is joined for names, context windows and prices, so
  a model the snapshot predates is still listed, with `null` limits and no price.
  **A partner model must be enabled per project in Model Garden**, and the listing cannot say
  whether it was: every chat-capable Anthropic candidate is checked with
  `POST https://aiplatform.googleapis.com/v1beta1/projects/{project}/modelGardenEula:check`,
  and only the models whose terms this project has accepted are listed — so the picker does not
  offer a Claude model that would fail on the first message. Two further rules keep the rest
  out: only `gemini-*` and `claude-*` ids have a client here (the MaaS models Google resells —
  `xai/…`, `meta/…` — do not), and the catalogue's own chat filter drops the non-chat families
  (Gemini's image, speech and embedding models). The status is `ok` with the time of the read;
  a listing that fails is the same visible `fallback` every provider gets — the snapshot's
  Vertex models, through the same two filters, with the reason.- **Where the list comes from.** Per provider, the server calls that provider's own
  list-models endpoint with the caller's credential (`GET /v1/models` for OpenAI and
  Anthropic, `GET /v1beta/models` for Gemini, `GET /api/v1/models` for OpenRouter,
  `GET /models` for the OpenAI-compatible providers), from a fixed, known table. Each call has
  a 5-second deadline; Gemini's key travels in the `x-goog-api-key` header, never in the URL.
  The one **user-supplied** URL is a custom credential's `base_url`: its `/models` call goes
  through the SSRF guard, so a private address is refused exactly as it is on save — unless the
  server's self-host setting (`OPENHARNESS_ALLOW_PRIVATE_PROVIDER_URLS`, off by default) allows
  it, which applies to that credential type alone and never to Azure.
- **The registry join, and how models are filtered.** What the provider's own payload carries
  is used first: Gemini's `displayName`/`inputTokenLimit`/`outputTokenLimit`, OpenRouter's
  `name`/`context_length`, Anthropic's `display_name`. The bundled models.dev snapshot —
  a file committed to the server, never fetched from the network — is joined for the rest:
  per model, its display name, context window and output limit. It carries **no chat flag**
  (models.dev has none), so a model the provider's own payload does not classify is
  classified by name, and a model neither side knows keeps `null` limits. A model is
  listed when it is a chat model, by this rule: an explicit non-chat verdict drops it (the
  provider's own capability data, e.g. Gemini's `supportedGenerationMethods` without
  `generateContent`); an explicit chat verdict keeps it (OpenRouter lists chat models only);
  otherwise it is dropped only when its id names a known non-chat family (embedding, TTS,
  whisper, transcription, speech, image, moderation, realtime, audio, search, rerank, video,
  instruct, the legacy completions models) — an id the rule does not recognise is kept, so a
  usable chat model is never hidden. `apps/server/AGENTS.md` has the exact family list.
- **Fallback is visible, never silent.** If the provider call fails or times out (5 seconds),
  the provider has no known list endpoint, or the stored credential cannot be opened, that
  provider's chat models are served from the registry instead (through the same chat filter —
  the registry lists non-chat models too): `status: "fallback"`, `fetched_at: null`, and a
  `message` saying why — the provider's own status and a bounded snippet of what it said, or
  the plain reason; never a key. `status: "ok"` means the provider's own list answered. A
  provider never hides a usable chat model, and no non-chat model is ever shown.
- **Cache.** The answer is held in memory on the serving instance, per user and provider, for
  one hour; saving or deleting a credential drops that provider's entry. Nothing is stored in
  Postgres. `refresh=true` bypasses the cache and re-fetches — rate-limited to **once a
  minute per user**: a second refresh inside the window is answered `429 rate_limit_error`
  rather than refreshed, so a Refresh button should show that instead of looping.

## Usage and cost

Two routes answer what was spent. Both are **reads of the log**: the tokens come from the
`span.model_request_end` events the log holds, the money is computed from the model catalog's
prices when the request is answered, and nothing about cost is ever written down.
`session.usage` (above) is the same totals pushed onto the stream, so a client following a
session does not have to ask.

```
GET /v1/sessions/{session_id}/usage    -> { session_id, totals, cost, unpriced_requests, by_model, searches }
GET /v1/me/usage?from=&to=&tz=         -> { from, to, tz, totals, cost, unpriced_requests, by_model, by_day, searches }
```

```json
{
  "session_id": "sesn_01JQZ8R6X9M4V0W7Y2B3C5D6E7",
  "totals": {
    "input_tokens": 1076,
    "output_tokens": 64,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  },
  "cost": 0.002792,
  "unpriced_requests": 0,
  "searches": 1,
  "by_model": [
    {
      "model": "anthropic/claude-sonnet-5",
      "usage": {
        "input_tokens": 1076,
        "output_tokens": 64,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0
      },
      "requests": 2,
      "cost": 0.002792,
      "unpriced_requests": 0
    }
  ]
}
```

- **Cost is computed on read, and never estimated.** Every total carries `cost` and
  `unpriced_requests`: a total **sums the requests it can price and counts the ones it cannot**
  (#247, decided 2026-10-09). One request with no published price no longer turns a whole
  session's total into `—` — the money is the priced part and the count names the rest (`—` on
  screen is reserved for a total with nothing priced at all). A model that publishes an input and
  output rate but no cache rates is priced for the tokens whose rates exist and answers `null`
  for a request that spent cache tokens, and that request counts as unpriced: charging nothing
  for tokens that were really spent would understate the bill. `session.usage` (above) carries no
  cost, only the tokens and the per-model request counts a client prices with. Prices are USD per
  million tokens, from the vendored models.dev snapshot (see `apps/server/AGENTS.md`).
- **Cache tokens are priced separately.** `cache_read` and `cache_write` are their own rates at
  every provider that publishes them, not a fraction of the input rate.
- **Searches are counted, and never priced** (epic #303, #305). `searches` is how many
  `web_search` calls the covered log holds — the call and its successful result, so a refused,
  failed or never-answered call is not one — and it is a **count**: the operator pays the search
  provider, no rate for that is in this repository, and inventing one would be the estimate the
  rest of this surface refuses to make. It is a sibling of the totals rather than a member of
  them, and every per-day entry of `by_day` carries its own.
- **Usage is broken down by model, never by mode.** A session may switch models mid-conversation
  (U3), so `by_model` is what separates the cheap requests from the expensive ones. The per-user
  route adds `by_day`; there is no third axis.
- **Days are the reader's days.** `tz` is an IANA zone name — the web app reads
  `Intl.DateTimeFormat().resolvedOptions().timeZone` and `oh` the same in Node — and the request
  timestamps are grouped by the local day they fell on _there_. A zone the server does not know
  is a `400 invalid_request_error`, never a silent UTC. `from` and `to` are inclusive local days
  and default to the current month so far; a `from` after `to` is a `400` too. A day with no
  requests is **absent** from `by_day`, not present as a zero.
- **Ownership is the whole of the access control** (A4). The session route is owner-scoped:
  another user's session is the `404` an unknown id gets. The per-user route has no id in its
  path at all — it is always the caller — and there is no operator-wide view.
- **Nothing is rolled up or stored.** Deleting a session removes its usage with it (the log is
  gone), and a request inside a branch a `session.rewind` replaced is not billed: the reads go
  through the replay read, which skips what a range supersedes.

## Errors

| status | type                          | when                                                                                    |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| 400    | `invalid_request_error`       | the request does not match the protocol's schemas                                       |
| 401    | `authentication_error`        | not signed in, or the session or bearer token is invalid/expired                        |
| 403    | `permission_error`            | a cookie-authenticated write from an untrusted origin (CSRF)                            |
| 404    | `not_found_error`             | the id names nothing, the route does not exist, or the resource belongs to another user |
| 409    | `conflict_error`              | a mode name the caller already has, or the twenty-first mode; a rewind while running    |
| 422    | `invalid_provider_credential` | a provider credential failed validation on save                                         |
| 422    | `mode_unavailable_error`      | a chat starting or continuing on a mode whose model cannot be used (M6)                 |
| 429    | `rate_limit_error`            | a cache-bypassing refresh (`/v1/models?refresh=true`) more than once a minute per user  |
| 500    | `api_error`                   | an unexpected server failure — never a stack trace                                      |
