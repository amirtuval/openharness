# openharness (the CLI)

The openharness terminal UI: an Ink (React) chat client, installed as the `oh` command. It
talks to the server through `@openharness/client` only — the same client the web app uses —
so there is no second transport to keep honest.

The package is published to npm as the unscoped, public **`openharness`** (#152) — the one
workspace whose name is not `@openharness/*`. The build is **one self-contained file**:
`dist/index.js` inlines the workspace packages and every third-party dependency, so the
published `package.json` has no runtime `dependencies` and `npm install -g openharness@next`
may replace the file under a running `oh` (that is the ground the D10 auto-update stands on).
See "Packaging" below.

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

| command                                 | what it does                                             |
| --------------------------------------- | -------------------------------------------------------- |
| `oh`                                    | start a new chat on the default model                    |
| `oh -s <id>` / `--session <id>`         | resume a session, showing its history                    |
| `oh -c` / `--continue`                  | resume the most recent session                           |
| `oh sessions`                           | list every session: id, title, status, updated           |
| `oh sessions delete <id>`               | delete a chat and everything in it (asks; `--yes` skips) |
| `oh agents`                             | list the saved agents (optional presets): id, name       |
| `oh default-model [provider/model]`     | print or set the model a new chat starts on              |
| `oh login`                              | sign in through the browser (the device flow)            |
| `oh logout`                             | revoke the session on the server, forget the token       |
| `oh whoami`                             | print the signed-in email and server                     |
| `oh update`                             | install the newest published version now                 |
| `oh -v` / `--version`, `oh -h`/`--help` | print and stop                                           |

Global flags: `--server <url>`, `--debug`; `oh login` also takes `--no-browser`, and
`oh sessions delete` takes `--yes`. The chat flags are `-s`/`-c`, `--agent` and `--model`;
the other commands take none of them (and reject them loudly).

Exit codes: `0` did what it was asked (including a chat the user ended, a chat that was
deleted elsewhere, a delete answer of "no", and a `logout` whose server-side revoke could
not be reached — the token is still gone locally); `1` the server,
the network or the sign-in state said no — a 401 is the not-signed-in error described under
"Signing in" below, and an account with no provider keys ends there too, as "Choosing a
model" describes; `2`
the command line or the configuration was wrong (including an unusable config or credentials
file, named in the message) — and also a chat asked for without a terminal, since stdin has
to be a TTY to read a key, and an `oh update` in an `oh` that is not a global npm install;
and `130`/`143` when the process was signalled, which is also how
a running `oh login` is cancelled.

Unknown flags are errors, not positionals: `node:util`'s `parseArgs` runs in strict mode, the
message goes to stderr, and the exit code is `2`.

### Configuration precedence

Highest first:

1. `--server`
2. `OPENHARNESS_URL`
3. `~/.config/openharness/config.json` (or `$XDG_CONFIG_HOME/openharness/config.json`, which
   is ignored when it is not an absolute path):
   `{ "server": "http://localhost:3000", "autoUpdate": true }`
4. `http://localhost:3000`

`autoUpdate` is the config file's own off switch for the background self-update (it defaults to
`true`); `server` is the only other key the file takes, and either may be left out. See
"Updating itself" below.

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

