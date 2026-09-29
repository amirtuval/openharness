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

| method | path                                      | what it does                                                    |
| ------ | ----------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/health`                                 | liveness; the only route that never needs a key                 |
| `POST` | `/v1/agents`                              | create an agent                                                 |
| `GET`  | `/v1/agents`                              | list agents, oldest first                                       |
| `GET`  | `/v1/agents/{agent_id}`                   | read one agent                                                  |
| `POST` | `/v1/agents/{agent_id}`                   | update an agent; sessions already created keep their snapshot   |
| `POST` | `/v1/sessions`                            | create a session that snapshots an agent                        |
| `GET`  | `/v1/sessions`                            | list sessions, newest first (`agent_id` filters)                |
| `GET`  | `/v1/sessions/{session_id}`               | read one session                                                |
| `POST` | `/v1/sessions/{session_id}/events`        | append user events; the server owns every other event type      |
| `GET`  | `/v1/sessions/{session_id}/events`        | read the log, with `types[]`, `after_seq`, `limit` and `page`   |
| `GET`  | `/v1/sessions/{session_id}/events/stream` | follow it live over SSE; `event_deltas[]` opts into previews    |
| `POST` | `/v1/sessions/{session_id}/ai-sdk/chat`   | AI SDK `useChat` compatibility — an extension, not the protocol |

List endpoints answer `{ data, next_page }`; `next_page` is an opaque cursor handed back as
`page`, and `null` means there is nothing more.

## Events

The log is the source of truth, and `seq` is the order it happened in: `1`, `2`, `3`, per
session. It is also the SSE `id` and the resume position, so a client that reconnects with
`last-event-id: 7` gets `8` next — never `7` twice, never a gap.

| event                        | who writes it | what it means                                         |
| ---------------------------- | ------------- | ----------------------------------------------------- |
| `user.message`               | the client    | a message, until the brain claims it (`processed_at`) |
| `user.interrupt`             | the client    | stop the turn in flight                               |
| `agent.message`              | the brain     | a reply, under the `sevt_` id its previews announced  |
| `session.status_running`     | the brain     | a turn started (also after a retry)                   |
| `session.status_idle`        | the brain     | the turn ended; the session is waiting for input      |
| `session.status_rescheduled` | the brain     | a transient failure; it is retrying                   |
| `session.error`              | the brain     | what went wrong, and whether it is retrying           |
| `span.model_request_start`   | the brain     | a model request began                                 |
| `span.model_request_end`     | the brain     | it finished, with `model_usage` and any error         |

`event_start` and `event_delta` are stream-only: they never enter the log, and they carry no
`seq`. They preview an `agent.message` under the id it will be stored as, which is how a UI
renders a reply while it is still being written and then swaps in the real event.

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

### Reloading mid-reply

`event_start` and `event_delta` go only to the connections attached when they are published, so
a client that connects while a reply is streaming would otherwise render it from the first
delta it caught — a message that begins mid-word until the stored `agent.message` arrives at
the end of the turn.

A connection that asked for `agent.message` previews is given what it missed instead: after the
replay, and before the live events, the server sends the `event_start` of the reply in flight
and **one** `event_delta` carrying the whole text accumulated so far (`index: 0`). Deltas that
follow continue from there, and the stored `agent.message` — the same `sevt_` id — replaces the
preview as it always does. A delta that arrives while that snapshot is being read is not
delivered twice.

## Authentication

With `OPENHARNESS_API_KEY` set, every `/v1/*` request needs it:

```bash
curl localhost:3000/v1/agents -H "x-api-key: $OPENHARNESS_API_KEY"
```

`/health` never needs it. Without the variable the API is open, which is what a single-binary
deployment behind its own front door wants.

## Errors

| status | type                    | when                                               |
| ------ | ----------------------- | -------------------------------------------------- |
| 400    | `invalid_request_error` | the request does not match the protocol's schemas  |
| 401    | `authentication_error`  | missing or wrong `x-api-key`                       |
| 404    | `not_found_error`       | the id names nothing, or the route does not exist  |
| 500    | `api_error`             | an unexpected server failure — never a stack trace |
