# The API, at a glance

openharness speaks an Anthropic-shaped API: an agent configures a model, a session is the
durable log that agent works in, and everything that happens is an event in that log. This
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
`{"type":"user.interrupt"}`, and it aborts the turn in flight.

The first `user.message` a session is sent also names it: the session's `title` — `null` until
then — becomes the message's first non-empty line, whitespace collapsed and cut to
`SESSION_TITLE_MAX_LENGTH`, so a list of chats shows what each one is about rather than the
agent's name. That happens once. A title passed to `POST /v1/sessions`, and one an earlier
message produced, is never overwritten; a session created with `initial_events` is named the
same way, in the same request.

## Routes

| method   | path                                      | what it does                                                         |
| -------- | ----------------------------------------- | -------------------------------------------------------------------- |
| `GET`    | `/health`                                 | liveness; open, like `/v1/auth-config` below                         |
| `GET`    | `/v1/auth-config`                         | unauthenticated: which providers are on, and whether dev login is    |
| `GET`    | `/v1/me`                                  | the signed-in user                                                   |
| `POST`   | `/v1/agents`                              | create an agent                                                      |
| `GET`    | `/v1/agents`                              | list agents, oldest first                                            |
| `GET`    | `/v1/agents/{agent_id}`                   | read one agent                                                       |
| `POST`   | `/v1/agents/{agent_id}`                   | update an agent; sessions already created keep their snapshot        |
| `POST`   | `/v1/sessions`                            | create a session that snapshots an agent                             |
| `GET`    | `/v1/sessions`                            | list sessions, newest first (`agent_id` filters)                     |
| `GET`    | `/v1/sessions/{session_id}`               | read one session                                                     |
| `POST`   | `/v1/sessions/{session_id}/events`        | append user events; the server owns every other event type           |
| `GET`    | `/v1/sessions/{session_id}/events`        | read the log, with `types[]`, `after_seq`, `limit` and `page`        |
| `GET`    | `/v1/sessions/{session_id}/events/stream` | follow it live over SSE; `event_deltas[]` opts into a reply's chunks |
| `POST`   | `/v1/sessions/{session_id}/ai-sdk/chat`   | AI SDK `useChat` compatibility — an extension, not the protocol      |
| `PUT`    | `/v1/provider-credentials/{provider}`     | add or replace the caller's credential for a provider (write-only)   |
| `GET`    | `/v1/provider-credentials`                | list the caller's credential metadata; never the secrets             |
| `DELETE` | `/v1/provider-credentials/{provider}`     | delete one; answers `204` with no body                               |

Every `/v1` resource belongs to the caller and is scoped to them.

List endpoints answer `{ data, next_page }`; `next_page` is an opaque cursor handed back as
`page`, and `null` means there is nothing more.

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

### Claims, chunks and superseding (D9)

