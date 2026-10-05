# openharness

The terminal UI for [openharness](https://github.com/amirtuval/openharness) — an open-source
implementation of Anthropic's [Managed Agents](https://www.anthropic.com/engineering/managed-agents)
architecture (a stateless brain, a durable session log, pluggable hands). An Ink (React) chat
client that talks to an openharness server, installed as the **`oh`** command.

One self-contained file, no runtime dependencies: `oh` loads everything at startup, so an
`npm install -g openharness@next` may replace it on disk while a chat is running.

## Install

Requires Node.js 24 or newer.

```bash
npm i -g openharness
```

This installs the `oh` command.

## Use

Point it at a server (see the [repo](https://github.com/amirtuval/openharness) for how to run
one), sign in, and chat:

```bash
oh --server http://localhost:3000 login   # the device flow: prints a URL and a code
oh --server http://localhost:3000         # a new chat on your default model
```

`--server` is per-run; to keep it, either export it or write it to the config file:

```bash
export OPENHARNESS_URL=http://localhost:3000   # or, persistent:
# ~/.config/openharness/config.json → { "server": "http://localhost:3000" }
```

Resolution order, highest first: `--server`, `OPENHARNESS_URL`,
`~/.config/openharness/config.json`, then `http://localhost:3000` as the default.

## Commands

| command                                | what it does                                                           |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `oh`                                   | start a new chat on your default model                                 |
| `oh -c` / `oh -s <id>`                 | resume the most recent session, or a particular one                    |
| `oh sessions`                          | list your sessions; `oh sessions delete <id>` deletes one (asks first) |
| `oh agents`                            | list saved agent presets; start one with `--agent <id\|name>`          |
| `oh default-model [provider/model]`    | print or set the model a new chat starts on                            |
| `oh login` / `oh logout` / `oh whoami` | sign in (browser device flow), revoke, who am I                        |
| `oh --help`, `oh --version`            | print and stop                                                         |

Inside a chat: Enter sends (a message sent mid-reply steers it), `/model` switches models,
Ctrl+J or Alt+Enter inserts a newline, and Ctrl+C interrupts — pressed again when idle, it
leaves. On the way out, `oh` prints the `oh -s <id>` line that resumes the chat.

The session token is stored per server in `~/.config/openharness/credentials.json` (mode
`0600`). `oh logout` revokes it server-side and forgets it locally.

## Links

- Source, issues and docs: <https://github.com/amirtuval/openharness>
- The server and the web app live in the same repository.

MIT © Amir Tuval
