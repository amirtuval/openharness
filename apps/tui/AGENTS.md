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

| command                                 | what it does                              |
| --------------------------------------- | ----------------------------------------- |
| `oh`                                    | start a new chat                          |
| `oh -s <id>` / `--session <id>`         | resume a session, showing its history     |
| `oh -c` / `--continue`                  | resume the most recent session            |
| `oh sessions`                           | list sessions: id, title, status, updated |
| `oh agents`                             | list agents: id, name, model              |
| `oh -v` / `--version`, `oh -h`/`--help` | print and stop                            |

Global flags: `--server <url>`, `--api-key <key>`, `--debug`.

Exit codes: `0` did what it was asked (including a chat the user ended), `1` the server or the
network said no, `2` the command line or the configuration was wrong — and also a chat asked
for without a terminal, since stdin has to be a TTY to read a key — and `130`/`143` when the
process was signalled.

Unknown flags are errors, not positionals: `node:util`'s `parseArgs` runs in strict mode, the
message goes to stderr, and the exit code is `2`.

### Configuration precedence

Highest first:

1. `--server` / `--api-key`
2. `OPENHARNESS_URL` / `OPENHARNESS_API_KEY`
3. `~/.config/openharness/config.json` (or `$XDG_CONFIG_HOME/openharness/config.json`, which
   is ignored when it is not an absolute path):
   `{ "server": "http://localhost:3000", "apiKey": "oh_..." }`
4. `http://localhost:3000`

A missing config file is fine. A file that exists and does not parse, holds the wrong types,
or names a key that does not exist is an error (exit `2`) naming the file and the problem. An
empty environment variable counts as unset; a missing API key is fine (the server may need
none).

### Choosing an agent

A new chat needs an agent, in this order: `--agent <id|name>` (id first, then exact name,
then case-insensitive name — an ambiguous match is an error, not a guess); the only agent,
when the server has exactly one; an interactive picker, when it has several; and a message
saying to create one in the web app, when it has none. This CLI does not create agents.

`--session` wins over everything: it names the session to resume, whatever agents exist.

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
  errors.ts              ApiError / fetch failures → a message and hints
  help.ts                the --help text
  signals.ts             SIGINT/SIGTERM/SIGHUP → handlers, and a disposer
  terminal.ts            restoreTerminal: raw mode off, cursor shown
  version.ts             the version injected at build time
  chat/
    session.ts           the runtime: transcript + stream + send/interrupt/dispose
    screen.tsx           the chat screen (transcript, status line, prompt)
    target.ts            which session to open, and the agent-selection rules
    ctrl-c.ts            the Ctrl+C rules (interrupt / arm / exit)
  components/            message-view, transcript-view, status-line, prompt-input,
                         notice-view, agent-picker
  commands/list.ts       `oh sessions` / `oh agents`
  dev/fake.ts            OPENHARNESS_FAKE: the fake client, seeded, dev only
  test-support/          test-only helpers (fake clients, keystrokes, frame waits)
```

## Fake mode (dev only)

```bash
OPENHARNESS_FAKE=1 yarn dev     # or: OPENHARNESS_FAKE=1 node dist/index.js
```

`OPENHARNESS_FAKE=1` makes `oh` run against `createFakeClient()` from
`@openharness/client/testing` instead of a server: no network, no model, scripted replies that
stream in. The fake is seeded with three agents (so the picker comes up unless `--agent` names
one), a scripted conversation, and a session with history behind it for `--continue` and
`-s <id>`. It is a development and QA aid — the entry point is loaded lazily, so a normal `oh`
never reads it, and nothing in this package enables it on its own. See `src/dev/fake.ts`.

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
against, so a rule that changes on the server side fails here too. Everything else (args,
config precedence, error mapping, the Ctrl+C rules, the transcript-driven runtime) is tested
without Ink at all.

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
