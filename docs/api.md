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
| `GET`    | `/v1/me/preferences`                      | the caller's preferences — the default model and the web theme                                  |
| `PUT`    | `/v1/me/preferences`                      | merge fields in; `default_model` is `provider/model` or `null`, `theme` one of four names       |
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

| event                        | who writes it | what it means                                                                        |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `user.message`               | the client    | a message, until the brain claims it                                                 |
| `user.interrupt`             | the client    | stop the turn in flight                                                              |
| `agent.message`              | the brain     | a reply, under the `sevt_` id its chunks announced                                   |
| `session.status_running`     | the brain     | a turn started (also after a retry)                                                  |
| `session.status_idle`        | the brain     | the turn ended; the session is waiting for input                                     |
| `session.status_rescheduled` | the brain     | a transient failure; it is retrying                                                  |
| `session.error`              | the brain     | what went wrong, and whether it is retrying — `missing_provider_credential` never is |
| `span.model_request_start`   | the brain     | a model request began, and the messages it claims                                    |
| `span.model_request_end`     | the brain     | it finished — usage, any error, the interrupts it ends                               |
| `event_start`                | the brain     | a reply started streaming — a stored chunk since D9                                  |
| `event_delta`                | the brain     | a streamed fragment of it — a stored chunk since D9                                  |
| `session.usage`              | the brain     | the session's running token totals, per model, after a request that reported usage   |
| `session.rewind`             | the server    | // extension: the session restarts from an earlier `user.message` (#238)             |
| `session.deleted`            | the server    | stream-only: the session was deleted; sent last, then the stream closes (#111)       |

A `user.message` may also carry a `model` (`{ "id": "provider/model" }`): it switches the
model the session runs from that message on, and the session keeps running it until another
message changes it (epic #116, U3). The switch is stored on the message — the log stays the
source of truth — and each `span.model_request_start` still records the model its request
actually used.

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

`GET /v1/me/preferences` answers the caller's stored preferences, unwrapped —
`{ "default_model": "anthropic/claude-sonnet-5", "theme": "system" }` — and
`{ "default_model": null, "theme": "system" }` for a caller who has never saved any (the
absence of a choice, not a 404).

`default_model` is a router id of `provider/model` shape, checked for shape only — it does not
have to be in the caller's catalog — and it is what a new chat starts with (epic #116, U1).
`theme` is the web app's colour scheme: `system` (follow the operating system; the default),
`light`, `dim` or `dark` (epic #201, X3). It is a _choice_, not a resolved value — a `system`
user is not rewritten to `light` or `dark` when their OS changes, because the following
happens in the browser.

`PUT` **merges**: each field the body carries is stored, a field it leaves out keeps its
stored value, and `default_model: null` clears the stored default. An empty body is a no-op
that answers what is stored. So the two settings cannot clear each other — `{"theme": "dim"}`
from Settings leaves the default model alone, and `{"default_model": "openai/gpt-5-mini"}`
from `oh default-model` leaves the theme alone. Both routes are owner-only like the rest of
`/v1/me`.

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

curl localhost:3000/v1/provider-credentials -H "Authorization: Bearer $TOKEN"
# → {"data":[ …the metadata of both… ]}

curl -X DELETE localhost:3000/v1/provider-credentials/azure-eu \
  -H "Authorization: Bearer $TOKEN"
# → 204
```

- **Write-only.** The secret is accepted on the `PUT` and never returned, logged, put in an
  event or repeated in an error. `last4` exists so a settings screen can tell two apart.
- **Validated on save** with one cheap call. An `api_key` is checked against the provider's own
  model list; an `azure_openai` credential is checked with one chat request to its **first
  deployment**, sent through the SSRF guard — so an endpoint that resolves inside the network
  (loopback, private, link-local, the cloud metadata service) is refused before it can be
  stored. A credential the provider rejects is an `invalid_provider_credential` with status
  `422`, and nothing is stored.
- **A credential is keyed by its `name`**, which is the `provider` half of the model ids it
  serves — and that is also the path parameter, which is why the route's shape did not change
  when names arrived. `PUT` replaces the credential with that name; deletion is immediate.
- **The eleven fixed providers keep their ids as names**, one each: an `api_key` credential may
  only be stored under `anthropic`, `openai`, … A **named credential type** — `azure_openai`
  today — may be stored under any short, lowercase name (`[a-z0-9-]`, at most 32 characters)
  that is not one of those ids, which is how a user keeps `azure` *and* `azure-eu`. Only the
  first credential of a type defaults to the type's name (`azure`); the frontends ask for a
  name for a second one. Anything else is a `400 invalid_request_error`.
- `type` is a discriminated union: `api_key` (`api_key`) and `azure_openai` (`endpoint`, an
  `https` URL; `api_key`; `deployments`, at least one). Bedrock and Vertex come later.
- A turn whose model's provider half names no stored credential fails with a `session.error`
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
      "source": "provider"
    },
    {
      "id": "openai/gpt-4.1-mini",
      "provider": "openai",
      "name": "openai/gpt-4.1-mini",
      "context_window": null,
      "max_output_tokens": null,
      "cost": null,
      "source": "provider"
    },
    {
      "id": "anthropic/claude-sonnet-5",
      "provider": "anthropic",
      "name": "Claude Sonnet 5",
      "context_window": null,
      "max_output_tokens": null,
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
- **A named credential contributes its deployments.** Azure OpenAI offers no endpoint that
  lists deployments, so an `azure_openai` credential contributes one model per name the user
  typed — `azure/gpt-4o`, `azure-eu/gpt-4o-mini` — with `source: "provider"` (the credential's
  own list is the deployment names), and its per-provider status is `ok` with the time the
  credential was read. A deployment whose name is one models.dev's `azure` entry knows carries
  that model's context window; one it does not know gets `null` for both limits rather than a
  guessed number.
- **Where the list comes from.** Per provider, the server calls that provider's own
  list-models endpoint with the caller's credential (`GET /v1/models` for OpenAI and
  Anthropic, `GET /v1beta/models` for Gemini, `GET /api/v1/models` for OpenRouter,
  `GET /models` for the OpenAI-compatible providers), from a fixed, known table — a
  user-supplied URL is never called, so there is no SSRF surface. Each call has a 5-second
  deadline; Gemini's key travels in the `x-goog-api-key` header, never in the URL.
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
GET /v1/sessions/{session_id}/usage    -> { session_id, totals, cost, unpriced_requests, by_model }
GET /v1/me/usage?from=&to=&tz=         -> { from, to, tz, totals, cost, unpriced_requests, by_model, by_day }
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
| 422    | `invalid_provider_credential` | a provider credential failed validation on save                                         |
| 429    | `rate_limit_error`            | a cache-bypassing refresh (`/v1/models?refresh=true`) more than once a minute per user  |
| 500    | `api_error`                   | an unexpected server failure — never a stack trace                                      |
