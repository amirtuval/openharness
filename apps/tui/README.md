# openharness

The terminal UI for [openharness](https://github.com/amirtuval/openharness) — an open-source
implementation of Anthropic's [Managed Agents](https://www.anthropic.com/engineering/managed-agents)
architecture (a stateless brain, a durable session log, pluggable hands). An Ink (React) chat
client that talks to an openharness server, installed as the **`oh`** command.

One self-contained file, no runtime dependencies: `oh` loads everything at startup, so an
`npm install -g @openh/cli@next` — including the one `oh` runs for itself — may replace it on
disk while a chat is running.

## Install

Requires Node.js 24 or newer.

```bash
npm i -g @openh/cli
```

This installs the `oh` command. The npm package is **`@openh/cli`** (npm refuses the unscoped
`openharness` name, #194); the command it installs is `oh`.

## Use

Sign in, add a provider key, and chat — `oh` will offer the first two itself if you just run
it:

```bash
oh                 # signed out? it asks, then runs the device flow
                   # no provider key? it asks for one right here, then opens a chat
oh providers list  # what you have stored: provider, last four, when it was added
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

| command                                | what it does                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `oh`                                   | start a new chat on your default model                                         |
| `oh -c` / `oh -s <id>`                 | resume the most recent session, or a particular one                            |
| `oh sessions`                          | list your sessions; `oh sessions delete <id>` deletes one (asks first)         |
| `oh agents`                            | list saved agent presets; start one with `--agent <id\|name>`                  |
| `oh providers`                         | list the model-provider keys you have stored                                   |
| `oh providers add [provider]`          | connect a provider — paste its key into a hidden prompt                        |
| `oh providers remove <provider>`       | forget a key (asks first; `--yes` skips the question)                          |
| `oh default-model [provider/model]`    | print or set the model a new chat starts on                                    |
| `oh modes`                             | list your modes; start a chat on one with `--mode <name>`                      |
| `oh settings`                          | show or set when a long chat is summarized, and by which model                 |
| `oh tools [name]`                      | list the built-in tools, or set one (`--on`/`--off`/`--policy`)                |
| `oh mcp`                               | your remote MCP servers: add, connect (OAuth), test, set tool permissions      |
| `oh skills`                            | list your imported skills, and switch each on or off                           |
| `oh skills add <url> [flags]`          | import skills from a public git repository (`--ref`/`--path`/`--all`/`--name`) |
| `oh skills refresh <name>`             | show what changed upstream and replace the snapshot (asks; `--yes` skips)      |
| `oh skills remove <name>`              | delete a skill and its snapshot (asks; `--yes` skips)                          |
| `oh login` / `oh logout` / `oh whoami` | sign in (browser device flow), revoke, who am I                                |
| `oh update`                            | install the newest published version now                                       |
| `oh --help`, `oh --version`            | print and stop                                                                 |

Inside a chat: Enter sends (a message sent mid-reply steers it), and Ctrl+J or Alt+Enter
inserts a newline. Type `/` for the command menu — ↑/↓ choose, Tab completes, Enter runs, Esc
closes — which holds `/model` (switch models), `/providers` (connect a provider without leaving
the chat), `/new` (start a new chat on the current model), `/compact [instructions]`
(summarize the older history now, with optional guidance for the summary), `/tools` (turn the
built-in tools on or off and set what each may do: allow, ask or deny), `/mcp` (your remote MCP
servers), `/skills` (list, switch, remove or import a skill), `/clear` (clear the screen,
keeping the session), `/help`, and `/exit`. The enabled skills that you can invoke are offered
in that menu too, with their argument hints: `/release-notes v1.2` sends the message and loads
the skill's instructions into that turn (the transcript shows the invocation as a chip, and
the `skill` calls the model then makes as `Loaded skill …` lines). A message that starts
with `//` sends a literal `/`. Ctrl+C interrupts the reply; pressed again when idle, it leaves.
On the way out, `oh` prints the `oh -s <id>` line that resumes the chat.

The model can use tools: fetch a page, search the web (on providers that have a native search),
keep a task list, ask you a question, and call the tools of your remote MCP servers. Each call is
a line in the transcript with a `⎿` line under it saying what came back; Ctrl+O shows the full
input and result of the calls still on screen. A task list stays pinned above the prompt (Ctrl+T
folds it). A tool set to `ask`, and every MCP tool until you allow it, waits for your answer —
allow once, for this chat, always, or deny — and a question from the model is answered with the
arrow keys and Enter. If an MCP server needs signing in again mid-chat, Ctrl+R reconnects it.

When a chat's context fills up, the server summarizes the older history and the chat carries on
from the summary and the recent messages; the transcript keeps the whole conversation, with a
"Conversation summarized" divider. The status line shows how full the context is ("62% of
context used") and "Summarizing… 2 of 3" while a summary is being made. `oh settings` changes
when this happens (a share of the model's context), which model writes the summary, and how many
passes it may take — the same settings as the web app's Settings → Context.

**Skills** are folders of instructions in the open Agent Skills format, imported from a public
git repository and stored as a snapshot you review first. `oh skills add <url>` reads the
repository, prints what it holds — each candidate with its files, its `SKILL.md` and anything
wrong with it — and then either imports what `--all` or `--name <n>` named, or opens a pick to
choose from. `oh skills` lists yours, `enable`/`disable` switches one on for your chats,
`refresh <name>` re-reads its source, shows the diff and replaces the snapshot only when you
confirm, and `remove <name>` deletes it. A mode may turn particular skills on or off, which
`oh modes` shows read-only (editing a mode is the web app's Settings → Modes). Everything of
this is in a chat too, under `/skills`.

The session token is stored per server in `~/.config/openharness/credentials.json` (mode
`0600`). `oh logout` revokes it server-side and forgets it locally.

Your provider keys are **not** stored on this machine. A key typed into `oh providers add` goes
over HTTPS to the same credentials API the web app uses, is validated once against the provider,
and is stored encrypted on the server — `oh` keeps no copy, and the prompt that takes it echoes
nothing.

## Updating

Installed with `npm i -g @openh/cli`, `oh` keeps itself current: at most once an hour it asks
npm for the published version and, when that one is newer, installs it for the next run — in
the background, without interrupting the chat you are in. The next run prints one line about
how it went. Because the package is a single self-contained file, the copy running right now is
never the one that changes.

The check runs in a process of its own, detached from the one you started it with, so it sees
itself through whether or not the command you typed sticks around: `oh whoami` sets an update
in motion just as a long chat does. A check that fails — no network, no answer from npm — is
not counted as this hour's: the next run asks again.

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