The log is immutable: once an event is appended no field of it changes, and the only deletion
is compaction ([issue #46](https://github.com/amirtuval/openharness/issues/46)). Four fields
carry that:

- Three event types list `consumes`, the ids of the user events they claim: a
  `span.model_request_start` claims the `user.message`s its request folds in (and `model`, the
  `provider/model` that served it); a `span.model_request_end` claims the `user.interrupt`s that
  cut its request short; a `session.status_idle` claims the `user.interrupt`s a turn that had
  nothing running ended on. The claim _is_ that append: an event already consumed by one event
  cannot be consumed again. `processed_at` stays in the payload and is derived on read from the
  claim that took the event.
- `event_start` and `event_delta` are **stored events**, with `id`, `seq` and `processed_at`
  like any other — a reply in flight is part of the log, so reconnecting mid-reply is
  `after_seq` / `last-event-id` alone. They keep the names and shapes of Anthropic's previews,
  and a connection that asked for `event_deltas[]=agent.message` gets them live; there is no
  second, envelope-less form.
- The event that finishes a reply — the `agent.message`, or the `span.model_request_end` that
  closes a request that stored none (an interrupt, a brain that died, a reply that streamed no
  text) — carries `supersedes: { from_seq, to_seq }`, the chunk range it replaces, inclusive
  and with `from_seq <= to_seq`. **Replay skips superseded chunks**, so a resumed client sees
  the reply once, whole. The chunks stay for a retention window and are then deleted by
  compaction; whether compaction has run is invisible to a reader.

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

An interrupt that arrives with nothing running is claimed by the `session.status_idle` that
ends the turn — no span is opened for it, because no model request runs:

```json
{"type":"user.interrupt","id":"sevt_…","seq":7,"processed_at":null}
{"type":"session.status_running","id":"sevt_…","seq":8,"processed_at":"…"}
{"type":"session.status_idle","id":"sevt_…","seq":9,"processed_at":"…",
 "stop_reason":{"type":"end_turn"},"consumes":["sevt_…"]}
```

`consumes`, `model` and `supersedes` are optional in the schema so that a log written before
D9 keeps validating; from phase P3 on the server writes them on every event that takes them
(and from P4 on, `consumes` on all three claim sites).

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
`agent.message` when the turn ends. The chunks are stored events and nothing else: the
envelope-less previews a pre-D9 server published were removed in P4, when nothing wrote them
any more.

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
  # → {"providers":["github","google"],"dev_login":false}
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
  `authentication_error` with status `401`. `/health` is the only route that never asks.
- **Everything belongs to the user who created it.** Agents and sessions carry a read-only
  `owner_id`; a resource that belongs to another user answers **`404`**, not `403`, so its
  existence never leaks. Nothing is shared and no request ever carries an owner.
- The static `OPENHARNESS_API_KEY` / `x-api-key` scheme of v1 is gone; provider keys live in
  encrypted settings, below.

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

### Provider credentials

The server has no model-provider keys of its own — each user stores their own, and the API is
**write-only**. A credential goes up once, is stored encrypted, and only metadata ever comes
back:

```bash
curl -X PUT localhost:3000/v1/provider-credentials/anthropic \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"api_key","api_key":"sk-ant-…"}'
# → 200 {"id":"pcred_01J…","type":"api_key","provider":"anthropic","last4":"…xYz9",
#        "created_at":"…","updated_at":"…","validated_at":"…"}

curl localhost:3000/v1/provider-credentials -H "Authorization: Bearer $TOKEN"
# → {"data":[ …the same metadata… ]}

curl -X DELETE localhost:3000/v1/provider-credentials/anthropic \
  -H "Authorization: Bearer $TOKEN"
# → 204
```

- **Write-only.** `api_key` is accepted on the `PUT` and never returned, logged, put in an
  event or repeated in an error. `last4` exists so a settings screen can tell two keys apart.
- **Validated on save** with one cheap provider call; a key the provider rejects is an
  `invalid_provider_credential` with status `422`, and nothing is stored.
- One credential per provider per user; `PUT` replaces it. Deletion is immediate.
- `type` is a discriminated union that has only `api_key` today (Bedrock, Vertex and Azure
  credentials come later); the provider is the Mastra router name (`anthropic`, `openai`, …).
- A turn whose model's provider has no stored credential fails with a `session.error` whose
  type is `missing_provider_credential` — non-retryable, the message names the provider. The
  server never falls back to provider keys from the environment.

## Errors

| status | type                          | when                                                                                    |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------- |
| 400    | `invalid_request_error`       | the request does not match the protocol's schemas                                       |
| 401    | `authentication_error`        | not signed in, or the session or bearer token is invalid/expired                        |
| 404    | `not_found_error`             | the id names nothing, the route does not exist, or the resource belongs to another user |
| 422    | `invalid_provider_credential` | a provider credential failed validation on save                                         |
| 500    | `api_error`                   | an unexpected server failure — never a stack trace                                      |
