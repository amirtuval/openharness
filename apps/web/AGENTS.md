# @openharness/web

The openharness web app: a chat UI for the v1 API, built with Vite + React + TypeScript,
Tailwind and shadcn/ui. It talks to the server only through `@openharness/client`, signs in
through Better Auth's browser client, and every piece of chat state comes from the client's
transcript reducer — there is no second store.

The long version of the decisions below, and what to watch out for, is in
[`docs/chat-ui.md`](./docs/chat-ui.md) and [`docs/auth.md`](./docs/auth.md).

## Commands

Run from this folder (`apps/web`):

| command             | what it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `yarn build`        | builds the static site into `dist/` with Vite                           |
| `yarn build:deps`   | builds only this package's workspace dependencies (turbo filter `^...`) |
| `yarn dev`          | Vite dev server on http://localhost:5173, with `/v1` proxied            |
| `yarn typecheck`    | `tsc --noEmit`                                                          |
| `yarn lint`         | ESLint over this folder                                                 |
| `yarn format`       | Prettier `--write`                                                      |
| `yarn format:check` | Prettier `--check`                                                      |
| `yarn test`         | Vitest, single run                                                      |

`yarn build:deps` matters when you work in isolation: it builds this package's workspace
dependencies (from the repo root's installed `node_modules`) without touching the rest of the
repo.

## Running it

Development and tests run either against a real server or, with no server around, entirely on
the client's fake server.

```bash
# UI only, in-memory server, seeded scenario, scripted replies
VITE_OPENHARNESS_FAKE=1 yarn dev

# against a real server (defaults to http://localhost:3000 for /v1)
yarn dev
OPENHARNESS_PROXY_TARGET=http://localhost:8787 yarn dev
```

`yarn dev` proxies `/v1` to `http://localhost:3000` (the target comes from
`OPENHARNESS_PROXY_TARGET`, read in `vite.config.ts`). With an empty server URL in the
settings — the default — the app calls `/v1` on its own origin, which is exactly what the
proxy answers in dev and what a static `dist/` served next to the API wants in production.

The fake is signed in and has no sign-in page of its own — it answers `me()` and every other
`/v1` call — so fake mode still develops the chat without a server; the sign-in page appears
against a real one (or with `authenticated: false` in a test).

Fake mode is development-only by construction: the gate is
`import.meta.env.DEV && import.meta.env.VITE_OPENHARNESS_FAKE === '1'`, which a production
build replaces with `false`, and the fake itself is a dynamic import — so neither the branch
nor the `@openharness/client/testing` chunk ends up in `dist/`. The fake is also handy in a
browser console: fake mode puts it on `window` as `__openharnessFake`.

## Structure

```
src/
  main.tsx                     bootstrap: resolve the client (fake in dev mode), render <App>
  App.tsx                      the client from the settings, the routes, the app shell:
                               sidebar (column or drawer), the top bar, the routed screen
  index.css                    Tailwind + the shadcn design tokens (dark follows the system;
                               `color-scheme` + the popover tokens keep the native controls —
                               select popups, datalists, scrollbars — in the same scheme)
  components/
    client-provider.tsx        the client in context, so screens can use it
    auth-provider.tsx          the Better Auth browser client in context
    provider-icon.tsx          the Google / GitHub / Microsoft marks, inline
    sidebar.tsx                session list (newest first), New chat, Settings,
                               the row's kebab menu (Delete chat, in-page confirm),
                               and the signed-in user with Sign out at the foot;
                               the column from `md` up, the overlay drawer below it
    settings/
      model-providers.tsx      Settings -> Model providers: the list, add/replace, delete
      default-model.tsx        Settings -> Default model: the picker, saved to preferences
    chat/
      chat-view.tsx            the chat screen: header (+ delete), messages, errors,
                               composer with the model selector, the model-change marker
      message-list.tsx         the scrolling conversation + stick-to-bottom
      message-item.tsx         one message (user right / agent left, markdown), and the
                               "Switched to …" marker when it changed the model
      markdown.tsx             react-markdown + remark-gfm, styled element by element
      composer.tsx             the input; Enter sends, Stop appears while running, and
                               the model control sits in its bottom row
      status-indicator.tsx     running / idle / retrying
      error-banner.tsx         inline errors (from the log, or from a failed request)
    models/
      model-picker.tsx         THE model control: grouped, searchable, free text, refresh;
                               `full` in Settings, `compact` in the composer (#91, #113)
    ui/                        shadcn/ui primitives, copied from the registry
  screens/
    home-screen.tsx            no chat open
    new-chat-screen.tsx        an empty composer on the default model; the session is
                               created with the first message (#113); with no default the
                               catalog decides (#146): the picker with a pick required, a
                               preselected sole model, a loading state, the catalog's
                               error, or the "add a provider key" state when there are
                               no providers and no models
    settings-screen.tsx        the server URL (localStorage), Default model, Model providers
    sign-in-screen.tsx         one button per provider, the dev form when offered
    device-screen.tsx          the device-approval page `oh login` opens
  hooks/
    use-session.ts             THE session hook: history, live stream, send (with a model), interrupt
    use-sessions.ts            the sidebar's list, plus create and remove (and forget)
    use-session-refresh.ts     the re-read after a first message, shared by both of those
    use-models.ts              the catalog (GET /v1/models), once for the whole shell
    use-preferences.ts         GET/PUT /v1/me/preferences: the default model
    use-auth.ts                the auth store's React binding
    use-auth-config.ts         GET /v1/auth-config for the sign-in page
    use-provider-credentials.ts  the credentials list, plus save and delete
    use-notice.ts              the shell's one-line notice (a chat deleted elsewhere)
    use-stick-to-bottom.ts     auto-scroll that stays put when the reader scrolls up
    use-route.ts, use-settings.ts   thin React bindings over the two small stores
  lib/
    router.ts                  the hash routes (#/s/<id>, #/new, #/settings,
                               #/signin, #/device?user_code=...)
    auth-config.ts             GET /v1/auth-config, validated with a local zod schema
    auth-client.ts             Better Auth's browser client, narrowed to the calls we make
    auth-store.ts              who we are signed in as, and "a 401 means sign in again"
    settings.ts                localStorage settings, a stable snapshot for React
    notice.ts                  the shell's notice, a one-line store
    providers.ts               the provider names the *credentials* form offers
    session-refresh.ts         the one re-read of a session whose first message named it
    dev-fake-client.ts         dev-only fake client + the seeded scenario
    models.ts                  helpers over the catalog: grouping, name lookup
    paging.ts                  walking `next_page` for the two lists, with a safety cap
    errors.ts, format.ts, utils.ts
  test-support/render-app.tsx  render the app against a fake client; DOM readers
  test-support/stream.ts       gate the fake's stream, one event at a time
  test-support/catalog.ts      the two-provider catalog fixtures the picker tests share
```

### Routes

| route                       | screen                                           |
| --------------------------- | ------------------------------------------------ |
| `#/`                        | home (no chat open)                              |
| `#/s/<sessionId>`           | the chat                                         |
| `#/new`                     | new chat: an empty composer on the default model |
| `#/settings`                | server URL, Default model, Model providers       |
| `#/signin`                  | sign in (`?next=<hash>` to return there)         |
| `#/device?user_code=<code>` | the device-approval page `oh login` opens        |

There is no `#/agents` route since #91: chatting is model-first, agents are hidden from the
UI, and an old bookmark to that screen lands on home.

Signed out — a 401 from `client.me()` at startup or from any later call — the shell renders the
sign-in page in place of everything else, and signing in puts the reader back on the route they
were on; `#/device` is the one route that is reached signed out on purpose, and it signs the
reader in first (a device code is claimed by the session that approves it).

Hash routes, so the build stays a static bundle that any static host can serve without a
rewrite rule. Chat links are real `<a href="#/s/…">`, so Back, middle-click and a reload land
where a reader expects.

## State flow

`useSession(client, sessionId)` (`src/hooks/use-session.ts`) is the one place the chat state
lives. It owns a `createTranscript()` store and, in one effect:

1. loads the history with `client.sessions.events.iterate(sessionId)` and folds it into the
   transcript;
2. then follows live with
   `client.sessions.events.stream(sessionId, { deltas: true, afterSeq: transcript.getState().lastSeq })`
   — exactly where the history stopped, so nothing is replayed and nothing is missed;
3. aborts the stream on unmount (`signal.abort()` ends the iteration quietly, no throw).

Rendering reads the store with `useSyncExternalStore(transcript.subscribe, transcript.getState)`,
so the transcript stays plain data, and a reload is just the same code path as opening the
session for the first time — which is why it restores the history _and_ resumes the stream.

`send(text)` calls `client.sendMessage` and folds the returned stored event in immediately:
the message shows at once, and the stream's copy of the same event is dropped by the
transcript's `seq` rule, so nothing is duplicated. While a turn is running, `send` is a
steering message — the server queues it, and the transcript shows it as `pending` until the
next model request picks it up. `interrupt()` is the Stop button (`user.interrupt`); the
partial reply stays on screen, which is the transcript's rule, not the UI's.

**A session is named by the request that stores its first message** (`apps/server/src/titles.ts`,
PR #32), which answers with the stored events rather than the session and is never announced on
the stream. So once this chat's transcript holds a `user.message` and the session still shows no
title, `useSession` asks `src/lib/session-refresh.ts` for one re-read: at most one per session,
nothing polls, and the copy it reads is what both this header and the sidebar row render — which
is why a new chat's header and sidebar row switch from the model's name to the derived title a
moment after the first message, with no reload and no second walk of the list.

Failures never throw at the user: a failed load, send or interrupt lands in `requestError`,
and a `session.error` from the log is `lastError` — both rendered inline above the composer.

## Paging: the session list

`GET /v1/sessions` answers one page at a time (`{ data, next_page }`), and the page size
defaults to 20 — so a list that reads one page silently hides everything past it. The sidebar
is the only way to an older chat, which is where that bites.

`src/lib/paging.ts` is the one place that walks the pages. `listAllPages(fetchPage, options)`
asks for `MAX_PAGE_LIMIT` (100, the protocol's maximum) and then keeps asking with
`page: next_page` until the server answers `null`; cursors are opaque and are handed back
exactly as they arrived. It stops on the first of:

- `next_page === null` — the end of the list;
- a cursor the server has already handed back (which would otherwise page forever);
- `MAX_PAGE_ITEMS` (1000) items — a documented safety cap, so a server with a very long list
  cannot make the browser hold an unbounded one;
- an aborted signal.

Only the cap sets `truncated`, and the sidebar renders `and more… only the first 1000 are
listed` when it does. Anything else is a complete list.

`useSessions` is the one caller that remains (#91): `onPage` sets the first page straight away
and appends the later ones (`appendUnseen`, which drops an item that was already added by a
`create` while the walk was running), so the sidebar is usable while the rest of a long list
is still loading. It also returns `truncated`, and never decodes a cursor itself. The agents
list used to be the second caller; the agents screen is gone (see below), but `listAllPages`
stays generic.

## Errors

`src/lib/errors.ts` turns anything thrown into the one line a banner shows
(`describeError(error, context)`), and it is the only place that decides what a failure is
called. Its wording follows the TUI's (`apps/tui/src/errors.ts`) without importing from it —
the frontends share the protocol and the client, not their errors.

- **A request that never reached the server** is caught by what `fetch` throws, which is not
  the same in every browser: a `TypeError` saying "Failed to fetch" (Chromium), "NetworkError
  when attempting to fetch resource." (Firefox) or "Load failed" (Safari), or "fetch failed"
  with `ECONNREFUSED`/`ENOTFOUND`/… in the `cause` chain under Node. The client wraps none of
  this — only an answer from the server becomes an `ApiError` — so the original error is what
  arrives, and the browser's words ("Failed to fetch") are what the reader used to see. It now
  reads `Can't reach the openharness server at <url>. Check that it's running, or change the
server URL in Settings.`, with **this site** in place of the URL when the setting is empty
  and the app is calling its own origin.
- **A session the server will not take** (a 401) keeps the server's own message and adds
  `Sign in again to continue.` Most 401s never reach a banner: `noteAuthenticationError`
  turns them into the sign-in page first (see `docs/auth.md`). A 403 is reported as what it
  is — a refusal, not a missing session.
- **Everything else** keeps its message; an abort is "The request was cancelled." rather than
  a failure.

The context is the configured server URL, read from the settings store by the hooks that catch
(`use-session`, `use-sessions`, `use-models`, `use-provider-credentials`) — the same store the
client is built from, so the URL in the message is the URL that was called.

## Authentication

A browser's session is a **cookie** the server sets (epic #65, A2): the app cannot read it,
never stores a token, and `@openharness/client` sends `credentials: 'include'` on every request.
Signing in is Better Auth's own `/api/auth/*` surface (A1), through the typed adapter in
`src/lib/auth-client.ts`; who we are comes from `client.me()`; and a **401 from any call**
becomes the sign-in page through `src/lib/auth-store.ts` — including the 401 the client's
reconnect gets after the server closes the stream of a chat whose session was revoked (A2;
`docs/auth.md`). Settings -> Model providers is the write-only credential API (A5) with a UI.
The full picture — routes, the exact Better Auth calls, and the device-approval page's
`verification_uri` shape — is in [`docs/auth.md`](./docs/auth.md).

The one thing to remember while reading the shell: **`#/device?user_code=<code>` is the URL
`oh login` opens**, and signed out it signs the reader in first, because verifying a device
code claims it for the session.

## The responsive shell

The sidebar is a fixed 256px column, and at 390px that is two thirds of the screen: the chat
was left with ~134px and wrapped one word per line. Below the `md` breakpoint the same panel
is therefore an overlay drawer over the content, opened from a small top bar that exists only
at that size (it is rendered on every screen — the shell owns it, not the screens).
`max-md:` variants do the switching, so from `md` up the layout is exactly what it was: no
JavaScript breakpoint, nothing to hydrate, and the columns behave the same on the first paint
as after it.

The drawer is `aria-expanded`-state on a `aria-label`ed button, moves focus into the panel
when it opens and back to the button when it closes. It closes on navigation (both the shell's
route effect and the sidebar's own `onNavigate`, so re-picking the chat that is already open
closes it too), on Escape, and on a backdrop click — a backdrop that is itself `md:hidden`, as
is the button.

The tests in `src/App.test.tsx` assert the switch and the behaviour, not the pixels: jsdom has
no layout. What 390px looks like is a browser question.

## Model-first chat (#91, #113)

Chatting does not need an agent (epic #92): a chat is started from a **model**, and the model
list is fed by `client.models.list()` — the chat models the reader's own keys can use, and
nothing else. There is no hardcoded suggestion list.

`useModels(client)` loads the catalog **once, in the shell** (`AppFrame`), so the composer's
model selector, Settings' default-model picker, the chat header and the sidebar rows all read
the same copy. `refresh()` calls `list({ refresh: true })` to bypass the server's cache; a 429
(`rate_limit_error`) is answered as an outcome, not an error state — the picker shows the
server's sentence inline and keeps the list it had.

`ModelPicker` (`src/components/models/model-picker.tsx`) is the app's own listbox, not a
native `<select>` (#87: native popups could not be themed); it uses the popover tokens and is
built as a combobox — the search field keeps focus, arrows move `aria-activedescendant`, Enter
picks, Escape closes and returns focus to the trigger. Each row shows the display name, the
`provider/model` id and the context window (`formatContextWindow` → "128K context"). Groups
are the providers the server sent, in its order; a provider in `fallback` status carries a
small note ("from the built-in list; the provider couldn't be reached"). The last row is
"Other model ID…": it swaps the panel for a free-text `provider/model` field, because the
router accepts models the catalog may not know yet. Refresh lives in the panel's foot, so
every surface that offers the catalog can rebuild it where the list is. It has two sizes:
`full` (Settings) and `compact` — the composer's quiet "gpt-4.1-mini ▾" control, whose panel
opens upward.

### New chat is immediate (#113, epic #116 U2)

`#/new` is an empty chat, not a picker screen: `NewChatScreen` renders the composer with the
account's **default model** from `client.preferences.get()`, and the session is created on the
first send — `sessions.create({ model })`, then `sendMessage` — after which the app moves to
the chat. With no default the shell's **catalog** decides (#146), because keys can exist
without one — a key saved before automatic picking, a pick that failed at save time, or a
provider deleted behind a chosen default (which the server clears on purpose): models mean
the normal composer with the compact picker and nothing selected (a send is refused until a
pick, "Pick a model to start" plus a Settings link; a one-model catalog is preselected), a
catalog still loading means a loading line, a failed one means its error banner, and only a
catalog with **no providers and no models** means "Add a provider key to start" with the
Settings link. A failed create keeps the text in the box; a failed send keeps the session it
already created and retries into that, not a second empty chat. The first message is what
names the session (#35), so a successful send asks `lib/session-refresh` for its one re-read
itself — the sidebar row was added by the create, before the name existed.

### The composer's model control (#113, U3)

The selector shows the session's current model: the transcript's `model` (the id the log last
said), else the model the session was created with. Picking another one **holds it until the
next message** — that message carries `{ model }` and the session's model moves with it — and
after a successful send the selector reads the log again, so what is shown is the log's answer,
not a local leftover. A switch is visible in the transcript: `TranscriptMessage.modelChangedTo`
draws a "Switched to <display name>" marker above that message. (The _first_ model a message
carries only sets the state, silently — there is nothing it changed from.)

### Default model in Settings (#113, U1/U4)

`DefaultModelCard` (Settings → Default model) is the same picker, `full` size, over
`usePreferences` — `GET`/`PUT /v1/me/preferences`. It shows whatever the server holds,
including a default the **server picked by itself** when the first provider key was saved (U4),
and saves a pick immediately (`preferences.put`), with the failure shown inline while the
stored value stays in effect.

### Deleting a chat (#113, U5)

Each sidebar row carries a kebab menu (revealed on hover or focus, always reachable by
keyboard) with **Delete chat**, and the chat header has a delete action; both confirm **in the
page** — never `window.confirm` — and deleting the open chat navigates to New chat. A chat
deleted _elsewhere_ announces itself through the stream's `session.deleted`: the open chat
raises the shell's notice (`lib/notice.ts`), the sidebar drops its row without a call of its
own (`useSessions.forget`), and the app lands on New chat.

### Agents are hidden — the code is gone, not dormant

Agents stay in the API (they are optional presets), but the UI no longer offers them: the
Agents screen, the agent form, `useAgents`, their tests and the `#/agents` route were
**deleted** rather than left unreachable — dead code that cannot be exercised rots, and git
history keeps the implementation. The one thing that had to survive is that **an existing
session created from an agent still opens and works**: `Session.agent` is nullable since #93,
nothing in the chat reads it for display, and the label rule below shows such a session by its
model like any other.

### Labels (#91)

`sessionLabel(session, nameOf)` (`lib/format.ts`): the session's **title**, else its
**model's display name** from the catalog, else the `provider/model` id. The agent's name is
never used. The sidebar passes the lookup in; the chat header uses it for its title and shows
the model's id underneath, so the model is always visible on the chat.

The chat is built from shadcn/ui primitives plus five presentational components in
`src/components/chat/` — `MessageList`, `MessageItem`, `Composer`, `StatusIndicator`,
`ErrorBanner` — driven by `useSession` and styled with Tailwind and shadcn/ui's Button,
Textarea, Input, Label, Card and Badge (copied from the registry, with the import paths
rewritten — this app has no `@/` alias, because its single `tsconfig.json` is the browser
program and a Vite alias needs an absolute path from a Node API it cannot see). Vercel AI
Elements and assistant-ui were both evaluated and not used; why is in
[`docs/chat-ui.md`](./docs/chat-ui.md).

Markdown is `react-markdown` + `remark-gfm` with the elements styled by hand; no
`rehype-raw`, so HTML in a message stays text.

## Testing

`src/**/*.test.tsx` with Vitest (jsdom) and Testing Library, driving
`createFakeClient()` — no server, no mocked client. `src/test-support/render-app.tsx` renders
the app with the fake and provides a few DOM readers; `src/test-support/better-auth-client-mock.ts`
is the other seam (see `docs/auth.md`).

**Better Auth is mocked at the module boundary for every test file** (`vitest.setup.ts` maps
`better-auth/client` and its plugin entry to the double in `src/test-support/`), because a
social sign-in leaves the page and cannot be run in a test. The app code is untouched: the
tests drive the same calls it makes, and assert their arguments. The double also records what
`createAuthClient()` was constructed with (`authClientCalls`), so `App.test.tsx` pins that
sign-in is built against the same `settings.serverUrl` as the API client — and against this
origin, with no `baseURL` at all, when none is set. `GET /v1/auth-config` — the one request
outside `@openharness/client` — is stubbed at `fetch` where a test needs it.

| file                                          | covers                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.test.tsx`                            | open a session, send → streamed reply, Stop → interrupted, reload → history, steering, retry → success, terminal error, the composer model switch + its marker, a title arriving without a reload, request error, a 401 sending the reader to sign in, the missing-provider-credential message, model-first labels, deleting chats (header, sidebar, failure, deleted elsewhere)                                                   |
| `src/screens/new-chat-screen.test.tsx`        | New chat is immediate (#113): the default shown and created with the first message, a pick before the first send, the no-default states the catalog decides (#146 — the picker with the send refused until a pick, then created with the picked model; a sole model preselected; no-key, loading and failed-catalog states), a failed create (keeping the text) and a failed send (reusing the session), a failed preferences load |
| `src/screens/settings-screen.test.tsx`        | settings round-trip, an empty URL as same-origin, the confirmation surviving a client rebuild (#81), credentials add/replace/delete, a failed keys load, no key in the DOM, the rejected-key and fresh-session errors, and the default model (server-chosen, saved, failed load/save)                                                                                                                                              |
| `src/screens/sign-in-screen.test.tsx`         | the 401 landing, provider buttons per auth-config, the dev form gating and sign-in, returning to the route, sign-out, a later 401                                                                                                                                                                                                                                                                                                  |
| `src/screens/device-screen.test.tsx`          | approve, deny, an invalid code, an expired code, a rate-limited one and the server's other error bodies (#80), an already-decided code, signing in first, the code through a social sign-in                                                                                                                                                                                                                                        |
| `src/components/chat/composer.test.tsx`       | the keyboard rules (#105, P1): Enter sends, Shift+Enter newlines, empty/whitespace sends nothing, Send disabled while empty, a failed send keeps the text                                                                                                                                                                                                                                                                          |
| `src/components/models/model-picker.test.tsx` | the picker itself: grouping, search, the keyboard rule, free text, the fallback note, refresh (429 and failure), the compact trigger                                                                                                                                                                                                                                                                                               |
| `src/hooks/use-session.test.tsx`              | the hook's own contract: a failed load, and no duplicated message                                                                                                                                                                                                                                                                                                                                                                  |
| `src/hooks/use-stick-to-bottom.test.tsx`      | the auto-scroll rule, with a scroll geometry jsdom does not have                                                                                                                                                                                                                                                                                                                                                                   |
| `src/components/sidebar.test.tsx`             | the session list: first page then the rest, the cap note, and the row's delete action (in-page confirm, cancel, Escape, failure)                                                                                                                                                                                                                                                                                                   |
| `src/lib/*.test.ts`                           | routes, the settings store, the fake-mode scenario, the paging walk, the session re-read, the label rules, the context-window formatting, the auth store's rules, and the auth-config schema's unknown-provider filter                                                                                                                                                                                                             |

Timing: streaming tests do not race the clock. `src/test-support/stream.ts` gates the fake's
stream so the test releases **one event at a time** and asserts between events — the fake
still produces the whole turn at `delayMs: 0`, and nothing can arrive while an assertion runs.
The one test that needs a turn genuinely in flight (Stop) gives the scripted reply a slow,
explicit `delayMs` and interrupts well inside it.

Interactions have to wait for the screen to be ready for them (#123): a click on a control the
screen is still disabling is a silent no-op (`user.click` dispatches nothing on a disabled
button), and a `getBy*` right after a `waitFor` on the hash can beat the render the hash
caused — wait for the button to be enabled before clicking it, and for the UI a navigation
produces with `findBy*`.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/client` (and its `./testing` subpath in dev and in tests)

`@openharness/config` is additionally allowed as a **devDependency**.

The app also depends on `better-auth` (its browser client — the only way to sign in; epic #65,
A1) and on `zod`, which the local schema for `GET /v1/auth-config` uses. Neither is an
`@openharness/*` package, so `yarn check:deps` has nothing to say about them.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/web/docs/`.
