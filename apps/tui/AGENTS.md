# @openharness/cli

The openharness terminal UI: an Ink (React) chat client, installed as the `oh` command. It
talks to the server through `@openharness/client` only — the same client the web app uses —
so there is no second transport to keep honest.

## Commands

Run from this folder (`apps/tui`):

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

## The `oh` command

| command                                 | what it does                                       |
| --------------------------------------- | -------------------------------------------------- |
| `oh`                                    | start a new chat, asking which model to run        |
| `oh -s <id>` / `--session <id>`         | resume a session, showing its history              |
| `oh -c` / `--continue`                  | resume the most recent session                     |
| `oh sessions`                           | list every session: id, title, status, updated     |
| `oh agents`                             | list the saved agents (optional presets): id, name |
| `oh login`                              | sign in through the browser (the device flow)      |
| `oh logout`                             | revoke the session on the server, forget the token |
| `oh whoami`                             | print the signed-in email and server               |
| `oh -v` / `--version`, `oh -h`/`--help` | print and stop                                     |

Global flags: `--server <url>`, `--debug`; `oh login` also takes `--no-browser`. The chat
flags are `-s`/`-c`, `--agent` and `--model`; the other commands take none of them.

Exit codes: `0` did what it was asked (including a chat the user ended, and a `logout` whose
server-side revoke could not be reached — the token is still gone locally); `1` the server,
the network or the sign-in state said no — a 401 is the not-signed-in error described under
"Signing in" below, and an account with no provider keys ends there too, as "Choosing a
model" describes; `2`
the command line or the configuration was wrong (including an unusable config or credentials
file, named in the message) — and also a chat asked for without a terminal, since stdin has
to be a TTY to read a key; and `130`/`143` when the process was signalled, which is also how
a running `oh login` is cancelled.

Unknown flags are errors, not positionals: `node:util`'s `parseArgs` runs in strict mode, the
message goes to stderr, and the exit code is `2`.

### Configuration precedence

Highest first:

1. `--server`
2. `OPENHARNESS_URL`
3. `~/.config/openharness/config.json` (or `$XDG_CONFIG_HOME/openharness/config.json`, which
   is ignored when it is not an absolute path): `{ "server": "http://localhost:3000" }`
4. `http://localhost:3000`

A missing config file is fine. A file that exists and does not parse, holds the wrong types,
or names a key that does not exist is an error (exit `2`) naming the file and the problem. An
empty environment variable counts as unset. `oh login` is the only way in.

### Signing in

`oh login` runs the device flow (RFC 8628) through `client.auth`: it asks for a code, prints
the sign-in URL and the user code (always, in that order — SSH and CI have no browser to
open), opens the browser at `verificationUriComplete` (falling back to `verificationUri`)
unless `--no-browser` is given, there is no display (`DISPLAY` and `WAYLAND_DISPLAY` both
unset on Linux), `CI` is set, or the session is an SSH one. `xdg-open` / `open` / `start` per
platform, detached; a command that is not installed does not fail the login, because the
printed URL is the fallback. Then it polls at the server's interval until approval —
`authorization_pending` and `slow_down` are handled by the client — and, on success, prints
`Logged in as <email> on <server>` from `client.me()`.

The session token is stored **per server URL** in
`~/.config/openharness/credentials.json` (XDG rules as for the config file):

```json
{ "servers": { "http://localhost:3000": "<session token>" } }
```

The file is written atomically (a temp file beside it, then a rename), with permissions
`0600`; the directory is created `0700`. A missing file is fine; a file that exists and
cannot be used is an error (exit `2`) naming it. Every other command — chat, `sessions`,
`agents`, `-c`, `-s` — sends the token for the selected `--server` as `Authorization: Bearer`
and answers a 401 with this line, on stderr, and exit `1`:

```
oh: not signed in to <server>. Run `oh login`.
```

`oh logout` revokes the token on the server (`client.auth.signOut()`), then deletes it
locally. If the server cannot be reached, the token is still deleted locally and a warning
goes to stderr; the exit code stays `0`. `oh whoami` prints the same `Logged in as <email> on
<server>` line, or the not-signed-in error. Ctrl+C during `oh login` aborts the poll, prints
`oh: login cancelled.` and exits `130` (`143` for `SIGTERM`). Expired codes and denied
logins are reported with their own one-liners, exit `1`.

A chat is not exempt once it is open: a session revoked while `oh` is in it — `oh logout`
from another terminal, a sign-out in the browser — closes the server's stream within about a
second; the client's reconnect is then refused with a 401, which ends the stream loop rather
than retrying. The chat shows the not-signed-in error, the same one any 401 gets.

### Choosing a model

