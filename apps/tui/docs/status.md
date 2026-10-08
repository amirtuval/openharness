# What the screen says: the status line, the working indicator, per-reply metadata

Three pieces of the chat answer "what is going on?" without the reader having to ask: the one
line above the prompt, the thing that moves while the agent works, and the dim footnote under
each reply that says what it cost. This is issue #208 (epic #201), and it builds on the
metadata the transcript already carries (#202, X1) and the rendering rules the transcript
already follows (#205, X2 and X4).

The bottom of the screen is one section, and #233 gave it its edges: the metadata is a footer
under the reply rather than its last line, and a dim rule separates the console — the status
line, the prompt and whatever takes the prompt's place — from the conversation above it. See
[The bottom of the screen](#the-bottom-of-the-screen) for the whole rhythm.

## The status line

One line, in this order:

```
Reviewer · Claude Sonnet 5 · sesn_…Q092B1 · ⠋ Working… 12s · fake client (dev)
```

| part        | what it is                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| the agent   | the agent the session snapshotted; absent for a model-first session (#93, #95)                                                         |
| the model   | the model the session **will** run — a `/model` pick that has not been sent yet replaces it, with `(next message)` after it (#116, U3) |
| the session | a handle, not the id: see below                                                                                                        |
| the status  | the session's state, or what the working indicator has to say (below)                                                                  |
| the banner  | dev-only context, e.g. `fake client (dev)`                                                                                             |

### The model is named the way the catalog names it

`Claude Sonnet 5`, not `anthropic/claude-sonnet-5` — when the catalog is known
(`modelLabel`). "When it is known" is the honest half of that: a chat started with `--model`
or on a stored default **never reads the catalog**, which is what makes it start immediately
(#114, U1), so the id is what there is until a `/model` pick loads the list. The app hands the
chat the catalog it happened to read while resolving the target, and the picker adds the one
it reads later; nothing is fetched for the sake of the line.

### The session id is a handle

A session id is a ULID — 31 characters, most of them a timestamp — so the line shows
`sesn_…` and the last six (`shortSessionId`): the tail is what tells two sessions apart, and
the length is what does not fit. It is for **recognising** the session on screen, not for
typing: `oh -s` wants the whole id, which the CLI prints on the way out. A partial id would be
answered with a 404, so the line never pretends to be one.

### It is laid out to the terminal, and things are dropped, not wrapped

Parts go whole, least valuable first, until what is left fits the width — the banner, then the
session, then the model; the status is what is left. Half a part (`Claude Sonne… · sesn_…`) is
neither a fact about the chat nor a readable one. If even the status does not fit, it is
truncated with an ellipsis rather than wrapped: a status line that became two lines would push
the prompt down as the spinner turned.

### Colours are the terminal's

The chrome is dim and in no colour of its own; the status is drawn in a **named** ANSI colour
when it has something to say — `yellow` for a turn that is working or retrying, `red` for one
that was interrupted — and dim the rest of the time. `NO_COLOR` drops the colour entirely and
keeps the words (#201, X4). The palette is `PALETTE` in `../src/markdown/theme.ts`, the same
one the message view draws from.

## The working indicator

Nothing on screen moves until text arrives, and a model can take a while to produce the first
token. So the status field is not the bare word `running` while a turn works:

| state       | the field says                                        | spinner |
| ----------- | ----------------------------------------------------- | ------- |
| nothing yet | `Working… 0s`, `Working… 12s` — the turn's age        | yes     |
| streaming   | `running`                                             | no      |
| quiet > 3 s | `Working… 12s` again — the turn is still the same age | yes     |
| retrying    | `Retrying… the model is overloaded`                   | yes     |
| interrupted | `Interrupted`                                         | no      |
| idle        | `idle`                                                | no      |

- **The clock** is the turn's, not the local one: `runningSince` is the `session.status_running`
  event's own `processed_at`, so `oh -s` into a session that has been running for a minute says
  `Working… 1m 5s` rather than `Working… 0s`. It is cleared by `session.status_idle`, because
  an elapsed time is about one turn and the next one starts its own. `lastTextAt` is the last
  delta's or stored reply's `processed_at`, and the quiet rule reads it
  (`WORKING_QUIET_MS`, 3 s).
- **The spinner** is ten braille frames on a `setInterval`, no dependency (`SPINNER_FRAMES`).
  While the indicator is _not_ showing but the turn is running, there is no interval at all —
  one `setTimeout` is armed for the moment the quiet window is up, so a reply that is streaming
  steadily costs no timer.
- **The timer lives in `StatusLine`**, not in the chat screen. That is the point: a timer that
  re-rendered the screen would re-render the transcript with it ten times a second, and the
  transcript is the one thing X2 is careful about. The component re-renders; nothing above it
  does.
- **Interrupted** is the client's own knowledge, not the log's: it is set when Ctrl+C asks the
  server to stop (`ChatSession.interrupt`) and cleared by the next turn or the next send. The
  protocol has no stop reason for an interrupt (`StopReasonSchema` is only `end_turn`), and the
  span error that _does_ say `interrupted` is not something the transcript keeps.
- **A retrying turn is the status line's news**: the reason appears here and the notice line
  for it goes away, because two lines about one thing is one too many. An error the status
  line cannot say — one that ended its turn, or one read back out of history — keeps its
  notice.

## Per-reply metadata

Every settled agent reply gets one dim line under it, at column 0 with its text (#229), set off
by **a blank line** (#233), so it reads as a footer to the reply rather than as a last line of
it:

```
The file has three callers.

openai/gpt-4.1-mini · 4.2s · 1.3k tokens
```

…which for a reply on the model the session already runs is just `4.2s · 1.3k tokens` — the
common case, and the one that says nothing the status line has not already said.

- **The model only when it is news**: a reply that ran on the session's own model, or on the
  one the reply before it ran, says nothing — the status line above is already showing that.
  What is left is a genuine change, and there the `provider/model` id is the informative thing.
- **The duration** (`formatDuration`) counts in milliseconds below a second (`450ms`), keeps a
  decimal below ten seconds (`4.2s`, where the difference between 1.4 and 2 is worth reading),
  rounds above (`12s`), and reads in minutes past a minute (`1m 5s`). The transcript's
  `durationMs` already runs from the turn's first request start to its last request end, so a
  retried reply reports the time a reader really waited.
- **The tokens** (`formatTokens`) are the reply's total (`1.3k`, `12k`, `1.2M`).
- **Nothing is invented** (#201, X1): a field the log does not have is left out, and a reply
  with nothing to say — no model change, no duration, no tokens — has **no line at all**.
  `0` is a number a model really reported and is printed as one.

### Why the line needs a hold

`<Static>` writes a message once and never redraws it (X2), and a reply's metadata arrives
_after_ the reply: the stored `agent.message` lands first, and the
`span.model_request_end` that carries the duration and the tokens follows in a later event —
often a later batch. A reply that settled in between would be written to the scrollback before
its metadata existed, and the line could never appear.

So a reply is not settled until its metadata has landed **or** its turn has gone idle:

- `ChatSession` derives `awaitingMetaId` from the transcript's `pendingRequests` — the
  transcript tracks a model request until its span end folds that request into the reply, so
  the last request that names a message is a reply whose metadata is on its way.
- `TranscriptView` takes that id as `holdLive` and keeps that one message in the live area.
  Holding it is what lets the metadata line arrive in the same `<Static>` write as the reply
  it belongs to.
- The hold ends when the span end lands, or when the turn ends — an idle empties the pending
  requests — so a log with no span events at all (a session written before epic #201) still
  settles, one turn later.

## The bottom of the screen

The console is one section, and the reader can see where it starts (issue #233):

```
Chaining iterator methods like filter, map, and sum is idiomatic Rust: …

7.3s · 347 tokens

────────────────────────────────────────────────────────
openai/gpt-6-astra · sesn_…N89SKV · idle
❯
```

- **The rule** is what says the conversation ends here: it is drawn from column 0, in the
  `chrome` named colour and dim, like every other piece of structure the transcript draws (X4),
  and it stops one column short of the terminal because the transcript reserves that column for
  its streaming cursor (`CURSOR_COLUMNS`) — the two agree about the right edge, and the rule is
  never a line exactly as wide as the terminal. Under `NO_COLOR` it is the plain `─` it always
  was: a rule is a character, not a surface.
- **Everything the console is renders under it**: the status line, the prompt, the command menu
  (`/`), whatever flow has taken the input area over (`prompt-slot.tsx` — the model picker,
  `/providers`), and the hidden key input. They are one section because they are one thing:
  what the user is looking at while typing.
- **Everything below the rule is still wiped by Ctrl+L**, and the status line's clock is
  unaffected by any of this: the rule is drawn once and never ticks.

### One blank line, everywhere

The blank line above the rule belongs to the _section_, and like every other blank line in the
transcript it is drawn by whoever needs it and only when it is not already there:

| above the section                           | the blank line comes from                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| an agent's reply (with or without a footer) | the input section (`InputRule`'s `blankAbove`)                                                      |
| a user's message                            | the band, whose own blank line ends it (#229)                                                       |
| a notice (`error: …`, `/help`, a hint)      | the input section — a notice never ends in one                                                      |
| a reply that has not said anything yet      | the band or reply above it: a message with nothing in it draws nothing, so it is not a block (#233) |

The same rule holds between messages: one blank line, never two, and none at the top of a
session. `app.test.tsx` holds the whole rhythm still — reply → blank → metadata → blank → rule
→ status → prompt — because whether each piece's own blank line adds up to one or two is a fact
about the screen rather than about any one component.

## Queued messages

A steering message — one sent while a reply is still streaming — is _queued_ until the request
that folds it in claims it (`consumes`, P3/P4). Until then it is drawn dimmed, whole, with
`(queued)` after it; both go away the moment it is delivered (`MessageView`, and `pending` in
`TranscriptMessage`). It keeps its place in the conversation while it waits.
