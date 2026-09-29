# v1 chat — hands-on QA pass (issue #14)

A manual pass over the web app and the `oh` CLI against the real running system: a browser
driven by Playwright, and a terminal driven through `tmux`. Everything below was executed;
nothing is inferred from the unit or e2e suites.

## Environment

|               |                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit tested | `74f6d35a91487567ce261394700ba559d24f46f1` (`main`, "E2E tests, docker-compose, and docs pass (#24)")                                                               |
| system        | `OPENHARNESS_TEST_MODEL=mock docker compose up --build -d` — server image `openharness-server:a4318082f5b5`, Postgres 18-alpine, web app served from `/` on `:3000` |
| docker        | 29.1.3, Compose v2.32.4 (the compose plugin was installed for this pass; `docker` alone had none)                                                                   |
| node / yarn   | v24.21.0 / 4.18.1                                                                                                                                                   |
| Playwright    | 1.63.0, chromium 1243 (`npx playwright --version` → `Version 1.63.0`)                                                                                               |
| browser       | launches headless and renders: the first spec (`W1`) passed on the first run                                                                                        |
| CLI           | `yarn turbo run build --filter=@openharness/cli...`, run as `node apps/tui/dist/index.js`                                                                           |
| terminal      | tmux 3.7b, panes at 80×24 and 200×50                                                                                                                                |
| provider pass | **skipped** — no `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment                                                                                         |

## How it was run

```bash
# the system under test (fresh database: W1's empty state and W10's agent list need it)
docker compose down -v && OPENHARNESS_TEST_MODEL=mock docker compose up --build -d

# the web scenarios, in order
cd e2e && yarn qa:web qa/w*.spec.ts

# the two scenarios that change the server they run against
QA_ALLOW_SERVER_RESTART=1 yarn qa:web qa/w11-errors.spec.ts --grep W11c
OPENHARNESS_TEST_MODEL=mock OPENHARNESS_API_KEY=qa-key-14-abc123 docker compose up -d
QA_API_KEY=qa-key-14-abc123 yarn qa:web qa/w12-auth.spec.ts

# the CLI, and the two frontends on one session
yarn turbo run build --filter=@openharness/cli...
QA_WITH_CLI=1 yarn qa:web qa/cli.spec.ts qa/c10-cross-client.spec.ts
```

`QA_BASE_URL` points the suite at another deployment (default `http://localhost:3000`).
`yarn qa:web` is not part of `yarn test` and not part of CI: the specs need a live server, and
vitest only collects `src/**/*.test.ts`.

## Scenario results

