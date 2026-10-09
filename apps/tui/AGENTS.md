# openharness (the CLI)

The openharness terminal UI: an Ink (React) chat client, installed as the `oh` command. It
talks to the server through `@openharness/client` only — the same client the web app uses —
so there is no second transport to keep honest.

The package is published to npm as the public **`@openh/cli`** (#194, #152) — the one
workspace whose name is not `@openharness/*`. npm refuses the unscoped `openharness` (too
similar to the existing `open-harness`), and the maintainer's npm org is `openh`; the command
it installs stays `oh`. The build is **one self-contained file**: `dist/index.js` inlines the
workspace packages and every third-party dependency, so the published `package.json` has no
runtime `dependencies` and `npm install -g @openh/cli@next` may replace the file under a
running `oh` (that is the ground the D10 auto-update stands on). See "Packaging" below.

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

| command                                 | what it does                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `oh`                                    | start a new chat on the default model                                        |
| `oh -s <id>` / `--session <id>`         | resume a session, showing its history                                        |
| `oh -c` / `--continue`                  | resume the most recent session                                               |
| `oh sessions`                           | list every session: id, title, status, updated                               |
| `oh sessions delete <id>`               | delete a chat and everything in it (asks; `--yes` skips)                     |
| `oh agents`                             | list the saved agents (optional presets): id, name                           |
| `oh modes`                              | list your modes and what each resolves to (#245, M6)                         |
| `oh providers`                          | list the stored model-provider keys: provider, last 4                        |
| `oh providers add [name]`               | connect a provider or a named credential — answer its fields, secrets hidden |
| `oh providers remove <provider>`        | forget a key (asks; `--yes` skips the question)                              |
| `oh default-model [provider/model]`     | print or set the model a new chat starts on                                  |
| `oh login`                              | sign in through the browser (the device flow)                                |
| `oh logout`                             | revoke the session on the server, forget the token                           |
| `oh whoami`                             | print the signed-in email and server                                         |
| `oh update`                             | install the newest published version now                                     |
| `oh -v` / `--version`, `oh -h`/`--help` | print and stop                                                               |

Global flags: `--server <url>`, `--debug`; `oh login` also takes `--no-browser`, and
`oh sessions delete` / `oh providers remove` take `--yes`. The chat flags are `-s`/`-c`,
`--agent`, `--model` and `--mode`; the other commands take none of them (and reject them
loudly).

Exit codes: `0` did what it was asked (including a chat the user ended, a chat that was
deleted elsewhere, a delete or remove answer of "no", a `providers add` the user cancelled,
and a `logout` whose server-side revoke could
not be reached — the token is still gone locally); `1` the server,
the network or the sign-in state said no — a 401 is the not-signed-in error described under
"Signing in" below (or, in a chat that can sign in, the offer described there), and an
account that ends up with no provider key ends there too, as "Choosing a
model" describes; `2`
the command line or the configuration was wrong (including an unusable config or credentials
file, named in the message) — and also a chat or an `oh providers add` asked for without a
terminal, since stdin has to be a TTY to read a key, and an `oh update` in an `oh` that is not
a global npm install;
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
   `{ "server": "https://app.oharness.dev", "autoUpdate": true, "theme": "auto" }`
4. `https://app.oharness.dev`

The default is **production** (#192): `npm i -g @openh/cli` lands on a machine with no server
of its own, so an `oh` nobody has pointed anywhere talks to the one that is always there.
Working from a checkout, `yarn oh` runs this CLI against `http://localhost:3000`; `--server`,
`OPENHARNESS_URL` or the config file point it anywhere else.

`autoUpdate` is the config file's own off switch for the background self-update (it defaults to
`true`), and `theme` picks the code theme's background — `auto` reads the terminal, `light`
and `dark` say so — for a terminal that reports nothing (#201, X4). Every key may be left
out. See "Updating itself" below and [`docs/markdown.md`](./docs/markdown.md).

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
{ "servers": { "https://app.oharness.dev": "<session token>" } }
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

**`oh` can sign in itself** (#210, epic #201 X7). A chat that finds no session — no stored
token, or one the server has revoked — does not stop at "Run `oh login`": it asks
`Sign in now? [Y/n]` (Enter takes the default `Y`), runs the device flow above through
`offerSignIn` (`src/commands/auth.ts`), and mounts the chat again on the token it stored. The
prompt and the flow are plain terminal IO outside the Ink UI — the app leaves with
`needsSignIn` on its exit payload and the run decides — so the question is asked once, on a
terminal it owns, and the reader who says no gets the not-signed-in line and exit `1` as
before. `oh providers add` makes the same offer when its write is refused with a 401, because
a credential write needs a fresh session. A run with no TTY never gets as far as asking: the
chat exits `2` with today's message, and so does `oh providers add`.

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
4. `--mode <name>` (#245, M6) names a mode a new chat follows instead of a model: it is matched
   against the user's modes by name (exactly, then ignoring case; a `mode_` id is read
   directly), ambiguity is an error, and the session is created with `{ mode }` — the server
   resolves the mode's model from the user's own settings, which is what "my default model"
   means. It is a usage error beside `--model`, because a chat follows one or the other.
5. Only with no default either is there a **model picker**, fed by `client.models.list()`:
   the chat models the user's own provider keys can use, grouped by provider, each row
   showing the display name and the context window, and a last row, "Other model id…", that
   takes a free-text `provider/model` id. A **search line** at the top filters the list as it
   is typed — a case-insensitive substring of the model's display name, its `provider/model`
   id or its provider name, with a provider's heading gone when none of its models match and
   "No models match" when none do; Backspace removes from the query and Esc clears it, or
   leaves when there is nothing to clear. Up/down move and Enter picks in the filtered list,
   whose cursor is back on the first match whenever the query changes, and Ctrl+C leaves; the
   list is windowed to ten rows and scrolls with the cursor, with the "N more above/below"
   counts about the filtered list. The numbers name rows only while the query is empty and the
   list is at most nine long (past nine, "12" would choose 1) — once a query is up a digit is a
   character in it, because model names are full of them (`gpt-4o`, `claude-sonnet-5`). Choosing
   "Other model id…" with a query carries the query into the free-text entry. After a pick,
   `oh` asks once — `Save <id> as your default model for new
chats? [y/N]` — and a `y` writes it with `preferences.put`; the chat opens either way,
   and a save that failed says so and steps aside on the next Enter.
6. With no provider keys at all — `client.models.list()` answers with no entries and there
   is no default — there is nothing to chat with, and `oh` connects one in the terminal
   instead (the next section). An account that has keys but still no models gets the message
   that says so, and exits `1`.

`oh default-model` prints the stored default (`Default model: …`, or that there is none and
a new chat will ask); `oh default-model <provider/model>` stores it and prints what the
server kept. The value is the one the web app's Settings show — it lives on the server
(`GET`/`PUT /v1/me/preferences`), so both frontends start a chat the same way.

`--session` and `--continue` win over everything: they name the session to resume, whatever
default, agents or models exist.

### Modes in a chat (#245, M6)

`/model` offers the user's **modes** as a `Modes` group above the providers, above every model
row, and the search line filters them with the models. Picking one is **pending**, exactly as a
model pick is: the next message carries it as `user.message.mode`, and the session follows the
mode live from then on (the server resolves its model, effort and prompt addition per request).
A mode whose model cannot be used is refused with the server's own sentence in the notice line,
never silently swapped. A plain model pick and a mode pick are one choice: each clears the
other, because a chat follows a mode or a model, never both. The status line names the mode
first — `smart · claude-sonnet-5` — so what the chat follows and what it resolved to are on one
line (`(next message)` while the pick is pending).

### Switching the model in a chat

`/model` typed into the prompt opens the same picker with the catalog. The choice is
**pending** rather than applied: the status line names it with `(next message)` after it, and
the next message carries it as `user.message.model` (`sendMessage(..., { model })`, U3). From
then on the session runs that model — later messages send no model — and the status line shows
the model the log last said the session runs (`transcript.model`, falling back to the
session's own), by its catalog name when the catalog is known and its id otherwise (#208).
Switching provider mid-chat is supported; the history is rebuilt per request. Ctrl+C in the
picker closes it and changes nothing — as does Esc, once the search line is empty (with a
query in it, Esc clears that first).

### Model providers in the terminal (#210, epic #201 X7/X8)

A chat runs on a model from a provider you have a key for, and until now the only way to give
`oh` one was the web app's Settings → Model providers. It happens here now, in three places
that are one component (`src/components/provider-setup.tsx`):

- **the first run** — a signed-in account with no credentials lands on it instead of "add a key
  in the web app". The screen reads `client.providerCredentials.list()` once: **empty** is the
  flow; **non-empty** (keys, but a catalog that listed nothing) is the message that says so;
- **`/providers [provider]`** in a chat, through the inline prompt slot — so the flow takes the
  input area over and gives it back, and no new mechanism was needed for a multi-step form;
- **`oh providers add [name]`**, on its own — a provider id, or the name a named credential was
  stored under; without one the flow starts on the list.

The flow is two steps. It picks a target from the list built from `CREDENTIAL_TARGETS` (the
metadata both frontends share, #209 — the eleven providers and the named credential types,
#245), each row with its **free-tier hint** (X8), and then answers its fields — **one prompt
each**, masked where the value is a secret and shown where it is not (an Azure endpoint, a
deployment list). The "get a key" URL is printed and `o` opens it in the browser (the same `openBrowser`
rules as `oh login`; a terminal that cannot open one says so and leaves the URL on screen).
The key goes into **`components/secret-input.tsx`** — a hidden input: `•` per character, never
the characters, and a bracketed paste taken as one value because a pasted key is the normal
case. It is deliberately not `PromptInput`: that echoes what it holds, hands every line to the
history and treats a pasted file as a feature, and none of that may happen to a secret.

The write is `client.providerCredentials.put(provider, { type: 'api_key', api_key })` — the
_same_ call the web app makes, over HTTPS, to the server that validates it once and seals it.
**Nothing is written to this machine**: there is no config-directory file a key could land in,
and the input never reaches `history.json` (the `record: false` seam #206 left is not even
needed — the secret is typed into a component that has no history to hand it to). What the
server refuses — a 422 `invalid_provider_credential` — is shown in the server's own words, and
the box asks again, because the usual mistake is a key copied with a space on it. A 401 is a
stale session: the flow hands that to its caller, which signs in again (above) rather than a
screen running a login itself.

The **form is built from the credential type** (X6), mirroring the web app: `CREDENTIAL_FORMS`
in `src/providers/credential-form.ts` is a `Record<ProviderCredentialType, …>` of the fields
and the request body they build — `api_key`'s one secret, `azure_openai`'s endpoint, key and
deployment names (#245, A3a), `bedrock`'s region, access key ID, secret access key and optional
session token (#245, A3c), and `openai_compatible`'s base URL plus an **optional** key (#249,
A3b). A field carries `secret` (masked, so no frame can hold it), `optional` (may be left empty;
`SecretInput` then submits its empty value and the body omits the field), and — for a field whose
value is a fixed list — `options` with a `defaultValue`: the region is a **list** the reader walks
with ↑/↓ and takes with Enter, because the value goes into an AWS hostname and a typed one could
only name a host that does not exist. A custom endpoint's target carries no `keyUrl`, so no key
page is printed and `o` is not bound — the letter stays typeable in the URL. A new member of the
protocol's union is a compile error there until it has a form, which is where Vertex lands.
A **named** target also asks for a **credential name**, and only when one of its type is already
stored — the first Azure credential takes the type's default (`azure`), a first Bedrock one takes
`bedrock`, and a second has to be told apart from it (`azure-eu`, `bedrock-us`), because the name
is the `provider` half of the model ids it serves. That is why the flow reads
`providerCredentials.list()` once, the same read the web dialog makes. The prompt names what the
second half of that type's model ids is, from the target's `modelIdHint` — `azure/<deployment>`,
`bedrock/<model id>` — so the two types do not borrow each other's words.

On success the server has picked a default model — the first key saved makes it do so (U4) —
and it is named back: `You're set: default model X`, the sentence the web app's first-run flow
ends on. The chat then opens on it (`oh` asks for Enter first, so the confirmation is read
rather than flashed past). `/providers` reads the catalog again in the background, so `/model`
offers the models the provider just connected — a plain read, not a `refresh`, because saving a
key already drops that provider's cache entry server-side.

`oh providers` lists what is stored: the display name, the credential type, the non-secret facts
the credential reports, the last four characters and when it was added. The facts are
`credentialFacts`, read from the credential's typed `details` (#245, A3c/A3d) — a Bedrock
credential's region, a Vertex one's service-account email, project and location, and never any
part of a private key — because `last4` alone cannot tell two credentials of one type apart when
they are two accounts or two regions of one account. They are the last field of the line rather
than a fixed column: an email address is wider than any column worth reserving on every key's
row. That is the whole of what the API can say — it is **write-only** (epic #65, A5). The
display name is the provider's, the credential type's where the name is that type's default
(`azure`, `bedrock`, `vertex`), or the reader's own label otherwise — so two Azure credentials
are told apart by the names they were saved under.
`oh providers remove <name>` forgets a credential after a `[y/N]` question (`--yes` skips it); deleting one that is not
there is not an error, because the route answers `204` either way.

### Slash commands, the menu, and the prompt slot (#207)

Every command is an entry in one registry (`src/chat/commands.ts`): a `name`, optional
`aliases`, a one-line `description`, an optional `args` hint, and `run(context, args)`. The
menu, the completion, `/help` and `oh --help` all read it, so a new command is one entry and
no other file knows its name.

`/model` picks a model (pending until the next message, as above), `/new` starts a new chat on
the current model (the app opens the session the way a first chat does, and the old screen's
stream is disposed with it), `/providers [provider]` connects a provider without leaving the
chat (#210), `/clear` wipes the screen with the Ctrl+L mechanism and keeps the
session, `/help` prints the commands and the keys above the prompt, and `/exit` (alias
`/quit`) leaves — the same leave as the second idle Ctrl+C.

What the prompt submitted is read by `parseChatInput`: `//…` is a message whose first slash is
dropped (the escape hatch for a literal `/`), `/name args` runs a command with the rest of the
line as its arguments, an unknown `/name` is named back with the closest match (edit distance,
ties by registry order) and sent nowhere, and anything else is a message. The command must
start the line — a line with a leading space is a message — which is the menu's rule too.

Typing `/` on an empty buffer opens the filtered list under the prompt. ↑/↓ highlight (they do
not walk the history while it is up), Tab completes the highlighted command into the buffer,
Enter runs it, Esc closes the menu and keeps the text. The menu closes once the command word
is over: at the first space, or as soon as the word is a command. Its rows are ANSI colours
(`cyan` for the highlighted one), and the usage column is padded to the whole registry's
widest label so the descriptions do not move as the filter narrows.

**The inline prompt slot** (`src/components/prompt-slot.tsx`) is the one mechanism through
which a flow takes the input area over and gives it back with a result:
`const answer = await slot.request<string | null>((settle) => <ModelPicker … onSelect={settle}
onCancel={() => settle(null)} />)`. The prompt is not rendered while a flow is up, so the flow
owns the keys (the screen's Ctrl+C/Ctrl+L stands down), and one flow at a time is a property
of the layout rather than a lock. The model picker and the `/providers` key entry are its two users today — the latter (#210, X7)
picks a provider, asks for a secret and saves it as one flow, settling once, which is why it
needed no change to the slot; a `question` part and an approval fit the same way, because how
many steps a flow takes is the flow's business. See
[`docs/commands.md`](./docs/commands.md).

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
leaves out counted above and below (`↑ 35 more`) — the counts are about what the search line
has left, so typing narrows the whole view. A number key picks only while the query is empty
and the list is at most nine long, with the same "12" rule as before; once a query is up the
digits are its characters.

### Updating itself

The CLI is published to npm as `@openh/cli` (#194, #152) and installed with `npm i -g
@openh/cli`, so there is no launcher to keep it current: it updates itself (epic #148,
decision D10). The ground it stands on is that the published package is one self-contained
file — `npm install -g @openh/cli@<v>` may replace it on disk while the running copy keeps
going, which is why the running process is never the one that changes and the next run is
simply the new version.

On startup — for every command except `--version`, `--help` and `oh update`, and before the
chat's Ink UI mounts or `oh login` starts its device flow, so a notice is never printed into a
screen — the updater does two things:

1. **The notice.** A finished install leaves its outcome in the state file; the next run prints
   it **once** and forgets it. A success is one line on stdout, `oh updated to v0.4.0`. A
   failure is one line on stderr — `oh could not update itself: <reason>; run npm i -g
@openh/cli` — plus, when npm could not write to its global prefix, a hint about sudo or
   `npm config set prefix`.
2. **The check.** At most once an hour (`lastCheck` in the same state file), it starts a
   **detached child** that does the whole check: `npm root -g`, `npm view @openh/cli version`,
   the comparison, and `npm install -g @openh/cli@<v>` when the published version is newer. The
   running process is untouched and never waits for any of it.

   The child is what makes the check work for a quick command (#197). A lookup is a network
   call nobody is waiting for, and `oh whoami` is over in microseconds — so anything the
   foreground kept doing died with the process before npm had answered, and the hour was spent
   anyway. The child is a fresh `node`, `unref`'d, its stdout and stderr on the null device;
   it is the only thing in the auto-update that outlives the run.

   So the foreground only decides _whether_ to start one, out of things that need no npm at
   all: the layout of the bundle it is running from (`detect.ts` — a checkout, or the package
   vendored inside somebody else's `node_modules`, is not a global install), the global root
   when the state file has one cached for this node, the hour, and the claim below. Most runs
   therefore spawn nothing, and the ones that spawn pay a few milliseconds for it — no npm, no
   network, nothing awaited.

   The comparison in the child is a copy of `semver.ts`'s (a small comparator, prereleases
   included, since the bundle cannot take a runtime dependency and a detached child has no
   module to import it from); `npm.test.ts` drives that copy through the wrapper over the same
   version pairs `semver.test.ts` asserts on, so the two cannot drift apart quietly.

A claim — `checking` in the state file: when, and the pid of the child that holds it — is what
keeps two `oh` started at once from both installing the same version: the second sees a claim
whose process is still running and stands down. The pid is the whole point of it: a claim whose
process is gone is stale — a check that was killed, a machine that went down — so the next run
claims the check itself and looks again, at once, rather than waiting the hour out. Its
timestamp is only a backstop, for a pid that has been recycled.

A detached child has no way to report back, so it is a tiny `node -e` program (`npm.ts`'s
`updateWrapperSource`) that does the check, runs npm, waits for it, and writes the published
version and npm's exit code and output tail into the state file, where the next run picks it
up. It writes `lastCheck` itself, when the lookup has actually answered: a lookup that failed
or was killed leaves the hour unspent, and the next run asks again. The wrapper is spawned as
either CommonJS or ESM (the input type of `-e` depends on the nearest `package.json`), which is
why its imports are `await import()`.

Both files live in the CLI's config directory, beside `config.json` and `credentials.json`:

| file                              | what it holds                                                           |
| --------------------------------- | ----------------------------------------------------------------------- |
| `…/openharness/update-state.json` | `lastCheck`, the claim, the cached global root, and the pending outcome |
| `…/openharness/update.log`        | npm's output from the last detached install                             |

The auto-update is **off** when any of these says so:

- `OH_NO_AUTO_UPDATE` is set (blank, `0` and `false` do not count — the rule `CI` already gets);
- the config file sets `"autoUpdate": false`;
- `CI` is set;
- this `oh` is not a global npm install.

The last is the one that matters and it is deliberately two questions, because one of them is
free. The running bundle must sit at `<somewhere>/<module dir>/@openh/cli/dist/index.js` — the
scope is a folder of its own, so the package folder is two levels above the bundle, not one
(reached through the `bin` symlink npm installs, so the check realpaths first) — which
`node apps/tui/dist/index.js` from this repo does not, and that answer costs nothing. Then that
module directory must be the one `npm root -g` names; only this needs npm. The free half is
answered in the foreground (`globalModuleDirectory`), and the half that needs npm is answered
in the child — which caches its answer in the state file beside the `node` that produced it, so
a checkout never spawns npm at all, an installed `oh` spawns it at most once per node
installation, and a package that is _not_ the global one spawns one child, once, ever. A
`realpath` that fails, a missing `npm`, a mangled state file: every one of them ends the same
way, as "no update", never as a failed command.

`oh update` does the same thing in the foreground: the version lookup, then npm's own install
output as the progress, `0` when the CLI is current or just became so and `1` when npm could
not be asked or the install failed. It works with the auto-update switched off — it is the one
thing that is always about updating — and refuses with exit `2` when this `oh` is not a global
install, because there is nothing here for npm to replace.

## In the chat

| key                     | what it does                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `/` + Enter             | the command menu: `/model`, `/providers`, `/new`, `/clear`, `/help`, `/exit` (#207, #210)             |
| Enter                   | send — also while a reply streams, which is what steering is                                          |
| Ctrl+J, Alt+Enter       | insert a newline                                                                                      |
| ←/→, Home/End, Ctrl+A/E | move the cursor; Home/End and Ctrl+A/Ctrl+E take the line's ends                                      |
| Backspace / Delete      | delete behind the cursor, and at it                                                                   |
| Ctrl+U / Ctrl+K         | delete to the start of the line, and to its end                                                       |
| Ctrl+W, Alt+Backspace   | delete the word before the cursor                                                                     |
| Alt+B / Alt+F, Ctrl+←/→ | jump a word back and forward                                                                          |
| ↑/↓                     | the menu's rows while it is open (#207), otherwise the buffer's own lines and then the history (#206) |
| Tab                     | complete the highlighted command into the buffer (#207)                                               |
| Esc                     | close the menu, keeping the text (#207)                                                               |
| Ctrl+L                  | clear the screen; the session stays (#206)                                                            |
| Ctrl+C                  | interrupt the running turn; pressed again when idle, leave                                            |

"Shift+Enter" is not a key a terminal can send — most send the same `\r` for both — so the
newline is bound to **Ctrl+J** (line feed, `0x0A`, against Enter's `0x0D`), which every
terminal can send and none confuses with Enter, and to **Alt+Enter** (`ESC` + `\r`) for muscle
memory.

The editing keys are readline's (#206), and the cursor is drawn as an inverse-video cell,
including on a multi-line buffer. A paste is one **bracketed-paste** event — Ink's `usePaste`,
which turns bracketed paste mode on while the prompt is mounted — so it arrives as a single
string that is inserted verbatim, newlines included, and nothing inside it can be read as a
keypress: a pasted line ending does not send. A paste over 2,000 characters is shown collapsed
as `[pasted N lines]` and sent in full. ↑/↓ walk what this user has sent to this server, kept
in `~/.config/openharness/history.json` under the server and the user, capped at 500 entries;
the full list of bindings, the file's shape and the "don't record" seam the hidden-input issue
(#207, X7) will use are in [`docs/prompt.md`](./docs/prompt.md); the slash menu that shares the
↑/↓ keys with the history is in [`docs/commands.md`](./docs/commands.md).

On the way out the CLI prints `Resume this session with: oh -s <id>` — unless the session
was deleted while the chat was open, when it prints `This chat was deleted; it is gone.`
instead (epic #116 U5).

### How a message is drawn

**Everything starts at column 0** (#229). `MessageView` lays a message out — the wrapping, the
block cursor while a reply streams, the `(queued)` note — and draws its content part by part
through `PART_RENDERERS` (epic #201, X1), a `Record<MessagePart['type'], …>` that holds the
text renderer today and is where the next phases' parts — a tool call, a question, an approval
— get theirs. A renderer returns **lines of styled spans**, not characters and not a `<Text>`:
Markdown needs more than a string (a heading is bold, a table is a box, a code block is a
tinted panel) and less than a `<Text>` (the band around a user's message is not its business),
and the renderer is handed the width of the message itself, since the pass took the label away.
Each line is one `<Text>` whose children are the spans — nested text nodes are one line of
output, where sibling ones in a column would be two.

The label and the hanging indent under it are gone, because both were characters in front of a
line: selecting a reply and pasting it pasted them too. What tells the two apart instead is a
**band** — every line of a user's message carries a background, padded to the terminal's edge —
and a dim `›` on a line of its own above the message under `NO_COLOR`, where there is no colour
to band with. `messageLayout()` in `message-view.tsx` decides all of that as plain data so a
test can hold it still, and `MessageView` draws it.

**A background is drawn in as much colour as the terminal has** (#231). The sixteen named
colours have no subtle gray, so the band and the code block's panel are _derived_ shades of the
detected background instead: 24-bit hex on a level-3 terminal (`COLORTERM=truecolor|24bit`), the
nearest grays of the 232-255 ramp on a level-2 one (`TERM=…-256color`), the named colours `oh`
has always used below that, and nothing at all under `NO_COLOR` — which is why `TerminalTheme`
carries a `level` beside the background and the flag. Foreground colour is unchanged: named ANSI
colours, except inside a code block's syntax theme. The shades and the argument for them are in
[`docs/markdown.md`](./docs/markdown.md).

Messages are separated by one blank line, drawn as part of the next message's output rather
than as a thing of its own — a reply arrives as one `<Static>` write, and a separator of its
own would be written twice: once while that message was live, and again when it settled. A
user's message brings the blanks around its band itself, so the transcript draws no separator
around one and asks a user's message for the line above it only when the message above is not
another user's message: one blank line between any two messages, and none at the top.

An **agent** message is rendered as Markdown and a **user** message as typed, and both are
wrapped to the terminal width, hard-wrapped, with Ink re-wrapping anything wider than the
terminal, `<Static>` included — so the newlines a copied paragraph has are the terminal's and
the text in front of them is nothing. The width is read when the message is drawn, which is
what makes a resize leave the scrollback alone (#201, X2): settled messages are Ink's
`<Static>` and are never re-rendered, so they keep the width they had. The last column is left
empty: the `▌` a streaming reply ends with is a column of its own, and a full-width line — a
code panel's padding, a paragraph wrapped to the final column — would push it onto a line of
its own, which was the streaming bug #229 reports. Foreground colour is ANSI named colours
only, the code theme is chosen from the terminal's background, the two backgrounds are derived
shades of it where the terminal can mix one (#231), and `NO_COLOR` drops the lot (#201, X4).
The renderer, the tables, the code panel and the theme are
[`docs/markdown.md`](./docs/markdown.md); the wrapping itself is `src/markdown/text.ts`.

A **settled agent reply** carries one dim line under it — what it ran on, how long it took,
what it cost (`4.2s · 1.3k tokens`) — written by `components/reply-meta.ts` and drawn by
`message-view.tsx` at column 0 with the reply, and set off from it by **a blank line** (#233),
so the line reads as a footer rather than as a last line of the reply. The model appears only
when it is news (the session's own, or the previous reply's, is not), and a field the log does
not have is left out; a reply with nothing to say has no line at all — and so no blank line
either. Because the tokens and the duration arrive with the reply's `span.model_request_end` —
_after_ the reply itself — a reply is held out of `<Static>` until that lands or its turn goes
idle (`TranscriptView`'s `holdLive`, from `ChatViewState.awaitingMetaId`); otherwise Ink would
write the message once, without a line that did not exist yet, and never redraw it (#208, X2).

A **message that draws nothing is not a block**: a reply the log has announced but that has not
produced a token yet is in the transcript with no parts and no text, and the blank lines the
transcript draws around blocks — and the one the input section owes it (#233) — are not drawn
around it (`draws` in `message-view.tsx`, and `TranscriptView`'s `blocks`).

### The input section

The bottom of the screen is its own section (#233): one blank line under the transcript, then a
**dim full-width rule** (`InputRule`), then the status line, then the prompt — and the command
menu, the flow in the prompt slot and the hidden key input all render under the rule with it.
The rule is drawn from column 0 in the `chrome` colour and dim, like the transcript's own rules,
and stops one column short of the terminal because the transcript reserves that column for its
streaming cursor (`CURSOR_COLUMNS`) — and it is the plain `─` under `NO_COLOR`, because a rule
is a character rather than a surface.

The blank line above it is drawn by the section and only when it is not already there: a user's
message ends in a blank line of its own (its band does), a notice never does, and an empty
transcript at the start of a session has nothing to be set off from. The whole rhythm — reply →
blank → metadata → blank → rule → status → prompt — is held still by a frame test in
`src/app.test.tsx`, because whether the blanks each piece draws add up to one or two is a fact
about the screen and not about any one component.

### What the status line says

`components/status-line.tsx` draws the input section: the rule that opens it, and one line —
who is answering, the model, the session and the status. The mode the chat follows comes first when there is one
(`smart · claude-sonnet-5`, #245, M6), then the model — named the way the catalog
names it when the catalog is known, and by its `provider/model` id otherwise — a chat opened on
`--model` or a stored default never _waits_ for the catalog, which is what makes it start
immediately (a background read fills the names and the prices in, #247).
The session is a shortened handle (`sesn_…Q092B1`), for recognition rather than for `oh -s`. The
parts are dropped — whole, least important first — when the terminal is too narrow, and the
status is the one that stays. Only named ANSI colours, and `NO_COLOR` drops them (#201, X4).

The line also carries **what the session has spent** (#247), between the session handle and
the status: `formatCostTotal(sessionCost(selectSessionUsage(transcript), costOf))`, priced with
the catalog's rates. A total **sums the requests it can price and counts the rest** (`$1.23 + 4
unpriced`, decided 2026-10-09), and `—` is drawn only when nothing in the session could be
priced. Nothing is drawn until a request has run. When the terminal is too narrow for the full
line the cost is **shortened before it is dropped** — `$1.23+`, the money with the count
collapsed to a trailing plus — and only then does the segment go, before the session and the
model: the status is what the line exists for.

The rates come from a catalog the screen reads **once, in the background**, purely for the
prices and the display names (`chat/screen.tsx`): a chat opened on `--model` or on a stored
default still starts immediately, and a chat that never reads one shows no cost at all rather
than a dash that claims to know. Until it lands the transcript settles **nothing** (`holdAll` on
`TranscriptView`) — Ink writes a settled message once and never redraws it (#208, X2), so a
footer that settled early would keep a cost it could not compute, and that applies to the
replies loaded from history as much as to the live one. The messages are still drawn while they
are held (live rather than static); they settle, with their costs, the moment the read answers,
whatever the answer was.

The status field doubles as the **working indicator** (#208): `Working… 12s` with a turning
spinner while a running turn has produced no text yet, `running` once it has, the spinner back
if the reply goes quiet for over three seconds, `Retrying… <reason>` while the server retries,
and `Interrupted` after a Ctrl+C. The clock comes from the events' own `processed_at`, and the
ticking lives in this component and nowhere above it — a timer that re-rendered the chat screen
would re-render the transcript with it. A retrying turn says so here instead of in a notice
line of its own. The rules, the palette and the metadata line's formats are
[`docs/status.md`](./docs/status.md).

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
  atomic-write.ts        the atomic 0600 write credentials.json and history.json share
  history.ts             history.json: the prompts ↑ walks, per server and user (#206)
  browser.ts             open the sign-in page (xdg-open / open / start), and when not to
  errors.ts              ApiError / fetch failures → a message and hints
  help.ts                the --help text
  providers/
    credential-form.ts   CREDENTIAL_FORMS: the key form, built from the credential type (#210)
  signals.ts             SIGINT/SIGTERM/SIGHUP → handlers, and a disposer
  terminal.ts            restoreTerminal (raw mode off, cursor shown), and clearScreen
  version.ts             the version injected at build time
  paging.ts              listAll: walk next_page to the end of an agents/sessions list
  modes.ts             modes: what a mode resolves to, the name a chat follows (#245, M6)
  chat/
    session.ts           the runtime: transcript + stream + send/interrupt/dispose,
                         the pending `/model` pick (a model or a mode), and the
                         deleted-session end state
    screen.tsx           the chat screen (transcript, status line, prompt, the slash
                         commands), and the prompt slot's first flow
    commands.ts          the slash-command registry, `parseChatInput`, the "did you mean",
                         the keys `/help` and `oh --help` both list (#207)
    target.ts            which session to open, and the model/agent-selection rules
    ctrl-c.ts            the Ctrl+C rules (interrupt / arm / exit)
  markdown/
    text.ts              spans and lines: what a rendered line is, and the ANSI-free wrapper
    theme.ts             named colours, the light/dark code palettes, the derived band and
                         panel tints, NO_COLOR, COLORFGBG, the colour level
    highlight.ts         highlight.js → coloured spans, for the code blocks
    parse.ts             a reply's text → mdast (remark-parse + remark-gfm)
    render.ts            mdast → lines of spans: headings, lists, tables, quotes, code (#205)
  components/            message-view (a message, the renderer per part type, and the
                         per-reply metadata line, #201/#208/#233), reply-meta (the
                         words and numbers that line is made of), theme (the context the
                         transcript reads), transcript-view (the static/live split and the
                         blank lines between blocks, #208/#233), status-line (the rule that
                         opens the input section, the line, the working indicator and its
                         clock, #208/#233), prompt-input
                         (and its command menu), prompt-slot (what takes the input area
                         over, #207), secret-input (a masked, non-echoing one-line input,
                         #210), provider-setup (the connect-a-provider flow, #210),
                         notice-view, model-picker
  update/
    index.ts             the auto-update: the notice, and the decision to check
    decide.ts            the off switches (env / config / CI), the hourly throttle, the claim
    semver.ts            the version comparator — the bundle cannot borrow one
    detect.ts            is this `oh` a global npm install, and the module dir the child needs
    npm.ts               spawning npm, and the detached check's `node -e` program
    state.ts             update-state.json: the timestamp, the claim, the root, the outcome
    notice.ts            the one line the next run prints, once
  commands/list.ts       `oh sessions` / `oh agents` / `oh sessions delete`
  commands/modes.ts      `oh modes` (#245, M6)
  commands/providers.tsx `oh providers` / `add` / `remove` (#210)
  commands/preferences.ts  `oh default-model`
  commands/io.ts         what a print-and-stop command writes, how it fails, and the
                         read-line / y-or-n pair the commands that ask share
  commands/auth.ts       `oh login` / `oh logout` / `oh whoami`, and offerSignIn — the
                         device flow a chat that found no session offers to run (#210)
  commands/update.ts     `oh update` — the auto-update, in the foreground
  dev/fake.ts            OPENHARNESS_FAKE: the fake client, seeded, dev only
  test-support/          test-only helpers (fake clients, keystrokes, frame waits, and this
                         package's own version, which `--version` prints)
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
session with history behind it for `--continue` and `-s <id>`, and the scripted conversation
that session gives — `oh -c` is how you see it, which is why the replies are scripted on that
session and not on the fake's own: a chat the CLI opens is a session of its own, created at
run time, with an id nobody could have scripted for. One of the replies is a Markdown
showcase, so the transcript's rendering is visible from the first run.
It is a development and QA aid — the entry point is loaded lazily, so a normal `oh` never
reads it, and nothing in this package enables it on its own. See `src/dev/fake.ts`.

The auth commands run against the fake too: `oh login` asks it for the (deterministic) codes,
polls it once, and stores its `FAKE_SESSION_TOKEN` in the real credentials file — point
`XDG_CONFIG_HOME` at a scratch directory when you do that by hand. `oh logout` signs the fake
out; `oh whoami` reads what the login stored.

`OPENHARNESS_FAKE_SIGNED_OUT=1` (beside `OPENHARNESS_FAKE=1`) makes the fake start **signed
out**, which is how the sign-in a chat offers with no session — and the 401 a stale one gets —
is seen without a server and a second terminal (#210). The seeding happens first and the
sign-out last, so the catalog and the default model are the dev ones; `oh` then asks
`Sign in now? [Y/n]`, and the fake's scripted device flow approves.

The dev fake's clock ticks a millisecond a call, so the agents and sessions it seeds have a
known order: a list is ordered by `(created_at, id)`, and two rows created inside one
millisecond are tied and then ordered by the random half of their ULIDs.

## Public API

| `@openh/cli` (npm) | `PACKAGE_NAME`, `App`, `parseArgs()`, `readVersion()`, `run()`, `createChatSession()`, `resolveConfig()`, `describeError()` |
| `oh` (bin) | the commands above |

The version is injected at build time from `package.json` as `__CLI_VERSION__`
(see `tsdown.config.ts` and `vitest.config.ts`), so `oh --version` works from any
working directory and cannot drift from `package.json`.

## Packaging

`npm i -g @openh/cli` installs the package as the `oh` command. The published package is
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
(the off switches, the throttle, the claim, the version comparison, the cached global root)
tested against fakes, and the one thing that _must_ be exercised through a real subprocess —
the spawn, the detached child's check, its log and state file, the exit code it records, and
that it outlives the process that started it — runs against a **fake `npm` on `PATH`**, a small
shell script, rather than a mocked `spawn`. `run()` itself takes the updater as a `RunOptions`
seam, so its tests watch which commands reach it without anything spawning npm.

The auth side is tested at both levels: `src/credentials.ts` against a temp directory (the
atomic write, `0600`/`0700`, per-server tokens, the errors a broken file produces),
`src/browser.ts` with an injected spawn (the CI / SSH / no-display skips and the per-platform
command), and `src/commands/auth.ts` against the fake's scripted device flow (approval, expiry,
denial, cancellation, revoke failures); `src/index.test.ts` drives `run()` all the way through
`login` / `whoami` / `logout` with `XDG_CONFIG_HOME` pointed at a temp directory.

| file                                              | covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.test.ts`                               | `run()` end to end: the exit codes, login / whoami / logout, signals, `default-model` and `sessions delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/args.test.ts`                                | `parseArgs` and `readVersion`: every command, unknown and conflicting flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/config.test.ts`                              | the precedence chain, and the errors a bad config file produces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/credentials.test.ts`                         | the credentials file: atomic write, `0600`/`0700`, per-server tokens, a write that failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/history.test.ts`                             | `history.json`: the list, the cap, consecutive duplicates, per server _and_ user, `record: false`, and the reads it tolerates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/components/prompt-input.test.tsx`            | every prompt binding, the cursor's line, history browsing with a draft, multi-line navigation, paste (#206), and the command menu's keys and filtering (#207)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/chat/commands.test.ts`                       | the registry, the parse (`//`, unknown, aliases), the filter, the closest match, `currentModelOf`, and every command's `run` (#207)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/components/command-menu.test.tsx`            | the menu's rows, the highlight, and the usage column padded to the whole registry (#207)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/components/prompt-slot.test.tsx`             | a flow in the prompt's place, its result, its steps, and a flow that replaces one that is up (#207)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/providers/credential-form.test.ts`           | the form table: a form per credential type (the `api_key` one, azure's three fields with the deployments split, bedrock's region list with its default, its two keys and its optional token, and the custom endpoint's base URL and optional key — omitted from the body when empty), the bodies they build — a skipped session token left out rather than sent empty, and vertex's key-file path, project and location, the project offered from the key document's own — `nameErrorMessage`, and the fallback for an unknown provider (#210, X6; #245 A3a/A3b/A3c/A3d)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/components/secret-input.test.tsx`            | the hidden input: no echo, the mask's length, paste (newline and all), Enter/Esc, the character the flow claims before it is inserted, and an **optional** field submitting its empty value (#210, #249)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/components/provider-setup.test.tsx`          | the connect flow: the provider list and its free-tier hints, the key page and `o`, a save, a rejected key asking again, a stale session, Esc back and Esc out (#210) — the Azure form: its three fields one prompt at a time, the endpoint shown because it is not a secret, the name prompt a second credential gets, and a name already taken refused before the fields (#245 A3a) — the Bedrock form (#245 A3c): the region as a list whose cursor moves with ↑/↓, a save carrying the picked region, a token typed and a token **skipped**, no secret in any frame, and a second credential under its own name and region — and the custom form: a base URL and a keyless save, no key page, the name prompt saying `<name>/<model>` (#249, A3b) — and the Vertex form (#245 A3d): the key read from a path the reader gives and never put on the screen, the project prompt opened with the key document's own project, and a location outside Google's list refused rather than sent |
| `src/commands/providers.test.tsx`                 | `oh providers`: the list's columns, the remove question, `--yes`, and the connect screen end to end (#210)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/markdown/text.test.ts`                       | the wrapper: prose and pasted indentation, wide characters, long words, truncation and alignment (#205)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/markdown/theme.test.ts`                      | `COLORFGBG`, `NO_COLOR`, the colour level (`COLORTERM`, `-256color`, and nothing), the config's `theme`, the two syntax palettes, and the band and panel per level and background (#205, #231)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/markdown/highlight.test.ts`                  | highlight.js → spans: tokens, nested scopes, entities, a language it does not know, half a snippet (#205)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/markdown/render.test.ts`                     | mdast → lines: every element, the table in the room it has, the code panel (the label at the right edge, the padding, the code at column 0, the labels-less fallback), NO_COLOR, no line wider than its box, and a fence that has not closed laid out like the block it becomes (#205, #229, #231)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/components/message-view.test.tsx`            | the frame: column 0, a reply rendered as Markdown, wide characters, the cursor, `(queued)`, the metadata line and the blank line above it, the band a user's message sits on (per colour level) and its `NO_COLOR` mark, the code panel growing line by line, and a half-streamed fence that does not jump (#205, #208, #229, #231, #233)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/components/reply-meta.test.ts`               | durations, token counts and costs, and the line they compose: the model only when it is news, nothing invented, no line when there is nothing to say, `—` at the end of the line for a model nobody prices, and no cost at all from a caller with no catalog (#208, #247)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/components/status-line.test.tsx`             | the input section's rule (its width, its colour, `NO_COLOR`, the blank line above it), the line's parts and colours, the shortened id, the model's display name, the spinner on fake timers, the quiet window, retrying and interrupted, and what a narrow terminal drops (#208, #233)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/browser.test.ts`                             | the skip rules and the per-platform command, with an injected spawn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/commands/auth.test.ts`                       | `oh login` / `logout` / `whoami` against the fake's scripted device flow, mid-poll cancellation included, and `offerSignIn` — the chat's offer, and the answers it takes as yes (#210)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/commands/preferences.test.ts`                | `oh default-model`: print, set, replace, the failures                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/commands/list.test.ts`, `src/paging.test.ts` | the listings, their formatting, `sessions delete`, and the `next_page` walk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/chat/session.test.ts`                        | the runtime: transcript, stream, send, `/model`, deleted sessions, dispose, and the turn clock the status line reads (#208)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/chat/target.test.ts`                         | session/model/agent selection, the default model, and the paging it needs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/chat/ctrl-c.test.ts`                         | the Ctrl+C rules: interrupt, arm, exit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/components/model-picker.test.tsx`            | the picker: windowing, number keys, the free-text row, and the search line: `pickerRows` as a rule, the filtering list, heading hiding, the cursor reset, digits, Esc, the counts, the empty state and prefill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/app.test.tsx`                                | the Ink screens through `ink-testing-library` and `createFakeClient()`, and the bottom of the screen whole: reply → blank → metadata → blank → rule → status → prompt, and one blank line and no more while a turn works (#233)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/errors.test.ts`                              | `describeError`: the 401 line, the connection hints, 403/429, `--debug`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/signals.test.ts`, `src/terminal.test.ts`     | the signal handlers and `restoreTerminal`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/update/semver.test.ts`                       | the comparator: the three numbers, prereleases, and what is not a version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/update/decide.test.ts`                       | the off switches, the hourly throttle, and the claim (the pid liveness included)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/update/state.test.ts`                        | `update-state.json`: the write, the tolerant read, and the once-only consume                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/update/detect.test.ts`                       | the global-install check, `bin` symlink and case-insensitivity included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/update/notice.test.ts`                       | the one line: its two shapes, the stream it goes to, and that it never repeats                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/update/npm.test.ts`                          | npm over a fake `npm` on `PATH`: the lookup, the timeout, and the detached check's whole program                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/update/check.test.ts`                        | the foreground decision: the gate, the throttle, the claim, and the spawn, against a fake runner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/commands/update.test.ts`                     | `oh update`: up to date, installed, failed, and refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/dev/fake.test.ts`                            | the fake-mode gate and the seeded dev client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

The modes suite (#245, M6) is tested here too: `src/modes.ts` and `src/commands/modes.ts` on
their own, the `/model` picker's Modes group and the `--mode` flag in `src/args.test.ts` and
`src/chat/target.test.ts`, the mode on the status line in `src/components/status-line.test.tsx`,
and a whole chat that follows a mode from `src/chat/session.test.ts`.

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
