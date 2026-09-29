# @openharness/web

The openharness web app: a chat UI for the v1 API, built with Vite + React + TypeScript,
Tailwind and shadcn/ui. It talks to the server only through `@openharness/client`, and every
piece of chat state comes from the client's transcript reducer — there is no second store.

The long version of the decisions below, and what to watch out for, is in
[`docs/chat-ui.md`](./docs/chat-ui.md).

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

The server is not built yet, so development and tests run against the client's fake server.

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
  index.css                    Tailwind + the shadcn design tokens (dark follows the system)
  components/
    client-provider.tsx        the client in context, so screens can use it
    sidebar.tsx                session list (newest first), New chat, Agents, Settings;
                               the column from `md` up, the overlay drawer below it
    chat/
      chat-view.tsx            the chat screen: header, messages, errors, composer
      message-list.tsx         the scrolling conversation + stick-to-bottom
      message-item.tsx         one message (user right / agent left, markdown)
      markdown.tsx             react-markdown + remark-gfm, styled element by element
      composer.tsx             the input; Enter sends, Stop appears while running
      status-indicator.tsx     running / idle / retrying
      error-banner.tsx         inline errors (from the log, or from a failed request)
    agents/agent-form.tsx      name, model (free text + suggestions), system prompt
    ui/                        shadcn/ui primitives, copied from the registry
  screens/
    home-screen.tsx            no chat open
    new-chat-screen.tsx        pick an agent, create the session, go to the chat
    agents-screen.tsx          list, create, edit
    settings-screen.tsx        server URL + API key, stored in localStorage
  hooks/
    use-session.ts             THE session hook: history, live stream, send, interrupt
    use-sessions.ts            the sidebar's list, plus create
    use-session-refresh.ts     the re-read after a first message, shared by both of those
    use-agents.ts              the agents list, plus create and update
    use-stick-to-bottom.ts     auto-scroll that stays put when the reader scrolls up
    use-route.ts, use-settings.ts   thin React bindings over the two small stores
  lib/
    router.ts                  the hash routes (#/s/<id>, #/new, #/agents, #/settings)
    settings.ts                localStorage settings, a stable snapshot for React
    session-refresh.ts         the one re-read of a session whose first message named it
    dev-fake-client.ts         dev-only fake client + the seeded scenario
    models.ts                  the model suggestions the agent form offers
    paging.ts                  walking `next_page` for the two lists, with a safety cap
    errors.ts, format.ts, utils.ts
  test-support/render-app.tsx  render the app against a fake client; DOM readers
```

### Routes

| route             | screen                         |
| ----------------- | ------------------------------ |
| `#/`              | home (no chat open)            |
| `#/s/<sessionId>` | the chat                       |
| `#/new`           | new chat: pick an agent        |
| `#/agents`        | agents: list, create, edit     |
| `#/settings`      | settings: server URL + API key |

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
is why a new chat stops showing the agent's name a moment after the first message, with no reload
and no second walk of the list.

Failures never throw at the user: a failed load, send or interrupt lands in `requestError`,
and a `session.error` from the log is `lastError` — both rendered inline above the composer.

## Paging: the two lists

`GET /v1/agents` and `GET /v1/sessions` answer one page at a time (`{ data, next_page }`), and
the page size defaults to 20 — so a list that reads one page silently hides everything past
it. The agents screen is where that bites hardest: an agent that is never rendered cannot be
edited.

`src/lib/paging.ts` is the one place that walks the pages. `listAllPages(fetchPage, options)`
asks for `MAX_PAGE_LIMIT` (100, the protocol's maximum) and then keeps asking with
`page: next_page` until the server answers `null`; cursors are opaque and are handed back
exactly as they arrived. It stops on the first of:

- `next_page === null` — the end of the list;
- a cursor the server has already handed back (which would otherwise page forever);
- `MAX_PAGE_ITEMS` (1000) items — a documented safety cap, so a server with a very long list
  cannot make the browser hold an unbounded one;
- an aborted signal.

Only the cap sets `truncated`, and both lists render `and more… only the first 1000 are
listed` when it does. Anything else is a complete list.

`useAgents` and `useSessions` are the two callers and share the same shape: `onPage` sets the
first page straight away and appends the later ones (`appendUnseen`, which drops an item that
was already added by a `create` while the walk was running), so the sidebar is usable while
the rest of a long list is still loading. Both also return `truncated`, and neither decodes a
cursor itself.

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
- **A key the server will not take** (401/403) keeps the server's own message and adds
  `Check the API key in Settings.`
- **Everything else** keeps its message; an abort is "The request was cancelled." rather than
  a failure.

The context is the configured server URL, read from the settings store by the three hooks that
catch (`use-session`, `use-sessions`, `use-agents`) — the same store the client is built from,
so the URL in the message is the URL that was called.

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

## Chat components

**Vercel AI Elements and assistant-ui were both evaluated and not used**; the chat is built
from shadcn/ui primitives plus five presentational components in `src/components/chat/`:

- AI Elements does render from props (`Message` takes `from` and children), but it hard-depends
  on `ai` and `streamdown` for `Message`, and `PromptInput` brings `ai`, `nanoid` and six
  shadcn primitives for a composer whose state (attachments, model pickers) this app does not
  have. Pulling the AI SDK in for types and a markdown renderer — when the issue says not to
  use `useChat` — is the wrong trade.
- assistant-ui's external-store runtime expects its own message model (`ThreadMessageLike`
  parts) and its own streaming flags. That is a second state model next to the transcript
  reducer, which already models exactly this (previews, reconciliation, pending, errors).

So: `MessageList`/`MessageItem`/`Composer`/`StatusIndicator`/`ErrorBanner`, driven by
`useSession`, styled with Tailwind and shadcn/ui's Button, Textarea, Input, Label, Card and
Badge (copied from the registry, with the import paths rewritten — this app has no `@/`
alias, because its single `tsconfig.json` is the browser program and a Vite alias needs an
absolute path from a Node API it cannot see).

Markdown is `react-markdown` + `remark-gfm` with the elements styled by hand; no
`rehype-raw`, so HTML in a message stays text.

## Testing

`src/**/*.test.tsx` with Vitest (jsdom) and Testing Library, driving
`createFakeClient()` — no server, no mocked client. `src/test-support/render-app.tsx` renders
the app with the fake and provides a few DOM readers.

| file                                     | covers                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.test.tsx`                       | open a session, send → streamed reply, Stop → interrupted, reload → history, steering, retry → success, terminal error, new chat, a title arriving without a reload, request error |
| `src/screens/agents-screen.test.tsx`     | list, create and edit an agent, the model suggestions                                                                                                                              |
| `src/screens/settings-screen.test.tsx`   | settings round-trip, an empty URL as same-origin                                                                                                                                   |
| `src/hooks/use-session.test.tsx`         | the hook's own contract: a failed load, and no duplicated message                                                                                                                  |
| `src/hooks/use-stick-to-bottom.test.tsx` | the auto-scroll rule, with a scroll geometry jsdom does not have                                                                                                                   |
| `src/components/sidebar.test.tsx`        | the session list follows `next_page`, and the cap note                                                                                                                             |
| `src/lib/*.test.ts`                      | routes, the settings store, the fake-mode scenario, the paging walk, the session re-read                                                                                           |

Timing matters: the fake streams with `delayMs: 0` by default, so a test that wants to observe
a reply _while it streams_ passes a larger `delayMs` (and enough `chunks`) — otherwise the
reply can be finished before the first assertion runs.

## Allowed `@openharness/*` dependencies

Only these (see the table in `docs/architecture.md`):

- `@openharness/protocol`
- `@openharness/client` (and its `./testing` subpath in dev and in tests)

`@openharness/config` is additionally allowed as a **devDependency**.

Packages consume each other through built output only (`exports` → `dist/`), never through
relative paths. `yarn check:deps` at the repo root enforces this.

## Rules

- Stay inside this folder; do not edit other packages. A change that needs another package
  belongs in a separate issue.
- Update this file whenever the behaviour or the public API changes.
- Larger docs go in `apps/web/docs/`.