| id  | scenario                                              | result   | bug                                                                                                                                                               |
| --- | ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | first run: empty state, create an agent, start a chat | **pass** |                                                                                                                                                                   |
| W2  | basic chat: streaming, focus, markdown                | **pass** |                                                                                                                                                                   |
| W3  | multi-turn: three turns in order, auto-scroll         | **pass** |                                                                                                                                                                   |
| W4  | scrolling during a long stream                        | **pass** |                                                                                                                                                                   |
| W5  | steering mid-stream                                   | **pass** |                                                                                                                                                                   |
| W6  | interrupt: Stop keeps the partial reply               | **pass** |                                                                                                                                                                   |
| W7  | reload mid-stream and after                           | **fail** | [no. 3](https://github.com/amirtuval/openharness/issues/14#issuecomment-5885844041) — the text already arrived is lost, the reply resumes mid-word (`W7b`)        |
| W8  | two tabs on one session                               | **pass** |                                                                                                                                                                   |
| W9  | session list: order, switching, labels                | **fail** | [no. 5](https://github.com/amirtuval/openharness/issues/14#issuecomment-5885849682) — no session ever has a title                                                 |
| W10 | agent edit: new sessions only                         | **fail** | [no. 1](https://github.com/amirtuval/openharness/issues/14#issuecomment-5885806631) — the screen lists one page of agents, the rest are unreachable               |
| W11 | errors: retryable, terminal, server down              | **pass** | [no. 4](https://github.com/amirtuval/openharness/issues/14#issuecomment-5885844246) — server down reads "Failed to fetch"                                         |
| W12 | auth: no key, wrong key, right key                    | **pass** |                                                                                                                                                                   |
| W13 | layout 1440 / 390, Enter, Shift+Enter, Tab            | **fail** | [no. 2](https://github.com/amirtuval/openharness/issues/14#issuecomment-5885842197) — at 390 px the sidebar keeps its width and the chat is a few characters wide |
| C1  | new chat: pick an agent, send, stream                 | **pass** |                                                                                                                                                                   |
| C2  | long reply at 80×24 and 200×50                        | **pass** |                                                                                                                                                                   |
| C3  | resume: `oh -s <id>`, `oh -c`                         | **pass** |                                                                                                                                                                   |
| C4  | steering mid-stream                                   | **pass** |                                                                                                                                                                   |
| C5  | Ctrl+C interrupt, Ctrl+C twice to exit                | **pass** |                                                                                                                                                                   |
| C6  | Ctrl+J and Alt+Enter add a newline                    | **pass** |                                                                                                                                                                   |
| C7  | `sessions`, `agents`, `--help`, `--version`, bad args | **pass** | [no. 6](https://github.com/amirtuval/openharness/issues/14#issuecomment-5885856894) — `--agent` cannot see past the first page                                    |
| C8  | config precedence, wrong key                          | **pass** | (see C7's bug for the agent list behind `--agent`)                                                                                                                |
| C9  | server down                                           | **pass** |                                                                                                                                                                   |
| C10 | cross-client: `oh` ↔ web                              | **pass** |                                                                                                                                                                   |

The three tests marked `test.fail` in the specs (`W7b`, `W9b`, `W10c`) are the reproductions
for bugs 1, 3 and 5: they fail today by design, and will report as failures the moment they
start passing, which is the signal to delete the marker.

## Rough edges (not bugs)

- **The sidebar shows no per-session status.** `oh sessions` has a status column; the web list
  shows the label, the model and a relative time. Status only exists in the chat header.
- **`oh sessions` and `oh agents` print one page and say nothing about it.** The code calls
  this deliberate (`apps/tui/src/commands/list.ts`: "a terminal is not the place to scroll
  through thousands of sessions") — but 20 sessions on a server with 40 looks like 20 sessions.
- **`oh --version` prints `0.0.0`.** Correct — it is `apps/tui/package.json`'s version, injected
  at build time — but not useful while the tree is unreleased.
- **The CLI status line wraps at 80 columns.** `agent · model · session id · status` is longer
  than a narrow terminal, so it takes two rows and the terminal shows `… ·` / `running`.
- **Resizing the terminal does not re-wrap what was already printed.** Ink's `<Static>` writes
  a settled message at the width it had; going from 80 to 200 columns leaves the old wrapping
  in place (visible in `c2-02-wide-200x50.png`). Nothing breaks; it just does not reflow.
- **A "queued" badge flashes on every message.** The transcript marks a message pending until
  the brain claims it, which is right for steering but shows the badge for a moment on an idle
  session too.
- **Tab order walks every session in the sidebar.** No skip link and no roving tabindex: fine
  with three sessions, forty presses to reach the chat with forty.
- **Send is not in the tab order until the composer has text** — a disabled button is not
  focusable, which is correct HTML and still surprising when tabbing.
- **User bubbles stretch to 85 % of a 1440 px window**, so a one-line message is a very wide
  block of colour at desktop width.
- **Recovery after a restart is better than asked for.** The client's stream reconnect loop
  brought an open tab back on its own once the server was listening again — no reload needed.

## Screenshots

`docs/qa/v1-chat/` holds one key frame per scenario, from the pass above. `w*` are browser
captures; `c*` are terminal captures — `tmux capture-pane` rendered as monospace text and
screenshotted, so a scenario's screen can be looked at without re-running it. The specs write
every frame they take into the same folder, so a fresh run overwrites these and adds the ones
that were left out here; the committed set is the one this report describes.

| file                                       | shows                                            |
| ------------------------------------------ | ------------------------------------------------ |
| `w1-01-empty-state`                        | the first run: no chats, no agents               |
| `w2-01-markdown-reply`                     | markdown — heading, list, code block             |
| `w3-01-three-turns`                        | three turns in order                             |
| `w4-01-scrolled-up`                        | scrolled up mid-stream, "Jump to latest" showing |
| `w5-01-steering-queued`                    | a steering message queued behind a running reply |
| `w6-01-after-stop`                         | Stop: the partial reply, status idle             |
| `w7-01-reloaded-mid-stream`                | the bug: the reply resumes at "6/40"             |
| `w8-01-second-tab`                         | the same session in a second tab                 |
| `w9-01-session-list`                       | the sidebar, and the labels it has to work with  |
| `w10-01-agent-edited`                      | an edited agent, notice shown                    |
| `w11-02-terminal-error`                    | a terminal model failure, inline                 |
| `w11-03-server-down`                       | "Request failed / Failed to fetch"               |
| `w12-02-wrong-key`                         | a wrong API key                                  |
| `w13-01-desktop-1440`, `w13-02-narrow-390` | the two widths                                   |
| `c1-01-agent-picker`                       | the agent picker at 80×24                        |
| `c2-02-wide-200x50`                        | a long reply after a resize to 200×50            |
| `c3-02-resumed`                            | `oh -s <id>` restoring the history               |
| `c4-01-steering-queued`                    | `(queued)` in the CLI                            |
| `c5-01-interrupted`                        | Ctrl+C: the partial stays, the prompt returns    |
| `c6-01-ctrl-j`                             | Ctrl+J, two lines in the composer                |
| `c10-01-oh-session-in-the-web`             | a chat started in `oh`, read in the browser      |