Chatting is model-first (epic #92): a new chat picks a **model**, not an agent. In order:

1. `--model <provider/model>` names the model directly and skips the picker: the catalog is
   not even read, because the router accepts models the catalog does not know (C5).
2. `--agent <id|name>` starts from a saved agent preset instead, matched against every agent
   the server has — by id, then exact name, then case-insensitive name, and an ambiguous
   match is an error rather than a guess. A value shaped like an `agent_…` id is read
   straight from the server first (`agents.get`): one request instead of a walk, with a
   value that misses that way still matched by name. `--model` beside `--agent` overrides
   the preset's model — the protocol's own combination. This CLI does not create agents.
3. Otherwise a **model picker**, fed by `client.models.list()`: the chat models the user's
   own provider keys can use, grouped by provider, each row showing the display name and
   the context window, and a last row, "Other model id…", that takes a free-text
   `provider/model` id. Up/down move, Enter picks, the number keys pick directly, Ctrl+C
   leaves; the list is windowed to ten rows and scrolls with the cursor, and the numbers
   are positions in the whole list (and are off past nine rows, where "12" would choose 1).
4. With no provider keys at all — `client.models.list()` answers with no entries — there is
   nothing to chat with: `oh` prints where to add a key (the web app's Settings → Model
   providers) and exits `1`, the documented code for the server saying no.

The session is created with `{ model }` (`sessions.create`), so it is agent-less and runs
the chosen model; `--agent` sessions still name their preset.

`--session` and `--continue` win over everything: they name the session to resume, whatever
agents or models exist.

### Reading a list to the end

`oh agents`, `oh sessions` and the list `--agent` matches against are the whole list, not
its first page: `src/paging.ts` asks for `limit: MAX_PAGE_LIMIT` and follows
`page: next_page` until the server answers `null`. A cursor is opaque — handed back byte for
byte, never decoded. The walk stops at a cursor the server has already handed out (a server
that repeats itself cannot be paged past) and fails after `MAX_LIST_PAGES` requests rather
than returning a list that is silently short, because a short list is how an agent the
server has comes to be reported as missing. `--continue` is the exception: `limit: 1`, the
newest session, which is on the first page by construction.

The model picker needs no paging: `GET /v1/models` answers with the whole catalog in one
response. It draws ten rows at a time, with the window following the cursor and the rows it
leaves out counted above and below (`↑ 35 more`); a number key picks only while the list is
at most nine long, with the same "12" rule as before.

## In the chat

| key               | what it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| Enter             | send — also while a reply streams, which is what steering is |
| Ctrl+J, Alt+Enter | insert a newline                                             |
| ←/→, Home/End     | move the cursor; Backspace deletes behind it, Delete at it   |
| Ctrl+C            | interrupt the running turn; pressed again when idle, leave   |

"Shift+Enter" is not a key a terminal can send — most send the same `\r` for both — so the
newline is bound to **Ctrl+J** (line feed, `0x0A`, against Enter's `0x0D`), which every
terminal can send and none confuses with Enter, and to **Alt+Enter** (`ESC` + `\r`) for muscle
memory. A paste arrives as one chunk and is inserted verbatim, newlines included.

On the way out the CLI prints `Resume this session with: oh -s <id>`.

### Terminal hygiene

Ink restores raw mode and the cursor when it unmounts, and the CLI unmounts on every path out:
the second idle Ctrl+C, the picker's Ctrl+C, an error screen, a `SIGINT`/`SIGTERM`/`SIGHUP`,
and a `process.once('exit')` net for anything else — including an exception thrown out of the
run. `restoreTerminal()` (raw mode off, cursor shown) backs all of it up and is idempotent, so
a signal that arrives mid-unmount cannot leave a shell that stopped echoing. Streamed text
never repaints the scrollback: settled messages go through Ink's `<Static>`, and only the live
tail — the message being streamed, the status line, the prompt — is redrawn.

## Structure

```
src/
  index.tsx              the bin: run(argv) → exit code, signals, terminal restore
  app.tsx                the top-level screen: resolve the session, then chat
  args.ts                parseArgs: commands, flags, usage errors
  config.ts              flags > env > config file > default, and its errors
  credentials.ts         credentials.json: one token per server, atomic, 0600
  browser.ts             open the sign-in page (xdg-open / open / start), and when not to
  errors.ts              ApiError / fetch failures → a message and hints
  help.ts                the --help text
  signals.ts             SIGINT/SIGTERM/SIGHUP → handlers, and a disposer
  terminal.ts            restoreTerminal: raw mode off, cursor shown
  version.ts             the version injected at build time
  paging.ts              listAll: walk next_page to the end of an agents/sessions list
  chat/
    session.ts           the runtime: transcript + stream + send/interrupt/dispose
    screen.tsx           the chat screen (transcript, status line, prompt)
    target.ts            which session to open, and the model/agent-selection rules
    ctrl-c.ts            the Ctrl+C rules (interrupt / arm / exit)
  components/            message-view, transcript-view, status-line, prompt-input,
                         notice-view, model-picker
  commands/list.ts       `oh sessions` / `oh agents`
  commands/auth.ts       `oh login` / `oh logout` / `oh whoami`
  dev/fake.ts            OPENHARNESS_FAKE: the fake client, seeded, dev only
  test-support/          test-only helpers (fake clients, keystrokes, frame waits)
```

## Fake mode (dev only)

```bash
OPENHARNESS_FAKE=1 yarn dev     # or: OPENHARNESS_FAKE=1 node dist/index.js
```

`OPENHARNESS_FAKE=1` makes `oh` run against `createFakeClient()` from
`@openharness/client/testing` instead of a server: no network, no model, scripted replies that
stream in. The fake is seeded with a three-provider model catalog
(`DEV_MODELS`) so a new chat's picker has groups and context windows to show, three agents
for `oh agents` and the `--agent` path, a scripted conversation, and a session with history
behind it for `--continue` and `-s <id>`. It is a development and QA aid — the entry point is loaded lazily, so a normal `oh`
never reads it, and nothing in this package enables it on its own. See `src/dev/fake.ts`.

The auth commands run against the fake too: `oh login` asks it for the (deterministic) codes,
polls it once, and stores its `FAKE_SESSION_TOKEN` in the real credentials file — point
`XDG_CONFIG_HOME` at a scratch directory when you do that by hand. `oh logout` signs the fake
out; `oh whoami` reads what the login stored.

## Public API

| `@openharness/cli` | `PACKAGE_NAME`, `App`, `parseArgs()`, `readVersion()`, `run()`, `createChatSession()`, `resolveConfig()`, `describeError()` |
| `oh` (bin) | the commands above |

The version is injected at build time from `package.json` as `__CLI_VERSION__`
(see `tsdown.config.ts` and `vitest.config.ts`), so `oh --version` works from any
working directory and cannot drift from `package.json`.

## Testing

`src/**/*.test.ts(x)` with Vitest (jsdom, which is what `reactVitestTestConfig` gives this
package) and `ink-testing-library`: the app is rendered into a frame and asserted on, so no TTY
is needed. The component tests drive the real client interface through `createFakeClient()`,
plus `src/test-support/` for keystrokes and frame waits — the same fake the web app tests
against, so a rule that changes on the server side fails here too. `src/test-support/fake.ts`
also seeds long lists and serves them a page at a time (`seedAgents`, `pagedAgents`,
`pagedSessions`), for the tests where the first page is not the whole list. Everything else
(args, config precedence, error mapping, the Ctrl+C rules, the transcript-driven runtime) is
tested without Ink at all.

The auth side is tested at both levels: `src/credentials.ts` against a temp directory (the
atomic write, `0600`/`0700`, per-server tokens, the errors a broken file produces),
`src/browser.ts` with an injected spawn (the CI / SSH / no-display skips and the per-platform
command), and `src/commands/auth.ts` against the fake's scripted device flow (approval, expiry,
denial, cancellation, revoke failures); `src/index.test.ts` drives `run()` all the way through
`login` / `whoami` / `logout` with `XDG_CONFIG_HOME` pointed at a temp directory.

| file                                              | covers                                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/index.test.ts`                               | `run()` end to end: the exit codes, login / whoami / logout, signals        |
| `src/args.test.ts`                                | `parseArgs` and `readVersion`: every command, unknown and conflicting flags |
| `src/config.test.ts`                              | the precedence chain, and the errors a bad config file produces             |
| `src/credentials.test.ts`                         | the credentials file: atomic write, `0600`/`0700`, per-server tokens        |
| `src/browser.test.ts`                             | the skip rules and the per-platform command, with an injected spawn         |
| `src/commands/auth.test.ts`                       | `oh login` / `logout` / `whoami` against the fake's scripted device flow    |
| `src/commands/list.test.ts`, `src/paging.test.ts` | the two listings, their formatting, and the `next_page` walk                |
| `src/chat/session.test.ts`                        | the runtime: transcript, stream, send, interrupt, dispose                   |
| `src/chat/target.test.ts`                         | session/model/agent selection, and the paging it needs                      |
| `src/chat/ctrl-c.test.ts`                         | the Ctrl+C rules: interrupt, arm, exit                                      |
| `src/components/model-picker.test.tsx`            | the picker: windowing, number keys, the free-text row                       |
| `src/app.test.tsx`                                | the Ink screens through `ink-testing-library` and `createFakeClient()`      |
| `src/errors.test.ts`                              | `describeError`: the 401 line, the connection hints, `--debug`              |
| `src/signals.test.ts`, `src/terminal.test.ts`     | the signal handlers and `restoreTerminal`                                   |
| `src/dev/fake.test.ts`                            | the fake-mode gate and the seeded dev client                                |

Two things worth knowing before writing a test here:

- `waitForScreen` waits for a frame _and_ a tick: Ink writes the frame before React runs the
  passive effect that subscribes `useInput`, so a key pressed the instant a screen appears is
  a key nobody hears. A person cannot type that fast; a test can.
- Keystrokes must be written one at a time (`typeText`): a chunk with several characters is a
  paste, and the prompt inserts pastes verbatim, `\r` included.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/client` (including its `@openharness/client/testing` subpath, for dev mode and
  for tests)

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/tui/docs/`.