Chatting is model-first (epic #92) and starts on the **default model** (epic #116): a new
chat picks a model, not an agent, and usually picks it with no dialog at all. In order:

1. `--model <provider/model>` names the model directly and skips everything else — the
   default is not read and the catalog is not even fetched, because the router accepts
   models the catalog does not know (C5).
2. `--agent <id|name>` starts from a saved agent preset instead, matched against every agent
   the server has — by id, then exact name, then case-insensitive name, and an ambiguous
   match is an error rather than a guess. A value shaped like an `agent_…` id is read
   straight from the server first (`agents.get`): one request instead of a walk, with a
   value that misses that way still matched by name. `--model` beside `--agent` overrides
   the preset's model — the protocol's own combination. This CLI does not create agents.
3. Otherwise the **default model** (`client.preferences.get()`, U1) decides, and the chat
   opens on it immediately: the session is created with `{ model }` and no picker is drawn.
   The stored id wins even when the catalog is empty — it is the user's own choice, and
   free-text ids are allowed (the server validates the shape, not the catalog).
4. Only with no default either is there a **model picker**, fed by `client.models.list()`:
   the chat models the user's own provider keys can use, grouped by provider, each row
   showing the display name and the context window, and a last row, "Other model id…", that
   takes a free-text `provider/model` id. Up/down move, Enter picks, the number keys pick
   directly, Ctrl+C leaves; the list is windowed to ten rows and scrolls with the cursor,
   and the numbers are positions in the whole list (and are off past nine rows, where "12"
   would choose 1). After a pick, `oh` asks once — `Save <id> as your default model for new
chats? [y/N]` — and a `y` writes it with `preferences.put`; the chat opens either way,
   and a save that failed says so and steps aside on the next Enter.
5. With no provider keys at all — `client.models.list()` answers with no entries and there
   is no default — there is nothing to chat with: `oh` prints where to add a key (the web
   app's Settings → Model providers) and exits `1`, the documented code for the server
   saying no.

`oh default-model` prints the stored default (`Default model: …`, or that there is none and
a new chat will ask); `oh default-model <provider/model>` stores it and prints what the
server kept. The value is the one the web app's Settings show — it lives on the server
(`GET`/`PUT /v1/me/preferences`), so both frontends start a chat the same way.

`--session` and `--continue` win over everything: they name the session to resume, whatever
default, agents or models exist.

### Switching the model in a chat

`/model` typed into the prompt opens the same picker with the catalog. The choice is
**pending** rather than applied: the status line shows `<id> (next message)`, and the next
message carries it as `user.message.model` (`sendMessage(..., { model })`, U3). From then
on the session runs that model — later messages send no model — and the status line shows
the model the log last said the session runs (`transcript.model`, falling back to the
session's own). Switching provider mid-chat is supported; the history is rebuilt per
request. Ctrl+C in the picker closes it and changes nothing.

### Deleting a chat

`oh sessions delete <id>` asks `Delete chat <id>? This cannot be undone [y/N] ` (read from
stdin; a `y`/`yes`, any case, goes ahead and anything else — including end of input, so a
pipe nobody wrote to cannot delete — answers no and prints `Not deleted.`). `--yes` skips
the question. On success it prints `Deleted chat <id>.`; the server answers an unknown or
already-deleted id as `not found`, exit `1`.

A chat whose session is deleted while `oh` is in it — from the web app, another terminal —
receives the stream's final `session.deleted`, shows `This chat was deleted elsewhere.`,
and exits `0` without a resume hint: there is no session to resume, so printing one would
lie.

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

### Updating itself

The CLI is published to npm as `openharness` (#152) and installed with `npm i -g openharness`,
so there is no launcher to keep it current: it updates itself (epic #148, decision D10). The
ground it stands on is that the published package is one self-contained file — `npm install -g
openharness@<v>` may replace it on disk while the running copy keeps going, which is why the
running process is never the one that changes and the next run is simply the new version.

On startup — for every command except `--version`, `--help` and `oh update`, and before the
chat's Ink UI mounts or `oh login` starts its device flow, so a notice is never printed into a
screen — the updater does two things:

1. **The notice.** A finished install leaves its outcome in the state file; the next run prints
   it **once** and forgets it. A success is one line on stdout, `oh updated to v0.4.0`. A
   failure is one line on stderr — `oh could not update itself: <reason>; run npm i -g
openharness` — plus, when npm could not write to its global prefix, a hint about sudo or
   `npm config set prefix`.
2. **The check.** At most once an hour (`lastCheck` in the same state file), it asks `npm view
openharness version` in the background — never awaited, with a timeout — and if that version
   is newer (a small comparator in `semver.ts`, prereleases included, since the bundle cannot
   take a runtime dependency) starts a **detached** `npm install -g openharness@<v>`: a fresh
   `node` process, `unref`'d, its output redirected to the log file. The running process is
   untouched.

   "Never awaited" is not enough for "does not block": npm is spawned with its pipes and the
   timeout `unref`'d as well. A child's pipes are event-loop handles of their own, and with a
   `'data'` listener attached they hold a finished command open until npm exits — a second of
   npm before the shell prompt comes back, for a lookup nobody asked for. The check therefore
   simply does not finish for a command that exits first, which is why updates land during
   chats and logins and not during `oh agents`. A test proves it against a slow fake npm, by
   timing the process itself.

A detached child has no way to report back, so it is a tiny `node -e` program (`npm.ts`'s
`installWrapperSource`) that runs npm, waits for it, and writes npm's exit code and the tail of
its output into the state file, where the next run picks it up. The wrapper is spawned as
either CommonJS or ESM (the input type of `-e` depends on the nearest `package.json`), which is
why its imports are `await import()`.

Both files live in the CLI's config directory, beside `config.json` and `credentials.json`:

| file                              | what it holds                                                        |
| --------------------------------- | -------------------------------------------------------------------- |
| `…/openharness/update-state.json` | `lastCheck`, the cached global root, and the pending install outcome |
| `…/openharness/update.log`        | npm's output from the last detached install                          |

The auto-update is **off** when any of these says so:

- `OH_NO_AUTO_UPDATE` is set (blank, `0` and `false` do not count — the rule `CI` already gets);
- the config file sets `"autoUpdate": false`;
- `CI` is set;
- this `oh` is not a global npm install.

The last is the one that matters and it is deliberately two questions, because one of them is
free. The running bundle must sit at `<somewhere>/<module dir>/openharness/dist/index.js`
(reached through the `bin` symlink npm installs, so the check realpaths first) — which
`node apps/tui/dist/index.js` from this repo does not, and that answer costs nothing. Then that
module directory must be the one `npm root -g` names; only this needs npm, and its answer is
cached in the state file beside the `node` that produced it, so a checkout never spawns npm and
an installed `oh` spawns it at most once per node installation. A `realpath` that fails, a
missing `npm`, a mangled state file: every one of them ends the same way, as "no update", never
as a failed command.

`oh update` does the same thing in the foreground: the version lookup, then npm's own install
output as the progress, `0` when the CLI is current or just became so and `1` when npm could
not be asked or the install failed. It works with the auto-update switched off — it is the one
thing that is always about updating — and refuses with exit `2` when this `oh` is not a global
install, because there is nothing here for npm to replace.

## In the chat

| key               | what it does                                                 |
| ----------------- | ------------------------------------------------------------ |
| `/model` + Enter  | pick a model; it applies from the next message and sticks    |
| Enter             | send — also while a reply streams, which is what steering is |
| Ctrl+J, Alt+Enter | insert a newline                                             |
| ←/→, Home/End     | move the cursor; Backspace deletes behind it, Delete at it   |
| Ctrl+C            | interrupt the running turn; pressed again when idle, leave   |

"Shift+Enter" is not a key a terminal can send — most send the same `\r` for both — so the
newline is bound to **Ctrl+J** (line feed, `0x0A`, against Enter's `0x0D`), which every
terminal can send and none confuses with Enter, and to **Alt+Enter** (`ESC` + `\r`) for muscle
memory. A paste arrives as one chunk and is inserted verbatim, newlines included.

On the way out the CLI prints `Resume this session with: oh -s <id>` — unless the session
was deleted while the chat was open, when it prints `This chat was deleted; it is gone.`
instead (epic #116 U5).

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
    session.ts           the runtime: transcript + stream + send/interrupt/dispose,
                         the pending `/model` pick, and the deleted-session end state
    screen.tsx           the chat screen (transcript, status line, prompt, `/model`)
    target.ts            which session to open, and the model/agent-selection rules
    ctrl-c.ts            the Ctrl+C rules (interrupt / arm / exit)
  components/            message-view, transcript-view, status-line, prompt-input,
                         notice-view, model-picker
  update/
    index.ts             the auto-update: the notice, the background check, detection
    decide.ts            the off switches (env / config / CI) and the hourly throttle
    semver.ts            the version comparator — the bundle cannot borrow one
    detect.ts            is this `oh` a global npm install?
    npm.ts               spawning npm, and the detached installer's `node -e` wrapper
    state.ts             update-state.json: the timestamp, the cached root, the outcome
    notice.ts            the one line the next run prints, once
  commands/list.ts       `oh sessions` / `oh agents` / `oh sessions delete`
  commands/preferences.ts  `oh default-model`
  commands/io.ts         what a print-and-stop command writes, and how it fails
  commands/auth.ts       `oh login` / `oh logout` / `oh whoami`
  commands/update.ts     `oh update` — the auto-update, in the foreground
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
(`DEV_MODELS`) — for the `/model` picker and for a chat with the default cleared — the
default model itself (`DEV_DEFAULT_MODEL`, so `oh` starts chatting with no dialog, the way
an account that has saved one does), three agents for `oh agents` and the `--agent` path, a
scripted conversation, and a session with history behind it for `--continue` and `-s <id>`.
It is a development and QA aid — the entry point is loaded lazily, so a normal `oh` never
reads it, and nothing in this package enables it on its own. See `src/dev/fake.ts`.

The auth commands run against the fake too: `oh login` asks it for the (deterministic) codes,
polls it once, and stores its `FAKE_SESSION_TOKEN` in the real credentials file — point
`XDG_CONFIG_HOME` at a scratch directory when you do that by hand. `oh logout` signs the fake
out; `oh whoami` reads what the login stored.

## Public API

| `openharness` (npm) | `PACKAGE_NAME`, `App`, `parseArgs()`, `readVersion()`, `run()`, `createChatSession()`, `resolveConfig()`, `describeError()` |
| `oh` (bin) | the commands above |

The version is injected at build time from `package.json` as `__CLI_VERSION__`
(see `tsdown.config.ts` and `vitest.config.ts`), so `oh --version` works from any
working directory and cannot drift from `package.json`.

## Packaging

`npm i -g openharness` installs the package as the `oh` command. The published package is
the `package.json` (`private` removed, `bin`, `files`, `publishConfig`) plus
`dist/index.js`, `dist/index.d.ts`, `README.md` and `LICENSE`. There are **no runtime
`dependencies`**: everything — `@openharness/client`, `@openharness/protocol`, Ink, React —
lives in `devDependencies` and is inlined into the bundle.

`tsdown.config.ts` builds the single file:

- every import is bundled (nothing is external: the production-dependency list tsdown would
  externalize is empty), and `outputOptions.codeSplitting: false` folds the one dynamic
  import (`src/dev/fake.ts`'s lazy `@openharness/client/testing`) into the bundle instead of
  emitting a chunk;
- `process.env.NODE_ENV` is defined as `"production"` at build time, so React's and Ink's
  dev-only paths are dropped;
- Ink's layout engine needs no asset handling: the `yoga-layout` build this package
  resolves (`yoga-wasm-base64-esm.js`) carries its wasm **base64-encoded inside the JS
  module**, so the wasm travels in `dist/index.js` like any other module — there is no
  `.wasm` file to ship and nothing to read from disk at startup;
- the shebang is kept (`dist/index.js` is executable — the `bin` entry), and a source map is
  built for local debugging but **not** in `files`, so it does not ship.

`yarn check:pack` (`scripts/check-pack.mjs`) is the proof: it runs `npm pack`, installs the
tarball into a fresh temporary directory outside the workspace, runs the installed `oh
--version` and `oh --help` there (asserting the printed version), and greps the bundle for
a bare-specifier `import`/`require` that would resolve from `node_modules` at runtime. CI
runs it after the build.

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

The auto-update is tested without a registry: `src/update/`'s decisions are plain values
(the off switches, the throttle, the version comparison, the cached global root) tested against
fakes, and the one thing that _must_ be exercised through a real subprocess — the spawn, the
detached installer's log and state file, the exit code it records — runs against a **fake
`npm` on `PATH`**, a small shell script, rather than a mocked `spawn`. `run()` itself takes the
updater as a `RunOptions` seam, so its tests watch which commands reach it without anything
spawning npm.

The auth side is tested at both levels: `src/credentials.ts` against a temp directory (the
atomic write, `0600`/`0700`, per-server tokens, the errors a broken file produces),
`src/browser.ts` with an injected spawn (the CI / SSH / no-display skips and the per-platform
command), and `src/commands/auth.ts` against the fake's scripted device flow (approval, expiry,
denial, cancellation, revoke failures); `src/index.test.ts` drives `run()` all the way through
`login` / `whoami` / `logout` with `XDG_CONFIG_HOME` pointed at a temp directory.

| file                                              | covers                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/index.test.ts`                               | `run()` end to end: the exit codes, login / whoami / logout, signals, `default-model` and `sessions delete` |
| `src/args.test.ts`                                | `parseArgs` and `readVersion`: every command, unknown and conflicting flags                                 |
| `src/config.test.ts`                              | the precedence chain, and the errors a bad config file produces                                             |
| `src/credentials.test.ts`                         | the credentials file: atomic write, `0600`/`0700`, per-server tokens, a write that failed                   |
| `src/browser.test.ts`                             | the skip rules and the per-platform command, with an injected spawn                                         |
| `src/commands/auth.test.ts`                       | `oh login` / `logout` / `whoami` against the fake's scripted device flow, mid-poll cancellation included    |
| `src/commands/preferences.test.ts`                | `oh default-model`: print, set, replace, the failures                                                       |
| `src/commands/list.test.ts`, `src/paging.test.ts` | the listings, their formatting, `sessions delete`, and the `next_page` walk                                 |
| `src/chat/session.test.ts`                        | the runtime: transcript, stream, send, `/model`, deleted sessions, dispose                                  |
| `src/chat/target.test.ts`                         | session/model/agent selection, the default model, and the paging it needs                                   |
| `src/chat/ctrl-c.test.ts`                         | the Ctrl+C rules: interrupt, arm, exit                                                                      |
| `src/components/model-picker.test.tsx`            | the picker: windowing, number keys, the free-text row                                                       |
| `src/app.test.tsx`                                | the Ink screens through `ink-testing-library` and `createFakeClient()`                                      |
| `src/errors.test.ts`                              | `describeError`: the 401 line, the connection hints, 403/429, `--debug`                                     |
| `src/signals.test.ts`, `src/terminal.test.ts`     | the signal handlers and `restoreTerminal`                                                                   |
| `src/update/semver.test.ts`                       | the comparator: the three numbers, prereleases, and what is not a version                                   |
| `src/update/decide.test.ts`                       | the off switches, and the hourly throttle                                                                   |
| `src/update/state.test.ts`                        | `update-state.json`: the write, the tolerant read, and the once-only consume                                |
| `src/update/detect.test.ts`                       | the global-install check, `bin` symlink and case-insensitivity included                                     |
| `src/update/notice.test.ts`                       | the one line: its two shapes, the stream it goes to, and that it never repeats                              |
| `src/update/npm.test.ts`                          | npm over a fake `npm` on `PATH`: the lookup, the timeout, and the detached installer's state file           |
| `src/update/check.test.ts`                        | the background check's decisions, against a fake npm runner                                                 |
| `src/commands/update.test.ts`                     | `oh update`: up to date, installed, failed, and refused                                                     |
| `src/dev/fake.test.ts`                            | the fake-mode gate and the seeded dev client                                                                |

Every `run()` test gets its own `XDG_CONFIG_HOME` (`index.test.ts` creates one per test):
without it the suite reads the developer's real `~/.config/openharness`, where a hand-written
`config.json` flips the server and a mangled `credentials.json` makes unrelated commands
exit 2 (the review of #105, P1).

Three things worth knowing before writing a test here:

- `waitForScreen` waits for a frame _and_ for the screen to be ready for keys: Ink writes the
  frame during React's commit, but `useInput` subscribes in the passive-effect flush after
  it, so a key pressed the instant a screen appears is a key nobody hears. A person cannot
  type that fast; a test can. The wait is a condition — one event-loop turn (a yield, not a
  timeout), then Ink's `readable` listener on stdin must exist — not a fixed sleep: it costs
  a fast machine nothing and a loaded one exactly what it needs (#105, P1).
- Keystrokes must be written one at a time (`typeText`): a chunk with several characters is a
  paste, and the prompt inserts pastes verbatim, `\r` included. `pressKey` covers the named
  keys only — a plain letter is `typeText`, or the write is `undefined`.
- The suite's ceiling is 20 s per test (`vitest.config.ts`): the Ink tests drive real timers,
  so a contended CI runner is slower, not broken — but a hang still fails.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/client` (including its `@openharness/client/testing` subpath, for dev mode and
  for tests)

`@openharness/config` is additionally allowed as a **devDependency**. Since the bundle
inlines them, the two above are **devDependencies** here too — the package publishes no
runtime `dependencies` at all.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/tui/docs/`.
