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

| method | path                                      | what it does                                                         |
| ------ | ----------------------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/health`                                 | liveness; the only route that never needs a key                      |
| `POST` | `/v1/agents`                              | create an agent                                                      |
| `GET`  | `/v1/agents`                              | list agents, oldest first                                            |
| `GET`  | `/v1/agents/{agent_id}`                   | read one agent                                                       |
| `POST` | `/v1/agents/{agent_id}`                   | update an agent; sessions already created keep their snapshot        |
| `POST` | `/v1/sessions`                            | create a session that snapshots an agent                             |
| `GET`  | `/v1/sessions`                            | list sessions, newest first (`agent_id` filters)                     |
| `GET`  | `/v1/sessions/{session_id}`               | read one session                                                     |
| `POST` | `/v1/sessions/{session_id}/events`        | append user events; the server owns every other event type           |
| `GET`  | `/v1/sessions/{session_id}/events`        | read the log, with `types[]`, `after_seq`, `limit` and `page`        |
| `GET`  | `/v1/sessions/{session_id}/events/stream` | follow it live over SSE; `event_deltas[]` opts into a reply's chunks |
| `POST` | `/v1/sessions/{session_id}/ai-sdk/chat`   | AI SDK `useChat` compatibility — an extension, not the protocol      |

List endpoints answer `{ data, next_page }`; `next_page` is an opaque cursor handed back as
`page`, and `null` means there is nothing more.

## Events

The log is the source of truth, and `seq` is the order it happened in: `1`, `2`, `3`, per
session. It is also the SSE `id` and the resume position, so a client that reconnects with
`last-event-id: 7` gets `8` next — never `7` twice, never a gap.

| event                        | who writes it | what it means                                          |
| ---------------------------- | ------------- | ------------------------------------------------------ |
| `user.message`               | the client    | a message, until the brain claims it                   |
| `user.interrupt`             | the client    | stop the turn in flight                                |
| `agent.message`              | the brain     | a reply, under the `sevt_` id its chunks announced     |
| `session.status_running`     | the brain     | a turn started (also after a retry)                    |
| `session.status_idle`        | the brain     | the turn ended; the session is waiting for input       |
| `session.status_rescheduled` | the brain     | a transient failure; it is retrying                    |
| `session.error`              | the brain     | what went wrong, and whether it is retrying            |
| `span.model_request_start`   | the brain     | a model request began, and the messages it claims      |
| `span.model_request_end`     | the brain     | it finished — usage, any error, the interrupts it ends |
| `event_start`                | the brain     | a reply started streaming — a stored chunk since D9    |
| `event_delta`                | the brain     | a streamed fragment of it — a stored chunk since D9    |

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
