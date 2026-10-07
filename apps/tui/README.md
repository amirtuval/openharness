# openharness

The terminal UI for [openharness](https://github.com/amirtuval/openharness) — an open-source
implementation of Anthropic's [Managed Agents](https://www.anthropic.com/engineering/managed-agents)
architecture (a stateless brain, a durable session log, pluggable hands). An Ink (React) chat
client that talks to an openharness server, installed as the **`oh`** command.

One self-contained file, no runtime dependencies: `oh` loads everything at startup, so an
`npm install -g openharness@next` — including the one `oh` runs for itself — may replace it on
disk while a chat is running.

## Install

Requires Node.js 24 or newer.

```bash
npm i -g openharness
```

This installs the `oh` command.

## Use

Sign in, and chat:

```bash
oh login   # the device flow: prints a URL and a code, then signs you in
oh         # a new chat on your default model
```

`oh` talks to **`https://app.oharness.dev`** unless you point it somewhere else. `--server` is
per-run; to keep it, either export it or write it to the config file:

```bash
oh --server http://localhost:3000 login        # a server of your own (see the repo for one)
export OPENHARNESS_URL=http://localhost:3000   # or, persistent:
# ~/.config/openharness/config.json → { "server": "http://localhost:3000" }
```

Resolution order, highest first: `--server`, `OPENHARNESS_URL`,
`~/.config/openharness/config.json`, then `https://app.oharness.dev` as the default.

Working from a checkout of the [repo](https://github.com/amirtuval/openharness), `yarn oh`
builds the CLI and runs it against `http://localhost:3000` (`yarn oh:staging` and
`yarn oh:prod` run it against staging and production); arguments pass straight through, so
`yarn oh:staging login` works.

## Commands

| command                                | what it does                                                           |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `oh`                                   | start a new chat on your default model                                 |
| `oh -c` / `oh -s <id>`                 | resume the most recent session, or a particular one                    |
| `oh sessions`                          | list your sessions; `oh sessions delete <id>` deletes one (asks first) |
| `oh agents`                            | list saved agent presets; start one with `--agent <id\|name>`          |
| `oh default-model [provider/model]`    | print or set the model a new chat starts on                            |
| `oh login` / `oh logout` / `oh whoami` | sign in (browser device flow), revoke, who am I                        |
| `oh update`                            | install the newest published version now                               |
| `oh --help`, `oh --version`            | print and stop                                                         |

Inside a chat: Enter sends (a message sent mid-reply steers it), `/model` switches models,
Ctrl+J or Alt+Enter inserts a newline, and Ctrl+C interrupts — pressed again when idle, it
leaves. On the way out, `oh` prints the `oh -s <id>` line that resumes the chat.

The session token is stored per server in `~/.config/openharness/credentials.json` (mode
`0600`). `oh logout` revokes it server-side and forgets it locally.

## Updating

Installed with `npm i -g openharness`, `oh` keeps itself current: at most once an hour it asks
npm for the published version and, when that one is newer, installs it for the next run — in
the background, without interrupting the chat you are in. The next run prints one line about
how it went. Because the package is a single self-contained file, the copy running right now is
never the one that changes.

```bash
oh update     # the same thing now, in the foreground, with npm's own progress
```

Turn the background update off with any of: `OH_NO_AUTO_UPDATE=1` in the environment,
`"autoUpdate": false` in `~/.config/openharness/config.json`, or running in CI. It is also
inert when `oh` was not installed globally (for example, run from a checkout) — `oh update`
says so and stops. What it remembers between runs lives in `~/.config/openharness/`
(`update-state.json` and `update.log`), beside the config and credentials files.

## Links

- Source, issues and docs: <https://github.com/amirtuval/openharness>
- The server and the web app live in the same repository.

MIT © Amir Tuval
