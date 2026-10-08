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
| `yarn icons`        | regenerates `public/favicon.ico` and `apple-touch-icon.png` (#240)      |
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

# the other account: no provider key, so `#/` is the first-run flow (#209)
VITE_OPENHARNESS_FAKE=1 VITE_OPENHARNESS_FAKE_STATE=empty yarn dev

# against a real server (defaults to http://localhost:3000 for /v1)
yarn dev
OPENHARNESS_PROXY_TARGET=http://localhost:8787 yarn dev
```

`VITE_OPENHARNESS_FAKE_STATE=empty` runs the fake with no credentials, and therefore no models,
no providers and no default — the state the first-run screen exists for. Without it fake mode is
the seeded account, which is the state to develop in; the empty one is the state to look at.

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
  index.css                    Tailwind + the design tokens: the shadcn color tokens and the
                               U10 scales (type, spacing, radii, elevation) mapped for
                               utilities, one block of variables per theme (Light, Dim, Dark)
                               under `[data-theme]`, `@custom-variant dark` re-pointed at that
                               attribute, `color-scheme` per theme so the native controls —
                               select popups, datalists, scrollbars — stay in the same scheme,
                               and one `prefers-reduced-motion` rule that turns every
                               animation off for a reader who asked for less
  components/
    client-provider.tsx        the client in context, so screens can use it
    auth-provider.tsx          the Better Auth browser client in context
    provider-icon.tsx          the sign-in marks (Google / GitHub / Microsoft) and the
                               model providers' marks, inline; a monogram where a brand's
                               mark could not be confirmed
    logo-mark.tsx              the openharness mark, inline (#240): the ring in the link
                               token, the dot in coral; the same drawing is
                               `public/favicon.svg`
    sidebar.tsx                the chat list, grouped by date (Today / Yesterday / Previous
                               7 days / Older), New chat, the row's menu (Delete chat,
                               in-page confirm, Radix DropdownMenu), and the account menu at
                               the foot (Settings, the theme submenu, Sign out); the column
                               from `md` up — collapsible there — and the overlay drawer
                               below it
    settings/
      providers.tsx            Settings -> Providers: the list, Replace, Delete, Add provider
      default-model.tsx        Settings -> Default model: the picker, saved to preferences
      appearance.tsx           Settings -> Appearance: the four-way theme picker (#203)
      usage.tsx                Settings -> Usage: this month by model and by day (#247)
    providers/
      provider-tiles.tsx       the provider grid: one tile per PROVIDER, free-tier hint (X5/X8)
      provider-key-form.tsx    THE key form, built from the credential type (X6); the same
                               component in the first-run screen, the dialog and Settings
      add-provider-dialog.tsx  the Add-provider dialog (Radix), opened by the picker and the
                               missing-key banner (X5)
    theme-menu.tsx             the theme quick switch as menu items: the four choices, as a
                               radio group, inside the account menu's submenu (#203, #211)
    theme-preference.tsx       the theme's one server read and write, rendered nowhere
    chat/
      chat-view.tsx            the chat screen: header (+ delete), messages, errors,
                               composer with the model selector, the model-change marker,
                               and Edit and resend, which rewinds the session (#238)
      message-list.tsx         the scrolling conversation + stick-to-bottom
      message-item.tsx         one message (user right / agent left, markdown), the
                               "Switched to …" marker when it changed the model,
                               PART_RENDERERS: a renderer per message part (#201), the
                               bubble that takes the whole column when it holds a block
                               (#231), and the dimmed `data-replacing` state of a message
                               an edit pending in the composer would replace (#238)
      markdown.tsx             react-markdown + remark-gfm, styled element by element, and
                               streaming-safe by rendering (a half-written fence is a code
                               block; #204)
      code-block.tsx           a fenced block: the language, the Copy button, the highlighted
                               lines — lazily, per theme — and the full column of the message
                               it is in (#204, #231)
      composer.tsx             the input: Enter sends, it grows to a cap and then scrolls,
                               Stop (worded) and Send sit in its foot, the model control
                               is part of the same surface (#211), and the edit indicator
                               with its Cancel sits above it (#238)
      status-indicator.tsx     running / idle / retrying — the header's dot
      working-row.tsx          the row at the foot of the transcript: Working… with a clock,
                               Retrying… with the reason, or Interrupted (#211); workingState()
                               is the rule, the component is the clock
      error-banner.tsx         inline errors (from the log, or from a failed request)
    models/
      model-picker.tsx         THE model control: grouped, searchable, free text, refresh,
                               and "+ Add provider"; `full` in Settings, `compact` in the
                               composer (#91, #113)
    ui/                        shadcn/ui primitives, copied from the registry (dialog and
                               collapsible among them, for #209; dropdown-menu, tooltip and
                               skeleton added in #211)
  screens/
    start-screen.tsx           what `#/` and `#/new` show: New chat, or the first-run flow
                               when the account has no provider key (#209)
    first-run-screen.tsx       "Let's get you chatting ✨": tiles -> key form -> the default
                               the server picked -> "Let's go" (X5, #227)
    new-chat-screen.tsx        an empty composer on the default model, under a greeting, the
                               model and four suggested prompts that fill the box (#113,
                               #211); the session is created with the first message; with no
                               default the catalog decides (#146): the picker with a pick
                               required, a preselected sole model, a loading skeleton, the
                               catalog's error, or the "add a provider key" state when there
                               are no providers and no models
    settings-screen.tsx        Providers, Default model, Appearance, and Advanced — the
                               server URL, collapsed (#209)
    sign-in-screen.tsx         one button per provider, the dev form when offered
    device-screen.tsx          the device-approval page `oh login` opens
  hooks/
    use-session.ts             THE session hook: history, live stream, send (with a model, or a rewind), interrupt
    use-sessions.ts            the sidebar's list, plus create and remove (and forget)
    use-session-refresh.ts     the re-read after a first message, shared by both of those
    use-models.ts              the catalog (GET /v1/models), once for the whole shell; reload()
                               after a credential change, refresh() to bypass the cache
    use-preferences.ts         GET/PUT /v1/me/preferences: the default model
    use-usage.ts               GET /v1/me/usage: this month, in the reader's own zone (#247)
    use-theme.ts               the theme store's React binding (#203)
    use-auth.ts                the auth store's React binding
    use-auth-config.ts         GET /v1/auth-config for the sign-in page
    use-provider-credentials.ts  the credentials list, plus put (a whole request body), the
                               api_key shorthand, remove and reload
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
    theme.ts                   the theme: the choice, the `data-theme` it resolves to, the
                               `localStorage` cache the first paint reads (#203)
    notice.ts                  the shell's notice, a one-line store
    session-refresh.ts         the one re-read of a session whose first message named it
    highlight.ts               the code highlighter: lazy Shiki, three themes, Shiki's
                               whole bundled grammar set fetched one grammar at a time,
                               and the tokens the code block draws (#204, #227)
    dev-fake-client.ts         dev-only fake client + the seeded scenario, which carries
                               the markdown the QA screenshots are taken of (#204); the
                               `empty` state is the first-run account (#209)
    paging.ts                  walking `next_page` for the two lists, with a safety cap
    session-groups.ts          the chat list's date buckets (Today / Yesterday / Previous 7
                               days / Older), measured in local calendar days (#211)
    suggestions.ts             the four openers New chat offers; they fill the composer
                               and send nothing (#211)
    models.ts                  helpers over the catalog: grouping, name lookup, price lookup,
                               providerOf (#247)
    usage.ts                   the reader's local days: the zone, the month so far, a day's label
    errors.ts, format.ts, utils.ts    and `formatElapsed` for the working row's clock
  test-support/render-app.tsx  render the app against a fake client; DOM readers
  test-support/stream.ts       gate the fake's stream, one event at a time
  test-support/catalog.ts      the two-provider catalog fixtures the picker tests share
```

Two folders outside `src/` matter here. `public/` is served at the site root by Vite and holds
the icons (see "The mark") — files there are copied, not imported, so nothing can be
tree-shaken or hashed and the paths in `index.html` are literal. `scripts/` holds
`build-icons.mjs`, the one-off rasterizer behind `yarn icons`: a `.mjs` run by hand, never by
the build, which is why its rasterizer is a devDependency rather than a dependency.

### Routes

| route                       | screen                                              |
| --------------------------- | --------------------------------------------------- |
| `#/`                        | New chat — or the first-run flow with no key (#209) |
| `#/s/<sessionId>`           | the chat                                            |
| `#/new`                     | new chat: an empty composer on the default model    |
| `#/settings`                | Providers, Default model, Appearance, Advanced      |
| `#/signin`                  | sign in (`?next=<hash>` to return there)            |
| `#/device?user_code=<code>` | the device-approval page `oh login` opens           |

There is no `#/agents` route since #91: chatting is model-first, agents are hidden from the
UI, and an old bookmark to that screen lands on the root route. There is no **Home** screen
since #209 either: the root of a signed-in app is New chat, or the first-run flow for an
account with no provider key, so an old `#/` link — the sidebar's own logo among them — lands
where a reader meant to go.

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
next model request picks it up. `send(text, { rewindTo })` is "edit and resend" (#238): the
rewind rides the same request as the message, the server restarts the session from the message
the reader edited, and the transcript drops what the edit replaced. `interrupt()` is the Stop
button (`user.interrupt`); the partial reply stays on screen, which is the transcript's rule,
not the UI's.

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

**From `md` up the column can be put away** (`#211`). It is a different thing from the drawer,
and the two do not interact: the drawer is how a phone _reaches_ the list, the collapse is how
a wide screen gives the chat the whole width. The control is the sidebar's own header
("Hide sidebar"); once the column is gone the shell puts a "Show sidebar" bar at the top of the
content column, `hidden md:flex`, so it exists exactly where the collapse does. The state is
the shell's (`AppFrame`), not a stored preference — it is a thing about this window more than
about the reader, and the drawer has always been state too — so it is not remembered across a
reload. The collapse rule is `md:hidden` and nothing else, which is why a phone that had the
column put away on a desktop still gets its drawer.

The tests in `src/App.test.tsx` assert the switch and the behaviour, not the pixels: jsdom has
no layout. What 390px looks like is a browser question.

## The visual pass, and the working state (#211, epic #201 U10)

The app worked and looked thin. U10 is the pass that put a system under it and moved the
session's busy state next to the thing it is about. The reasoning is in
[`docs/chat-ui.md`](./docs/chat-ui.md); what a reader of this file needs is the shape.

**Tokens first.** `src/index.css` now carries a type scale (`text-2xs`, the one step Tailwind
does not ship, plus the rest named in a comment), four named spacing steps (`gap-inline`,
`gap-control`, `gap-block`, `gap-section` — aliases of Tailwind's numeric ones, so a component
says what a distance is _for_), a `rounded-2xl`, and three elevations (`shadow-raised`,
`shadow-popover`, `shadow-panel`). The elevations are the only ones that are **per theme**:
`--elevation-*` is defined in each of the four blocks, because a black shadow on a near-black
page is invisible. The scales were applied where the one-offs were — the chat components and
the sidebar — and `text-[0.65rem]` is gone.

**The sidebar is a list again.** Chats are grouped by date (`lib/session-groups.ts`: Today,
Yesterday, Previous 7 days, Older — local calendar days, one clock per render, empty buckets
omitted, an unreadable timestamp is "Older" rather than a dropped row). The open chat is marked
by `aria-current="page"` _and_ a bar at the row's leading edge, because the tint alone is
neither. The row's menu is a real Radix `DropdownMenu` — arrow keys, roving focus, type-ahead,
Escape, and portalled so the scrolling list cannot clip it. The foot is one **account menu**:
Settings, the Theme submenu (`theme-menu.tsx` is now the items, a radio group) and Sign out,
behind a trigger labelled "Account menu" — a stable name, because the email inside it changes
with the account.

**Loading is drawn.** `components/ui/skeleton.tsx` is the one placeholder: the sidebar's rows,
the transcript's history (three bubbles, alternating alignments) and the two reads New chat
waits on. A skeleton may carry a `label`, which becomes `role="status"` plus screen-reader
text, and that is what the tests read instead of the prose the screens used to print. Errors
did not need a new component — `ErrorBanner` already was one.

**New chat has an empty state.** The greeting (exported as `NEW_CHAT_GREETING` — "Hey! What are
we building today?" since #227; it replaced the literal "New chat" heading, so `App.test.tsx`
and three QA specs read it from one constant or one line of `e2e/qa/support.ts`), the model the
chat would run on, and four suggested prompts
from `lib/suggestions.ts`. A prompt **fills the composer** and stops: nothing is created,
nothing is sent, and the text is editable. That is why the composer's draft is a prop
(`value`/`onValueChange`) — a screen that wants to put words in the box owns the box's text,
rather than reaching into the DOM behind React's back.

**The busy state is in the transcript.** `components/chat/working-row.tsx`, at the foot of the
message list: "Working… 12s" while a turn is running and nothing has arrived, "Retrying… (the
server's reason)" when the error says so, "Interrupted" after Stop. The header's
`StatusIndicator` is unchanged and still there — the row is the same fact where the answer is
going to appear. Two rules are worth remembering:

- **"Nothing has arrived" is asked of the transcript, not of the clock**: an agent message is
  the newest one and it is still empty. A reply that is visibly being written gets no row.
- **"Interrupted" is the screen's own memory.** Nothing in the event log distinguishes "the
  reader stopped this" from "the turn ended", so `ChatView` remembers the one action that could
  only have come from here and drops it on the next send. It belongs to the turn it stopped.

`workingState()` is a pure function over (status, retrying, reason, interrupted, has-reply) and
is tested as one; the component's own test is the clock, under fake timers.

**The composer is one surface.** Border, focus ring (`focus-within:`) and elevation belong to
the whole thing, so the model control reads as part of it and the ring appears when focus is
anywhere inside. It grows with its text up to 200px and then scrolls — measured and set by
hand, because `field-sizing-content` is Chromium-only — and Stop carries the word, so "which
one am I about to press" does not depend on hovering.

**Accessibility, in one place.** Every new control has a `aria-label` or a visible one (there
are `Tooltip`s on the two icon-only buttons in the sidebar, as _descriptions_ — never as
names). Landmarks are `<aside aria-label="Navigation">`, `<nav aria-label="Chats">`,
`role="log"` for the transcript and `<main>` for the content column. Focus is visible
everywhere (the shadcn primitives' rings, plus the composer's own), and
`prefers-reduced-motion: reduce` turns off every animation — the pulsing dot, the spinner, the
caret — with one global rule, since an `animate-pulse` three levels down cannot be reached by a
variant. Colours are the #203 palettes unchanged; the new surfaces were built out of token
pairs that were already measured.

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

### Onboarding: one flow, from sign-in to a first chat (#209, epic #201 X5/X6/X8; #227)

An account with **no provider key** lands on the first-run screen instead of New chat, at both
`#/` and `#/new`:

    tiles -> the key form -> "You're all set! 🎉 Your chats will use X" -> "Let's go"

`StartScreen` (`src/screens/start-screen.tsx`) is the gate: it reads the credentials list once
and decides once. Deciding once matters — saving a key makes the list non-empty, and a live
condition would swap the screen out from under the confirmation the reader is reading — so the
reader leaves when they say so, by "Let's go" or Skip, and the next mount decides again.

The screen is **centred in the main area** (`m-auto` on a flex scroller, not `items-center`:
centred when it fits and scrolled from the top when it does not), and its heading is one of the
two the violet→coral gradient is on — see "The palette" below. `FIRST_RUN_HEADING` is exported
the way `NEW_CHAT_GREETING` is, and the ✨ sits outside the gradient span.

- **Tiles** come from `@openharness/client`'s `PROVIDERS`, one per provider, each with its mark
  and its free-tier hint (X8) drawn as a coral chip (`components/providers/free-tier-chip.tsx`,
  the one place that hint is styled — the tiles and the key form both render it). The list is
  complete by construction: it is the same set as the server's `VALIDATABLE_PROVIDERS`, held
  together by `e2e/src/provider-metadata.test.ts`.
- **The form** is `components/providers/provider-key-form.tsx`, and it is the only place a key is
  typed in this app — the first-run screen, the Add-provider dialog and Settings all render it,
  so "paste and validate" means the same thing everywhere. **Its fields come from the credential
  type** (X6): `CREDENTIAL_FORMS` is a `Record<ProviderCredentialType, …>` holding the fields and
  the request body they build, and `api_key` is the only member today. A new member of the
  protocol's credential union is a compile error there until it has a form — which is where
  Bedrock, Vertex and Azure land in phase 4.
- **Errors are inline**, in the three classes the credentials API has: a refused key
  (`invalid_provider_credential`, titled "Hmm, <provider> didn't accept that key" since #227
  while the server's own 422 message stays the body — warm, never vague), a stale session (401,
  with a link to sign in again and back to where the reader is), and everything else as one line.
- **Skip** leaves for New chat, whose own empty state still says what is missing — the flow
  prompts, it does not block.

The two writes a save causes are both re-reads, because the server owns them: saving the first
key makes the server pick a default model (U4), so `usePreferences` is asked again for the model
to name, and the catalog is read again (`useModels.reload`, not `refresh`) so the models the new
provider lists are in the picker before the first message. `reload` is the plain read on purpose:
saving a key already invalidates that provider's cache entry server-side (C4), while `refresh`
is the deliberate cache bypass the reader asks for and is rate-limited to once a minute.

### Add provider: a dialog, not a detour (#209, X5)

The same form, in `components/providers/add-provider-dialog.tsx`, reachable **without leaving
the chat**:

- from the model picker's foot ("+ Add provider"), on the tiles;
- from a `missing_provider_credential` banner, **preselected to the provider the failed model
  names** (`providerOf(sessionModel)`) — it used to be a link to Settings → Model providers and
  a walk back.

It is Radix Dialog (`components/ui/dialog.tsx`) for the focus trap, Escape and the modal
semantics. Two things about how it is written are load-bearing:

- **The root stays mounted; only `open` moves.** Radix restores focus when its `FocusScope`
  unmounts, and a caller that unmounted the whole dialog would take that with it, leaving the
  reader on `document.body`. `AddProviderDialog` also has no `DialogTrigger` to hand focus back
  to — the three things that open it live in three different components — so it remembers the
  last focused element while it is closed and focuses it again on close.
- **The body is its own component**, because Radix keeps dialog content out of the tree while it
  is closed: the credentials read happens on open, not once per mounted chat.

After a save the dialog closes, the shell says so (`showNotice`), and the caller re-reads the
catalog — so the provider just connected is in the picker immediately, with no reload and no
Settings trip.

### Settings, in the order a reader needs it (#209, X5)

**Providers**, **Default model**, **Appearance**, then **Advanced** — the server URL, collapsed.
The screen used to open on a Connection card only a self-hoster has a use for, with the thing
everyone needs below the fold. The Providers card is the **list**: it shows each key by display
name and last four (`providerName`), and rows carry Replace (which opens the dialog on that
provider) and Delete (in-page confirm). Adding is the dialog, so there is one form in one place.

The free-text provider id the card used to offer is gone with `lib/providers.ts`: now that the
metadata list is the complete set the server can validate, a typed id could only name a provider
whose key the server refuses on save — a dead end dressed as an escape hatch.

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

### Usage and cost (#247)

Three surfaces, and each is priced where it is read — the log holds tokens and never money:

- **a reply's metadata row** (`components/chat/message-meta.tsx`) ends with what that reply cost,
  next to the tokens #212 already showed. It is `replyCost(meta, costOf)` over the reply's own
  counters and its model's rates, and it draws `—` for a model nobody prices. `costOf` is the
  shell's `modelPriceLookup(catalog.models)` (`lib/models.ts`), pushed down the same path
  `nameOf` travels; a caller with no catalog leaves the cost off the line rather than drawing an
  unknown one.
- **the chat header** shows what the session has spent, beside the model id (`chat-view.tsx`):
  `selectSessionUsage(transcript)` — the log's running totals, or the ones derived from its
  replies — priced with the same lookup. It is absent until a request has run: a chat with no
  answer has no cost to report.
- **Settings → Usage** (`components/settings/usage.tsx` over `hooks/use-usage.ts`) is the month
  so far: the total, a table of models, and a bar per day. It reads `GET /v1/me/usage` with the
  zone the browser reports (`lib/usage.ts`: `localTimeZone`, `currentMonthRange`, `formatDay`),
  because the server groups by **the reader's** days. Nothing polls and nothing is cached: it is
  a screen a reader opens.

`formatCost` (`lib/format.ts`) is the one place a number becomes money on screen — `—` for
unknown, four decimals while the number is a fraction of a cent, and cents at dollar scale.

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

### Edit and resend rewinds the session (#238)

**Edit and resend** puts a message's words back in the composer, and sending them **rewinds the
session to that message**: the original and everything after it drop out of the transcript and
out of the model's context, and the edited text is what the conversation continues from. The
log stays append-only — the server writes a `session.rewind` whose range covers what it
replaced, and replay, the transcript and the brain's context all skip it — so nothing a reader
saw is deleted; it is taken back.

Four things about the UI are worth knowing:

- **It is offered on every message the reader wrote**, not only the last: the branch _behind_
  the message is what gets replaced, which is what "I would have said it differently" means.
- **The target is remembered by the screen, not by the composer.** `chat-view.tsx` holds
  `{ seq }` — the message's own `position`, which is what `client.sendMessage`'s `rewindTo`
  takes — and drops it **when the box is emptied** (clearing the composer is how an edit is
  cancelled, and a cancelled edit must not rewind) and after any send succeeds. **Cancel and
  Escape are spelled as clearing it**, through the same `changeDraft('')`, so there is still
  exactly one rule about what ends an edit.
- **The mode is visible.** `Composer` draws an `composer-edit` row above the box — "Editing
  message · sending replaces what follows it", and a Cancel — and `MessageList` carries the
  edited message's `position` down so every message **after** it renders `data-replacing`
  dimmed: what a send would take back is on screen, not only in the composer. The composer
  stays a prop-driven box: the screen hands it `{ blocked, onCancel }` (`ComposerEdit`), the
  way it hands it a model selector (#238).
- **It is disabled, and its send withheld, whenever the session is not idle** — not merely
  while `running`. That is the state the server takes a rewind in (409 `conflict_error`
  otherwise), and the web has it as `status === 'idle'`; the check is `!idle` in one place, so
  the action and the send cannot disagree. If a turn starts while an edit is pending (another
  tab, a recovered turn), the reader keeps the draft, the composer says "wait for the reply to
  finish", and Enter and the button both send nothing rather than firing a rewind that comes
  back a 409. `sendFromComposer` refuses it as well, because the composer is not the only
  thing that could ask.

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

**A message is drawn part by part** (epic #201, X1). `MessageItem` owns the bubble, the
model-change marker, the queued badge and the streaming caret; the message's own content goes
through `PART_RENDERERS`, a `Record<MessagePart['type'], …>` that holds the text renderer
today (the user's plain text, the agent's markdown) and is where the next phases' parts — a
tool call, a question, an approval — get theirs. The record is what makes a new part type a
compile error here instead of a message that renders as nothing, and `message.text` (the parts
joined) is what the rest of the app still reads.

Markdown is `react-markdown` + `remark-gfm` with the elements styled by hand; no
`rehype-raw`, so HTML in a message stays text.

### Markdown while it streams, and code blocks (#204, epic #201)

The reply is rendered from the text that has arrived, and the text that has arrived is
rendered by the same rules as the finished one. **There is no pre-processing, no
"incomplete-markdown" parser and no second markdown engine**: a fence that has not closed yet
is a code block, because CommonMark closes an unterminated fence at the end of its input, and
a half-written `**bold` is the characters that arrived. Nothing is hidden and nothing is
mangled, and the next delta completes it. `src/lib/dev-fake-client.ts` seeds a reply that is
all of it at once, for fake mode and for the QA pass.

Fenced blocks are `components/chat/code-block.tsx`: the language in a header, a **Copy**
button that says "Copied" for a second and a half, and the code highlighted by Shiki. The
grammar is fetched **on demand** by `src/lib/highlight.ts`, which is itself a dynamic import —
so Shiki, its engine and its grammars are not in the app's main bundle, and the block renders
as plain text (still labelled, still copyable) until they arrive. A language the chat does not
ship is plain text forever, which is not an error state.

Highlighting is **theme-aware without re-highlighting**: `defaultColor: false` makes Shiki
write all three palettes as CSS variables on the block, and three `[data-theme]` rules in
`index.css` pick the one the page is in — Light to `github-light`, Dim to `github-dark-dimmed`
and Dark to `github-dark`. See `docs/chat-ui.md` for the numbers and the decisions.

A block **fills the message column** (#231). A bubble is as wide as its words, so a short block
used to draw a stub as wide as its longest line; `has-[pre]:w-full` on the bubble — a code
block is the only thing `markdown.tsx` produces a `pre` for — gives the whole 85% column to a
message that holds one and leaves every other message exactly as small as it was. A percentage
width asked for from inside a shrink-to-fit box would resolve back to the content, which is why
it is the bubble that carries it. `message-item.test.tsx` pins the class; what it looks like at
400px is a browser question.

### Themes (#203, epic #201 X3)

Four choices — **System** (the default), **Light**, **Dim**, **Dark** — set as `data-theme` on
`<html>`, with one block of CSS variables per theme in `src/index.css` and `@custom-variant
dark` re-pointed at that attribute so `dark:` means "dark chrome" in both Dim and Dark. Light
and Dark are the palettes the app already shipped; Dim is the soft one, and its comment in the
stylesheet carries the measured contrast ratios.

Three pieces, and each has one job:

- `src/lib/theme.ts` — the store: the choice, the `data-theme` it resolves to, and the
  `localStorage` cache (`openharness:theme`). `system` is resolved here against
  `matchMedia('(prefers-color-scheme: dark)')` and re-resolved when the operating system
  changes, so the attribute always names a theme that exists and no CSS media query duplicates
  the rule. Frozen and tiny; `use-theme.ts` is its React binding.
- `index.html` — the inline script that reads the same cache and sets the attribute **before
  the first paint**, so a dark-theme reader never sees a white flash. It is the only place that
  duplicates the resolution rule; keep the two in step.
- `src/components/theme-preference.tsx` — the one caller that knows about the client: it reads
  `GET /v1/me/preferences` once and writes every choice back with `PUT`. It renders nothing and
  lives in the shell, so `Settings → Appearance` (`components/settings/appearance.tsx`) and the
  sidebar's quick switch (`components/theme-menu.tsx`) are both just `chooseTheme(...)`: applied
  in the click, saved in one place. The account's stored value wins once it arrives — unless
  the reader has clicked since that request left, which the component knows and the store
  cannot.

The theme is not the TUI's (there, the terminal's own colours are the theme, epic #201 X4), and
it is why `Settings` grew a card rather than the whole app growing a context: a theme is one
attribute and one preference, and a provider for it would be a provider for a string.

### The palette: violet + coral, and the languages (#227)

The maintainer's feedback after the first hands-on test was that the app worked and had no
personality. U12 is the pass that gave it one, in three parts, and the whole of it is **tokens
in the three `src/index.css` blocks** — there is not one one-off colour in a component.

- **Violet is the primary** (`#7C3AED` as a fill in all three themes, so the Send button, the
  active sidebar row, a selected theme, a picked provider and every focus ring are the same
  violet). Two tokens exist because a fill and _type_ are not the same problem: `--primary` is
  the fill with white on it (5.7:1 everywhere), and `--link`/`--ring` are the same hue lifted to
  `#A78BFA` on Dim and Dark, where the fill violet is only 2.9:1 as text. Light needs no
  separation (5.3:1 either way), which is why `--link` equals `--primary` there.
- **Coral is the highlight** (`--coral`, the mark: the streaming caret, the "Working…" spinner,
  the status dot, a chip's tint) with `--coral-ink` as its text-safe twin — `#FB7185` on the
  dark themes, `#BE123C` in Light. `Badge` grew a `coral` variant for it, and
  `components/providers/free-tier-chip.tsx` is the free-tier hint.
- **No gray survives.** The page is a faint violet in Light (`#F7F5FF`), Dim is violet-leaning
  (`#1E1B2E`) and Dark is the same palette taken deep (`#12101B`); borders, muted surfaces and
  muted text carry the tint, and the user's own bubble is `--secondary` — a violet tint in
  Light, a deep violet on the dark themes.
- **The gradient is on the two hero headings only**, through one rule (`[data-slot='hero-title']`
  in `index.css`) rather than a utility on each, because each end has to be a _per-theme_ token
  to stay legible as type. An emoji on one of those headings is drawn outside the clipped span:
  `background-clip: text` would paint over a colour-emoji glyph's own colours.

Every pair is at WCAG AA and the measured ratios are in the stylesheet's own comments (the
tightest: muted text on the page at 6.5:1 in Light, coral ink on its chip at 5.1:1). The three
Shiki themes were **not** changed: a code block is its own surface, its palettes are measured
against their own backgrounds, and nothing in this palette is read inside one.

**Highlighting covers the languages people actually paste.** `src/lib/highlight.ts` now resolves
a fence against Shiki's whole bundled set (`bundledLanguages` from `shiki/langs` — 242 grammars
and their aliases: `rs`, `c++`, `cs`, `kt`, `rb`, `py`, `sh`, `zsh`, `yml`, `tf`, `dockerfile`,
…) plus two the app adds, `golang` and `patch`. The property that mattered is unchanged: that
table is a map of `() => import('…')` thunks, so reading it is free and only the grammar a block
actually names is fetched — the main bundle does not move, and `highlight.test.ts` asserts the
resolution and the tokenizing for thirty of them.

### The mark (#240)

The openharness mark is a ring left open at the upper right, with a coral dot in the opening:
the agent loop, open to the outside. It is the favicon, and it sits beside the sidebar's
wordmark. (The TUI's own branding, and the README's logo, are not this change.)

- **One 32×32 drawing, written down twice.** A page cannot put a React component in a
  `<link rel="icon">`, so `components/logo-mark.tsx` draws it inline — `LOGO_MARK_RING` and
  `LOGO_MARK_DOT` are the exported numbers, and `LogoMark` is sized by `className` (the sidebar
  uses `size-5`) — and `public/favicon.svg` is the file. `src/icons.test.ts` parses the SVG and
  compares it against those constants, so the two cannot drift.
- **No colour is a literal in the component.** The ring is `currentColor`, and the component's
  default ink is `text-link`: the primary violet in Light, the lighter violet in Dim and Dark,
  and a caller that names its own text colour wins. The dot is `fill-coral`. That is what makes
  the mark follow `data-theme`, which a favicon cannot read — the SVG therefore spells the
  values out and swaps the ring for the dark violet inside
  `@media (prefers-color-scheme: dark)`.
- **The files.** `public/favicon.svg` is the mark with that dark rule, `public/favicon.ico` is
  16 + 32 px of the light variant for a browser without SVG favicons, and
  `public/apple-touch-icon.png` is 180 px and opaque — the mark at 70% of the square on the
  Light page colour, because iOS composites an alpha channel onto white. `index.html` links all
  three. There is no web manifest, so there are no 192/512 icons to add with it.
- **Regenerating them** is `yarn icons` from this folder: `scripts/build-icons.mjs` reads
  `favicon.svg`, strips the dark-scheme `<style>` to leave the light variant, and rasterizes
  with `sharp` — a devDependency, pinned exactly, used nowhere else. The generated files are
  committed, so neither the build nor CI ever runs the script.
- **In the sidebar** the mark is 20px, inside the same link as the wordmark and 8px to its
  left. It is decorative (`aria-hidden`), so the link's accessible name is still
  "openharness". The collapsed column is `md:hidden` — the whole panel is put away and there is
  no icon rail — so there is no mark-only variant to show; the drawer below `md` renders the
  same header at its full width.

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

| file                                                    | covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.test.tsx`                                      | open a session, send → streamed reply, Stop → interrupted (and the "Interrupted" row after it, gone on the next send), the "Working…" row while a turn is running with no text on screen, reload → history, steering, retry → success, terminal error, the composer model switch + its marker, a title arriving without a reload, request error, a 401 sending the reader to sign in, the missing-provider-credential message, model-first labels, deleting chats (header, sidebar, failure, deleted elsewhere), and edit and resend (#238 — the action on every message the reader wrote and no reply, an edit sent as a rewind with the transcript dropping what it replaced, clearing the box cancelling the edit instead of rewinding, the action disabled while the agent works, the indicator showing what a send would replace with Cancel taking the edit back, Escape leaving the mode, the messages after the edited one marked as about to be replaced, and a turn starting mid-edit withholding the send and keeping the draft) |
| `src/screens/new-chat-screen.test.tsx`                  | New chat is immediate (#113), for an account with a key: the default shown and created with the first message, a pick before the first send, the no-default states the catalog decides (#146 — the picker with the send refused until a pick, then created with the picked model; a sole model preselected; no-key, loading and failed-catalog states), a failed create (keeping the text) and a failed send (reusing the session), a failed preferences load; and, for #211, the empty state — the greeting, the model it names, and the suggested prompts filling the box without creating or sending anything                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/screens/settings-screen.test.tsx`                  | the four sections in order and Advanced collapsed by default (and opening on demand), the server-URL round trip, an empty URL as same-origin, the confirmation surviving a client rebuild (#81), and the default model (server-chosen, saved, failed load/save)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/screens/first-run-screen.test.tsx`                 | the first-run flow (#209): shown with no credentials and not with one, the tiles and their free-tier hints, a save that names the server's pick and lands on New chat with the cursor in the box, changing that pick, a rejected key, the stale-session prompt and where it returns to, Skip, and back-from-the-form                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/components/providers/add-provider-dialog.test.tsx` | the dialog (#209): opened from the picker without leaving the chat, a save that closes it and re-reads the catalog, the preselected provider from a row's Replace, and Escape returning focus to what opened it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/components/settings/providers.test.tsx`            | the Providers card: metadata-only rows with display names, Add provider opening the dialog, Replace through it with the list following, the in-page delete (confirm, cancel, failure), the stale-session prompt and the failed-list banner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/screens/sign-in-screen.test.tsx`                   | the 401 landing, provider buttons per auth-config, the card's own padding above the first button and below the last one (#187), the dev form gating and sign-in, returning to the route, sign-out, a later 401                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/screens/device-screen.test.tsx`                    | approve, deny, an invalid code, an expired code, a rate-limited one and the server's other error bodies (#80), an already-decided code, signing in first, the code through a social sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/components/chat/composer.test.tsx`                 | the keyboard rules (#105, P1): Enter sends, Shift+Enter newlines, empty/whitespace sends nothing, Send disabled while empty, a failed send keeps the text — and, for #238, the edit indicator's wording, Cancel and Escape leaving the mode, and a blocked send withheld on Enter and the button alike with the draft kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/components/chat/markdown.test.tsx`                 | the agent's markdown (#204): GFM headings/lists/tables/inline code, a fenced block highlighted with a variable per theme (against the real Shiki), an unshipped language falling back to plain text, Copy putting the code on a mocked clipboard and saying so, raw HTML staying text, links opening in a new tab, and an unfinished fence — and an unfinished `**bold`/link — mid-stream, both rendered directly and through the app's gated stream                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/components/models/model-picker.test.tsx`           | the picker itself: grouping, search, the keyboard rule, free text, the fallback note, refresh (429 and failure), the compact trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/hooks/use-session.test.tsx`                        | the hook's own contract: a failed load, and no duplicated message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/hooks/use-stick-to-bottom.test.tsx`                | the auto-scroll rule, with a scroll geometry jsdom does not have                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/components/logo-mark.test.tsx`                     | the mark (#240): one `aria-hidden` svg, the ring in `currentColor` and the dot in coral, no hex anywhere in the markup, the canonical geometry on both circles, and a caller's own size and ink winning over the defaults                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/components/sidebar.test.tsx`                       | the session list: first page then the rest, the cap note, and the row's delete action (in-page confirm, cancel, Escape, failure); then, for #211, the date headings (and only the buckets that hold something), the marked open chat, the account menu, the loading skeleton and the collapse control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/lib/session-groups.test.ts`                        | the date buckets (#211), with the clock pinned: each bucket, calendar days rather than 24-hour windows, the seventh day back against the eighth, empty buckets left out, an unreadable timestamp kept, a future one as today, and the order inside a bucket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/components/chat/working-row.test.tsx`              | the working row (#211): `workingState` as a rule (running/no-text, gone once text arrives, idle, retrying with the server's reason and without one, the reader's own stop first), and the component's clock under fake timers — counting up, the minute rollover, and no clock at all for "Interrupted"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/components/theme-menu.test.tsx`                    | the theme quick switch (#203), now the account menu's submenu (#211): a pick paints and saves, it reads back with `aria-checked`, Escape closes without choosing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/components/settings/appearance.test.tsx`           | the Appearance picker (#203): a pick is saved to the account and painted at once, the cached theme paints first and the account's stored one takes over once it answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/lib/*.test.ts`                                     | routes (including `#/` and its fallbacks, #209), the settings store, the theme store (`system` following `matchMedia`, the cache, the attribute; #203), the fake-mode scenario, the paging walk, the session re-read, the label rules, the context-window formatting, the auth store's rules, the auth-config schema's unknown-provider filter, and the highlighter's language table — thirty languages plus seventeen aliases, tokenized for real (#227)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/icons.test.ts`                                     | the shipped icons (#240): `public/favicon.svg` parses, draws the ring and dot the component's constants describe, carries the tokens' exact sRGB (with the dark violet behind its media query) — and every icon `index.html` links really exists in `public/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
A1), on `zod`, which the local schema for `GET /v1/auth-config` uses, and on `shiki`, which
highlights code blocks (#204). None is an `@openharness/*` package, so `yarn check:deps` has
nothing to say about them — but `shiki` is the one that is loaded lazily, on demand and in
pieces, and `docs/chat-ui.md` carries the sizes.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/web/docs/`.
